// ============================================================
// カメラの手ジェスチャーで舵(rudder)を動かすスクリプト
//
// 仕組み:
//   1. MediaPipe Hands がカメラ映像から手の21個の点(ランドマーク)を検出する
//   2. 手首(landmark 0)と中指の付け根(landmark 9)を結ぶ線の「傾き角度」を計算する
//   3. その角度を舵の角度に変換して、画面のSVGを回転させる
//
// 数値をいじって挙動を変えたい場合は、下の CONFIG を編集してください。
// ============================================================

const CONFIG = {
  smoothingAlpha: 0.2, // 数値を大きくすると反応が速く/カクつきやすくなる。小さくすると滑らかだが遅くなる。
};

const videoEl = document.getElementById('input-video');
const canvasEl = document.getElementById('overlay-canvas');
const canvasCtx = canvasEl.getContext('2d');
const statusEl = document.getElementById('status');
const angleValueEl = document.getElementById('angle-value');
const rudderPivot = document.getElementById('rudder-pivot');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnCalibrate = document.getElementById('btn-calibrate');

const sensitivityInput = document.getElementById('sensitivity');
const sensitivityValueEl = document.getElementById('sensitivity-value');
const maxAngleInput = document.getElementById('max-angle');
const maxAngleValueEl = document.getElementById('max-angle-value');
const mirrorToggle = document.getElementById('mirror-toggle');

let sensitivity = parseFloat(sensitivityInput.value);
let maxAngle = parseFloat(maxAngleInput.value);
let mirror = mirrorToggle.checked;
let calibrationOffset = 0; // 基準にした時の生の角度を引いておく
let smoothedAngle = 0;
let camera = null;
let handsDetected = false;

// --- 設定を localStorage に保存して、次回このPCで開いたときにも覚えておく ---
const STORAGE_KEY = 'kaken-kazi-cam-settings';
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (typeof saved.sensitivity === 'number') sensitivity = saved.sensitivity;
    if (typeof saved.maxAngle === 'number') maxAngle = saved.maxAngle;
    if (typeof saved.mirror === 'boolean') mirror = saved.mirror;
    if (typeof saved.calibrationOffset === 'number') calibrationOffset = saved.calibrationOffset;
  } catch (e) { /* 保存データが無ければ何もしない */ }
  sensitivityInput.value = sensitivity;
  sensitivityValueEl.textContent = sensitivity.toFixed(1);
  maxAngleInput.value = maxAngle;
  maxAngleValueEl.textContent = maxAngle;
  mirrorToggle.checked = mirror;
}
function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sensitivity, maxAngle, mirror, calibrationOffset }));
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

// --- 手の傾き角度を計算する ---
// 手首(0)から中指の付け根(9)への向きを使う。まっすぐ上向きが0度。
let lastRawAngle = 0;
function computeHandAngleDeg(landmarks) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  let dx = middleMcp.x - wrist.x;
  const dy = middleMcp.y - wrist.y;
  if (mirror) dx = -dx;
  return Math.atan2(dx, -dy) * (180 / Math.PI);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function onResults(results) {
  canvasEl.width = results.image.width;
  canvasEl.height = results.image.height;

  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  canvasCtx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const landmarks = results.multiHandLandmarks[0];
    window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, { color: '#4f9dd9', lineWidth: 3 });
    window.drawLandmarks(canvasCtx, landmarks, { color: '#ffffff', radius: 3 });

    lastRawAngle = computeHandAngleDeg(landmarks);
    handsDetected = true;
    btnCalibrate.disabled = false;
    statusEl.textContent = '手を検出中';
  } else {
    handsDetected = false;
    btnCalibrate.disabled = true;
    statusEl.textContent = '手が見つかりません。カメラに手を映してください';
  }
  canvasCtx.restore();

  updateRudder();
}

function updateRudder() {
  const targetAngle = handsDetected
    ? clamp((lastRawAngle - calibrationOffset) * sensitivity, -maxAngle, maxAngle)
    : smoothedAngle * (1 - CONFIG.smoothingAlpha); // 手が見えない間はゆっくり中心に戻す

  smoothedAngle += (targetAngle - smoothedAngle) * CONFIG.smoothingAlpha;

  rudderPivot.setAttribute('transform', `translate(0,100) rotate(${smoothedAngle.toFixed(2)})`);
  angleValueEl.textContent = smoothedAngle.toFixed(1);
}

// --- カメラの開始・停止 ---
const hands = new window.Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});
hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
});
hands.onResults(onResults);

btnStart.addEventListener('click', async () => {
  statusEl.textContent = 'カメラを起動しています…(ブラウザの許可ダイアログが出たら「許可」を押してください)';
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
    statusEl.textContent = '手が見つかりません。カメラに手を映してください';
  } catch (err) {
    statusEl.textContent = 'カメラを開始できませんでした: ' + err.message;
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', () => {
  if (camera) {
    camera.stop();
  }
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnCalibrate.disabled = true;
  handsDetected = false;
  statusEl.textContent = '「カメラ開始」を押してください';
});

btnCalibrate.addEventListener('click', () => {
  calibrationOffset = lastRawAngle;
  saveSettings();
  statusEl.textContent = '今の手の向きを基準(0°)にしました';
});
