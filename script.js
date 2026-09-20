/* =========================================================================
   パケット・トラフィック・ラボ  script.js
   -------------------------------------------------------------------------
   【このファイルでやっていること】
   1. サンプル画像（10×10のドット絵）を100個のパケットに分解する
   2. requestAnimationFrame で回線上のブロックを毎フレーム動かす
   3. 混雑度からパケットロスの確率を計算し、TCP / UDP で挙動を変える
   4. スループット・遅延・パケットロス率をリアルタイムに計算して表示する
   ========================================================================= */
'use strict';

/* =========================================================================
   1. サンプル画像データ（ドット絵）
   ------------------------------------------------------------------------
   1文字＝1ドット＝1パケット。文字と色の対応は PALETTE で決めている。
   ユーザーが画像をアップロードしなくても動くように、ここに直接書いている。
   ========================================================================= */
const ART_ROWS = [
  'bbkbbbbkbb',
  'bkykbbkykb',
  'bkyykkyykb',
  'kyyyyyyyyk',
  'kykyyyykyk',   // ← 目のライン
  'kyyynnyyyk',   // ← 鼻のライン
  'kypyyyypyk',   // ← ほっぺのライン
  'kyyyyyyyyk',
  'bkyyyyyykb',
  'bbkkkkkkbb'
];

// 文字 → 色 の対応表（ネコのドット絵）
const PALETTE = {
  b: '#cfe6ff', // 背景（空色）
  k: '#2b2b3d', // 輪郭（黒）
  y: '#ffb84d', // からだ（オレンジ）
  n: '#ff5f9e', // 鼻（ピンク）
  p: '#ff8fb1'  // ほっぺ（うすピンク）
};

const GRID_SIZE = 10;                       // 10×10
const TOTAL_PACKETS = GRID_SIZE * GRID_SIZE; // 全100パケット

// 各パケットの色を1次元配列にしておく（index 0〜99）
const PACKET_COLORS = [];
ART_ROWS.forEach(function (row) {
  row.split('').forEach(function (ch) {
    PACKET_COLORS.push(PALETTE[ch] || '#ffffff');
  });
});

/* =========================================================================
   2. HTML要素の取得（あとで何度も使うのでまとめて変数に入れる）
   ========================================================================= */
const el = {
  protocolSwitch: document.getElementById('protocolSwitch'),
  protocolNote:   document.getElementById('protocolNote'),
  trafficSlider:  document.getElementById('trafficSlider'),
  trafficValue:   document.getElementById('trafficValue'),
  bandwidthSlider:document.getElementById('bandwidthSlider'),
  bandwidthValue: document.getElementById('bandwidthValue'),
  condition:      document.getElementById('condition'),
  conditionText:  document.getElementById('conditionText'),
  sendBtn:        document.getElementById('sendBtn'),
  resetBtn:       document.getElementById('resetBtn'),
  sourceGrid:     document.getElementById('sourceGrid'),
  resultGrid:     document.getElementById('resultGrid'),
  road:           document.getElementById('road'),
  phone:          document.getElementById('phoneDevice'),
  server:         document.getElementById('serverDevice'),
  log:            document.getElementById('log'),
  progressFill:   document.getElementById('progressFill'),
  progressValue:  document.getElementById('progressValue'),
  throughputFill: document.getElementById('throughputFill'),
  throughputValue:document.getElementById('throughputValue'),
  latencyFill:    document.getElementById('latencyFill'),
  latencyValue:   document.getElementById('latencyValue'),
  lossFill:       document.getElementById('lossFill'),
  lossValue:      document.getElementById('lossValue'),
  statSent:       document.getElementById('statSent'),
  statLost:       document.getElementById('statLost'),
  statRetrans:    document.getElementById('statRetrans'),
  statTime:       document.getElementById('statTime'),
  verdict:        document.getElementById('verdict')
};

/* =========================================================================
   3. シミュレーションの状態をまとめて管理するオブジェクト
   ========================================================================= */
const state = {
  protocol: 'tcp',      // 'tcp' か 'udp'
  traffic: 50,          // 利用者の多さ 0〜100
  bandwidth: 50,        // 回線の太さ 0〜100

  running: false,       // 送信中かどうか
  finished: false,      // 送信が終わったか
  startTime: 0,         // 送信開始時刻
  elapsed: 0,           // 経過時間（秒）

  queue: [],            // これから送るパケット番号の待ち行列
  packets: [],          // いま回線を走っている自分のパケット
  nacks: [],            // 再送リクエスト（TCPのみ）
  cars: [],             // 他人の通信（グレーのブロック）

  received: new Set(),  // 届いたパケット番号
  sentCount: 0,         // 送信した回数（再送も1回と数える）
  lostCount: 0,         // 消えた回数
  retransCount: 0,      // 再送した回数

  cwnd: 4,              // TCPの「同時に送れる数」＝ウィンドウサイズ
  spawnTimer: 0,        // 次のパケットを送り出すまでのタイマー
  carTimer: 0,          // 次の他人通信を出すまでのタイマー
  arrivals: [],         // スループット計算用：到着時刻の記録
  latencies: [],        // 遅延計算用：最近のパケットの所要時間
  noiseCells: []        // UDPで届かなかったマス（砂嵐表示用）
};

// 道路のサイズ（画面幅が変わるたびに測り直す）
let roadWidth = 600;
let roadHeight = 230;
const LANES = 5; // 回線の中に仮想的な5車線をつくる

/* =========================================================================
   4. 初期化：ドット絵グリッドをHTMLに作る
   ========================================================================= */
const sourcePixels = [];  // 元画像のマス
const resultPixels = [];  // 受信画像のマス

function buildGrids() {
  for (let i = 0; i < TOTAL_PACKETS; i++) {
    // --- 左の小さいプレビュー（最初から完成形を表示） ---
    const src = document.createElement('div');
    src.className = 'pixel';
    src.style.backgroundColor = PACKET_COLORS[i];
    el.sourceGrid.appendChild(src);
    sourcePixels.push(src);

    // --- 右の受信エリア（最初は空っぽ） ---
    const dst = document.createElement('div');
    dst.className = 'pixel';
    el.resultGrid.appendChild(dst);
    resultPixels.push(dst);
  }
}

/* =========================================================================
   5. 混雑度の計算（スライダーの値 → 実際の挙動）
   ------------------------------------------------------------------------
   trafficRate  : 利用者の多さ（0〜1）
   bandwidthRate: 回線の太さ（0〜1）
   ========================================================================= */
function trafficRate()   { return state.traffic / 100; }
function bandwidthRate() { return state.bandwidth / 100; }

// パケットロスが起きる確率（0〜0.55）
// 利用者が多いほど上がり、回線が太いほど下がる
function lossProbability() {
  const raw = trafficRate() * 0.85 - bandwidthRate() * 0.50;
  return Math.min(0.55, Math.max(0, raw));
}

// 回線の端から端まで走るのにかかる秒数（混むほど遅い）
function travelSeconds() {
  return 0.75 + 2.3 * trafficRate() * (1 - 0.6 * bandwidthRate());
}

// 次のパケットを送り出す間隔（ミリ秒）。回線が太いほど短い＝どんどん送れる
function spawnIntervalMs() {
  const base = 130 - 85 * bandwidthRate();
  // UDPは相手の返事を待たないので、どんどん詰め込む
  return state.protocol === 'udp' ? base * 0.55 : base;
}

// 混雑度を0〜1で表した総合指標（コンディション表示用）
function congestionLevel() {
  return Math.min(1, Math.max(0, trafficRate() * 0.8 + (1 - bandwidthRate()) * 0.4));
}

/* =========================================================================
   6. 画面表示の更新（スライダーやコンディションのラベル）
   ========================================================================= */
function levelLabel(value) {
  if (value < 20) return 'とても少ない';
  if (value < 40) return '少なめ';
  if (value < 60) return 'ふつう';
  if (value < 80) return '多め';
  return 'とても多い';
}

function widthLabel(value) {
  if (value < 20) return 'とてもせまい';
  if (value < 40) return 'せまめ';
  if (value < 60) return 'ふつう';
  if (value < 80) return '広め';
  return 'とても広い';
}

function updateConditionUI() {
  el.trafficValue.textContent = levelLabel(state.traffic);
  el.bandwidthValue.textContent = widthLabel(state.bandwidth);

  const c = congestionLevel();
  el.condition.classList.remove('is-smooth', 'is-busy', 'is-jam');

  if (c < 0.35) {
    el.condition.classList.add('is-smooth');
    el.conditionText.textContent = 'すいている（快適）';
  } else if (c < 0.7) {
    el.condition.classList.add('is-busy');
    el.conditionText.textContent = 'すこし混雑（ときどきロス）';
  } else {
    el.condition.classList.add('is-jam');
    el.conditionText.textContent = '大渋滞（ロスだらけ）';
  }
}

// プロトコルの説明文を切り替える
function updateProtocolNote() {
  if (state.protocol === 'tcp') {
    el.protocolNote.textContent =
      '消えたパケットは必ず再送して、最後は完璧な画像にする。そのぶん時間はかかる。';
  } else {
    el.protocolNote.textContent =
      '消えたパケットは気にせず送りっぱなし。一瞬で終わるけど、画像は欠けたまま。';
  }
}

/* =========================================================================
   7. 実況ログ（画面下に最新のできごとを表示）
   ========================================================================= */
function addLog(text, type) {
  const row = document.createElement('p');
  row.className = 'log__row' + (type ? ' log__row--' + type : '');
  row.textContent = text;
  el.log.prepend(row);                 // 新しいものを一番上に
  while (el.log.children.length > 5) { // 古いものは削除
    el.log.removeChild(el.log.lastChild);
  }
}

/* =========================================================================
   8. 回線上のブロックを作る／動かす
   ========================================================================= */

// 車線（lane）の縦位置を求める
function laneY(lane) {
  const margin = 22;
  return margin + lane * ((roadHeight - margin * 2) / (LANES - 1));
}

// 自分のパケットを1つ送り出す
function spawnPacket(index, isRetransmission) {
  const node = document.createElement('div');
  node.className = 'packet' + (isRetransmission ? ' is-retransmitted' : '');
  node.style.backgroundColor = PACKET_COLORS[index];
  el.road.appendChild(node);

  const packet = {
    index: index,                                  // 画像のどのマスか
    node: node,
    x: -20,                                        // 道路上のX座標（px）
    lane: Math.floor(Math.random() * LANES),
    // 「この先で消える運命かどうか」を送り出す瞬間にサイコロで決める
    doomed: Math.random() < lossProbability(),
    lossX: roadWidth * (0.25 + Math.random() * 0.5), // 消える位置
    bornAt: performance.now(),
    // 最初に送ろうとした時刻。再送されても引き継ぐので、遅延に再送時間が加算される
    firstTryAt: packetFirstTry[index] || performance.now()
  };

  packetFirstTry[index] = packet.firstTryAt;
  state.packets.push(packet);
  state.sentCount++;
  return packet;
}

// 各パケットが「最初に送られた時刻」を覚えておく入れもの
const packetFirstTry = {};

// 他人の通信（グレーのブロック）を1つ出す
function spawnCar() {
  const node = document.createElement('div');
  node.className = 'traffic-block';
  el.road.appendChild(node);

  state.cars.push({
    node: node,
    x: -30,
    lane: Math.floor(Math.random() * LANES),
    speedRate: 0.8 + Math.random() * 0.5   // 少しずつ速さを変えて自然に見せる
  });
}

// 衝突エフェクト（💥）を出す
function spawnBoom(x, y) {
  const node = document.createElement('div');
  node.className = 'boom';
  node.style.left = (x - 13) + 'px';
  node.style.top = (y - 13) + 'px';
  el.road.appendChild(node);
  // アニメが終わったら自動で消す
  setTimeout(function () { node.remove(); }, 450);
}

// 再送リクエスト（受信側 → 送信側へ戻る矢印）を出す
function spawnNack(index, x, lane) {
  const node = document.createElement('div');
  node.className = 'nack';
  el.road.appendChild(node);

  state.nacks.push({
    index: index,
    node: node,
    x: x,
    lane: lane
  });
}

/* =========================================================================
   9. パケットが到着したときの処理
   ========================================================================= */
function onPacketArrived(packet, now) {
  // すでに届いている番号なら何もしない（TCPで重複した場合の保険）
  if (!state.received.has(packet.index)) {
    state.received.add(packet.index);

    // 受信グリッドのマスに色をつける＝画像が少しずつ復元される
    const cell = resultPixels[packet.index];
    cell.style.backgroundColor = PACKET_COLORS[packet.index];
    cell.classList.add('is-arrived');
    cell.classList.remove('is-noise');
  }

  // 指標の計算用にデータを記録
  state.arrivals.push(now);
  state.latencies.push(now - packet.firstTryAt);
  if (state.latencies.length > 12) state.latencies.shift();

  // サーバーのランプを一瞬光らせる
  el.server.classList.add('is-receiving');
  clearTimeout(onPacketArrived.timer);
  onPacketArrived.timer = setTimeout(function () {
    el.server.classList.remove('is-receiving');
  }, 120);

  // TCPは「届いた」という返事が来るたびに、少しずつ送る量を増やす（輻輳制御）
  if (state.protocol === 'tcp') {
    state.cwnd = Math.min(16, state.cwnd + 0.18);
  }
}

/* =========================================================================
   10. パケットが消えた（ロスした）ときの処理
   ========================================================================= */
function onPacketLost(packet) {
  state.lostCount++;
  spawnBoom(packet.x, laneY(packet.lane));

  if (state.protocol === 'tcp') {
    // --- TCP：受信側が「届いてないよ！」と再送リクエストを送り返す ---
    spawnNack(packet.index, packet.x, packet.lane);
    // 混んでいると判断して、送る量を半分に減らす（これも輻輳制御）
    state.cwnd = Math.max(2, state.cwnd / 2);
    addLog('パケット #' + packet.index + ' が消えた → 再送をリクエスト', 'tcp');
  } else {
    // --- UDP：気にしない。二度と送らない ---
    addLog('パケット #' + packet.index + ' が消えた → UDPは再送しない', 'udp');
    markNoiseCell(packet.index);
  }
}

// UDPで失われたマスを「砂嵐」にする
function markNoiseCell(index) {
  if (state.received.has(index)) return;
  const cell = resultPixels[index];
  cell.classList.add('is-noise');
  if (state.noiseCells.indexOf(index) === -1) state.noiseCells.push(index);
}

// 砂嵐マスの色をランダムに変え続ける（ノイズっぽく見せる）
setInterval(function () {
  state.noiseCells.forEach(function (index) {
    const v = Math.floor(Math.random() * 160);
    resultPixels[index].style.backgroundColor = 'rgb(' + v + ',' + v + ',' + (v + 10) + ')';
  });
}, 110);

/* =========================================================================
   11. メインループ（毎フレーム呼ばれる）
   ========================================================================= */
let lastFrameTime = performance.now();

function loop(now) {
  // dt = 前のフレームからの経過秒数。端末の性能差を吸収する
  let dt = (now - lastFrameTime) / 1000;
  if (dt > 0.05) dt = 0.05; // タブを切り替えた直後などに飛びすぎないよう制限
  lastFrameTime = now;

  updateCars(dt);      // 他人の通信は送信していなくても常に流す
  if (state.running) {
    updateSending(dt, now);
    updatePackets(dt, now);
    updateNacks(dt);
    state.elapsed = (now - state.startTime) / 1000;
    checkFinish(now);
  }
  updateMeters(now);

  requestAnimationFrame(loop);
}

/* --- 11-1. 他人の通信（グレーブロック）の生成と移動 --- */
function updateCars(dt) {
  // 利用者が多いほど短い間隔でどんどん出てくる
  const interval = 320 - 280 * trafficRate();
  state.carTimer += dt * 1000;

  // 利用者ゼロのときは出さない
  if (trafficRate() > 0.03) {
    while (state.carTimer >= interval) {
      state.carTimer -= interval;
      if (state.cars.length < 90) spawnCar();
    }
  } else {
    state.carTimer = 0;
  }

  const speed = roadWidth / travelSeconds();

  for (let i = state.cars.length - 1; i >= 0; i--) {
    const car = state.cars[i];
    car.x += speed * car.speedRate * dt;

    if (car.x > roadWidth + 30) {
      // 画面の外に出たら削除
      car.node.remove();
      state.cars.splice(i, 1);
    } else {
      car.node.style.transform = 'translate(' + car.x + 'px,' + (laneY(car.lane) - 6) + 'px)';
    }
  }
}

/* --- 11-2. パケットを送り出す（送信側の処理） --- */
function updateSending(dt, now) {
  if (state.queue.length === 0) return;

  const interval = spawnIntervalMs();
  state.spawnTimer += dt * 1000;
  if (state.spawnTimer > interval * 3) state.spawnTimer = interval * 3; // 溜めすぎ防止

  while (state.spawnTimer >= interval && state.queue.length > 0) {
    // TCPは「同時に送れる数（ウィンドウ）」を超えたら待つ＝渋滞時は遅くなる
    if (state.protocol === 'tcp' && state.packets.length >= Math.round(state.cwnd)) break;

    state.spawnTimer -= interval;
    const item = state.queue.shift();
    spawnPacket(item.index, item.retry);
  }
}

/* --- 11-3. 自分のパケットの移動・到着・消滅の判定 --- */
function updatePackets(dt, now) {
  const speed = roadWidth / travelSeconds();

  for (let i = state.packets.length - 1; i >= 0; i--) {
    const p = state.packets[i];
    p.x += speed * dt;

    // (a) 消える運命のパケットが、消滅ポイントに到達した
    if (p.doomed && p.x >= p.lossX) {
      onPacketLost(p);
      p.node.remove();
      state.packets.splice(i, 1);
      continue;
    }

    // (b) 右端（サーバー）に到着した
    if (p.x >= roadWidth) {
      onPacketArrived(p, now);
      p.node.remove();
      state.packets.splice(i, 1);
      continue;
    }

    // (c) まだ走行中：位置を更新
    p.node.style.transform = 'translate(' + p.x + 'px,' + (laneY(p.lane) - 7) + 'px)';
  }
}

/* --- 11-4. 再送リクエスト（TCP）の移動 --- */
function updateNacks(dt) {
  const speed = roadWidth / 0.7; // 返事は速めに戻ってくる

  for (let i = state.nacks.length - 1; i >= 0; i--) {
    const n = state.nacks[i];
    n.x -= speed * dt;

    if (n.x <= 0) {
      // 送信側まで戻ってきた → 消えたパケットをもう一度送り直す
      n.node.remove();
      state.nacks.splice(i, 1);
      state.retransCount++;
      state.queue.unshift({ index: n.index, retry: true }); // 優先的に再送
      addLog('パケット #' + n.index + ' を再送します！', 'tcp');
    } else {
      n.node.style.transform = 'translate(' + n.x + 'px,' + (laneY(n.lane) - 7) + 'px)';
    }
  }
}

/* --- 11-5. 送信完了の判定 --- */
function checkFinish(now) {
  if (state.protocol === 'tcp') {
    // TCPは全部のマスが埋まるまで終わらない
    if (state.received.size >= TOTAL_PACKETS) finish(now);
  } else {
    // UDPは「送るものが無くなり、走っているパケットも無くなれば」終了
    if (state.queue.length === 0 && state.packets.length === 0) finish(now);
  }
}

function finish(now) {
  state.running = false;
  state.finished = true;
  state.elapsed = (now - state.startTime) / 1000;
  el.phone.classList.remove('is-sending');
  el.sendBtn.disabled = false;
  el.sendBtn.textContent = '画像を送信';

  const seconds = state.elapsed.toFixed(1);
  const lossRate = state.sentCount ? (state.lostCount / state.sentCount * 100).toFixed(1) : '0.0';

  if (state.protocol === 'tcp') {
    el.verdict.className = 'verdict is-tcp';
    el.verdict.textContent =
      'TCPの結果：' + state.retransCount + '回の再送のおかげで、画像は100%完璧に復元できた。' +
      'ただし完成までに ' + seconds + ' 秒（ロス率 ' + lossRate + '%）。' +
      'Webページやファイルのダウンロードはこの確実さが必要。';
    addLog('送信完了！ 完璧な画像が ' + seconds + ' 秒で届いた', 'tcp');
  } else {
    const missing = TOTAL_PACKETS - state.received.size;
    el.verdict.className = 'verdict is-udp';
    el.verdict.textContent =
      'UDPの結果：送信はわずか ' + seconds + ' 秒で完了。でも ' + missing +
      '個のパケットは行方不明のまま、画像はボロボロ（ロス率 ' + lossRate + '%）。' +
      'ビデオ通話やオンラインゲームは、多少乱れても速さを優先するのでこちら。';
    addLog('送信完了！ ' + seconds + ' 秒で終了、' + missing + '個が欠けたまま', 'udp');
  }
}

/* =========================================================================
   12. 通信品質メーターの更新
   ========================================================================= */
let lastMeterUpdate = 0;

function updateMeters(now) {
  // 毎フレーム書き換えると数字がチラつくので、150msごとに更新する
  if (now - lastMeterUpdate < 150) return;
  lastMeterUpdate = now;

  /* --- ① スループット：直近1秒間に届いたパケット数から計算 --- */
  state.arrivals = state.arrivals.filter(function (t) { return now - t < 1000; });
  const perSecond = state.arrivals.length;
  const throughput = perSecond * 0.5;          // 見かけ上の Mbps（教材用の目安）
  el.throughputValue.textContent = throughput.toFixed(1) + ' Mbps';
  el.throughputFill.style.width = Math.min(100, throughput / 25 * 100) + '%';

  /* --- ② 遅延：最近届いたパケットが「最初に送られてから」何msかかったか --- */
  let latency = 0;
  if (state.latencies.length) {
    const sum = state.latencies.reduce(function (a, b) { return a + b; }, 0);
    latency = sum / state.latencies.length;
  }
  el.latencyValue.textContent = Math.round(latency) + ' ms';
  el.latencyFill.style.width = Math.min(100, latency / 3000 * 100) + '%';

  /* --- ③ パケットロス率 --- */
  const lossRate = state.sentCount ? (state.lostCount / state.sentCount * 100) : 0;
  el.lossValue.textContent = lossRate.toFixed(1) + ' %';
  el.lossFill.style.width = Math.min(100, lossRate / 60 * 100) + '%';

  /* --- 復元の進み具合 --- */
  const progress = state.received.size / TOTAL_PACKETS * 100;
  el.progressValue.textContent = Math.round(progress) + '%';
  el.progressFill.style.width = progress + '%';

  /* --- 数値一覧 --- */
  el.statSent.textContent = state.sentCount;
  el.statLost.textContent = state.lostCount;
  el.statRetrans.textContent = state.retransCount;
  el.statTime.textContent = state.elapsed.toFixed(1) + ' 秒';
}

/* =========================================================================
   13. 送信スタート／リセット
   ========================================================================= */
function startSending() {
  if (state.running) return;
  resetSimulation(false); // 前回の結果を消してから始める

  // 0番から99番まで順番に送る待ち行列をつくる
  for (let i = 0; i < TOTAL_PACKETS; i++) {
    state.queue.push({ index: i, retry: false });
  }

  state.running = true;
  state.finished = false;
  state.startTime = performance.now();
  state.cwnd = 4;

  el.phone.classList.add('is-sending');
  el.sendBtn.disabled = true;
  el.sendBtn.textContent = '送信中…';
  el.verdict.className = 'verdict';
  el.verdict.textContent = state.protocol === 'tcp'
    ? 'TCPで送信中。消えたパケットは再送されるので、最後まで見守ろう。'
    : 'UDPで送信中。消えたパケットは置き去り。どこが欠けるかな？';

  addLog(
    (state.protocol === 'tcp' ? 'TCP' : 'UDP') + 'で100個のパケットを送信開始！',
    state.protocol
  );
}

// 画面をまっさらに戻す（clearLog=true のときはログも消す）
function resetSimulation(clearLog) {
  state.running = false;
  state.finished = false;

  // 回線上のブロックをすべて削除
  state.packets.forEach(function (p) { p.node.remove(); });
  state.nacks.forEach(function (n) { n.node.remove(); });
  state.packets = [];
  state.nacks = [];

  // カウンターをリセット
  state.queue = [];
  state.received = new Set();
  state.sentCount = 0;
  state.lostCount = 0;
  state.retransCount = 0;
  state.arrivals = [];
  state.latencies = [];
  state.noiseCells = [];
  state.elapsed = 0;
  state.spawnTimer = 0;
  state.cwnd = 4;
  for (const key in packetFirstTry) delete packetFirstTry[key];

  // 受信グリッドを空に戻す
  resultPixels.forEach(function (cell) {
    cell.style.backgroundColor = '';
    cell.classList.remove('is-arrived', 'is-noise');
  });

  el.phone.classList.remove('is-sending');
  el.sendBtn.disabled = false;
  el.sendBtn.textContent = '画像を送信';

  if (clearLog) {
    el.log.innerHTML = '';
    el.verdict.className = 'verdict';
    el.verdict.textContent = '「画像を送信」を押すとシミュレーションが始まります。';
  }

  // メーターを即座に0へ戻す（updateMeters は150msに1回しか動かないので解除してから呼ぶ）
  lastMeterUpdate = 0;
  updateMeters(performance.now());
}

/* =========================================================================
   14. イベント設定（ボタン・スライダーの操作を受け取る）
   ========================================================================= */

// --- プロトコル切り替え ---
el.protocolSwitch.addEventListener('click', function (event) {
  const btn = event.target.closest('.protocol-switch__btn');
  if (!btn) return;

  state.protocol = btn.dataset.protocol;

  // ボタンの見た目を切り替える
  Array.prototype.forEach.call(el.protocolSwitch.children, function (b) {
    const active = (b === btn);
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  updateProtocolNote();
  resetSimulation(true); // ルールが変わったので最初からやり直し
  addLog(state.protocol === 'tcp'
    ? 'TCPモードに切り替えました（確実性重視）'
    : 'UDPモードに切り替えました（スピード重視）', state.protocol);
});

// --- スライダー（送信中に動かしてもリアルタイムで反映される） ---
el.trafficSlider.addEventListener('input', function () {
  state.traffic = Number(this.value);
  updateConditionUI();
});

el.bandwidthSlider.addEventListener('input', function () {
  state.bandwidth = Number(this.value);
  updateConditionUI();
});

// --- ボタン ---
el.sendBtn.addEventListener('click', startSending);
el.resetBtn.addEventListener('click', function () { resetSimulation(true); });

// --- 道路のサイズを測る（画面サイズが変わったら測り直す） ---
function measureRoad() {
  roadWidth = el.road.clientWidth;
  roadHeight = el.road.clientHeight;
}
window.addEventListener('resize', measureRoad);

/* =========================================================================
   15. 起動処理
   ========================================================================= */
buildGrids();          // ドット絵のマスをつくる
measureRoad();         // 道路の大きさを測る
updateConditionUI();   // スライダーのラベルを初期表示
updateProtocolNote();  // プロトコル説明を初期表示
addLog('準備OK。スライダーで混雑ぐあいを決めて「画像を送信」を押そう');
requestAnimationFrame(loop); // メインループ開始
