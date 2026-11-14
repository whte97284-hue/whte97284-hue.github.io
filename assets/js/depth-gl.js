/* ==========================================================================
   DepthCore — 深度场景的 WebGL 渲染核心（depth.js 的“画笔”）
   · 首选在 Web Worker 里跑（OffscreenCanvas）：建上下文（GPU 进程初始化设备，主线程上会同步卡 30–170ms）、
     编译着色器、解码与上传纹理、每一帧的绘制，全都不在主线程——切换页面、滚动、排版时画面不会互相拖累
   · 不支持 OffscreenCanvas 的浏览器：depth.js 把本文件当普通脚本载入，在主线程用同一套核心
   Worker 消息：add {id, canvas, urls, o, css, dpr, st, vis} · size {id, css, dpr} · st {v:[id,mx,my,sy,reveal,…], idle}
               opt {id, o} · del {id}；回传 {type:"ready", id} / {type:"fail", id, msg}
   ========================================================================== */
(function (G) {
  "use strict";

  const VERT = "attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}";
  const FRAG = `
precision highp float;
varying vec2 v;
uniform sampler2D uImg, uDep;
uniform vec2 uRes, uImgRes, uDir, uCenter;
uniform float uFocus, uZoom, uReveal, uTime, uHaze, uMotes, uGrade, uFlare;
uniform vec3 uHazeCol, uMoteCol;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

vec2 cover(vec2 uv){
  float ra = uRes.x / uRes.y, ri = uImgRes.x / uImgRes.y;
  vec2 s = ra > ri ? vec2(1.0, ri / ra) : vec2(ra / ri, 1.0);
  return (uv - 0.5) * s / uZoom + 0.5 + uCenter;
}

void main(){
  vec2 uv0 = cover(vec2(v.x, 1.0 - v.y));

  // —— 视差遮挡：从最近的层(1)向最远(0)步进，找到第一个“挡住视线”的表面 ——
  const int N = 22;   // 视差强度只有 3% 左右，22 步 + 割线求交已足够（原 30 步）
  float stepL = 1.0 / float(N);
  vec2 hit = uv0 - uDir * (0.0 - uFocus);
  vec2 prevUv = uv0 - uDir * (1.0 - uFocus);
  float prevF = -1.0;
  for (int i = 1; i <= N; i++) {
    float L = 1.0 - float(i) * stepL;
    vec2 uv = uv0 - uDir * (L - uFocus);
    float f = texture2D(uDep, uv).r - L;
    if (f >= 0.0) {
      float t = prevF / (prevF - f);
      hit = mix(prevUv, uv, clamp(t, 0.0, 1.0));
      break;
    }
    prevUv = uv; prevF = f;
  }

  vec3 col = texture2D(uImg, hit).rgb;
  float d = texture2D(uDep, hit).r;

  // 空气透视
  col = mix(col, uHazeCol, (1.0 - d) * (1.0 - d) * uHaze);

  // 时段微调色：>0 偏暖（夕照），<0 偏冷（夜 / 清晨）
  col *= mix(vec3(1.0), vec3(1.05, 1.0, 0.93), max(uGrade, 0.0));
  col *= mix(vec3(1.0), vec3(0.92, 0.97, 1.07), max(-uGrade, 0.0));

  // 光尘：漂在 0.55 深度层，随视差移动
  if (uMotes > 0.0) {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    for (int k = 0; k < 2; k++) {
      float sc = 7.0 + float(k) * 5.0;
      vec2 p = v * asp * sc + vec2(uTime * 0.012 * (1.0 + float(k)), -uTime * 0.02) + uDir * (0.55 - uFocus) * sc * 2.0;
      vec2 c = floor(p);
      vec2 f = fract(p) - 0.5;
      float h = hash(c + float(k) * 17.0);
      vec2 o = vec2(hash(c + 1.3), hash(c + 7.1)) - 0.5;
      float dist = length(f - o * 0.7);
      float tw = 0.5 + 0.5 * sin(uTime * (0.5 + h) + h * 40.0);
      float a = smoothstep(0.045 * (0.4 + h), 0.0, dist) * step(0.78, h) * tw;
      col += uMoteCol * a * uMotes * (1.0 - float(k) * 0.4);
    }
  }

  // 显影：远景先出现，近景从雾中浮现
  float r = uReveal * 1.4 - 0.25;
  float m = smoothstep(r + 0.22, r - 0.04, d);
  vec3 mist = mix(uHazeCol, col, 0.18);
  col = mix(mist, col, m);
  col = mix(uHazeCol * 0.92, col, smoothstep(0.0, 0.35, uReveal));

  // 低角度的镜头光：只在顶部极淡地铺一层
  col += uHazeCol * uFlare * smoothstep(0.55, 1.0, v.y) * 0.08;

  // 颗粒（暗角改由 CSS 的 .depth::after 统一绘制：静态图与 WebGL 一致，画布淡入时角落不会突然变暗）
  vec2 q = v - 0.5;
  col += (hash(v * uRes + fract(uTime * 7.0) * 91.0) - 0.5) * 0.022;

  gl_FragColor = vec4(col, 1.0);
}`;

  const bitmap = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  };
  const UNIFORMS = ["uImg", "uDep", "uRes", "uImgRes", "uDir", "uCenter", "uFocus", "uZoom", "uReveal", "uTime", "uHaze", "uMotes", "uGrade", "uFlare", "uHazeCol", "uMoteCol"];

  class DepthCore {
    // o: { strength, focus, haze, hazeCol, motes, moteCol, grade, flare, center, zoom, reduce }
    constructor(canvas, o) { this.cv = canvas; this.o = o; this.gl = null; this.srcW = 1600; }

    // wait：等一帧的方法（主线程用 rAF；worker 里用它自己的 rAF）。返回 false 表示中途被销毁
    async init(urls, wait) {
      const gl = this.cv.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "high-performance" });
      if (!gl) throw new Error("no webgl");
      this.gl = gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);   // 不在这里查询状态：查询会强制同步等待编译完成
      const par = gl.getExtension("KHR_parallel_shader_compile");
      const images = Promise.all(urls.map(bitmap));   // 着色器编译的同时解码两张图
      images.catch(() => {});
      if (par) while (!gl.getProgramParameter(prog, par.COMPLETION_STATUS_KHR)) { await wait(); if (!this.gl) return false; }
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
      gl.useProgram(prog);
      this.u = {};
      UNIFORMS.forEach((n) => (this.u[n] = gl.getUniformLocation(prog, n)));
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      const [color, dep] = await images;
      if (!this.gl) { color.close(); dep.close(); return false; }
      this.srcW = color.width;
      gl.uniform2f(this.u.uImgRes, color.width, color.height);
      this.tex(0, color); color.close();
      await wait();   // 两张纹理分两帧上传
      if (!this.gl) { dep.close(); return false; }
      this.tex(1, dep); dep.close();
      gl.uniform1i(this.u.uImg, 0);
      gl.uniform1i(this.u.uDep, 1);
      gl.uniform3fv(this.u.uHazeCol, this.o.hazeCol);
      gl.uniform3fv(this.u.uMoteCol, this.o.moteCol);
      return true;
    }

    tex(unit, img) {
      const gl = this.gl, t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    }

    // 画布分辨率：不超过源图宽度的 1.1 倍（手绘背景放大不会多出细节），整屏画面 1.25 倍 dpr 已足够，再乘动态画质系数
    fit(cssW, cssH, dpr, scale) {
      if (!this.gl) return false;
      const d = Math.min(dpr || 1, cssW > 1200 ? 1.25 : 1.5) * scale;
      const cap = Math.min(1, (this.srcW * 1.1) / Math.max(1, cssW * d));
      const w = Math.max(2, Math.round(cssW * d * cap)), h = Math.max(2, Math.round(cssH * d * cap));
      if (this.cv.width === w && this.cv.height === h) return false;
      this.cv.width = w; this.cv.height = h;
      this.gl.viewport(0, 0, w, h);
      return true;   // 改尺寸会清空画布：调用方要立即重画
    }

    // s: { mx, my, sy, reveal }
    draw(now, s) {
      const gl = this.gl, o = this.o, u = this.u;
      if (!gl || !u) return;
      const k = o.strength, aspect = this.cv.width / this.cv.height;
      gl.uniform2f(u.uRes, this.cv.width, this.cv.height);
      gl.uniform2f(u.uDir, s.mx * k / Math.max(aspect, 1), (s.my * 0.6 + s.sy * 0.9) * k);
      gl.uniform2f(u.uCenter, o.center[0], o.center[1]);
      gl.uniform1f(u.uFocus, o.focus);
      gl.uniform1f(u.uZoom, o.zoom);
      gl.uniform1f(u.uReveal, s.reveal);
      gl.uniform1f(u.uTime, (now / 1000) % 1000);
      gl.uniform1f(u.uHaze, o.haze);
      gl.uniform1f(u.uMotes, o.reduce ? 0 : o.motes);
      gl.uniform1f(u.uGrade, o.grade);
      gl.uniform1f(u.uFlare, o.flare);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    destroy() {
      if (!this.gl) return;
      const ext = this.gl.getExtension("WEBGL_lose_context");
      ext && ext.loseContext();
      this.gl = null;
    }
  }
  G.DepthCore = DepthCore;

  /* ---------- Worker 模式：画布全部在这里画，主线程每帧只发来几个数 ---------- */
  if (typeof document !== "undefined" || typeof G.postMessage !== "function") return;
  const raf = G.requestAnimationFrame ? (f) => G.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
  const nextFrame = () => new Promise((r) => raf(() => r()));
  const scenes = new Map();   // id -> { core, ready, vis, s:{mx,my,sy,reveal}, css, dpr }
  const Q = { scale: 1, ema: 16.7, bad: 0, good: 0 };
  let idle = false, running = false, last = 0, tickN = 0;

  const refit = (sc, now) => { if (sc.ready && sc.core.fit(sc.css[0], sc.css[1], sc.dpr, Q.scale)) sc.core.draw(now, sc.s); };
  function setQuality(v) {
    v = Math.max(0.5, Math.min(1, v));
    if (Math.abs(v - Q.scale) < 0.01) return;
    Q.scale = v;
    const now = performance.now();
    scenes.forEach((sc) => refit(sc, now));
  }
  function loop(now) {
    let vis = 0;
    for (const sc of scenes.values()) if (sc.ready && sc.vis) vis++;
    if (!vis) { running = false; return; }
    const dt = last ? Math.min(64, now - last) : 16.7; last = now;
    const draw = !idle || (tickN++ & 1) === 0;   // 指针 / 滚动停下后降到半帧率：画面在缓慢呼吸，30fps 肉眼无差
    if (draw) for (const sc of scenes.values()) if (sc.ready && sc.vis) sc.core.draw(now, sc.s);
    // 动态分辨率：GPU 跟不上时逐级降，恢复后再慢慢升回去（只在全帧率时评估）
    if (draw && !idle) {
      Q.ema = Q.ema * 0.92 + dt * 0.08;
      if (Q.ema > 24) { Q.good = 0; if (++Q.bad > 24) { Q.bad = 0; setQuality(Q.scale * 0.85); } }
      else if (Q.ema < 18.5) { Q.bad = 0; if (++Q.good > 240 && Q.scale < 1) { Q.good = 0; setQuality(Q.scale * 1.1); } }
    }
    raf(loop);
  }
  const wake = () => { if (!running) { running = true; last = 0; raf(loop); } };

  G.onmessage = async (e) => {
    const m = e.data, sc = scenes.get(m.id);
    if (m.type === "st") {
      idle = !!m.idle;
      for (const s of scenes.values()) s.vis = false;
      const v = m.v;
      for (let i = 0; i < v.length; i += 5) {
        const s = scenes.get(v[i]);
        if (!s) continue;
        s.vis = true; s.s.mx = v[i + 1]; s.s.my = v[i + 2]; s.s.sy = v[i + 3]; s.s.reveal = v[i + 4];
      }
      wake();
    } else if (m.type === "add") {
      const s = { core: new DepthCore(m.canvas, m.o), ready: false, vis: !!m.vis, s: m.st, css: m.css, dpr: m.dpr };
      scenes.set(m.id, s);
      try {
        if (!(await s.core.init(m.urls, nextFrame)) || scenes.get(m.id) !== s) return;
        s.ready = true;
        s.core.fit(s.css[0], s.css[1], s.dpr, Q.scale);
        s.core.draw(performance.now(), s.s);   // 先画好第一帧，再告诉主线程可以淡入
        G.postMessage({ type: "ready", id: m.id });
        wake();
      } catch (err) {
        s.core.destroy(); scenes.delete(m.id);
        G.postMessage({ type: "fail", id: m.id, msg: String((err && err.message) || err) });
      }
    } else if (!sc) {
      return;
    } else if (m.type === "size") {
      sc.css = m.css; sc.dpr = m.dpr; refit(sc, performance.now());
    } else if (m.type === "opt") {
      Object.assign(sc.core.o, m.o);
      if (sc.ready) sc.core.draw(performance.now(), sc.s);
    } else if (m.type === "del") {
      sc.core.destroy(); scenes.delete(m.id);
    }
  };
})(self);
