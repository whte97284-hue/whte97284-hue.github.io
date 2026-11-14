/* ==========================================================================
   DepthScene — 用深度图把一张手绘背景“拆”成连续的前中远景
   · 视差遮挡映射（parallax occlusion）：从近到远步进求交，近景会正确地遮住远景
   · 空气透视：远处按深度混入一层雾色（新海诚背景里最典型的“空气感”）
   · 显影：初次进入视口时由远及近从雾里浮现 · 光尘：黄昏 / 夜景中漂在中景层的极少量光点
   本文件只管调度（何时建、何时画、视差往哪推）；WebGL 全在 depth-gl.js——
   首选放进 Web Worker（OffscreenCanvas），主线程一次都不碰 WebGL：切换页面、滚动时不会被 GPU 初始化卡住。
   失败（无 WebGL、file:// 跨域等）时保持原 <img>，不影响阅读。
   ========================================================================== */
(function () {
  "use strict";

  const hexToRgb = (h) => {
    const n = parseInt(h.replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const CORE_URL = new URL("depth-gl.js" + ((document.currentScript && new URL(document.currentScript.src).search) || ""), (document.currentScript && document.currentScript.src) || location.href).href;
  const abs = (u) => new URL(u, location.href).href;

  /* —— 渲染端：worker（首选）或主线程上的同一套核心（退路） —— */
  const OFF = !!(HTMLCanvasElement.prototype.transferControlToOffscreen && window.Worker && window.OffscreenCanvas);
  let worker = null, coreP = null, seq = 0;
  const waiting = new Map();   // id -> resolve(ok, msg)
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(CORE_URL);
    worker.onmessage = (e) => { const r = waiting.get(e.data.id); if (r) { waiting.delete(e.data.id); r(e.data); } };
    worker.onerror = () => { waiting.forEach((r) => r({ type: "fail", msg: "worker error" })); waiting.clear(); };
    return worker;
  }
  function loadCore() {
    return coreP || (coreP = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = CORE_URL; s.onload = () => (window.DepthCore ? res(window.DepthCore) : rej(new Error("no core"))); s.onerror = rej;
      document.head.appendChild(s);
    }));
  }

  // 全局指针（相对视口中心，-1..1）
  const pointer = { x: 0, y: 0, active: false };
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    pointer.x = (e.clientX / innerWidth) * 2 - 1;
    pointer.y = (e.clientY / innerHeight) * 2 - 1;
    pointer.active = true;
  }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.active = false; });

  // 视口：在 scroll / resize 事件里记下（那时版面是干净的）。Chrome 里逐帧读 scrollY / innerHeight，
  // 遇上页面正在填内容会触发一次同步排版
  // 初值也不在脚本执行时读（那时页面还没排过版），由第一批 IntersectionObserver 回调填上
  const VP = { y: 0, h: 0 };
  const seeVP = (e) => { VP.y = scrollY; VP.h = (e && e.rootBounds && e.rootBounds.height) || innerHeight; };
  addEventListener("scroll", () => { VP.y = scrollY; }, { passive: true });
  addEventListener("resize", () => { VP.y = scrollY; VP.h = innerHeight; });

  const scenes = new Set();
  let liveCount = 0;
  const MAX_LIVE = 6;

  /* —— 活动追踪：指针 / 滚动停下 1.5s 后，渲染降到半帧率 —— */
  let lastActivity = performance.now();
  const touch = () => { lastActivity = performance.now(); };
  ["pointermove", "scroll", "wheel", "resize", "keydown"].forEach((t) => addEventListener(t, touch, { passive: true }));

  /* —— 动态分辨率（主线程退路用；worker 模式下由 worker 按自己的帧间隔评估） —— */
  const Q = { scale: 1, ema: 16.7, bad: 0, good: 0 };
  function setQuality(v) {
    v = Math.max(0.5, Math.min(1, v));
    if (Math.abs(v - Q.scale) < 0.01) return;
    Q.scale = v;
    scenes.forEach((sc) => sc.resize(true));
  }

  /* —— 启动队列：一次只启动一个场景，离视口最近的优先 —— */
  const queue = new Set();
  let building = false;
  // content-visibility: auto 的区块正被跳过时，读其中元素的位置会迫使浏览器临时为它排版——其中的场景一律当作“很远”
  // 状态由事件维护；事件到达之前只问一次浏览器（checkVisibility 只需样式，不排版）
  document.addEventListener("contentvisibilityautostatechange", (e) => {
    for (const sc of scenes) if (sc.cv && e.target.contains(sc.el)) {
      sc.hid = e.skipped;
      if (!e.skipped) { sc.layout(); if (sc.near && !sc.live && !sc.failed) enqueue(sc); }
    }
  }, true);
  /* 位置：交给 IntersectionObserver 在浏览器自己排完版之后报上来（免费），脚本里从不同步读版面——
     页面刚换过来、正文还在往里填时，同步读一次就是整页多排一遍 */
  const boxIO = new IntersectionObserver((es) => es.forEach((e) => {
    const sc = e.target.__depthOf;
    boxIO.unobserve(e.target);
    if (!sc) return;
    const r = e.boundingClientRect;
    seeVP();   // 回调时版面刚排完，读它是免费的
    sc.box = { sticky: sc.sticky, top: r.top + VP.y, h: r.height };
  }));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const idleCb = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  function enqueue(sc) { queue.add(sc); pump(); }
  function pump() {
    if (building || !queue.size) return;
    // 跨页转场进行中：先不启动（转场里显示的本就是静态截图），结束后等主线程空下来再接着排
    const vt = window.KataVT && window.KataVT.busy;
    if (vt && !vt.done) { vt.then(() => idleCb(() => requestAnimationFrame(pump), { timeout: 900 })); return; }
    const list = [...queue].filter((sc) => sc.near && !sc.live && !sc.failed && !sc.hidden());
    queue.clear();
    if (!list.length) return;
    list.sort((a, b) => a.distance() - b.distance());
    list.slice(1).forEach((sc) => queue.add(sc));
    building = true;
    list[0].create().finally(() => { building = false; requestAnimationFrame(pump); });
  }

  class DepthScene {
    constructor(el) {
      this.el = el;
      this.cv = el.closest(".prose.chapter, [data-cv]");   // 所在的 content-visibility 区块（如有）
      this.img = el.querySelector("img");
      const d = el.dataset, c = (d.center || "0,0").split(",").map(Number);
      this.depthUrl = d.depth;
      this.o = {
        strength: parseFloat(d.strength || "0.028"), focus: parseFloat(d.focus || "0.4"), haze: parseFloat(d.haze || "0.18"),
        hazeCol: hexToRgb(d.hazeColor || "#dfe6ee"), motes: parseFloat(d.motes || "0"), moteCol: hexToRgb(d.moteColor || "#ffe9cf"),
        grade: parseFloat(d.grade || "0"), flare: parseFloat(d.flare || "0"), center: [c[0] || 0, c[1] || 0], zoom: parseFloat(d.zoom || "1.07"), reduce,
      };
      this.revealOnEnter = d.reveal !== "off";
      this.reveal = this.revealOnEnter && !reduce ? 0 : 1;
      this.revealStart = 0;
      this.mx = 0; this.my = 0; this.sy = 0;
      this.visible = false; this.near = false;
      this.live = false;   // 已经（或正在）占用一个 WebGL 上下文
      this.ready = false;  // 第一帧已画好
      this.extra = { x: 0, y: 0 };   // 外部（滚动叙事）可以推一下镜头
      const stage = el.closest(".opener__stage");
      this.sticky = !!stage;
      this.host = stage ? stage.parentElement : el;
      this.host.__depthOf = this;
      this.box = null; this.hid = null; this.css = null;
      scenes.add(this);
      this.layout();
    }
    get grade() { return this.o.grade; }
    set grade(v) {   // site.js 按读者本地时段设置首页大图的色调
      this.o.grade = v;
      if (this.wid && worker) worker.postMessage({ type: "opt", id: this.wid, o: { grade: v } });
      else if (this.core && this.ready) this.core.draw(performance.now(), this);
    }

    // 位置缓存：只在版面变化时量；逐帧只用 scrollY 推算
    hidden() {
      if (!this.cv) return false;
      if (this.hid == null) this.hid = this.el.checkVisibility ? !this.el.checkVisibility({ contentVisibilityAuto: true }) : false;
      return this.hid;
    }
    // 请浏览器在下一次排版后报告位置；报到之前沿用旧值
    layout() {
      if (this.hidden()) return;
      boxIO.unobserve(this.host); boxIO.observe(this.host);
    }
    view() {
      if (this.hidden()) return { top: 1e5, h: 0 };
      const b = this.box, y = VP.y, vh = VP.h || 1;
      if (!b) return this.visible ? { top: 0, h: vh } : { top: 1e5, h: 0 };
      if (!b.sticky) return { top: b.top - y, h: b.h };
      const t = b.top - y;
      return { top: t > 0 ? t : y < b.top + b.h - vh ? 0 : b.top + b.h - vh - y, h: vh };
    }
    distance() {
      const v = this.view();
      return v.top + v.h < 0 ? -(v.top + v.h) : v.top > VP.h ? v.top - VP.h : 0;
    }

    setNear(v) {
      this.near = v;
      if (v && !this.live && !this.failed && !this.hidden()) enqueue(this);
    }
    setVisible(v) {
      this.visible = v;
      if (v) {
        this.el.classList.add("is-in");
        if (!this.revealStart && this.revealOnEnter) this.revealStart = performance.now();
      }
    }

    async create() {
      if (liveCount >= MAX_LIVE) {
        const far = [...scenes].filter((sc) => sc.live && !sc.visible && sc !== this).sort((a, b) => b.distance() - a.distance())[0];
        if (!far) return;
        far.destroy();
      }
      const urls = [abs(this.img.currentSrc || this.img.src), abs(this.depthUrl)];
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      this.canvas = canvas; this.live = true; liveCount++;
      // 尺寸：ResizeObserver 在排版之后报上来，第一次回调就是初始尺寸
      const sized = new Promise((res) => {
        this.ro = new ResizeObserver((es) => { const b = es[es.length - 1].contentRect; this.css = [b.width, b.height]; res(); this.resize(); });
        this.ro.observe(this.el);
      });
      try {
        await sized;
        if (!this.live) return;
        if (OFF) {
          // 画布控制权交给 worker；画布先挂进页面（透明），worker 画好第一帧后再淡入
          const off = canvas.transferControlToOffscreen(), id = ++seq;
          this.wid = id;
          this.el.appendChild(canvas);
          const done = new Promise((res) => waiting.set(id, res));
          this.sizeKey = this.css.join("x") + "@" + (devicePixelRatio || 1);
          getWorker().postMessage({ type: "add", id, canvas: off, urls, o: this.o, css: this.css, dpr: devicePixelRatio || 1, vis: this.visible,
            st: { mx: this.mx, my: this.my, sy: this.sy, reveal: this.reveal } }, [off]);
          const m = await done;
          if (!this.live || this.wid !== id) return;
          if (m.type !== "ready") throw new Error(m.msg || "worker failed");
        } else {
          const Core = await loadCore();
          if (!this.live) return;
          this.core = new Core(canvas, this.o);
          if (!(await this.core.init(urls, nextFrame)) || !this.live) return;
          this.core.fit(this.css[0], this.css[1], devicePixelRatio || 1, Q.scale);
          this.core.draw(performance.now(), this);   // 先在页面外画好第一帧
          this.el.appendChild(canvas);
        }
        this.ready = true;
        requestAnimationFrame(() => this.el.classList.add("is-live"));
      } catch (err) {
        console.warn("[depth] fallback to static image:", err && err.message);
        this.failed = true;
        this.destroy();
      }
    }

    resize(force) {
      if (!this.ready || !this.css || this.hidden()) return;
      const [w, h] = this.css, dpr = devicePixelRatio || 1;
      if (this.wid) {
        const k = w + "x" + h + "@" + dpr;
        if (k !== this.sizeKey) { this.sizeKey = k; worker.postMessage({ type: "size", id: this.wid, css: [w, h], dpr }); }
      } else if (this.core && (this.core.fit(w, h, dpr, Q.scale) || force)) {
        this.core.draw(performance.now(), this);
      }
    }

    destroy() {
      if (this.ro) this.ro.disconnect();
      if (this.live) liveCount--;
      if (this.wid && worker) { worker.postMessage({ type: "del", id: this.wid }); waiting.delete(this.wid); }
      if (this.core) this.core.destroy();
      this.canvas && this.canvas.remove();
      this.el.classList.remove("is-live");
      this.live = false; this.ready = false; this.wid = 0; this.core = null; this.canvas = null; this.ro = null; this.sizeKey = "";
    }

    update(now, dt) {
      // 目标视差：鼠标 > 无鼠标时的缓慢“呼吸”漂移
      let tx, ty;
      if (finePointer && pointer.active && !reduce) { tx = pointer.x; ty = pointer.y; }
      else if (!reduce) { const t = now / 1000; tx = Math.sin(t * 0.17) * 0.55; ty = Math.cos(t * 0.13) * 0.3; }
      else { tx = 0; ty = 0; }
      // 滚动：元素中心相对视口中心的偏移，推动纵向视差（像镜头升降）
      const r = this.view();
      const sy = reduce ? 0 : ((r.top + r.h / 2) - VP.h / 2) / VP.h;
      const k = 1 - Math.pow(0.0018, dt / 1000);   // 与帧率无关的平滑
      this.mx += (tx + this.extra.x - this.mx) * k;
      this.my += (ty + this.extra.y - this.my) * k;
      this.sy += (sy - this.sy) * Math.min(1, k * 2.2);
      if (this.revealStart && this.reveal < 1) {
        const p = Math.min(1, (now - this.revealStart) / 2800);
        this.reveal = 1 - Math.pow(1 - p, 3);
      }
    }
  }

  // —— 观察者：近处排队启动；可见才渲染 ——
  const nearIO = new IntersectionObserver((es) => es.forEach((e) => e.target.__scene && e.target.__scene.setNear(e.isIntersecting)), { rootMargin: "120% 0px" });
  const visIO = new IntersectionObserver((es) => { seeVP(es[0]); es.forEach((e) => e.target.__scene && e.target.__scene.setVisible(e.isIntersecting)); }, { threshold: 0.02 });

  // 每帧：主线程只算几个数（视差、显影进度）；worker 模式下打包成一条消息发过去，由 worker 自己按它的节拍画
  let last = performance.now(), tickN = 0, sentAny = false;
  const st = [];
  function frame(now) {
    const dt = Math.min(64, now - last); last = now;
    let drawn = 0, settling = false;
    for (const sc of scenes) if (sc.visible && sc.ready && sc.reveal < 1) settling = true;
    const idle = !settling && now - lastActivity > 1500;
    const draw = !idle || (tickN++ & 1) === 0;
    st.length = 0;
    for (const sc of scenes) {
      if (!sc.visible) continue;
      sc.update(now, dt);
      if (!sc.ready) continue;
      if (sc.wid) st.push(sc.wid, sc.mx, sc.my, sc.sy, sc.reveal);
      else if (draw && sc.core) { sc.core.draw(now, sc); drawn++; }
    }
    if (worker && (st.length || sentAny)) { worker.postMessage({ type: "st", v: st, idle }); sentAny = st.length > 0; }
    if (drawn && !idle && !document.hidden) {
      Q.ema = Q.ema * 0.92 + dt * 0.08;
      if (Q.ema > 24) { Q.good = 0; if (++Q.bad > 24) { Q.bad = 0; setQuality(Q.scale * 0.85); } }
      else if (Q.ema < 18.5) { Q.bad = 0; if (++Q.good > 240 && Q.scale < 1) { Q.good = 0; setQuality(Q.scale * 1.1); } }
    }
    requestAnimationFrame(frame);
  }

  // 版面变化时重量位置：由 site.js 的统一测量（body ResizeObserver / resize）调用
  const relayout = () => scenes.forEach((sc) => sc.layout());

  window.Depth = {
    init(root = document) {
      root.querySelectorAll(".depth[data-depth]").forEach((el) => {
        if (el.__scene) return;
        el.__scene = new DepthScene(el);
        nearIO.observe(el); visIO.observe(el);
      });
      // 无深度图的 .depth 只做显影
      root.querySelectorAll(".depth:not([data-depth])").forEach((el) => plainIO.observe(el));
    },
    // 不再需要这个场景（轮播里离开了画面的那一张）：回收 WebGL 上下文与观察者；之后可以再 init
    drop(el) {
      const sc = el && el.__scene;
      if (!sc) return;
      nearIO.unobserve(el); visIO.unobserve(el); boxIO.unobserve(sc.host);
      queue.delete(sc);
      sc.destroy();
      scenes.delete(sc);
      el.__scene = null;
      if (sc.host && sc.host.__depthOf === sc) sc.host.__depthOf = null;
    },
    scenes,
    quality: Q,
    relayout,
    offscreen: OFF,
  };
  const plainIO = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("is-in")), { threshold: 0.1 });

  // 有深度场景的页面：提前把 worker 起好（下载 + 解析脚本），真正建场景时不再等
  if (OFF && document.querySelector(".depth[data-depth], [data-post]")) idleCb(getWorker, { timeout: 1200 });

  requestAnimationFrame(frame);
})();
