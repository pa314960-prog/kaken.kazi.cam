// ============================================================
// 「大海原を操れ！魔法の操舵輪」ゲーム本体
//
// 役割分担:
//   main.js … カメラと手の検出をして「舵角」を決める
//   game.js … その舵角を受け取って、船を動かし、海と岩を描く(このファイル)
//
// 仕組み:
//   船は常に前進していて、正面から岩が近づいてくる。
//   舵を切ると船の向き(heading)がゆっくり変わり、その分だけ横にずれていく。
//   岩の位置は「奥行き z」と「左右 x」で持っていて、画面に描くときに
//   遠近法(遠いものほど小さく、水平線に近く)で計算している。
//
// 難易度や操作感を変えたい場合は、下の GAME_CONFIG の数値を書き換えてください。
// ============================================================

// 難易度によらず共通の設定
const GAME_CONFIG = {
  // --- 見え方 ---
  focal: 560,           // 遠近の強さ。大きいほど望遠レンズのような見え方になる
  cameraHeight: 2.8,    // 視点の高さ(海面から何メートル上か)
  horizonRatio: 0.44,   // 画面の上から何割の位置に水平線を置くか

  // --- 岩の出方 ---
  spawnDistance: 160,   // 岩が現れる距離(メートル先)

  // --- 船の動き ---
  maxHeading: 0.28,     // 舵をいっぱいに切ったときの船の向き(ラジアン)。大きいと曲がりが急になる
  hullHalfWidth: 1.4,   // 当たり判定に使う船の半分の幅
  invincibleTime: 1.8,  // ぶつかった直後の無敵時間(秒)
};

// 難易度ごとの設定。ここの数値を変えると、そのまま難しさが変わります。
const DIFFICULTY_PRESETS = {
  easy: {
    label: 'やさしい',
    startSpeed: 10,       // 開始時の速さ(m/秒)
    speedGain: 0.18,      // 1秒あたりどれだけ速くなるか
    maxSpeed: 26,         // 速さの上限
    spawnInterval: 1.75,  // 岩が出てくる間隔(秒)
    spawnIntervalMin: 0.85, // 一番難しくなったときの間隔
    hardenTime: 100,      // 何秒かけて最高難易度まで上げるか
    laneHalfWidth: 7.0,   // 航路の広さ(中央から左右それぞれ何メートルまで動けるか)
    headingLag: 0.075,    // 舵への反応の速さ。大きいほど軽快に曲がる
    maxHp: 5,             // 岩に何回ぶつかったら終わりか
  },
  normal: {
    label: 'ふつう',
    startSpeed: 13,
    speedGain: 0.32,
    maxSpeed: 40,
    spawnInterval: 1.25,
    spawnIntervalMin: 0.45,
    hardenTime: 75,
    laneHalfWidth: 6.2,
    headingLag: 0.06,
    maxHp: 3,
  },
  hard: {
    label: 'むずかしい',
    startSpeed: 17,
    speedGain: 0.5,
    maxSpeed: 52,
    spawnInterval: 0.95,
    spawnIntervalMin: 0.32,
    hardenTime: 55,
    laneHalfWidth: 5.4,
    headingLag: 0.05,
    maxHp: 2,
  },
};

const RudderGame = (function () {
  'use strict';

  // 共通設定 + 選ばれた難易度の設定を合わせたもの。setDifficulty() で作り直す。
  let difficultyKey = 'normal';
  let C = Object.assign({}, GAME_CONFIG, DIFFICULTY_PRESETS.normal);

  const BUOY_COUNT = 8;      // 航路の端に浮かべる目印の数
  const BUOY_SPACING = 22;   // 目印どうしの間隔(メートル)

  let canvas = null;
  let ctx = null;
  let W = 0, H = 0, cx = 0, horizonY = 0;

  let state = 'ready';       // 'ready'(待機) | 'playing'(プレイ中) | 'over'(終了)
  let rocks = [];
  let buoys = [];

  let shipX = 0;             // 船の左右位置(メートル)
  let heading = 0;           // 船の向き(ラジアン)
  let speed = 0;             // 前進の速さ(m/秒)
  let distance = 0;          // 走った距離(メートル)
  let dodged = 0;            // 避けた岩の数
  let hp = C.maxHp;

  let elapsed = 0;           // 経過時間(演出と難易度に使う)
  let spawnTimer = 0;
  let waveScroll = 0;
  let invincible = 0;
  let shake = 0;             // 衝突時の画面のゆれ
  let flash = 0;             // 衝突時の赤い明滅

  const listeners = {};

  function on(name, fn) {
    (listeners[name] || (listeners[name] = [])).push(fn);
  }
  function emit(name, payload) {
    (listeners[name] || []).forEach(function (fn) { fn(payload); });
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // ------------------------------------------------------------
  // 初期化とサイズ合わせ
  // ------------------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2;
    horizonY = H * C.horizonRatio;
  }

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    resetRun();
  }

  function resetRun() {
    rocks = [];
    buoys = [];
    for (let i = 0; i < BUOY_COUNT; i++) buoys.push(6 + i * BUOY_SPACING);
    shipX = 0;
    heading = 0;
    speed = C.startSpeed;
    distance = 0;
    dodged = 0;
    hp = C.maxHp;
    elapsed = 0;
    spawnTimer = 1.0;
    invincible = 0;
    shake = 0;
    flash = 0;
  }

  // 難易度を切り替える。'easy' | 'normal' | 'hard'
  function setDifficulty(key) {
    if (!DIFFICULTY_PRESETS[key]) return;
    difficultyKey = key;
    C = Object.assign({}, GAME_CONFIG, DIFFICULTY_PRESETS[key]);
    resetRun();
  }

  function start() {
    resetRun();
    // 開始直後に何も起きない時間が続かないよう、あらかじめ岩を撒いておく
    // (これが無いと、最初の岩が届くまで10秒以上かかってしまう)
    for (let z = 46; z <= C.spawnDistance; z += 26) {
      const r = 0.9 + Math.random() * 1.0;
      const x = (Math.random() * 2 - 1) * (C.laneHalfWidth - r * 0.4);
      rocks.push(makeRock(x, z, r));
    }
    state = 'playing';
    emit('change', getStats());
  }

  // ------------------------------------------------------------
  // 岩を作る
  // ------------------------------------------------------------
  function makeRock(x, z, r) {
    // でこぼこした岩の形を、その岩ごとに一度だけ作っておく。
    // 半径を「前の頂点から少しずつずらす」ことで、星形にならず自然な岩肌になる。
    const n = 10 + Math.floor(Math.random() * 4);
    const verts = [];
    let rad = 0.85;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      rad = clamp(rad + (Math.random() - 0.5) * 0.34, 0.6, 1.05);
      verts.push([Math.cos(a) * rad, Math.sin(a) * rad * 0.9]);
    }
    return { x: x, z: z, r: r, verts: verts, tilt: (Math.random() - 0.5) * 0.5, resolved: false };
  }

  function spawnWave() {
    const hard = Math.min(1, elapsed / C.hardenTime); // 0(やさしい) → 1(むずかしい)
    const count = Math.random() < 0.22 + hard * 0.42 ? 2 : 1;
    // 岩どうしの間には、必ず船が通れるだけの隙間を空ける
    const gapNeeded = C.hullHalfWidth * 2 + 2.6;
    const placed = [];

    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 14; attempt++) {
        const r = 0.9 + Math.random() * (1.0 + hard * 0.8);
        const x = (Math.random() * 2 - 1) * (C.laneHalfWidth - r * 0.4);
        const ok = placed.every(function (p) {
          return Math.abs(p.x - x) > p.r + r + gapNeeded;
        });
        if (ok) { placed.push({ x: x, r: r }); break; }
      }
    }
    placed.forEach(function (p) {
      rocks.push(makeRock(p.x, C.spawnDistance, p.r));
    });
  }

  // ------------------------------------------------------------
  // 毎フレームの計算
  //   dt         … 前のフレームからの経過秒数
  //   rudderNorm … 舵の切り具合。-1(左いっぱい) 〜 0(中央) 〜 1(右いっぱい)
  // ------------------------------------------------------------
  function update(dt, rudderNorm) {
    elapsed += dt;
    speed = Math.min(C.maxSpeed, C.startSpeed + elapsed * C.speedGain);

    // 舵 → 船の向き。すぐには変わらず、じわじわ追従する(船らしい重さ)
    const targetHeading = clamp(rudderNorm, -1, 1) * C.maxHeading;
    heading += (targetHeading - heading) * clamp(C.headingLag * dt * 60, 0, 1);

    // 向いている方向へ横にずれていく
    shipX += Math.sin(heading) * speed * dt;

    // 航路の端では、それ以上外に出ないように止める
    if (shipX > C.laneHalfWidth)  { shipX = C.laneHalfWidth;  heading = Math.min(heading, 0); }
    if (shipX < -C.laneHalfWidth) { shipX = -C.laneHalfWidth; heading = Math.max(heading, 0); }

    distance += speed * dt;

    // 航路の目印(ブイ)を手前に流し、通り過ぎたものは奥へ戻して使い回す
    const buoySpan = BUOY_COUNT * BUOY_SPACING;
    for (let i = 0; i < buoys.length; i++) {
      buoys[i] -= speed * dt;
      if (buoys[i] < 2) buoys[i] += buoySpan;
    }

    // 岩を出す
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnWave();
      const hard = Math.min(1, elapsed / C.hardenTime);
      spawnTimer = C.spawnInterval - (C.spawnInterval - C.spawnIntervalMin) * hard;
    }

    // 岩を手前に近づけて、通り過ぎたところで当たったかどうかを判定する
    for (let i = rocks.length - 1; i >= 0; i--) {
      const rock = rocks[i];
      rock.z -= speed * dt;

      if (!rock.resolved && rock.z <= 1.0) {
        rock.resolved = true;
        if (Math.abs(rock.x - shipX) < rock.r + C.hullHalfWidth) {
          if (invincible <= 0) {
            hp -= 1;
            invincible = C.invincibleTime;
            shake = 1;
            flash = 1;
            emit('hit', getStats());
            if (hp <= 0) {
              state = 'over';
              emit('gameover', getStats());
            }
          }
        } else {
          dodged += 1;
          emit('dodge', getStats());
        }
      }
      if (rock.z < -8) rocks.splice(i, 1);
    }

    invincible = Math.max(0, invincible - dt);
  }

  // 待機中・終了後も海だけは動かしておく(止まった絵にしないため)
  function idle(dt) {
    elapsed += dt;
    speed = state === 'over' ? Math.max(0, speed - dt * 12) : C.startSpeed * 0.5;
    heading += (0 - heading) * clamp(0.04 * dt * 60, 0, 1);
    shake = Math.max(0, shake - dt * 2.2);
  }

  // ------------------------------------------------------------
  // 遠近法の計算
  //   (x, z) の海面上の点が、画面のどこに来るかを求める
  // ------------------------------------------------------------
  function project(x, z) {
    const inv = 1 / Math.max(z, 0.5);
    return {
      sx: cx + ((x - shipX) * inv - heading) * C.focal,
      sy: horizonY + C.cameraHeight * inv * C.focal,
      s: inv * C.focal,
    };
  }

  // ------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------
  function drawSky() {
    const g = ctx.createLinearGradient(0, -H * 0.35, 0, horizonY);
    g.addColorStop(0, '#050e1a');
    g.addColorStop(0.5, '#14304a');
    g.addColorStop(1, '#3d6a8c');
    ctx.fillStyle = g;
    ctx.fillRect(-W, -H, W * 3, horizonY + H);
  }

  function drawSea() {
    const g = ctx.createLinearGradient(0, horizonY, 0, H);
    g.addColorStop(0, '#2a5674');
    g.addColorStop(0.16, '#123048');
    g.addColorStop(1, '#03080f');
    ctx.fillStyle = g;
    ctx.fillRect(-W, horizonY, W * 3, H * 2);
  }

  function drawWaveRows() {
    const span = 200;
    const count = 34;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const raw = (i * (span / count) + waveScroll) % span;
      rows.push((raw + span) % span + 3);
    }
    rows.sort(function (a, b) { return b - a; });

    ctx.lineWidth = 1.2;
    rows.forEach(function (z) {
      const inv = 1 / z;
      const y = horizonY + C.cameraHeight * inv * C.focal;
      if (y > H + 60 || y < horizonY) return;

      const alpha = Math.min(0.30, 0.015 + inv * 2.4);
      const amp = Math.min(16, 0.30 * inv * C.focal);
      ctx.strokeStyle = 'rgba(150,205,240,' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      for (let px = -W * 0.25; px <= W * 1.25; px += 24) {
        const wob = Math.sin(px * 0.011 + z * 0.55 + elapsed * 1.7) * amp;
        if (px <= -W * 0.25) ctx.moveTo(px, y + wob);
        else ctx.lineTo(px, y + wob);
      }
      ctx.stroke();
    });
  }

  function drawBuoys() {
    buoys.forEach(function (z) {
      [-1, 1].forEach(function (side) {
        const p = project(side * C.laneHalfWidth, z);
        if (p.sy < horizonY || p.sy > H + 30) return;
        // 近づきすぎたブイが巨大な光の玉にならないよう、大きさに上限をつける
        const r = clamp(0.32 * p.s, 1.2, 11);
        ctx.globalAlpha = Math.min(0.9, 34 / z) * clamp(z / 7, 0, 1);
        ctx.fillStyle = '#f0c66a';
        ctx.shadowColor = 'rgba(240,198,106,.95)';
        ctx.shadowBlur = r * 3.5;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy - r, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      });
    });
  }

  function drawRocks() {
    const sorted = rocks.slice().sort(function (a, b) { return b.z - a.z; });
    sorted.forEach(function (rock) {
      if (rock.z <= 0.4) return;
      const p = project(rock.x, rock.z);
      const s = rock.r * p.s;
      if (s < 0.7 || p.sy < horizonY - 4) return;

      const alpha = clamp((C.spawnDistance - rock.z) / 45, 0, 1);
      ctx.globalAlpha = alpha;

      // 岩の足元に立つ白波
      ctx.fillStyle = 'rgba(190,225,245,.28)';
      ctx.beginPath();
      ctx.ellipse(p.sx, p.sy, s * 1.4, s * 0.30, 0, 0, Math.PI * 2);
      ctx.fill();

      // 岩本体
      ctx.save();
      ctx.translate(p.sx, p.sy - s * 0.72);
      ctx.rotate(rock.tilt);

      const path = new Path2D();
      rock.verts.forEach(function (v, i) {
        const X = v[0] * s, Y = v[1] * s;
        if (i === 0) path.moveTo(X, Y); else path.lineTo(X, Y);
      });
      path.closePath();

      // 岩の形で切り抜いてから塗ることで、上側だけに光を当てる
      ctx.save();
      ctx.clip(path);
      const g = ctx.createLinearGradient(0, -s, 0, s);
      g.addColorStop(0, '#33445a');
      g.addColorStop(0.55, '#18242f');
      g.addColorStop(1, '#050a11');
      ctx.fillStyle = g;
      ctx.fillRect(-s * 1.3, -s * 1.3, s * 2.6, s * 2.6);

      const hi = ctx.createLinearGradient(-s * 0.5, -s, s * 0.2, s * 0.1);
      hi.addColorStop(0, 'rgba(155,195,230,.42)');
      hi.addColorStop(1, 'rgba(155,195,230,0)');
      ctx.fillStyle = hi;
      ctx.fillRect(-s * 1.3, -s * 1.3, s * 2.6, s * 1.5);
      ctx.restore();

      ctx.strokeStyle = 'rgba(6,12,20,.85)';
      ctx.lineWidth = Math.max(1, s * 0.04);
      ctx.stroke(path);
      ctx.restore();

      ctx.globalAlpha = 1;
    });
  }

  function drawBow() {
    // 自分の船の船首。カメラは船に乗っているので、これは傾けない
    const bowW = W * 0.44;
    const bowH = H * 0.13;

    // 船首が押し分ける引き波
    ctx.fillStyle = 'rgba(200,232,255,.14)';
    ctx.beginPath();
    ctx.moveTo(cx - bowW * 1.25, H);
    ctx.quadraticCurveTo(cx, H - bowH * 1.5, cx + bowW * 1.25, H);
    ctx.closePath();
    ctx.fill();

    const g = ctx.createLinearGradient(0, H - bowH, 0, H);
    g.addColorStop(0, '#122032');
    g.addColorStop(1, '#03080e');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - bowW, H);
    ctx.quadraticCurveTo(cx, H - bowH, cx + bowW, H);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(240,198,106,.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - bowW, H);
    ctx.quadraticCurveTo(cx, H - bowH, cx + bowW, H);
    ctx.stroke();
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();

    // 衝突直後は画面を揺らす
    if (shake > 0) {
      const s = shake * 11;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    // 旋回に合わせて水平線を少し傾ける(バンク)
    ctx.translate(cx, horizonY);
    ctx.rotate(-heading * 0.5);
    ctx.translate(-cx, -horizonY);

    drawSky();
    drawSea();
    drawWaveRows();
    drawBuoys();
    drawRocks();

    ctx.restore();

    // 無敵時間中は船首を点滅させて、ダメージ中だと分かるようにする
    const blink = invincible > 0 && Math.floor(invincible * 10) % 2 === 0;
    ctx.globalAlpha = blink ? 0.45 : 1;
    drawBow();
    ctx.globalAlpha = 1;

    if (flash > 0) {
      ctx.fillStyle = 'rgba(190,45,32,' + (flash * 0.34).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ------------------------------------------------------------
  // 外から呼ばれる入口
  // ------------------------------------------------------------
  function tick(dt, rudderNorm) {
    if (state === 'playing') {
      update(dt, rudderNorm);
    } else {
      idle(dt);
    }
    waveScroll = (waveScroll - speed * dt) % 200;
    shake = Math.max(0, shake - dt * 2.2);
    flash = Math.max(0, flash - dt * 2.2);
    render();
  }

  function getStats() {
    return {
      distance: Math.floor(distance),
      dodged: dodged,
      hp: hp,
      maxHp: C.maxHp,
      speed: speed,
      state: state,
      difficulty: difficultyKey,
    };
  }

  return {
    init: init,
    start: start,
    tick: tick,
    on: on,
    getStats: getStats,
    setDifficulty: setDifficulty,
    getDifficulty: function () { return difficultyKey; },
    getState: function () { return state; },
  };
})();
