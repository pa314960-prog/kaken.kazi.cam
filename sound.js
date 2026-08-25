// ============================================================
// 音まわり
//
// 音声ファイルは一切使わず、すべてブラウザの Web Audio API で
// その場で合成しています。理由:
//   - mp3などを置くとリポジトリが重くなり、読み込みも遅くなる
//   - 「ファイルを置くだけでどのPCでも動く」という方針を保てる
//
// 使い方:
//   Sound.init()            … 最初のクリック時に呼ぶ(音を鳴らす許可はクリックが必要)
//   Sound.play('crash')     … 効果音を鳴らす
//   Sound.setIntensity(0.5) … 船の速さに応じて波と低音の迫力を変える(0〜1)
//   Sound.setEnabled(false) … 消音
//
// 音量を変えたい場合は、下の VOLUME を書き換えてください。
// ============================================================

const VOLUME = {
  master: 0.85,
  waves: 0.16,   // 波の音
  wind: 0.035,   // 風の音
  droneMax: 0.075, // 速く進んでいるときの低いうなり
  horn: 0.32,    // 汽笛
  crash: 0.45,   // 衝突
  dodge: 0.16,   // 岩をよけたときの風切り音
  chime: 0.18,   // 基準合わせのチャイム
  blip: 0.11,    // ボタンの音
};

const Sound = (function () {
  'use strict';

  let ctx = null;
  let master = null;
  let ambience = null;
  let noiseBuffer = null;
  let enabled = true;

  // --- 下ごしらえ ---------------------------------------------------------

  function makeNoiseBuffer() {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function noiseSource(loop) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = !!loop;
    return src;
  }

  // ゆっくりした揺らぎ(波のうねりや風の強弱)を作る
  function addLfo(rate, depth, targetParam) {
    const osc = ctx.createOscillator();
    osc.frequency.value = rate;
    const amp = ctx.createGain();
    amp.gain.value = depth;
    osc.connect(amp);
    amp.connect(targetParam);
    osc.start();
  }

  // 波・風・低いうなりを、止めずに鳴らし続ける
  function buildAmbience() {
    // 波: ホワイトノイズの低い成分だけを通す
    const waves = noiseSource(true);
    const wavesFilter = ctx.createBiquadFilter();
    wavesFilter.type = 'lowpass';
    wavesFilter.frequency.value = 420;
    const wavesGain = ctx.createGain();
    wavesGain.gain.value = VOLUME.waves;
    waves.connect(wavesFilter).connect(wavesGain).connect(master);
    addLfo(0.09, VOLUME.waves * 0.45, wavesGain.gain);   // うねり
    addLfo(0.05, 260, wavesFilter.frequency);            // 明るさの揺らぎ
    waves.start();

    // 風: 少し高い帯域を細く通す
    const wind = noiseSource(true);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 900;
    windFilter.Q.value = 0.8;
    const windGain = ctx.createGain();
    windGain.gain.value = VOLUME.wind;
    wind.connect(windFilter).connect(windGain).connect(master);
    addLfo(0.13, VOLUME.wind * 0.6, windGain.gain);
    wind.start();

    // 低いうなり: 速く進んでいるときだけ強くする(setIntensityで操作)
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 220;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    [55, 55.6, 82.5].forEach(function (f) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(droneFilter);
      o.start();
    });
    droneFilter.connect(droneGain).connect(master);

    ambience = { wavesGain: wavesGain, wavesFilter: wavesFilter, droneGain: droneGain };
  }

  // --- 初期化 -------------------------------------------------------------

  // ブラウザは「利用者が操作するまで音を鳴らしてはいけない」決まりなので、
  // 最初のクリックのときにこれを呼ぶ。2回目以降は何もしない(止まっていれば再開する)。
  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // 対応していないブラウザでは、音なしで普通に遊べる
    ctx = new AC();
    noiseBuffer = makeNoiseBuffer();
    master = ctx.createGain();
    master.gain.value = enabled ? VOLUME.master : 0;

    // 波・汽笛・衝突音などが同時に鳴っても音割れしないよう、
    // 出口に軽いリミッターを入れておく
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter).connect(ctx.destination);
    buildAmbience();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!ctx) return;
    master.gain.setTargetAtTime(enabled ? VOLUME.master : 0, ctx.currentTime, 0.05);
    if (enabled && ctx.state === 'suspended') ctx.resume();
  }

  function isEnabled() { return enabled; }

  // 船の速さ(0〜1)に応じて、波の迫力と低いうなりを変える
  function setIntensity(t) {
    if (!ctx || !ambience) return;
    const k = Math.max(0, Math.min(1, t));
    const now = ctx.currentTime;
    ambience.droneGain.gain.setTargetAtTime(0.015 + k * VOLUME.droneMax, now, 0.6);
    ambience.wavesFilter.frequency.setTargetAtTime(380 + k * 680, now, 0.8);
  }

  // --- 効果音 -------------------------------------------------------------

  function ready() { return ctx && enabled; }

  // 汽笛(ゲーム開始)
  function horn() {
    const t = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(VOLUME.horn, t + 0.18);
    gain.gain.setValueAtTime(VOLUME.horn, t + 0.8);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    filter.connect(gain).connect(master);
    [110, 164.8, 220].forEach(function (f, i) {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'sine' : 'sawtooth';
      o.frequency.value = f;
      o.connect(filter);
      o.start(t);
      o.stop(t + 1.6);
    });
  }

  // 衝突(岩が砕ける音 + 船体に響く衝撃)
  function crash() {
    const t = ctx.currentTime;

    const n = noiseSource(false);
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.setValueAtTime(2400, t);
    nf.frequency.exponentialRampToValueAtTime(180, t + 0.5);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(VOLUME.crash, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    n.connect(nf).connect(ng).connect(master);
    n.start(t);
    n.stop(t + 0.7);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    const og = ctx.createGain();
    og.gain.setValueAtTime(VOLUME.crash, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(og).connect(master);
    o.start(t);
    o.stop(t + 0.6);
  }

  // 岩が横を通り過ぎるときの風切り音
  function dodge() {
    const t = ctx.currentTime;
    const n = noiseSource(false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(1400, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(VOLUME.dodge, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    n.connect(bp).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.35);
  }

  // 座礁(下がっていく汽笛)
  function gameover() {
    const t = ctx.currentTime;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
    f.connect(g).connect(master);
    [196, 98].forEach(function (start) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(start, t);
      o.frequency.exponentialRampToValueAtTime(start * 0.3, t + 1.6);
      o.connect(f);
      o.start(t);
      o.stop(t + 2);
    });
  }

  // 基準合わせが終わったときの、魔法らしいチャイム
  function chime() {
    const t = ctx.currentTime;
    [880, 1108.7, 1318.5].forEach(function (f, i) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      const st = t + i * 0.06;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(VOLUME.chime, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 1.1);
      o.connect(g).connect(master);
      o.start(st);
      o.stop(st + 1.2);
    });
  }

  // 手を見つけたときの小さな合図
  function handOn() {
    const t = ctx.currentTime;
    [659.3, 987.8].forEach(function (f, i) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      const st = t + i * 0.07;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.1, st + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.22);
      o.connect(g).connect(master);
      o.start(st);
      o.stop(st + 0.25);
    });
  }

  // ボタンを押したときの音
  function blip() {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 520;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(VOLUME.blip, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.1);
  }

  const EFFECTS = {
    horn: horn,
    crash: crash,
    dodge: dodge,
    gameover: gameover,
    chime: chime,
    handOn: handOn,
    blip: blip,
  };

  function play(name) {
    if (!ready()) return;
    const fn = EFFECTS[name];
    if (fn) fn();
  }

  // 別のタブを見ている間は音を止める
  document.addEventListener('visibilitychange', function () {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (enabled) ctx.resume();
  });

  return {
    init: init,
    play: play,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    setIntensity: setIntensity,
  };
})();
