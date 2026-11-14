/* ==========================================================================
   かたわれ時 — 画廊（Pixiv 日榜，边缘层 /pixiv/rank）
   · 瀑布流：接口里带每张图的宽高，布局在图片到达之前就算好，图来了也不跳；排名第一的横跨两栏
   · 浮现：一张卡片只“出现”一次——等它自己的图解码好（最多 1.2 秒）再从水下浮上来，图随卡片一起到；
     按阅读顺序、至少相隔 70ms 依次浮现；浮上来时脚下的水面荡开一圈很轻的涟漪，图面掠过一道日光。
     数据还没到时不放骨架，水面自己每隔一会儿荡开一圈，就是“在加载”。
   · 图片：Pixiv 自带的 WebP 尺寸——卡片 600px（≈20–170KB，比 480px 的 JPEG 小一半以上），
     首图与灯箱 1200px（比 1200 的 JPEG 原图小约 80%）；WebP 失败时回退到原来的 JPEG
   · 水面：背景图交给一段很小的 WebGL 着色器——缓慢流动的折射、日光闪烁、尾波与涟漪；空闲时降到半帧率
   · 灯箱：从卡片 FLIP 展开；← → / 滑动翻页，并预取前后两幅；Esc / 点空白 / 滚动合上
   ========================================================================== */
(function () {
  "use strict";
  const A = window.KataAPI;
  const $ = (s, r = document) => r.querySelector(s);
  const wall = $("[data-slot=wall]");
  if (!wall || !A) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const esc = A.view.esc;
  const pad = (n) => String(n).padStart(2, "0");
  const variant = (u, v) => u.replace(/\/c\/[^/]+\/img-master\//, `/c/${v}/img-master/`);
  const thumb = (u) => variant(u, "600x1200_90_webp");
  const large = (u) => variant(u, "1200x1200_90_webp");
  const master = (u) => u.replace(/\/c\/[^/]+\/img-master\//, "/img-master/");

  /* ---------- 瀑布流 ---------- */
  let items = [], cards = [], laidW = 0;
  function cols(W) { return W >= 1500 ? 5 : W >= 1150 ? 4 : W >= 760 ? 3 : 2; }
  function layout() {
    const W = wall.clientWidth;                 // 只读墙本身的宽度（卡片绝对定位，不影响它）
    if (!W || !cards.length) return;
    laidW = W;
    const n = cols(W), g = Math.round(clamp(W * 0.016, 12, 24)), cw = (W - g * (n - 1)) / n;
    const h = new Array(n).fill(0);
    cards.forEach((el) => {
      const it = el.__it;
      const ar = clamp(it.width / it.height, 0.62, 1.9);         // 极端的长图 / 宽图裁一下，墙面才有节奏
      const span = it.feature && n >= 3 ? 2 : 1;
      let c = 0;
      if (span === 2) { let best = 1e9; for (let k = 0; k < n - 1; k++) { const m = Math.max(h[k], h[k + 1]); if (m < best) { best = m; c = k; } } }
      else for (let k = 1; k < n; k++) if (h[k] < h[c] - 1) c = k;
      const w = cw * span + g * (span - 1), ht = Math.round(w / ar);
      const y = span === 2 ? Math.max(h[c], h[c + 1]) : h[c], x = c * (cw + g);
      el.style.width = w.toFixed(1) + "px"; el.style.height = ht + "px";
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y}px, 0)`;
      el.__x = x; el.__y = y;
      for (let k = c; k < c + span; k++) h[k] = y + ht + g;
    });
    wall.style.height = Math.max(...h) - g + "px";
  }
  new ResizeObserver(() => { if (wall.clientWidth !== laidW) layout(); }).observe(wall);

  /* ---------- 图片 ---------- */
  function load(el) {
    if (el.__ready) return el.__ready;
    const img = $("img", el), frame = $(".gl-card__frame", el);
    el.__ready = new Promise((resolve) => {
      const ok = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => { frame.classList.add("is-loaded"); resolve(true); });
      img.addEventListener("load", ok);
      img.addEventListener("error", () => {
        if (!img.__fb) { img.__fb = 1; img.src = el.__it.url; return; }   // WebP 不行就回退到接口给的 JPEG
        frame.classList.add("is-loaded"); resolve(false);
      });
      img.src = img.dataset.src;
    });
    return el.__ready;
  }
  const loadIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { loadIO.unobserve(e.target); load(e.target); } }), { rootMargin: "100% 0px" });

  /* ---------- 浮现 ---------- */
  let nextSlot = 0;
  const STEP = 70, WAIT = 1200;
  function reveal(el) {
    el.classList.add("is-in");
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight && r.bottom > 0) water.ripple(r.left + r.width / 2, r.top + r.height * 0.55, 0.00042);   // 脚下的水面荡开一圈
    // 浮现结束后去掉延迟，悬停的反馈才是即时的
    setTimeout(() => el.classList.add("is-settled"), 1400);
  }
  function schedule(el) {
    if (el.__q) return;
    el.__q = true;
    const wait = new Promise((r) => setTimeout(r, WAIT));
    Promise.race([load(el), wait]).then(() => {
      const now = performance.now();
      nextSlot = Math.max(now, nextSlot + STEP);
      setTimeout(() => requestAnimationFrame(() => reveal(el)), nextSlot - now);
    });
  }
  const revealIO = new IntersectionObserver((es) => {
    // 同一批进入视野的按阅读顺序（先上后下、先左后右）排队
    es.filter((e) => e.isIntersecting).map((e) => e.target).sort((a, b) => (a.__y - b.__y) || (a.__x - b.__x)).forEach((el) => { revealIO.unobserve(el); schedule(el); });
  }, { rootMargin: "0px 0px -6% 0px" });

  function card(it, i) {
    const a = document.createElement("a");
    a.className = "gl-card" + (it.rank <= 3 ? " is-top" : "");
    a.href = "https://www.pixiv.net/artworks/" + it.id;
    a.target = "_blank"; a.rel = "noopener";
    a.setAttribute("aria-label", `${it.title} — ${it.author}`);
    const src = it.feature && cols(wall.clientWidth) >= 3 ? large(it.url) : thumb(it.url);     // 横跨两栏的那张用 1200；窄屏上它只占一栏，600 就够（少下四分之三）
    a.innerHTML = `<div class="gl-card__in"><div class="gl-card__frame">` +
      `<img data-src="${esc(src)}" alt="${esc(it.title)}" decoding="async" referrerpolicy="no-referrer" fetchpriority="${i < 8 ? "high" : "low"}">` +
      `<i class="gl-card__glint" aria-hidden="true"></i>` +
      `<span class="gl-card__rank" aria-hidden="true">${pad(it.rank)}</span></div></div>`;
    a.__it = it; a.__i = i;
    return a;
  }

  // 悬停标题：日文标题第一次排版要走系统字体回退，48 条一起排要几十毫秒（分批补也逃不掉排版），
  // 所以卡片里不预先放标题：鼠标移到哪张，才给那一张生成（2–3ms）；触屏设备一张都不排。
  // 新生成的标题先以“隐藏”状态排好一帧，再去掉 is-new，悬停的淡入照常
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  function addCap(el) {
    if (el.__cap || !el.__it) return;
    el.__cap = true;
    const it = el.__it, cap = document.createElement("span");
    cap.className = "gl-card__cap is-new";
    cap.innerHTML = `<b>${esc(it.title)}</b><small>${esc(it.author)}</small>`;
    $(".gl-card__frame", el).appendChild(cap);
    void cap.offsetWidth;
    requestAnimationFrame(() => cap.classList.remove("is-new"));
  }
  if (finePointer) wall.addEventListener("pointerover", (e) => { const a = e.target.closest(".gl-card"); if (a) addCap(a); });
  wall.addEventListener("focusin", (e) => { const a = e.target.closest(".gl-card"); if (a) addCap(a); });

  // 数据还没到：水面每隔一会儿在墙面的位置荡开一圈（不放骨架卡片，免得“骨架 → 空白 → 卡片”断三次）
  let pulse = 0;
  function waiting(on) {
    clearInterval(pulse);
    if (!on || reduce) return;
    const ping = () => { const r = wall.getBoundingClientRect(); water.ripple(innerWidth / 2, clamp(r.top + 120, innerHeight * 0.45, innerHeight * 0.8), 0.0007); };
    setTimeout(ping, 500);
    pulse = setInterval(ping, 1700);
  }

  function watch(c) { revealIO.observe(c); if (!c.__ready) loadIO.observe(c); }
  function render(data) {
    waiting(false);
    items = data.list.map((x, i) => ({ ...x, feature: i === 0 }));
    const d = String(data.date || "");
    $("[data-slot=date]").textContent = d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : "";
    $("[data-slot=count]").textContent = items.length ? `${items.length}` : "";
    cards = items.map(card);
    wall.classList.remove("is-laid");
    layout();                                   // 卡片还没进页面：只按宽高算位置，不触发排版
    // 首屏附近的卡片先进页面（一次插 48 张的首次排版要几十毫秒）；其余在空闲时插入
    const near = cards.filter((c) => c.__y < innerHeight * 1.6), rest = cards.filter((c) => c.__y >= innerHeight * 1.6);
    wall.replaceChildren(...near);
    wall.removeAttribute("aria-busy");
    near.filter((c) => c.__y < innerHeight * 1.1).forEach(load);   // 首屏那几张立刻开始下载
    near.forEach(watch);
    // 其余的分批插：每次空闲只插 6 张——插入本身在空闲回调里，但它带来的排版落在下一帧，一次插太多那一帧就会顿
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 120));
    const more = () => { const b = rest.splice(0, 6); wall.append(...b); b.forEach(watch); if (rest.length) idle(more, { timeout: 600 }); };
    if (rest.length) idle(more, { timeout: 900 });
    requestAnimationFrame(() => wall.classList.add("is-laid"));   // 之后窗口变化时，卡片会滑到新位置
  }

  async function start() {
    const note = $("[data-slot=note]");
    waiting(true);
    wall.setAttribute("aria-busy", "true");
    try {
      const data = await A.pixiv({ onUpdate: render });
      if (!data.list.length) throw new Error("empty");
      render(data);
    } catch (e) {
      waiting(false);
      wall.removeAttribute("aria-busy");
      wall.replaceChildren(); wall.style.height = "0px";
      note.hidden = false;
      note.innerHTML = `画廊暂时取不回来<button type="button">重试</button>`;
      $("button", note).addEventListener("click", () => { note.hidden = true; start(); }, { once: true });
    }
  }

  /* ---------- 灯箱 ---------- */
  const EASE = "cubic-bezier(.65,.05,.25,1)";
  let lb = null, st = null;
  function geom(r, w, h) {                 // 从 cover 裁切的卡片飞出：等比缩放 + 裁切
    const k = Math.max(r.width / w, r.height / h);
    const ix = Math.max(0, (w - r.width / k) / 2), iy = Math.max(0, (h - r.height / k) / 2);
    return { transform: `translate(${(r.left + r.width / 2 - (w * k) / 2).toFixed(1)}px, ${(r.top + r.height / 2 - (h * k) / 2).toFixed(1)}px) scale(${k.toFixed(4)})`, clipPath: `inset(${iy.toFixed(1)}px ${ix.toFixed(1)}px)` };
  }
  const fit = (it) => {
    const ar = it.width / it.height, maxW = innerWidth * 0.9, maxH = innerHeight * (innerWidth < 720 ? 0.72 : 0.8);
    let w = maxW, h = w / ar; if (h > maxH) { h = maxH; w = h * ar; }
    return { w, h, x: (innerWidth - w) / 2, y: (innerHeight - h) / 2 - innerHeight * 0.03 };
  };
  const ICON = { prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>', next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>', close: '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>' };
  const hiCache = new Map();               // 灯箱用的 1200 图：已经解码好的留着，翻回来是瞬间的
  function hiRes(it) {
    const u = large(it.url);
    if (!hiCache.has(u)) {
      const h = new Image(); h.referrerPolicy = "no-referrer"; h.decoding = "async"; h.src = u;
      const p = h.decode().then(() => u).catch(() => { const m = new Image(); m.referrerPolicy = "no-referrer"; m.src = master(it.url); return m.decode().then(() => m.src); });
      hiCache.set(u, p);
    }
    return hiCache.get(u);
  }
  function ensure() {
    if (lb) return;
    lb = document.createElement("div");
    lb.className = "gl-lb"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true");
    lb.innerHTML = `<div class="gl-lb__bg"></div><p class="gl-lb__cap"></p>` +
      `<button class="gl-lb__nav gl-lb__nav--prev" aria-label="上一幅">${ICON.prev}</button><button class="gl-lb__nav gl-lb__nav--next" aria-label="下一幅">${ICON.next}</button>` +
      `<button class="gl-lb__close" aria-label="关闭">${ICON.close}</button>`;
    document.body.appendChild(lb);
    $(".gl-lb__bg", lb).addEventListener("click", close);
    $(".gl-lb__close", lb).addEventListener("click", close);
    $(".gl-lb__nav--prev", lb).addEventListener("click", () => step(-1));
    $(".gl-lb__nav--next", lb).addEventListener("click", () => step(1));
    addEventListener("keydown", (e) => {
      if (!st) return;
      if (e.key === "Escape") close(); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "ArrowRight") step(1);
    });
    addEventListener("scroll", () => { if (st && Math.abs(scrollY - st.y0) > 80) close(); }, { passive: true });
    let sx = 0, sy = 0;                  // 触屏左右滑动翻页
    lb.addEventListener("pointerdown", (e) => { sx = e.clientX; sy = e.clientY; });
    lb.addEventListener("pointerup", (e) => { const dx = e.clientX - sx; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - sy) * 1.4) step(dx < 0 ? 1 : -1); });
  }
  function caption(it) {
    const tags = (it.tags || []).filter((t) => !/users入り$/.test(t)).slice(0, 5).map((t) => "#" + esc(t)).join("  ");
    $(".gl-lb__cap", lb).innerHTML = `<span class="latin">No. ${pad(it.rank)}</span><b>${esc(it.title)}</b><span>${esc(it.author)}</span>` +
      `<a href="https://www.pixiv.net/artworks/${it.id}" target="_blank" rel="noopener">在 Pixiv 查看 ↗</a>${tags ? `<small>${tags}</small>` : ""}`;
  }
  function makeImg(el, it, g) {
    const t = $("img", el);
    const img = new Image();
    img.className = "gl-lb__img"; img.alt = it.title; img.referrerPolicy = "no-referrer";
    img.src = (t && t.currentSrc) || thumb(it.url);               // 内存里已有的这张先顶上，飞行全程有画面
    hiRes(it).then((u) => { if (img.isConnected && img.src !== u) img.src = u; }).catch(() => {});
    img.style.width = g.w + "px"; img.style.height = g.h + "px"; img.style.objectFit = "cover";
    img.style.transform = `translate(${g.x}px, ${g.y}px)`;
    return img;
  }
  function prefetchAround(i) {             // 前后两幅：翻页时不用再等
    setTimeout(() => { [1, -1].forEach((d) => { const c = cards[(i + d + cards.length) % cards.length]; if (c) { load(c); hiRes(c.__it); } }); }, 500);
  }
  function open(i) {
    const el = cards[i]; if (!el) return;
    ensure();
    const it = el.__it, g = fit(it), r = $(".gl-card__frame", el).getBoundingClientRect();
    const img = makeImg(el, it, g);
    lb.insertBefore(img, $(".gl-lb__cap", lb));
    caption(it);
    el.style.visibility = "hidden";
    lb.classList.add("is-open");
    water.pause(true);
    if (!reduce) img.animate([geom(r, g.w, g.h), { transform: `translate(${g.x}px, ${g.y}px) scale(1)`, clipPath: "inset(0px 0px)" }], { duration: 820, easing: EASE });
    st = { i, el, img, g, y0: scrollY };
    prefetchAround(i);
  }
  function step(d) {
    if (!st) return;
    const n = (st.i + d + cards.length) % cards.length, el = cards[n], it = el.__it, g = fit(it);
    load(el);
    const img = makeImg(el, it, g), old = st.img;
    lb.insertBefore(img, $(".gl-lb__cap", lb));
    caption(it);
    st.el.style.visibility = ""; el.style.visibility = "hidden";
    if (!reduce) {
      old.animate([{ opacity: 1, transform: `translate(${st.g.x}px, ${st.g.y}px)` }, { opacity: 0, transform: `translate(${st.g.x - d * 60}px, ${st.g.y}px)` }], { duration: 420, easing: "cubic-bezier(.3,0,.2,1)", fill: "forwards" }).onfinish = () => old.remove();
      img.animate([{ opacity: 0, transform: `translate(${g.x + d * 60}px, ${g.y}px)` }, { opacity: 1, transform: `translate(${g.x}px, ${g.y}px)` }], { duration: 560, easing: "cubic-bezier(.2,.7,.2,1)" });
    } else old.remove();
    // 翻到的那张不在视野里：把墙面悄悄滚过去，合上时能飞回原位（不触发“滚动即关闭”）
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { scrollTo({ top: scrollY + r.top - innerHeight * 0.3, behavior: "instant" }); }
    if (!el.classList.contains("is-in")) { revealIO.unobserve(el); el.__q = true; el.classList.add("is-in", "is-settled"); }
    st = { i: n, el, img, g, y0: scrollY };
    prefetchAround(n);
  }
  function close() {
    if (!st) return;
    const { el, img, g } = st;
    st = null;
    lb.classList.remove("is-open");
    water.pause(false);
    const r = $(".gl-card__frame", el).getBoundingClientRect();
    const done = () => { img.remove(); el.style.visibility = ""; };
    const onScreen = r.bottom > 0 && r.top < innerHeight;
    if (reduce || !onScreen) { img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 1 : 300, fill: "forwards" }).onfinish = done; return; }
    img.animate([{ transform: `translate(${g.x}px, ${g.y}px) scale(1)`, clipPath: "inset(0px 0px)" }, geom(r, g.w, g.h)], { duration: 640, easing: EASE, fill: "forwards" }).onfinish = done;
  }
  wall.addEventListener("click", (e) => {
    const a = e.target.closest(".gl-card");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    open(a.__i);
  });

  /* ---------- 水面（WebGL） ---------- */
  const water = (function () {
    const box = $(".water"), canvas = $(".water__gl"), photo = $(".water__img");
    const pending = [];
    const api = { pause() {}, ripple(x, y, amp) { if (pending.length < 6) pending.push([x, y, amp]); } };
    if (!box || !canvas || !photo || reduce) { api.ripple = () => {}; return api; }
    // 优先在 Web Worker 里跑（OffscreenCanvas）：第一次建 WebGL 上下文在主线程上会同步卡 80–170ms，
    // 搬到工作线程后主线程一次都不碰 WebGL。不支持的浏览器才退回主线程，并且挪到首帧之后的空闲时段
    if (canvas.transferControlToOffscreen && window.Worker && window.createImageBitmap) {
      try { inWorker(); return api; } catch (e) { /* 退回主线程 */ }
    }
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    idle(() => init().catch(() => {}), { timeout: 700 });
    return api;

    function inWorker() {
      const off = canvas.transferControlToOffscreen();
      const w = new Worker("assets/js/gallery-water.js?v=" + ((document.currentScript && document.currentScript.src.split("v=")[1]) || "1"));
      const post = (m, t) => w.postMessage(m, t || []);
      let docMax = 1, alive = false, paused = false;
      const measure = () => { docMax = Math.max(1, document.documentElement.scrollHeight - innerHeight); post({ type: "measure", docMax }); };
      w.onmessage = (e) => {
        if (e.data.type === "ready") { alive = true; requestAnimationFrame(() => box.classList.add("is-live")); }
      };
      w.onerror = () => {};
      // 背景图在后台解码成位图，连同画布一起交给工作线程
      const im = new Image(); im.src = photo.currentSrc || photo.src;
      im.decode().then(() => createImageBitmap(im)).then((bitmap) => {
        measure();
        post({ type: "init", canvas: off, bitmap, w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1, sy: scrollY, docMax }, [off, bitmap]);
        api.ripple = (x, y, amp) => post({ type: "ripple", x, y, amp });
        api.pause = (v) => { paused = v; post({ type: "pause", v }); };
        pending.splice(0).forEach(([x, y, amp]) => api.ripple(x, y, amp));
      }).catch(() => {});
      addEventListener("resize", () => { post({ type: "resize", w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 }); measure(); });
      addEventListener("scroll", () => post({ type: "scroll", sy: scrollY }), { passive: true });
      new ResizeObserver(measure).observe(document.body);
      document.addEventListener("visibilitychange", () => post({ type: "pause", v: document.hidden || paused }));
      let lx = -1e3, ly = -1e3, lt = 0, la = 0;
      addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse") return;
        const now = performance.now();
        if (now - la > 400) { la = now; post({ type: "active" }); }
        if (now - lt > 140 && Math.hypot(e.clientX - lx, e.clientY - ly) > 48) { lx = e.clientX; ly = e.clientY; lt = now; api.ripple(lx, ly, 0.00055); }
      }, { passive: true });
      addEventListener("pointerdown", (e) => { if (!st) api.ripple(e.clientX, e.clientY, 0.0016); }, { passive: true });
    }

    async function init() {
      let q = 0.6;
      const size = () => { const d = Math.min(devicePixelRatio || 1, 2) * q; canvas.width = Math.max(2, Math.round(innerWidth * d)); canvas.height = Math.max(2, Math.round(innerHeight * d)); };
      size();                                   // 先定尺寸再建上下文：建好之后再改尺寸会重新分配缓冲区
      const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "low-power" });
      if (!gl) return;
      const VS = "attribute vec2 p; varying vec2 v; void main(){ v = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }";
      const FS = `precision mediump float;
varying vec2 v;
uniform sampler2D T; uniform vec2 R, I; uniform float t, drift; uniform vec4 rip[6];
float wave(vec2 p){
  float h = sin(dot(p, vec2(.84, .54)) * 6.5 + t * .50) * .55
          + sin(dot(p, vec2(-.48, .88)) * 10.5 - t * .66) * .32
          + sin(dot(p, vec2(.26, -.97)) * 18.0 + t * .97) * .16
          + sin(dot(p, vec2(.92, .39)) * 29.0 - t * 1.45) * .07;
  h *= .0016;
  for (int i = 0; i < 6; i++) {
    vec4 r = rip[i];
    if (r.w <= 0.) continue;
    float d = length(p - r.xy), w = d - r.z * .2;
    h += sin(w * 95.) * exp(-w * w / .0011) * exp(-r.z * 1.25) * r.w;
  }
  return h;
}
void main(){
  float ar = R.x / R.y;
  vec2 p = vec2(v.x * ar, v.y);
  float e = 1.5 / R.y;
  float h = wave(p);
  vec2 n = vec2(wave(p + vec2(e, 0.)) - h, wave(p + vec2(0., e)) - h) / e;
  vec2 s = vec2(1.);
  if (ar > I.x / I.y) s.y = (I.x / I.y) / ar; else s.x = ar / (I.x / I.y);
  s /= 1.12;
  vec2 uv = (v - .5) * s + .5;
  uv.y += (drift - .5) * (1. - s.y) * .9;
  uv += n * .55;
  vec3 c = texture2D(T, clamp(uv, .001, .999)).rgb;
  float lum = dot(c, vec3(.3, .55, .15));
  vec3 N = normalize(vec3(-n * 9., 1.));
  float sp = pow(max(dot(N, normalize(vec3(.32, .5, 1.))), 0.), 70.);
  c += vec3(1., .97, .9) * sp * smoothstep(.28, .8, lum) * .55;
  c *= .80 + .06 * smoothstep(.2, .9, lum);
  gl_FragColor = vec4(c, 1.);
}`;
      const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      // 并行编译：逐帧问一下好了没有，不在主线程上干等；同时在后台解码背景图
      const par = gl.getExtension("KHR_parallel_shader_compile");
      const bmpP = (async () => { const im = new Image(); im.src = photo.currentSrc || photo.src; await im.decode(); return window.createImageBitmap ? createImageBitmap(im) : im; })();
      if (par) while (!gl.getProgramParameter(prog, par.COMPLETION_STATUS_KHR)) await new Promise((r) => requestAnimationFrame(r));
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const U = {}; ["T", "R", "I", "t", "drift", "rip"].forEach((k) => (U[k] = gl.getUniformLocation(prog, k === "rip" ? "rip[0]" : k)));
      // 预热绘制：底层（ANGLE / D3D）要到第一次真正绘制时才把着色器编译完，这一下可能上百毫秒。
      // 趁页面还静止（作品还没浮上来）用 1×1 的纹理先画一次，把这笔账提前付掉
      {
        const t1 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([14, 25, 20]));
        gl.uniform2f(U.R, canvas.width, canvas.height); gl.uniform2f(U.I, 1, 1);
        gl.viewport(0, 0, 1, 1); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.deleteTexture(t1);
      }
      const bmp = await bmpP;
      await new Promise((r) => requestAnimationFrame(r));     // 纹理上传单独占一帧
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bmp);
      gl.uniform1i(U.T, 0); gl.uniform2f(U.I, bmp.width, bmp.height);
      gl.viewport(0, 0, canvas.width, canvas.height);

      const rips = new Float32Array(24);                 // 6 圈涟漪：x, y, 年龄（秒）, 强度
      let ri = 0, paused = false, raf = 0, slow = 0, dtAvg = 16, last = 0, active = performance.now(), odd = false, docMax = 1, sy = scrollY;
      const t0 = performance.now();
      const resize = () => { size(); gl.viewport(0, 0, canvas.width, canvas.height); };
      const measure = () => { docMax = Math.max(1, document.documentElement.scrollHeight - innerHeight); };
      const kick = () => { if (!raf && !paused) raf = requestAnimationFrame(frame); };
      const poke = () => { active = performance.now(); kick(); };
      function ripple(x, y, amp) {
        const o = (ri++ % 6) * 4;
        rips[o] = (x / innerWidth) * (innerWidth / innerHeight); rips[o + 1] = 1 - y / innerHeight; rips[o + 2] = 0; rips[o + 3] = amp;
        poke();
      }
      function frame(now) {
        raf = 0;
        if (paused || document.hidden) return;
        raf = requestAnimationFrame(frame);
        // 空闲（2.5 秒没有指针、滚动、涟漪）时隔帧绘制：水流很慢，半帧率看不出，GPU 省一半
        const live = rips[3] > 0 || rips[7] > 0 || rips[11] > 0 || rips[15] > 0 || rips[19] > 0 || rips[23] > 0;
        odd = !odd;
        if (!live && now - active > 2500 && odd) return;
        const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
        dtAvg += (dt * 1000 - dtAvg) * 0.05;
        if (dtAvg > 26 && q > 0.36 && (live || now - active <= 2500)) { if (++slow > 40) { q *= 0.8; slow = 0; resize(); } } else slow = 0;
        for (let k = 0; k < 6; k++) if (rips[k * 4 + 3] > 0) { rips[k * 4 + 2] += dt; if (rips[k * 4 + 2] > 4) rips[k * 4 + 3] = 0; }
        gl.uniform2f(U.R, canvas.width, canvas.height);
        gl.uniform1f(U.t, (now - t0) / 1000);
        gl.uniform1f(U.drift, clamp(sy / docMax, 0, 1));          // 不在这里读 scrollY：版面有变动时读它会逼浏览器同步重排整页
        gl.uniform4fv(U.rip, rips);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      measure();
      addEventListener("resize", () => { resize(); measure(); poke(); });
      addEventListener("scroll", () => { sy = scrollY; poke(); }, { passive: true });
      new ResizeObserver(measure).observe(document.body);
      document.addEventListener("visibilitychange", kick);
      // 指针划过水面留下一道很轻的尾波；按下去荡开一圈
      let lx = -1e3, ly = -1e3, lt = 0;
      addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse") return;
        active = performance.now();
        if (active - lt > 140 && Math.hypot(e.clientX - lx, e.clientY - ly) > 48) { lx = e.clientX; ly = e.clientY; lt = active; ripple(lx, ly, 0.00055); }
      }, { passive: true });
      addEventListener("pointerdown", (e) => { if (!st) ripple(e.clientX, e.clientY, 0.0016); }, { passive: true });
      api.ripple = ripple;
      api.pause = (v) => { paused = v; if (!v) { last = 0; poke(); } };
      pending.splice(0).forEach((x) => ripple(...x));
      poke();
      requestAnimationFrame(() => box.classList.add("is-live"));
    }
  })();

  start();
})();
