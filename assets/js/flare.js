/* ==========================================================================
   かたわれ時 — 开场的流星（只做“真实的流星”，当加载进度条用）
   真实的流星没有衍射星芒，是这样的：
     · 头：很小的白热核心，周围是一团向后拉长的彗发（点扩散函数的长尾，不是高斯）
     · 炽热的尾迹：亮度从头往后指数衰减，颜色随冷却由白热 → 蓝白 → 深蓝
     · 周围的天空被它照亮一点点
     · 烧蚀的碎屑：细小的火花从头部脱落，留在原地渐渐熄灭（所以天空里会留下一串点点光）
     · 偶尔一下短促的“爆闪”（真实流星的闪光），平时有极轻微的闪烁
   实现：全部预渲染成精灵（Moffat 轮廓），每帧只做几百次 drawImage；画布不透明（黑底）+ CSS mix-blend-mode: screen，
   等同于 img + L·(1 − img)——只加光、不压暗海报；分辨率按帧耗时自动降档。
   使用：const f = KataFlare(canvas, samples, [vbW, vbH], {W, H, dpr}); f.frame(now, v, rect); f.arrive(); f.resize(W, H, dpr);
     samples：路径上等弧长的采样点（SVG 坐标）；v：进度 0~1；rect：海报框的屏幕矩形（随 CSS 缩放实时变化）
   首选在 Web Worker 里画（OffscreenCanvas）：开场这几秒正是页面最忙的时候（脚本、字体、首屏大图、文章数据），
   流星不和它们抢主线程；主线程每帧只发来进度和海报框的矩形。
   Worker 消息：init {canvas, samples, vb, view, v, rect} · st {v, rect} · resize {view} · arrive · stop
   ========================================================================== */
(function (G) {
  "use strict";
  const mk = (n) => { if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(n, n); const c = document.createElement("canvas"); c.width = c.height = n; return c; };
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sm = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* 精灵：size×size，半径 1 处衰减到 0。profile(r) 返回亮度（0~1），color(r) 返回 [R,G,B]（0~1）
     Moffat 轮廓 (1 + (r/a)²)^−β：中心很尖、翼很长，像真实相机里的点光源 */
  function sprite(size, a, beta, col0, col1, tint) {
    const c = mk(size);
    const g = c.getContext("2d"), im = g.createImageData(size, size), h = size / 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - h, y + 0.5 - h) / h;
      const I = Math.pow(1 + (r / a) * (r / a), -beta) * (1 - sm((r - 0.55) / 0.45));
      const t = sm(r / tint);
      const o = (y * size + x) * 4;
      im.data[o] = 255 * I * (col0[0] + (col1[0] - col0[0]) * t);
      im.data[o + 1] = 255 * I * (col0[1] + (col1[1] - col0[1]) * t);
      im.data[o + 2] = 255 * I * (col0[2] + (col1[2] - col0[2]) * t);
      im.data[o + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  }

  G.KataFlare = function (canvas, samples, vb, view) {
    const ctx = canvas.getContext("2d", { alpha: false });
    const N = samples.length - 1, VW = vb[0], VH = vb[1];
    let Lsvg = 0;                                         // 每个采样间隔的 SVG 长度
    for (let i = 0; i < N; i++) Lsvg += Math.hypot(samples[i + 1][0] - samples[i][0], samples[i + 1][1] - samples[i][1]);
    Lsvg /= N;

    // ---- 精灵（一次性生成，约 3ms）----
    const HOT = sprite(96, 0.055, 1.35, [1, 1, 1], [0.66, 0.84, 1], 0.5);        // 白热核心：尖、长翼，翼偏蓝
    const COOL = sprite(96, 0.22, 2.0, [0.5, 0.74, 1], [0.28, 0.46, 0.98], 0.7);  // 彗发 / 尾迹冷端 / 天空光：柔、蓝
    const DOT = sprite(16, 0.28, 2.2, [1, 1, 1], [1, 1, 1], 1);                   // 火花
    const DOTW = sprite(16, 0.28, 2.2, [1, 0.8, 0.52], [1, 0.8, 0.52], 1);        // 偏暖的火花（烧蚀的碎屑有的发橙）

    // 抖动颗粒：8 位画布上的柔和渐变会出现一圈圈的色带；在辉光范围内再加 0~2 个色阶的随机噪点（每帧换位置），把色带的边界打散
    const noise = mk(128);
    {
      const g = noise.getContext("2d"), im = g.createImageData(128, 128);
      for (let i = 0; i < 128 * 128; i++) { const r = Math.random(), v = r < 0.5 ? 0 : r < 0.85 ? 1 : 2; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
      g.putImageData(im, 0, 0);
    }
    let noisePat = null;

    // ---- 画布与自适应分辨率 ----
    let W = 0, H = 0, q = 1, quality = 1, dtAvg = 16, slow = 0;
    function resize() {
      W = view.W; H = view.H;
      q = Math.min(view.dpr || 1, 1.5) * quality;
      canvas.width = Math.max(2, Math.round(W * q)); canvas.height = Math.max(2, Math.round(H * q));
      ctx.setTransform(q, 0, 0, q, 0, 0);
      noisePat = ctx.createPattern(noise, "repeat");
    }
    resize();

    // ---- 状态 ----
    let last = performance.now(), prevX = 0, prevY = 0, speed = 0, havePrev = false;
    let nextFlare = performance.now() + rnd(500, 1100), flareAt = -1e9, flareAmp = 1;
    let arriveAt = 0;
    const MAXP = 72;
    const P = { x: new Float32Array(MAXP), y: new Float32Array(MAXP), vx: new Float32Array(MAXP), vy: new Float32Array(MAXP),
      age: new Float32Array(MAXP), life: new Float32Array(MAXP), size: new Float32Array(MAXP), warm: new Float32Array(MAXP), ph: new Float32Array(MAXP) };
    let np = 0;
    function spawn(x, y, vx, vy, s, life) {
      if (np >= MAXP) return;
      const i = np++;
      P.x[i] = x; P.y[i] = y; P.vx[i] = vx; P.vy[i] = vy; P.age[i] = 0; P.life[i] = life;
      P.size[i] = rnd(0.7, 1.7) * s; P.warm[i] = Math.random() < 0.28 ? 1 : 0; P.ph[i] = rnd(0, 6.28);
    }

    const at = (f) => {                                    // 路径上第 f 个采样点（线性插值），SVG 坐标
      f = clamp(f, 0, N);
      const i = Math.min(N - 1, Math.floor(f)), u = f - i, a = samples[i], b = samples[i + 1];
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };
    const draw = (spr, x, y, R, alpha) => { ctx.globalAlpha = alpha; ctx.drawImage(spr, x - R, y - R, R * 2, R * 2); };

    return {
      frame(now, v, rect) {
        const dt = clamp((now - last) / 1000, 0.001, 0.05); last = now;
        // 自适应分辨率：连续偏慢就降一档（光是柔的，降到 0.55 倍也看不出）
        dtAvg += (dt * 1000 - dtAvg) * 0.08;
        if (dtAvg > 22 && quality > 0.56) { if (++slow > 20) { quality *= 0.85; slow = 0; resize(); } } else slow = 0;

        const kx = rect.width / VW, ky = rect.height / VH, s = rect.width / 1600;
        const X = (p) => rect.left + p[0] * kx, Y = (p) => rect.top + p[1] * ky;
        const f = clamp(v, 0, 1) * N;
        const hp = at(f), hx = X(hp), hy = Y(hp);
        const bp = at(f - 4), dx0 = hx - X(bp), dy0 = hy - Y(bp), dl = Math.hypot(dx0, dy0) || 1;
        const dx = dx0 / dl, dy = dy0 / dl, ang = Math.atan2(dy, dx);      // 运动方向（单位向量）
        if (havePrev) speed += (Math.hypot(hx - prevX, hy - prevY) / dt - speed) * 0.15;
        prevX = hx; prevY = hy; havePrev = true;

        // 到达：核心一亮、彗发胀开，然后慢慢熄灭（不放焰火）
        const ta = arriveAt ? (now - arriveAt) / 1000 : -1;
        const boost = ta >= 0 ? Math.sin(Math.min(1, ta / 0.2) * Math.PI / 2) * Math.exp(-ta / 0.75) : 0;
        const presence = ta >= 0 ? 1 - sm((ta - 0.55) / 0.9) : 1;
        if (presence <= 0.003) { ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); return; }

        // 闪烁：极轻的大气闪烁 + 偶尔一次短促的爆闪（真实流星的 flare）
        if (now > nextFlare && ta < 0) {
          flareAt = now; flareAmp = rnd(0.55, 1.0); nextFlare = now + rnd(900, 2200);
          for (let i = 0; i < 6; i++) spawn(hx, hy, -dx * rnd(20, 90) * s + rnd(-40, 40) * s, -dy * rnd(20, 90) * s + rnd(-40, 40) * s, s, rnd(0.35, 0.8));
        }
        const fe = (now - flareAt) / 1000, flareEnv = fe < 0 ? 0 : (fe < 0.04 ? fe / 0.04 : Math.exp(-(fe - 0.04) / 0.16)) * flareAmp;
        const scint = 0.93 + 0.07 * Math.sin(now * 0.037) * Math.sin(now * 0.0123 + 1.7);
        const lum = (scint + 0.55 * flareEnv + 1.1 * boost) * presence;

        // 烧蚀火花：从头部脱落，留在原地（随速度出的多一点）
        if (ta < 0) {
          const rate = 26 + Math.min(40, speed / (14 * s + 1));
          let n = rate * dt + Math.random();
          while (n-- >= 1) {
            const back = rnd(8, 70) * s;
            spawn(hx + rnd(-1.5, 1.5) * s, hy + rnd(-1.5, 1.5) * s, -dx * back + (-dy) * rnd(-16, 16) * s, -dy * back + dx * rnd(-16, 16) * s, s, rnd(0.45, 1.1));
          }
        } else if (ta < 0.05 && np < MAXP - 24) {                       // 到达的一瞬：沿运动方向冲出一小撮火花
          for (let i = 0; i < 22; i++) { const a = ang + rnd(-0.9, 0.9), sp = rnd(40, 200) * s; spawn(hx, hy, Math.cos(a) * sp, Math.sin(a) * sp, s, rnd(0.5, 1.2)); }
        }

        // ---- 绘制（全部加光） ----
        ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "lighter";

        // ① 被照亮的天空（很淡很大）
        draw(COOL, hx, hy, 240 * s * (1 + 0.5 * boost), 0.11 * lum);

        // ② 炽热的尾迹：沿真实路径往回盖章，亮度指数衰减，颜色由白热渐变为蓝
        const lam = 52 * s * (1 + 0.35 * boost), dmax = lam * 4.2, spacing = Math.max(2.2, 2.4 * s);
        const stepPx = Lsvg * (kx + ky) / 2;                                    // 每个采样间隔对应的屏幕像素
        for (let d = spacing; d < dmax; d += spacing) {
          const fi = f - d / stepPx;
          if (fi < 0) break;
          const p = at(fi), w = Math.exp(-d / lam), x = X(p), y = Y(p);
          const R = (2.6 + 8.5 * w) * s;
          draw(COOL, x, y, R * 2.4, 0.09 * w * lum);
          draw(HOT, x, y, R, 0.27 * w * w * lum);
        }

        // ③ 头：彗发（沿运动方向拉长，偏后）→ 核心 → 白热中心
        const stretch = 1 + Math.min(1.1, speed / (700 * s + 1));
        ctx.save();
        ctx.translate(hx - dx * 7 * s, hy - dy * 7 * s); ctx.rotate(ang);
        ctx.scale(stretch * 1.9, 0.85);
        ctx.globalAlpha = 0.78 * lum; ctx.drawImage(COOL, -17 * s * (1 + 0.8 * boost), -17 * s * (1 + 0.8 * boost), 34 * s * (1 + 0.8 * boost), 34 * s * (1 + 0.8 * boost));
        ctx.restore();
        draw(COOL, hx, hy, 72 * s * (1 + 1.1 * boost), 0.42 * lum);                     // 外晕
        draw(HOT, hx, hy, 18 * s * (1 + 0.5 * boost), Math.min(1, 1.0 * lum));         // 核心
        draw(HOT, hx, hy, 6.5 * s, Math.min(1, 1.0 * lum));                              // 白热中心（叠两次，中心过曝成白）

        // ④ 火花
        for (let i = np - 1; i >= 0; i--) {
          P.age[i] += dt;
          if (P.age[i] >= P.life[i]) { np--; for (const k in P) P[k][i] = P[k][np]; continue; }
          const dr = Math.exp(-1.7 * dt);
          P.vx[i] *= dr; P.vy[i] *= dr; P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt + 5 * s * dt;
          const u = P.age[i] / P.life[i], a = Math.pow(1 - u, 1.6) * (0.65 + 0.35 * Math.sin(now * 0.02 + P.ph[i])) * presence;
          const R = P.size[i] * (1.6 - 0.7 * u) * 1.6;
          if (P.warm[i]) draw(DOTW, P.x[i], P.y[i], R * 1.15, a * 0.8); else draw(DOT, P.x[i], P.y[i], R, a * 0.9);
        }
        // ⑤ 抖动（只在辉光的范围内；图案偏移每帧换一次，颗粒是活的）
        if (noisePat) {
          const r = 250 * s * (1 + 0.5 * boost);
          if (noisePat.setTransform && typeof DOMMatrix !== "undefined") noisePat.setTransform(new DOMMatrix().translate((Math.random() * 128) | 0, (Math.random() * 128) | 0));
          ctx.fillStyle = noisePat; ctx.globalAlpha = 1;
          ctx.fillRect(hx - r, hy - r, 2 * r, 2 * r);
        }
        ctx.globalAlpha = 1;
      },
      arrive() { arriveAt = performance.now(); },
      resize(w, h, dpr) { view = { W: w, H: h, dpr }; resize(); },
    };
  };

  /* ---------- Worker 模式：自己按帧画，主线程的进度 / 矩形一到就用最新的 ---------- */
  if (typeof document !== "undefined" || typeof G.postMessage !== "function") return;
  const raf = G.requestAnimationFrame ? (f) => G.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
  let fx = null, v = 0, rect = null, run = false;
  const loop = (now) => { if (!run) return; fx.frame(now, v, rect); raf(loop); };
  G.onmessage = (e) => {
    const m = e.data;
    if (m.type === "init") { fx = G.KataFlare(m.canvas, m.samples, m.vb, m.view); v = m.v; rect = m.rect; run = true; raf(loop); }
    else if (!fx) return;
    else if (m.type === "st") { v = m.v; rect = m.rect; }
    else if (m.type === "resize") fx.resize(m.view.W, m.view.H, m.view.dpr);
    else if (m.type === "arrive") fx.arrive();
    else if (m.type === "stop") { run = false; G.close(); }
  };
})(self);
