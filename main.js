// ============================================================
// カメラの手ジェスチャーで舵を操作するスクリプト
//
// 役割分担:
//   main.js … カメラと手の検出をして「舵角」を決める(このファイル)
//   game.js … その舵角で船を動かし、海と岩を描く
//
// 仕組み:
//   1. MediaPipe Hands がカメラ映像から手の21個の点(ランドマーク)を検出する
//   2. 「傾き角度」を計算する。手が2つ見えているか1つかで方法が変わる
//      - 両手 … 左右の手のひらを結ぶ線の傾き(舵輪を両手で握るのと同じ感覚)
//      - 片手 … 手首(landmark 0)から中指の付け根(landmark 9)への向き
//   3. その角度を舵角に変換して、操舵輪の絵とゲームに渡す
//
// 数値をいじって挙動を変えたい場合は、下の CONFIG を編集してください。
// (岩の出方や船の速さなど、ゲーム側の調整は game.js の GAME_CONFIG です)
// ============================================================

const CONFIG = {
  smoothingAlpha: 0.2, // 数値を大きくすると反応が速く/カクつきやすくなる。小さくすると滑らかだが遅くなる。
  // 舵角1度あたり操舵輪を何度回すか。
  // 輪には「手」の絵が乗っていて、それが利用者の実際の手の傾きに見えるようにしたいので
  // 1.0(等倍)にしてある。ここを大きくすると輪は派手に回るが、手の絵が実際の手とずれる。
  wheelTurnRatio: 1.0,
};

const videoEl = document.getElementById('input-video');
const canvasEl = document.getElementById('overlay-canvas');
const canvasCtx = canvasEl.getContext('2d');
const statusEl = document.getElementById('status');
const angleValueEl = document.getElementById('angle-value');
const wheelRotor = document.getElementById('wheel-rotor');

const gripLeft = document.getElementById('grip-left');
const gripRight = document.getElementById('grip-right');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnCalibrate = document.getElementById('btn-calibrate');
const btnPlay = document.getElementById('btn-play');
const btnRetry = document.getElementById('btn-retry');
const btnBackTitle = document.getElementById('btn-back-title');
const btnSound = document.getElementById('btn-sound');
const difficultyButtons = document.getElementById('difficulty-buttons');
const resultDifficultyEl = document.getElementById('result-difficulty');

const sensitivityInput = document.getElementById('sensitivity');
const sensitivityValueEl = document.getElementById('sensitivity-value');
const maxAngleInput = document.getElementById('max-angle');
const maxAngleValueEl = document.getElementById('max-angle-value');
const mirrorToggle = document.getElementById('mirror-toggle');

const hudEl = document.getElementById('hud');
const hudDistanceEl = document.getElementById('hud-distance');
const hudDodgedEl = document.getElementById('hud-dodged');
const hudHpEl = document.getElementById('hud-hp');
const overlayTitle = document.getElementById('overlay-title');
const overlayGameover = document.getElementById('overlay-gameover');
const resultDistanceEl = document.getElementById('result-distance');
const resultDodgedEl = document.getElementById('result-dodged');
const resultBestEl = document.getElementById('result-best');

let sensitivity = parseFloat(sensitivityInput.value);
let maxAngle = parseFloat(maxAngleInput.value);
let mirror = mirrorToggle.checked;

// 基準(0°)にしたときの生の角度。両手と片手では自然な構えが違うので別々に覚えておく。
// これを1つで共用すると、片手↔両手が切り替わった瞬間に舵が跳ねてしまう。
let calibrationOffset = { one: 0, two: 0 };

let bestDistance = { easy: 0, normal: 0, hard: 0 }; // 難易度ごとの自己最高記録
let difficulty = 'normal';
let soundEnabled = true;

let smoothedAngle = 0;
let camera = null;
let handsDetected = false;
let handMode = 'none';     // 'none' | 'one' | 'two'
let oneHandOnRight = true; // 片手のとき、その手が右側にあるか(手の絵の出し分けに使う)
let lastRawAngle = 0;
let keyDir = 0;            // キーボード操作用(-1:左 0:なし 1:右)

// --- 設定を localStorage に保存して、次回このPCで開いたときにも覚えておく ---
const STORAGE_KEY = 'kaken-kazi-cam-settings';
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (typeof saved.sensitivity === 'number') sensitivity = saved.sensitivity;
    if (typeof saved.maxAngle === 'number') maxAngle = saved.maxAngle;
    if (typeof saved.mirror === 'boolean') mirror = saved.mirror;
    if (saved.calibrationOffset && typeof saved.calibrationOffset === 'object') {
      Object.assign(calibrationOffset, saved.calibrationOffset);
    }
    if (saved.bestDistance && typeof saved.bestDistance === 'object') {
      Object.assign(bestDistance, saved.bestDistance);
    }
    if (DIFFICULTY_PRESETS[saved.difficulty]) difficulty = saved.difficulty;
    if (typeof saved.soundEnabled === 'boolean') soundEnabled = saved.soundEnabled;
  } catch (e) { /* 保存データが無ければ何もしない */ }
  sensitivityInput.value = sensitivity;
  sensitivityValueEl.textContent = sensitivity.toFixed(1);
  maxAngleInput.value = maxAngle;
  maxAngleValueEl.textContent = maxAngle;
  mirrorToggle.checked = mirror;
}
function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    sensitivity, maxAngle, mirror, calibrationOffset, bestDistance, difficulty, soundEnabled,
  }));
}
loadSettings();

sensitivityInput.addEventListener('input', () => {
  sensitivity = parseFloat(sensitivityInput.value);
  sensitivityValueEl.textContent = sensitivity.toFixed(1);
  saveSettings();
});
maxAngleInput.addEventListener('input', () => {
  maxAngle = parseFloat(maxAngleInput.value);
  maxAngleValueEl.textContent = maxAngle;
  saveSettings();
});
mirrorToggle.addEventListener('change', () => {
  mirror = mirrorToggle.checked;
  saveSettings();
});

// --- 片手のときの傾き角度 ---
// 手首(0)から中指の付け根(9)への向きを使う。手をまっすぐ立てた状態が0度。
function computeOneHandAngleDeg(landmarks) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  let dx = middleMcp.x - wrist.x;
  const dy = middleMcp.y - wrist.y;
  if (mirror) dx = -dx;
  return Math.atan2(dx, -dy) * (180 / Math.PI);
}

// --- 両手のときの傾き角度 ---
// 左右の手のひら(中指の付け根)を結ぶ線が、水平から何度傾いているかを使う。
// 舵輪を両手で握って回すのと同じ感覚になる。両手が水平に並んだ状態が0度。
function computeTwoHandAngleDeg(handA, handB) {
  const a = handA[9];
  const b = handB[9];
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (mirror) dx = -dx;
  // どちらの手が先に検出されても同じ結果になるよう、必ず左→右の向きにそろえる
  if (dx < 0) { dx = -dx; dy = -dy; }
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

// 操舵輪に重ねる「手」の絵を、検出した手に合わせて出し分ける
function updateGripHands() {
  const showBoth = handMode === 'two';
  gripRight.classList.toggle('active', showBoth || (handMode === 'one' && oneHandOnRight));
  gripLeft.classList.toggle('active', showBoth || (handMode === 'one' && !oneHandOnRight));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ------------------------------------------------------------
// MediaPipe から手の検出結果が届いたとき
// (カメラの速さで呼ばれる。描画そのものは下のループが担当する)
// ------------------------------------------------------------
function onResults(results) {
  canvasEl.width = results.image.width;
  canvasEl.height = results.image.height;

  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  canvasCtx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);

  const hands = results.multiHandLandmarks || [];
  const wasDetected = handsDetected;

  // 見つかった手をすべて描く
  hands.forEach((landmarks) => {
    window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, { color: '#f0c66a', lineWidth: 3 });
    window.drawLandmarks(canvasCtx, landmarks, { color: '#fff2c4', radius: 3 });
  });

  if (hands.length >= 2) {
    handMode = 'two';
    handsDetected = true;
    lastRawAngle = computeTwoHandAngleDeg(hands[0], hands[1]);
    statusEl.textContent = '両手で操作中';
  } else if (hands.length === 1) {
    handMode = 'one';
    handsDetected = true;
    lastRawAngle = computeOneHandAngleDeg(hands[0]);
    // 画面のどちら側に手があるか(mirror が有効なら左右が入れ替わる)
    const x = hands[0][9].x;
    oneHandOnRight = (mirror ? 1 - x : x) > 0.5;
    statusEl.textContent = '片手で操作中';
  } else {
    handMode = 'none';
    handsDetected = false;
    statusEl.textContent = '手が見つかりません';
  }

  // 手を見失っていた状態から見つかった瞬間だけ、小さな合図を鳴らす
  if (handsDetected && !wasDetected) Sound.play('handOn');

  btnCalibrate.disabled = !handsDetected;
  updateGripHands();
  canvasCtx.restore();
}

// ------------------------------------------------------------
// 画面の更新ループ(60fps)
// カメラより速く回るので、船の動きが滑らかになる
// ------------------------------------------------------------
let lastTime = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  // --- 舵角を決める ---
  let targetAngle;
  if (handsDetected) {
    // 片手と両手では基準の角度が違うので、そのモード用の基準を引く
    const offset = handMode === 'two' ? calibrationOffset.two : calibrationOffset.one;
    targetAngle = clamp((lastRawAngle - offset) * sensitivity, -maxAngle, maxAngle);
  } else if (keyDir !== 0) {
    targetAngle = keyDir * maxAngle;          // キーボードで操作しているとき
  } else {
    targetAngle = 0;                          // 手もキーも無ければ舵は中央に戻る
  }
  const alpha = clamp(CONFIG.smoothingAlpha * dt * 60, 0, 1);
  smoothedAngle += (targetAngle - smoothedAngle) * alpha;

  // --- 操舵輪の見た目を更新 ---
  wheelRotor.setAttribute('transform', `rotate(${(smoothedAngle * CONFIG.wheelTurnRatio).toFixed(2)})`);
  angleValueEl.textContent = smoothedAngle.toFixed(1);
  // 舵を切るほど魔法陣の光を強くする(0〜1をCSS変数で渡す)
  document.documentElement.style.setProperty('--glow', (Math.abs(smoothedAngle) / maxAngle).toFixed(3));

  // --- ゲームを1コマ進める ---
  RudderGame.tick(dt, smoothedAngle / maxAngle);

  const stats = RudderGame.getStats();
  if (stats.state === 'playing') updateHud(stats);

  // 速く進んでいるほど波の音と低いうなりを強くする
  Sound.setIntensity(stats.state === 'playing' ? stats.speed / 40 : 0);

  requestAnimationFrame(frame);
}

function updateHud(stats) {
  hudDistanceEl.textContent = stats.distance;
  hudDodgedEl.textContent = stats.dodged;

  // 船体の数は難易度によって変わるので、足りなければ作り直す
  if (hudHpEl.children.length !== stats.maxHp) {
    hudHpEl.textContent = '';
    for (let i = 0; i < stats.maxHp; i++) {
      const pip = document.createElement('span');
      pip.className = 'pip';
      hudHpEl.appendChild(pip);
    }
  }
  const pips = hudHpEl.children;
  for (let i = 0; i < pips.length; i++) {
    pips[i].classList.toggle('lost', i >= stats.hp);
  }
}

// ------------------------------------------------------------
// ゲームの開始・終了
// ------------------------------------------------------------
// --- 難易度の選択 ---
function applyDifficulty(key) {
  difficulty = key;
  RudderGame.setDifficulty(key);
  [...difficultyButtons.children].forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.difficulty === key);
  });
  saveSettings();
}

difficultyButtons.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-difficulty]');
  if (btn) applyDifficulty(btn.dataset.difficulty);
});

applyDifficulty(difficulty); // 前回選んだ難易度を復元

function startGame() {
  overlayTitle.hidden = true;
  overlayGameover.hidden = true;
  hudEl.hidden = false;
  RudderGame.start();
  updateHud(RudderGame.getStats());
  Sound.play('horn'); // 出航の汽笛
}

function backToTitle() {
  overlayGameover.hidden = true;
  hudEl.hidden = true;
  overlayTitle.hidden = false;
}

RudderGame.on('hit', (stats) => {
  updateHud(stats);
  Sound.play('crash');
});

RudderGame.on('dodge', () => Sound.play('dodge'));

RudderGame.on('gameover', (stats) => {
  updateHud(stats);
  Sound.play('gameover');
  resultDistanceEl.textContent = stats.distance;
  resultDodgedEl.textContent = stats.dodged;
  if (stats.distance > (bestDistance[difficulty] || 0)) {
    bestDistance[difficulty] = stats.distance;
    saveSettings();
  }
  resultDifficultyEl.textContent = DIFFICULTY_PRESETS[difficulty].label;
  resultBestEl.textContent = bestDistance[difficulty] || 0;
  overlayGameover.hidden = false;
});

btnPlay.addEventListener('click', startGame);
btnRetry.addEventListener('click', startGame);
btnBackTitle.addEventListener('click', backToTitle);

// ------------------------------------------------------------
// カメラの開始・停止
// ------------------------------------------------------------
const hands = new window.Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});
hands.setOptions({
  maxNumHands: 2, // 両手操作に対応するため2つまで検出する
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
});
hands.onResults(onResults);

btnStart.addEventListener('click', async () => {
  statusEl.textContent = 'カメラを起動中…(許可ダイアログが出たら「許可」を押してください)';
  btnStart.disabled = true;
  try {
    camera = new window.Camera(videoEl, {
      onFrame: async () => {
        await hands.send({ image: videoEl });
      },
      width: 640,
      height: 480,
    });
    await camera.start();
    btnStop.disabled = false;
    statusEl.textContent = 'カメラに手をかざしてください';
  } catch (err) {
    statusEl.textContent = 'カメラを開始できませんでした: ' + err.message;
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', () => {
  if (camera) camera.stop();
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnCalibrate.disabled = true;
  handsDetected = false;
  handMode = 'none';
  updateGripHands();
  statusEl.textContent = 'カメラは停止中です';
});

btnCalibrate.addEventListener('click', () => {
  if (handMode === 'none') return;
  // 今使っているモード(片手/両手)の基準だけを更新する
  if (handMode === 'two') calibrationOffset.two = lastRawAngle;
  else calibrationOffset.one = lastRawAngle;
  saveSettings();
  Sound.play('chime');
  statusEl.textContent = (handMode === 'two' ? '両手' : '片手') + 'の基準を合わせました';
});

// ------------------------------------------------------------
// 音のON/OFF
// ------------------------------------------------------------
function applySound(on) {
  soundEnabled = on;
  Sound.setEnabled(on);
  btnSound.textContent = on ? '♪ 音 ON' : '♪ 音 OFF';
  btnSound.setAttribute('aria-pressed', String(on));
  saveSettings();
}

btnSound.addEventListener('click', () => applySound(!soundEnabled));

// ブラウザは利用者が操作するまで音を鳴らせない決まりなので、
// どのボタンでも最初のクリックで音の準備をする。あわせてボタン音も鳴らす。
document.addEventListener('click', (e) => {
  Sound.init();
  if (e.target.closest('.btn') && e.target.closest('#btn-sound') === null) {
    Sound.play('blip');
  }
});

// ------------------------------------------------------------
// キーボード操作(カメラが使えないときの予備)
// ------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { keyDir = -1; e.preventDefault(); }
  if (e.key === 'ArrowRight') { keyDir = 1; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' && keyDir === -1) keyDir = 0;
  if (e.key === 'ArrowRight' && keyDir === 1) keyDir = 0;
});

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------
applySound(soundEnabled); // 前回の音のON/OFFを復元
RudderGame.init(document.getElementById('game-canvas'));
requestAnimationFrame(frame);
