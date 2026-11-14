/* ==========================================================================
   かたわれ時 — 阅读体验
   原则：不劫持滚动；正文段落不做任何动画；所有动效都只发生在图像、标题和页边。
   ========================================================================== */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const html = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const smooth = (t) => t * t * (3 - 2 * t);
  const store = {
    get(k) { try { return localStorage.getItem("kata:" + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("kata:" + k, v); } catch (e) {} },
  };

  /* ---------- 滑行：目录 / 章节跳转的统一滚动（只在读者明确要求跳转时才动，平时绝不接管滚动） ----------
     近处（两屏以内）：一段缓入缓出的滑行，时长随距离增长（0.5–1.1s）。
     远处：不让画面在几十屏的正文里“飞”过去（看不清、也白白排版沿途的图片）——
       正文先淡下去（0.22s），在目标前约半屏处落下，再一边滑完最后这半屏、一边淡回来。
     读者一碰滚轮 / 触屏 / 键盘就立即停下，交还控制。 */
  let glideRaf = 0, glideStop = null;
  const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // top 可以是数，也可以是函数（每帧重新取目标：图片还在加载、版面在变时，落点跟着标题走）
  function glide(top, { done } = {}) {
    glideStop && glideStop();
    const want = top, live = typeof want === "function";
    const target = () => clamp(Math.round(live ? want() : want), 0, Math.max(0, document.documentElement.scrollHeight - innerHeight));
    top = target();
    const from = scrollY, dist = top - from, h = innerHeight;
    const finish = () => { glideStop = null; done && done(); };
    if (reduce || Math.abs(dist) < 2) { scrollTo(0, top); finish(); return; }
    const main = $("main");
    let cancelled = false, fadeT = 0;
    const evs = ["wheel", "touchstart", "pointerdown", "keydown"];
    const stop = () => {
      cancelled = true; cancelAnimationFrame(glideRaf); clearTimeout(fadeT); glideRaf = 0;
      evs.forEach((t) => removeEventListener(t, stop, true));
      if (main) { main.style.opacity = ""; main.style.transition = ""; }
      glideStop = null;
    };
    glideStop = stop;
    const run = (start, d, dur, after) => {
      const t0 = performance.now();
      const step = (now) => {
        if (cancelled) return;
        const k = Math.min(1, (now - t0) / dur);
        if (live) d = target() - start;
        scrollTo(0, start + d * inOut(k));
        if (k < 1) glideRaf = requestAnimationFrame(step); else { glideRaf = 0; after(); }
      };
      glideRaf = requestAnimationFrame(step);
    };
    const end = () => { evs.forEach((t) => removeEventListener(t, stop, true)); if (main) main.style.transition = ""; finish(); };
    // 跳转本身的点击 / 按键已经发生过了，从下一刻起读者的任何操作都打断滑行
    setTimeout(() => evs.forEach((t) => addEventListener(t, stop, { capture: true, passive: true })), 0);
    if (Math.abs(dist) <= h * 2.2 || !main) {
      run(from, dist, Math.min(1100, 460 + Math.sqrt(Math.abs(dist)) * 12), end);
      return;
    }
    const near = top - Math.sign(dist) * h * 0.55;
    main.style.transition = "opacity .22s cubic-bezier(.4, 0, 1, 1)";
    main.style.opacity = "0";
    fadeT = setTimeout(() => {
      if (cancelled) return;
      scrollTo(0, near);
      requestAnimationFrame(() => {
        if (cancelled) return;
        main.style.transition = "opacity .7s cubic-bezier(.22, .61, .36, 1)";
        main.style.opacity = "";
        run(near, top - near, 760, end);
      });
    }, 230);
  }

  /* ---------- 阅读偏好（尽早应用，避免闪烁） ---------- */
  const prefs = { size: store.get("size") || "m", leading: store.get("leading") || "normal", theme: store.get("theme") || "story" };
  function applyPrefs() {
    html.dataset.size = prefs.size;
    html.dataset.leading = prefs.leading;
    if (prefs.theme === "story") delete html.dataset.theme; else html.dataset.theme = prefs.theme;
  }
  applyPrefs();

  /* ---------- 滚动状态：一处读，多处用 ---------- */
  let vh = innerHeight, docMax = 1, sy = scrollY, lastSy = sy, ticking = false;
  const onScrollFns = [];
  const onResizeFns = [];
  function measure() {
    vh = innerHeight;
    docMax = Math.max(1, document.documentElement.scrollHeight - vh);
    onResizeFns.forEach((f) => f());
  }
  /* 重量版面：不在脚本里同步读（页面正在填内容时，读一次 scrollHeight 就是整页同步排版一次），
     而是借一个 ResizeObserver 的首次回调——它在浏览器自己排完版之后才触发，那时读版面是免费的 */
  let remeasure = false;
  const postLayout = new ResizeObserver(() => { postLayout.disconnect(); remeasure = false; measure(); tick(); });
  function scheduleMeasure() { if (remeasure) return; remeasure = true; postLayout.observe(document.documentElement); }
  function tick() {
    ticking = false;
    sy = scrollY;
    onScrollFns.forEach((f) => f(sy, sy - lastSy));
    lastSy = sy;
  }
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(tick); } }, { passive: true });
  addEventListener("resize", () => { measure(); tick(); });

  /* ---------- 顶栏 & 彗星进度 ---------- */
  function setupBar() {
    const bar = $(".bar");
    const comet = $(".comet");
    if (!bar) return;
    const darkStages = $$("[data-dark-stage]");
    const chapters = $$("[data-chapter]");
    const label = $(".bar__chapter span");
    let current = null, hiddenAt = 0;

    // 章节刻度
    const ticks = comet ? $(".comet__ticks", comet) : null;
    let tickEls = [];
    function layoutTicks() {
      if (!ticks) return;
      ticks.innerHTML = "";
      tickEls = chapters.map((c) => {
        const t = document.createElement("i");
        t.className = "comet__tick";
        const top = c.getBoundingClientRect().top + scrollY;
        t.style.left = (clamp(top / docMax) * 100).toFixed(3) + "%";
        t.__top = top;
        ticks.appendChild(t);
        return t;
      });
    }
    onResizeFns.push(layoutTicks);
    // 位置只在版面变化时量一次（滚动时一次都不读版面：读会迫使浏览器同步重排整页长文）
    onResizeFns.push(() => {
      darkStages.forEach((s) => { const m = $(".mist", s); const r = s.getBoundingClientRect(); s.__top = r.top + scrollY; s.__bottom = r.bottom + scrollY - (m ? m.offsetHeight * 0.62 : 0); });
      chapters.forEach((c) => (c.__top = c.getBoundingClientRect().top + scrollY));
    });

    onScrollFns.push((y, dy) => {
      const p = clamp(y / docMax);
      comet && comet.style.setProperty("--p", p.toFixed(4));
      tickEls.forEach((t) => t.classList.toggle("is-past", y + vh * 0.4 >= t.__top));

      // 自动隐藏：向下读时让出画面，向上找时回来
      const drawerOpen = document.body.classList.contains("drawer-open");
      if (!drawerOpen) {
        if (y < 120 || dy < -6) bar.classList.remove("is-hidden");
        else if (dy > 6 && y - hiddenAt > 40) { bar.classList.add("is-hidden"); hiddenAt = y; }
        if (dy < 0) hiddenAt = y;
      }

      // 是否压在大图上（封面底部的云海是纸色，不算“图上”）
      const over = darkStages.some((s) => s.__top - y <= 10 && s.__bottom - y >= 60);
      bar.toggleAttribute("data-over-image", over);

      // 当前章节
      let cur = null;
      for (const c of chapters) if (c.__top - y < vh * 0.45) cur = c;
      if (cur !== current) {
        current = cur;
        const text = cur ? cur.dataset.chapter : (label && label.dataset.default) || "";
        if (label) {
          label.classList.add("is-out");
          setTimeout(() => { label.textContent = text; label.classList.remove("is-out"); }, reduce ? 0 : 280);
        }
        $$(".toc a").forEach((a) => a.setAttribute("aria-current", cur && a.getAttribute("href") === "#" + cur.id ? "true" : "false"));
      }
    });
  }

  /* ---------- 时段：昼夜随叙事流转 ---------- */
  function setupPhase() {
    const markers = $$("[data-phase-at]");
    if (!markers.length) return;
    const base = html.dataset.phase || "hiru";
    let cur = base;
    onResizeFns.push(() => markers.forEach((m) => { const r = m.getBoundingClientRect(); m.__at = r.top + scrollY + r.height * parseFloat(m.dataset.phaseAt); }));
    onScrollFns.push((y) => {
      let ph = base;
      for (const m of markers) if (m.__at - y < vh * 0.5) ph = m.dataset.phase;
      if (ph !== cur) { cur = ph; html.dataset.phase = ph; document.dispatchEvent(new CustomEvent("phase", { detail: ph })); }
    });
  }

  /* ---------- 章节开场：镜头缓推 + 标题出入 ---------- */
  function setupOpeners() {
    const ops = $$(".opener, .post-hero");
    if (!ops.length) return;
    const data = ops.map((el) => ({ el, stage: $(".opener__stage", el), top: 0, h: 1, hero: el.classList.contains("post-hero") }));
    const layout = () => data.forEach((d) => { d.top = d.el.getBoundingClientRect().top + scrollY; d.h = d.el.offsetHeight; });
    onResizeFns.push(layout);
    onScrollFns.push((y) => {
      for (const d of data) {
        const p = clamp((y - d.top) / Math.max(1, d.h - vh));
        if (y + vh < d.top - 50 || y > d.top + d.h + vh) continue;
        const s = d.stage.style;
        if (d.hero) {
          // 题图文字按“实际滚了多少”来退场，而不是按 1/4 屏的跑道进度：
          // 标题以比页面慢的速度上移（有纵深），滚过大半屏才完全淡去；底部化入纸面也拉长到一整屏，
          // 不会再像一块白布从下往上把标题盖掉。跑道结束后题图随页面自然离开，文字仍在慢慢淡出。
          const r = Math.max(0, y - d.top) / vh;              // 已滚动的屏数（可大于跑道长度）
          s.setProperty("--dolly", (1.04 + 0.05 * p).toFixed(4));
          s.setProperty("--shade", (0.9 + Math.min(1, r) * 0.1).toFixed(3));
          s.setProperty("--mask-from", (100 - smooth(clamp(r / 1.1)) * 46).toFixed(2) + "%");
          const head = $(".post-hero__head", d.el);
          if (head) {
            head.style.opacity = (1 - smooth(clamp((r - 0.12) / 0.62))).toFixed(3);
            head.style.transform = `translate3d(0, ${(-r * vh * 0.22).toFixed(1)}px, 0)`;
          }
        } else {
          s.setProperty("--dolly", (1.14 - 0.12 * ease(p)).toFixed(4));
          const tin = clamp((p - 0.06) / 0.22) * (1 - clamp((p - 0.7) / 0.2));
          s.setProperty("--t-in", ease(tin).toFixed(3));
          s.setProperty("--mask-from", (100 - clamp((p - 0.62) / 0.38) * 55).toFixed(2) + "%");
        }
      }
    });
  }

  /* ---------- 侧注 ---------- */
  function setupSidenotes() {
    const wide = matchMedia("(min-width: 1180px)");
    const refs = $$(".sn-ref");
    refs.forEach((ref) => {
      const note = document.getElementById(ref.getAttribute("aria-controls"));
      if (!note) return;
      ref.addEventListener("click", (e) => {
        e.preventDefault();
        if (wide.matches) return;
        const open = note.classList.toggle("is-open");
        ref.setAttribute("aria-expanded", open);
      });
      ref.addEventListener("mouseenter", () => note.classList.add("is-hot"));
      ref.addEventListener("mouseleave", () => note.classList.remove("is-hot"));
    });
    // 防止页边侧注互相重叠
    function stack() {
      const notes = $$(".sn");
      notes.forEach((n) => (n.style.transform = ""));
      if (!wide.matches) return;
      let lastBottom = -1e9;
      notes.forEach((n) => {
        const r = n.getBoundingClientRect();
        const top = r.top + scrollY;
        const shift = Math.max(0, lastBottom + 18 - top);
        if (shift) n.style.transform = `translateY(${shift}px)`;
        lastBottom = top + shift + r.height;
      });
    }
    onResizeFns.push(stack);
    document.fonts && document.fonts.ready.then(stack);
  }

  /* ---------- 抽屉：目录 / 设置 ---------- */
  function setupDrawer() {
    const drawer = $(".drawer");
    if (!drawer) return;
    const scrim = $(".scrim");
    let lastFocus = null;
    const open = () => {
      lastFocus = document.activeElement;
      drawer.classList.add("is-open"); scrim.classList.add("is-on");
      document.body.classList.add("drawer-open");
      drawer.setAttribute("aria-hidden", "false");
      setTimeout(() => $("button, a", drawer).focus({ preventScroll: true }), 50);
    };
    const close = () => {
      drawer.classList.remove("is-open"); scrim.classList.remove("is-on");
      document.body.classList.remove("drawer-open");
      drawer.setAttribute("aria-hidden", "true");
      lastFocus && lastFocus.focus({ preventScroll: true });
    };
    $$("[data-open-drawer]").forEach((b) => b.addEventListener("click", open));
    $$("[data-close-drawer]").forEach((b) => b.addEventListener("click", close));
    scrim.addEventListener("click", close);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer.classList.contains("is-open")) close(); });
    $$(".toc a").forEach((a) => a.addEventListener("click", (e) => {
      const t = document.querySelector(a.getAttribute("href"));
      if (!t) return;
      e.preventDefault(); close();
      // 跳到章节开场的“画面完全铺满”处；文章页的标题由 blog.js 的章节导航接管（落点、到达时的提示一致）
      if (window.KataSections && window.KataSections.go(a.getAttribute("href"))) return;
      const top = t.getBoundingClientRect().top + scrollY + (t.classList.contains("opener") ? vh * 0.42 : -80);
      glide(top);
      history.replaceState(null, "", a.getAttribute("href"));
    }));

    // 设置
    $$(".seg[data-pref]").forEach((seg) => {
      const key = seg.dataset.pref;
      const sync = () => $$("button", seg).forEach((b) => b.setAttribute("aria-pressed", String(b.value === prefs[key])));
      sync();
      seg.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        prefs[key] = b.value; store.set(key, b.value); applyPrefs(); sync();
        requestAnimationFrame(() => { measure(); tick(); });
      });
    });
  }

  /* ---------- 显影 / 红绳 ---------- */
  let revealIO = null;
  function observeReveal(root = document) {
    $$(".thread path", root).forEach((p) => { try { p.style.setProperty("--len", Math.ceil(p.getTotalLength()) + 2); } catch (e) {} });
    revealIO = revealIO || new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); revealIO.unobserve(e.target); } }), { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    $$("[data-reveal], .thread", root).forEach((el) => { if (!el.classList.contains("is-in")) revealIO.observe(el); });
  }
  function setupReveal() { observeReveal(document); }

  /* ---------- 双联画：⇄ 交换 ---------- */
  function setupDiptychs() {
    $$(".diptych").forEach((d) => {
      const btn = $(".diptych__swap", d);
      const pair = $(".diptych__pair", d);
      if (!btn || !pair) return;
      btn.addEventListener("click", () => {
        const cells = $$(".diptych__cell", pair);
        const first = cells.map((c) => c.getBoundingClientRect());
        pair.insertBefore(cells[1], cells[0]);
        if (reduce) return;
        cells.forEach((c, i) => {
          const last = c.getBoundingClientRect();
          const dx = first[i].left - last.left;
          c.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 1100, easing: "cubic-bezier(.65,.05,.25,1)" });
          const img = $("img", c);
          img && img.animate([{ filter: "brightness(1.35) blur(3px)" }, { filter: "none" }], { duration: 1100, easing: "ease-out" });
        });
        btn.classList.toggle("is-swapped");
      });
    });
  }

  /* ---------- 灯箱（FLIP） ---------- */
  let bindLightbox = () => {};
  function setupLightbox() {
    let box = null;
    let state = null;
    function ensureBox() {
      if (box) return;
      box = document.createElement("div");
      box.className = "lightbox";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.innerHTML = '<div class="lightbox__bg"></div><p class="lightbox__cap"></p>';
      document.body.appendChild(box);
      box.addEventListener("click", close);
      addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      addEventListener("scroll", () => { if (state && Math.abs(scrollY - state.y0) > 80) close(); }, { passive: true });
    }

    // FLIP：等比缩放 + 裁切展开（缩略图是 cover 裁切的，用非等比缩放飞会把画面拉变形）
    const EASE = "cubic-bezier(.65,.05,.25,1)";
    function geom(r, w, h) {
      const k = Math.max(r.width / w, r.height / h);                 // 与缩略图一样按 cover 铺满
      const ix = Math.max(0, (w - r.width / k) / 2), iy = Math.max(0, (h - r.height / k) / 2);
      return {
        transform: `translate(${(r.left + r.width / 2 - (w * k) / 2).toFixed(1)}px, ${(r.top + r.height / 2 - (h * k) / 2).toFixed(1)}px) scale(${k.toFixed(4)})`,
        clipPath: `inset(${iy.toFixed(1)}px ${ix.toFixed(1)}px)`,
      };
    }
    function openFrom(trigger) {
      const src = $("img", trigger);
      if (!src) return;
      const r = trigger.getBoundingClientRect();
      ensureBox();
      const ar = (src.naturalWidth || 16) / (src.naturalHeight || 9);
      const maxW = innerWidth * 0.92, maxH = innerHeight * 0.84;
      let w = maxW, h = w / ar; if (h > maxH) { h = maxH; w = h * ar; }
      const x = (innerWidth - w) / 2, y = (innerHeight - h) / 2 - innerHeight * 0.02;
      const img = new Image();
      img.className = "lightbox__img"; img.alt = src.alt || "";
      img.src = src.currentSrc || src.src;                           // 先用已经在内存里的这张，飞行全程有画面
      const full = src.currentSrc ? src.currentSrc.replace(/-960\.webp/, "-1600.webp") : "";
      if (full && full !== img.src) { const hi = new Image(); hi.src = full; hi.decode().then(() => { if (img.isConnected) img.src = full; }).catch(() => {}); }
      img.style.width = w + "px"; img.style.height = h + "px"; img.style.objectFit = "cover";
      box.appendChild(img);
      const cap = trigger.closest("figure") ? trigger.closest("figure").querySelector("figcaption") : null;
      $(".lightbox__cap", box).textContent = src.alt || (cap ? cap.textContent.trim() : "");
      const to = { transform: `translate(${x}px, ${y}px) scale(1)`, clipPath: "inset(0px 0px)" };
      img.style.transform = to.transform;
      trigger.style.visibility = "hidden";
      box.classList.add("is-open");
      if (!reduce) img.animate([geom(r, w, h), to], { duration: 820, easing: EASE });
      state = { trigger, img, to, y0: scrollY };
    }
    function close() {
      if (!state) return;
      const { trigger, img, to } = state;
      const r = trigger.getBoundingClientRect();
      const w = parseFloat(img.style.width), h = parseFloat(img.style.height);
      box.classList.remove("is-open");
      const done = () => { img.remove(); trigger.style.visibility = ""; };
      if (reduce) done();
      else { const back = geom(r, w, h); img.animate([to, back], { duration: 640, easing: EASE, fill: "forwards" }).onfinish = done; }
      state = null;
    }
    bindLightbox = (root = document) => {
      $$(".fig__frame, .diptych__cell", root).filter((t) => !t.closest(".loop") && !t.__lb).forEach((t) => {
        t.__lb = true;
        t.setAttribute("tabindex", "0");
        t.setAttribute("role", "button");
        t.setAttribute("aria-label", "放大查看");
        t.addEventListener("click", () => openFrom(t));
        t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFrom(t); } });
      });
    };
    bindLightbox(document);
  }

  /* ---------- 视频循环：只在可见时播放 ---------- */
  function setupLoops() {
    const vids = $$("video[data-loop]");
    if (!vids.length) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      const v = e.target;
      if (e.isIntersecting && !reduce) { v.play().catch(() => {}); } else v.pause();
    }), { threshold: 0.2 });
    vids.forEach((v) => { v.muted = true; v.playsInline = true; io.observe(v); });
  }

  /* ---------- 收尾：东京 夜 → 晨 ---------- */
  function setupScrub() {
    const el = $(".scrub");
    if (!el) return;
    const canvas = $("canvas", el);
    const ctx = canvas.getContext("2d");
    const N = parseInt(el.dataset.frames || "64", 10);
    const small = innerWidth < 900 || (navigator.connection && navigator.connection.saveData);
    const pattern = el.dataset.src.replace("{w}", small ? "960" : "1600");
    const frames = new Array(N);
    const clock = $(".scrub__clock", el);
    const lines = $$(".scrub__line", el);
    const stage = $(".scrub__stage", el);
    let started = false, top = 0, h = 1, curF = -1;

    function load(i) {
      if (frames[i]) return;
      const im = new Image();
      im.decoding = "async";
      im.src = pattern.replace("{i}", String(i).padStart(2, "0"));
      frames[i] = im;
      im.onload = () => { im.__ok = true; if (Math.abs(i - curF) < 2) draw(curF, true); };
    }
    function start() {
      if (started) return; started = true;
      // 先粗后细：先拿到每 8 帧，再补齐
      for (let s = 8; s >= 1; s = s >> 1) for (let i = 0; i < N; i += s) load(i);
    }
    function nearest(i) {
      for (let d = 0; d < N; d++) {
        if (frames[i - d] && frames[i - d].__ok) return i - d;
        if (frames[i + d] && frames[i + d].__ok) return i + d;
      }
      return -1;
    }
    function size() {
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(stage.clientWidth * dpr);
      canvas.height = Math.round(stage.clientHeight * dpr);
      top = el.getBoundingClientRect().top + scrollY; h = el.offsetHeight;
      draw(curF, true);
    }
    function cover(im) {
      const cw = canvas.width, ch = canvas.height, ir = im.naturalWidth / im.naturalHeight, cr = cw / ch;
      let w, hh; if (cr > ir) { w = cw; hh = cw / ir; } else { hh = ch; w = ch * ir; }
      return [(cw - w) / 2, (ch - hh) / 2, w, hh];
    }
    function draw(f, force) {
      if (f < 0) return;
      const fi = Math.floor(f), t = f - fi;
      const a = nearest(fi), b = nearest(Math.min(N - 1, fi + 1));
      if (a < 0) return;
      ctx.globalAlpha = 1;
      const ia = frames[a]; ctx.drawImage(ia, ...cover(ia));
      if (b >= 0 && b !== a && t > 0.01) { ctx.globalAlpha = t; const ib = frames[b]; ctx.drawImage(ib, ...cover(ib)); }
    }
    onResizeFns.push(size);
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) start(); }, { rootMargin: "150% 0px" });
    io.observe(el);

    // 时间：04:38 → 06:47（日出约在 0.42 处）
    const t0 = 4 * 60 + 38, t1 = 6 * 60 + 47;
    onScrollFns.push((y) => {
      if (y + vh < top - 100 || y > top + h + 100) return;
      const p = clamp((y - top) / Math.max(1, h - vh));
      const f = p * (N - 1);
      if (Math.abs(f - curF) > 0.02) { curF = f; draw(f); }
      const m = Math.round(t0 + (t1 - t0) * p);
      if (clock) clock.textContent = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      lines.forEach((l) => {
        const [a, b] = l.dataset.range.split(",").map(Number);
        l.classList.toggle("is-on", p >= a && p < b);
      });
      stage.style.setProperty("--shade", (1 - p * 0.25).toFixed(3));
    });
  }

  /* ---------- 首次访问的开场：彗星的尾迹 = 真实的加载进度 ----------
     四项任务各占一份权重（页面、字体、首屏大图、2.5D 画面；文章数据在首屏之外，不让开场等慢源站）；显示进度平滑追赶真实进度，
     另有一条随时间缓慢上升的下限，不会卡在某个百分比不动。到达后彗核闪亮、红色碎片一闪，再溶入首页。 */
  function runIntro(intro, ready) {
    const base = $(".intro__base", intro), core = $(".intro__core", intro);
    const rnd = (a, b) => a + Math.random() * (b - a);
    const trails = $$(".intro__trail, .intro__core", intro), pct = $(".intro__pct span", intro);
    const len = core.getTotalLength();
    const t0 = performance.now();
    const MIN = 1500, MAX = 4500;
    const done = {};
    const W = { dom: 0.15, fonts: 0.3, hero: 0.35, depth: 0.2 };
    const mark = (k) => { done[k] = true; };
    const loaded = () => { intro.classList.add("is-loaded"); afterState(); };
    if (base.complete && base.naturalWidth) loaded(); else { base.addEventListener("load", loaded, { once: true }); base.addEventListener("error", loaded, { once: true }); }
    mark("dom");
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => mark("fonts"));
    const heroImg = $(".home-hero img");
    if (!heroImg || heroImg.complete) mark("hero");
    else { heroImg.addEventListener("load", () => mark("hero"), { once: true }); heroImg.addEventListener("error", () => mark("hero"), { once: true }); }
    let p = 0, last = t0, finished = false;
    // 屏幕实际能看到的那段尾迹从哪里开始（竖屏只露出靠近彗核的一段）：画面外的部分一开始就亮着，
    // 0–100% 的进度全部落在看得见的这段上
    const frameEl = $(".intro__frame", intro);
    let p0 = 0;
    const visibleStart = () => {
      const fw = frameEl.offsetWidth, cx = parseFloat(getComputedStyle(frameEl).getPropertyValue("--cx")) / 100 || 0.5;
      const left = innerWidth / 2 - cx * fw;
      for (let i = 0; i <= 100; i++) {
        const pt = core.getPointAtLength((i / 100) * len);
        const x = (pt.x / 1000) * fw + left;
        if (x > 8 && x < innerWidth - 8) return Math.max(0, (i - 2) / 100);
      }
      return 0;
    };
    p0 = visibleStart();
    // 流星画在一张全屏画布上（flare.js）：画布不透明、用 screen 混合，等于只给海报“加光”；
    // 首帧（350ms 后）才建精灵与路径采样，不占页面初始化的那一下
    const fxCanvas = document.createElement("canvas");
    fxCanvas.className = "intro__fx";
    intro.insertBefore(fxCanvas, $(".intro__word", intro));
    $$(".intro__head, .intro__frag", intro).forEach((el) => el.remove());
    let fx = null, fxw = null, alive = true, vNow = p0;   // vNow：当前进度（0~1 的路径位置），由 set() 更新
    /* 海报框的屏幕矩形：框有一段 CSS 缩放过渡（scale 1.06 → 1.02 → 1 → 1.035）。不逐帧读 getBoundingClientRect——
       开场这几秒页面还在往里填内容，每读一次就是整页同步排版一次；改为从过渡本身推算：
       未缩放的几何只量一次，缩放值按过渡的起止、时长与缓动曲线算出，每次换状态后对一下真实的过渡 */
    const bez = ((x1, y1, x2, y2) => (x) => {        // cubic-bezier(.2,.6,.2,1)：牛顿迭代解 t，再求 y
      let t = x;
      for (let i = 0; i < 6; i++) {
        const e = 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3 - x;
        const d = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
        if (Math.abs(e) < 1e-5 || !d) break;
        t = Math.min(1, Math.max(0, t - e / d));
      }
      return 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
    })(0.2, 0.6, 0.2, 1);
    const geo = { W: 0, H: 0, cx: 0.5, iw: innerWidth, ih: innerHeight };
    const measureGeo = () => {
      geo.W = frameEl.offsetWidth; geo.H = frameEl.offsetHeight; geo.iw = innerWidth; geo.ih = innerHeight;
      geo.cx = parseFloat(getComputedStyle(frameEl).getPropertyValue("--cx")) / 100 || 0.5;
    };
    const scaleOf = (tf) => { const m = /matrix\(([^,]+)/.exec(tf || "") || /scale\(([^)]+)\)/.exec(tf || ""); return m ? parseFloat(m[1]) : 1; };
    let zs = { from: 1.06, to: 1.06, t: 0, dur: 1 };
    const scaleAt = (now) => zs.from + (zs.to - zs.from) * bez(Math.min(1, Math.max(0, (now - zs.t) / zs.dur)));
    function syncScale() {          // 读一次当前的过渡（只在开始和每次换状态后各一次）
      const a = frameEl.getAnimations ? frameEl.getAnimations().find((x) => x.transitionProperty === "transform") : null;
      if (a && a.effect) {
        const kf = a.effect.getKeyframes();
        zs = { from: scaleOf(kf[0].transform), to: scaleOf(kf[kf.length - 1].transform), t: a.startTime == null ? performance.now() : a.startTime, dur: a.effect.getTiming().duration || 1 };
      } else { const sc = scaleOf(getComputedStyle(frameEl).transform); zs = { from: sc, to: sc, t: 0, dur: 1 }; }
    }
    const rectAt = (now) => {       // transform-origin: 30% 48%
      const k = scaleAt(now), { W, H, cx, iw, ih } = geo;
      return { left: iw / 2 - cx * W + 0.3 * W * (1 - k), top: ih / 2 - H / 2 + 0.48 * H * (1 - k), width: W * k, height: H * k };
    };
    window.__introRect = () => ({ model: rectAt(performance.now()), real: frameEl.getBoundingClientRect().toJSON() });   // 自检用
    const onResize = () => {
      measureGeo(); syncScale();
      const view = { W: innerWidth, H: innerHeight, dpr: devicePixelRatio || 1 };
      if (fxw) fxw.postMessage({ type: "resize", view }); else if (fx) fx.resize(view.W, view.H, view.dpr);
    };
    function fxLoop(now) {
      if (!alive) return;
      const rect = rectAt(now);
      if (fxw) fxw.postMessage({ type: "st", v: vNow, rect });
      else if (fx) fx.frame(now, vNow, rect);
      requestAnimationFrame(fxLoop);
    }
    function startFx() {
      const src = $('script[src*="flare.js"]');
      if (!window.KataFlare || !src) return;
      const NS = 320, samples = [];
      for (let i = 0; i <= NS; i++) { const pt = core.getPointAtLength((i / NS) * len); samples.push([pt.x, pt.y]); }
      measureGeo(); syncScale();
      const view = { W: innerWidth, H: innerHeight, dpr: devicePixelRatio || 1 };
      if (fxCanvas.transferControlToOffscreen && window.Worker) {
        try {
          const off = fxCanvas.transferControlToOffscreen();
          fxw = new Worker(src.src);
          fxw.postMessage({ type: "init", canvas: off, samples, vb: [1000, 552], view, v: vNow, rect: rectAt(performance.now()) }, [off]);
        } catch (e) { fxw = null; }
      }
      if (!fxw) fx = window.KataFlare(fxCanvas, samples, [1000, 552], view);
      addEventListener("resize", onResize);
      requestAnimationFrame(fxLoop);
    }
    function afterState() { requestAnimationFrame(() => requestAnimationFrame(syncScale)); }   // 提升声明：loaded() 可能在这之前就被调用；新状态的过渡在下一次样式计算时才开始
    const set = (prog) => {
      const v = p0 + (1 - p0) * prog;
      vNow = v;
      trails.forEach((el) => el.style.setProperty("--off", (1 - v).toFixed(4)));
      pct.textContent = String(Math.round(prog * 100)).padStart(3, "0");
    };
    function frame(now) {
      if (finished) return;
      const dt = Math.min(64, now - last); last = now;
      const el = now - t0;
      // 首屏 2.5D 画面已上线（慢设备上超过 2.2 秒就不再等：静态海报先顶着，视差随后无缝接上）
      if (!done.depth && ($(".home-hero .reel__slide.is-on .depth.is-live, .home-hero > .depth.is-live") || el > 2200)) mark("depth");
      let target = Object.keys(W).reduce((a, k) => a + (done[k] ? W[k] : 0), 0);
      target = Math.max(target, Math.min(0.9, el / MAX));            // 时间下限：不会停在一个数上
      if (el < MIN) target = Math.min(target, el / MIN);              // 缓存命中时也不会一闪而过
      p += (target - p) * Math.min(1, (dt / 1000) * 3.4);             // 平滑追赶（与帧率无关）
      p = Math.min(1, Math.max(p, 0));
      set(p);
      const all = Object.keys(W).every((k) => done[k]);
      if ((all && p > 0.985 && el >= MIN) || el > MAX) return finish();
      requestAnimationFrame(frame);
    }
    function finish() {
      if (finished) return;
      finished = true;
      set(1);
      intro.classList.add("is-arrived");                                   // 彗核到达：闪亮、碎片一闪、天空被照亮
      afterState();
      if (fxw) fxw.postMessage({ type: "arrive" }); else if (fx) fx.arrive();
      setTimeout(() => { intro.classList.add("is-done"); afterState(); ready(); }, reduce ? 0 : 900);
      setTimeout(() => { alive = false; removeEventListener("resize", onResize); if (fxw) fxw.postMessage({ type: "stop" }); intro.remove(); }, reduce ? 50 : 2300);
    }
    intro.addEventListener("click", finish);
    set(0);
    // 前 350ms 海报还在淡入，彗核先不动：页面初始化（脚本、WebGL 建立）的那一下卡顿发生在这段静止里，看不出来
    setTimeout(() => { startFx(); last = performance.now(); requestAnimationFrame(frame); }, 350);
  }

  /* ---------- 首页：开场 · 目录悬停预览 · 此刻时段 ---------- */
  function setupHome() {
    const intro = $(".intro");
    const ready = () => document.body.classList.add("is-ready");
    if (intro) {
      let seen = false;
      try { seen = sessionStorage.getItem("kata:intro") === "1"; } catch (e) {}
      if (seen || reduce) { intro.remove(); requestAnimationFrame(ready); }
      else {
        try { sessionStorage.setItem("kata:intro", "1"); } catch (e) {}
        runIntro(intro, ready);
      }
    } else requestAnimationFrame(() => requestAnimationFrame(ready));

    // 此刻：按读者本地时间给首页大图一个时段
    const now = $("[data-now]");
    if (now) {
      const hr = new Date().getHours();
      const ph = hr >= 5 && hr < 10 ? ["朝", "彼は誰時", -0.3] : hr >= 10 && hr < 16 ? ["昼", "ひる", 0] : hr >= 16 && hr < 19 ? ["黄昏", "誰そ彼時", 0.6] : ["夜", "よる", -0.7];
      now.innerHTML = `此刻 · <b>${ph[0]}</b> · ${ph[1]}`;
      const hero = $(".home-hero .depth");
      if (hero && hero.__scene) hero.__scene.grade = ph[2] * 0.5;
      else if (hero) hero.dataset.grade = String(ph[2] * 0.5);
    }

    bindPeek(document);
  }

  /* 目录：悬停时一张画面跟着光标缓缓移动（动态渲染的列表也可以再次调用） */
  const peekState = { imgs: {}, tx: 0, ty: 0, x: 0, y: 0, on: false, raf: 0 };
  function bindPeek(root = document) {
    const peek = $(".peek");
    const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (!peek || !finePointer || reduce) return;
    const s = peekState;
    const loop = () => {
      s.x += (s.tx - s.x) * 0.12; s.y += (s.ty - s.y) * 0.12;
      peek.style.transform = `translate(${s.x}px, ${s.y}px)`;
      s.raf = s.on || Math.abs(s.tx - s.x) > 0.5 ? requestAnimationFrame(loop) : 0;
    };
    $$("a[data-peek]", root).filter((a) => !a.__peek).forEach((a) => {
      a.__peek = true;
      const src = a.dataset.peek;
      const ensure = () => { if (!s.imgs[src]) { const i = new Image(); i.src = src; i.alt = ""; i.decoding = "async"; peek.appendChild(i); s.imgs[src] = i; } };
      a.addEventListener("mouseenter", (e) => {
        ensure();
        s.on = true; peek.classList.add("is-on");
        Object.values(s.imgs).forEach((i) => i.classList.toggle("is-on", i === s.imgs[src]));
        if (!s.raf) { s.x = s.tx = e.clientX + 40; s.y = s.ty = e.clientY - peek.offsetHeight / 2; s.raf = requestAnimationFrame(loop); }
      });
      a.addEventListener("mousemove", (e) => { s.tx = e.clientX + 40; s.ty = e.clientY - peek.offsetHeight / 2; });
      a.addEventListener("mouseleave", () => { s.on = false; peek.classList.remove("is-on"); });
    });
  }

  /* ---------- 手机竖屏：首屏换成竖版海报的视差轮播 ----------
     四张海报按一天的时段排列（白昼与夜晚是同一构图的昼 / 夜两版，相邻时像时间流过）。
     只有当前这张在渲染 WebGL；下一张先在后台准备好（视差已上线）再淡入，不会闪出静态图。 */
  const REEL = [
    { key: "po-day", ph: "hiru", label: "昼", haze: "#e6eef5", motes: 0, alt: "白昼的彗星下，东京与糸守分立两侧的泷与三叶" },
    { key: "po-night", ph: "yoru", label: "夜", haze: "#1d2d5c", motes: 0.6, alt: "夜空中划过城市上空的彗星" },
    { key: "po-dusk", ph: "tasogare", label: "黄昏", haze: "#f0cfc0", motes: 0.5, alt: "黄昏的云海之上，两人相对而立" },
    { key: "po-stairs", ph: "asa", label: "朝", haze: "#e3edf5", motes: 0, alt: "须贺神社的台阶" },
  ];
  const isPortraitPhone = () => matchMedia("(max-width: 720px) and (orientation: portrait)").matches;

  /* ---------- 桌面 / 横屏：首页顶部的轮播 ----------
     六个镜头按一天的时间走一圈：黄昏（彗星）→ 夜 → 晨 → 昼 → 午后 → 夕 → 回到黄昏。
     · 第一张就是首页原有的那张（不重建、不闪）；其余的在轮到之前才取图、才建 WebGL，离开画面后立即回收——任何时候最多两个场景在渲染
     · 换景：新的一张从雾里显影（由远及近），同时慢慢落定（1.07 → 1），上一张轻轻推近（1 → 1.045），中间一抹来自下一景的光晕漫过——全部是透明度与位移，在合成线程完成
     · 标题背后的暗影随画面明暗调整（明亮的白昼更深一点），保证小字可读 */
  const WIDE_REEL = [
    { key: "ps08", label: "黄昏 · 彗星", haze: "#f1cdbf", motes: 0.7, mote: "#ffe4cc", flare: 0.7, focus: 0.4, tint: "#8d7392", w: [960, 1600, 2400], shade: 0, bloom: "255 214 196", alt: "黄昏，彗星划过天空，下方的湖面倒映着粉色的云" },
    { key: "cm06", label: "夜 · 星空", haze: "#1d2d5c", motes: 0.6, mote: "#cfe0ff", flare: 0, focus: 0.5, tint: "#0f2340", w: [960, 1600, 2400], shade: 0, bloom: "150 182 255", alt: "夜空中划过城市上空的彗星" },
    { key: "bg12", label: "晨 · 雾", haze: "#f3dcc4", motes: 0.5, mote: "#fff0d8", flare: 0.5, focus: 0.5, tint: "#755d51", w: [960, 1600], shade: 0.55, bloom: "255 226 192", alt: "清晨，薄雾里的群山与穿过云层的阳光" },
    { key: "bg01", label: "昼 · 湖", haze: "#e6f0f2", motes: 0, mote: "#ffffff", flare: 0, focus: 0.5, tint: "#7c9085", w: [960, 1600, 2400], shade: 1, bloom: "255 255 244", alt: "白昼的湖，岸边的小镇与远山" },
    { key: "ur", label: "午后 · 云上", haze: "#f6d9b0", motes: 0.5, mote: "#ffe9c4", flare: 0.5, focus: 0.45, tint: "#705c63", w: [960, 1600], shade: 0.7, bloom: "255 226 172", alt: "云海之上，夕阳从积云的缝隙里照出来" },
    { key: "cm03", label: "夕 · 云海", haze: "#f0b89a", motes: 0.5, mote: "#ffd9b8", flare: 0.6, focus: 0.5, tint: "#52567f", w: [960, 1600, 2400], shade: 0.45, bloom: "255 192 144", alt: "落日之下，一望无际的云海" },
  ];
  function setupHeroReel() {
    const host = $(".home-hero[data-reel]");
    if (!host || isPortraitPhone() || host.classList.contains("has-reel")) return;
    const first = $(":scope > .depth", host);
    if (!first || !window.Depth) return;
    const N = WIDE_REEL.length;
    // 按当前屏幕挑一张够用的宽度（画布最多取源图宽度的 1.1 倍，更大的图没有用）
    const pickW = (S) => { const need = innerWidth * Math.min(devicePixelRatio || 1, 1.5); return S.w.find((w) => w >= need) || S.w[S.w.length - 1]; };
    const imgUrl = (S) => `assets/img/${S.key}-${pickW(S)}.webp`;
    const depthUrl = (S) => `assets/depth/${S.key}.webp`;

    const reel = document.createElement("div");
    reel.className = "reel";
    reel.innerHTML = WIDE_REEL.map((S, i) => i === 0 ? '<div class="reel__slide is-on"></div>' : `<div class="reel__slide"><div class="depth" style="--tint:${S.tint}" data-src="${depthUrl(S)}" data-strength=".034" data-focus="${S.focus}" data-haze="${S.key === "bg01" ? 0.1 : 0.16}" data-haze-color="${S.haze}" data-motes="${S.motes}" data-mote-color="${S.mote}" data-flare="${S.flare}"><picture><img alt="${S.alt}" width="1600" height="900" decoding="async"></picture></div></div>`).join("")
      + '<i class="reel__shade" aria-hidden="true"></i><i class="reel__bloom" aria-hidden="true"></i>';
    const slides = $$(".reel__slide", reel), shade = $(".reel__shade", reel), bloom = $(".reel__bloom", reel);
    first.dataset.src = first.dataset.depth;
    slides[0].__live = true;   // 第一张沿用页面里原有的场景：离开画面后同样回收
    slides[0].appendChild(first);
    host.prepend(reel);
    host.classList.add("has-reel", "has-reel--wide");
    shade.style.opacity = WIDE_REEL[0].shade;

    const rail = document.createElement("div");
    rail.className = "reel__rail";
    rail.setAttribute("role", "group");
    rail.setAttribute("aria-label", "封面镜头");
    rail.innerHTML = WIDE_REEL.map((S, i) => `<button type="button" class="reel__dot" data-i="${i}" aria-label="切换到：${S.label}"><span>${S.label}</span><i><b></b></i></button>`).join("");
    host.appendChild(rail);
    const dots = $$(".reel__dot", rail);

    const HOLD = 9000, FADE = 2600;
    let cur = 0, timer = 0, busy = false, onScreen = true, t0 = 0, left = HOLD;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const mark = (i) => dots.forEach((d, j) => { d.classList.toggle("is-on", j === i); d.classList.toggle("is-past", j < i); d.setAttribute("aria-current", String(j === i)); d.style.setProperty("--hold", HOLD + "ms"); });
    mark(0);

    // 轮到之前才取图、才建场景；离开之后回收
    function prepare(i) {
      const s = slides[i], d = $(".depth", s), img = $("img", s), S = WIDE_REEL[i];
      if (s.__live) return;
      s.__live = true;
      if (i > 0 || !img.currentSrc) { img.removeAttribute("srcset"); img.src = imgUrl(S); }
      d.dataset.depth = d.dataset.src;
      window.Depth.init(s);
    }
    function release(i) {
      const s = slides[i], d = $(".depth", s);
      if (!s.__live) return;
      s.__live = false;
      window.Depth.drop(d);
      delete d.dataset.depth;
      d.classList.remove("is-live", "is-in");
    }
    // 空闲时把下一张的图和深度图先拉进缓存（轮到它时只剩解码与上传）
    const warmed = new Set();
    function warm(i) {
      i = (i + N) % N;
      if (warmed.has(i) || i === 0 || (navigator.connection && navigator.connection.saveData)) return;
      warmed.add(i);
      const S = WIDE_REEL[i];
      (window.requestIdleCallback || ((f) => setTimeout(f, 600)))(() => { const im = new Image(); im.decoding = "async"; im.src = imgUrl(S); fetch(depthUrl(S), { priority: "low" }).catch(() => {}); }, { timeout: 3000 });
    }
    const ready = (slide) => new Promise((res) => {          // 等图解码完、视差上线（最多 2s；慢设备上静态图先顶着，视差随后无缝接上）
      const img = $("img", slide), d = $(".depth", slide), t = performance.now();
      (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(function poll() {
        if (d.classList.contains("is-live") || performance.now() - t > 2000 || reduce) res(); else requestAnimationFrame(poll);
      });
    });

    async function go(next) {
      if (busy || next === cur) return;
      busy = true; clearTimeout(timer);
      const prev = cur, from = slides[prev], to = slides[next], S = WIDE_REEL[next];
      prepare(next);
      to.classList.add("is-next");                              // 先在下层显示出来（透明），让视差在后台上线
      await ready(to);
      shade.style.opacity = S.shade;
      if (!reduce) {
        const sc = $(".depth", to).__scene;
        if (sc) { sc.reveal = 0; sc.revealStart = performance.now(); }   // 这一张从雾里显影
        bloom.style.setProperty("--bc", S.bloom);
        bloom.animate([{ opacity: 0 }, { opacity: 0.6, offset: 0.4 }, { opacity: 0 }], { duration: FADE + 600, easing: "ease-in-out" });
        to.animate([{ opacity: 0, transform: "scale(1.07)" }, { opacity: 1, transform: "scale(1)" }], { duration: FADE, easing: "cubic-bezier(.4, 0, .2, 1)" });
        from.animate([{ transform: "scale(1)" }, { transform: "scale(1.045)" }], { duration: FADE + 400, easing: "cubic-bezier(.3, 0, .4, 1)" });
        await wait(FADE);
      }
      to.classList.remove("is-next");
      cur = next;
      slides.forEach((s, j) => s.classList.toggle("is-on", j === cur));
      mark(cur);
      release(prev);
      busy = false;
      warm(cur + 1);
      schedule(HOLD);
    }
    function schedule(ms) {
      clearTimeout(timer); left = ms; t0 = performance.now();
      if (!reduce && onScreen && !document.hidden) timer = setTimeout(() => go((cur + 1) % N), ms);
    }
    const pause = () => { clearTimeout(timer); left = Math.max(400, left - (performance.now() - t0)); rail.classList.add("is-paused"); };
    const resume = () => { rail.classList.remove("is-paused"); if (!busy) schedule(left); };
    new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; onScreen ? resume() : pause(); }, { threshold: 0.2 }).observe(host);
    document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));
    rail.addEventListener("pointerenter", pause);
    rail.addEventListener("pointerleave", resume);
    rail.addEventListener("click", (e) => { const b = e.target.closest(".reel__dot"); if (b) go(+b.dataset.i); });

    // 开场结束、首页稳定下来再开始计时：第一张至少完整地停留一个 HOLD
    const begin = () => { warm(1); schedule(HOLD); };
    const afterIntro = () => (document.querySelector(".intro") ? setTimeout(afterIntro, 400) : setTimeout(begin, 600));
    afterIntro();
  }
  function setupReel() {
    const hosts = $$("[data-reel]");
    if (!hosts.length || !isPortraitPhone()) return;
    const hr = new Date().getHours();
    const nowPh = hr >= 5 && hr < 10 ? "asa" : hr >= 10 && hr < 16 ? "hiru" : hr >= 16 && hr < 19 ? "tasogare" : "yoru";
    hosts.forEach((host, hi) => {
      const old = $(":scope > .depth", host);
      const reel = document.createElement("div");
      reel.className = "reel";
      reel.innerHTML = REEL.map((s) => `<div class="reel__slide" data-ph="${s.ph}"><div class="depth" style="--tint:#3c4567" data-depth="assets/depth/${s.key}.webp" data-strength=".034" data-focus=".55" data-haze=".14" data-haze-color="${s.haze}" data-motes="${s.motes}" data-reveal="off">
        <img src="assets/img/${s.key}-800.webp" srcset="assets/img/${s.key}-800.webp 800w, assets/img/${s.key}-1200.webp 1200w" sizes="100vw" alt="${s.alt}" decoding="async" loading="lazy"></div></div>`).join("");
      const nav = document.createElement("div");
      nav.className = "reel__nav";
      nav.setAttribute("aria-hidden", "true");
      nav.innerHTML = REEL.map((s) => `<i data-label="${s.label}"><b></b></i>`).join("");
      if (old) old.replaceWith(reel); else host.prepend(reel);
      host.appendChild(nav);
      host.classList.add("has-reel");

      const slides = $$(".reel__slide", reel), marks = $$("i", nav);
      const HOLD = 7500, FADE = 1800;
      let cur = Math.max(0, REEL.findIndex((s) => s.ph === nowPh)), timer = 0, busy = false, onScreen = true, t0 = 0, left = HOLD;
      if (host.classList.contains("arch-hero")) cur = (cur + 2) % REEL.length; // 文库与首页错开，不显示同一张
      const show = (i) => slides.forEach((s, j) => s.classList.toggle("is-on", j === i));
      const mark = (i) => marks.forEach((m, j) => { m.classList.toggle("is-on", j === i); m.classList.toggle("is-past", j < i); m.style.setProperty("--hold", HOLD + "ms"); });
      show(cur); mark(cur);
      const ready = (slide) => new Promise((res) => {               // 等下一张的图解码完、视差上线（最多 1.6s）
        const img = $("img", slide), d = $(".depth", slide), t = performance.now();
        (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(function poll() {
          if (d.classList.contains("is-live") || performance.now() - t > 1600 || reduce) res(); else requestAnimationFrame(poll);
        });
      });
      async function go(next) {
        if (busy || next === cur) return;
        busy = true; clearTimeout(timer);
        const from = slides[cur], to = slides[next];
        to.classList.add("is-next");                                // 先在下层显示出来，让视差在后台上线
        await ready(to);
        if (!reduce) {
          to.animate([{ opacity: 0, transform: "scale(1.06)" }, { opacity: 1, transform: "scale(1)" }], { duration: FADE, easing: "cubic-bezier(.4,0,.2,1)" });
          from.animate([{ transform: "scale(1)" }, { transform: "scale(1.04)" }], { duration: FADE, easing: "cubic-bezier(.4,0,.2,1)" });
          await new Promise((r) => setTimeout(r, FADE));
        }
        to.classList.remove("is-next");
        cur = next; show(cur); mark(cur);
        busy = false; schedule(HOLD);
      }
      function schedule(ms) {
        clearTimeout(timer); left = ms; t0 = performance.now();
        if (onScreen && !document.hidden) timer = setTimeout(() => go((cur + 1) % REEL.length), ms);
      }
      function pause() { clearTimeout(timer); left = Math.max(400, left - (performance.now() - t0)); nav.classList.add("is-paused"); }
      function resume() { nav.classList.remove("is-paused"); if (!busy) schedule(left); }
      new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; onScreen ? resume() : pause(); }, { threshold: 0.2 }).observe(host);
      document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));
      // 左右滑动换张
      let sx = 0, sy0 = 0;
      host.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy0 = e.touches[0].clientY; }, { passive: true });
      host.addEventListener("touchend", (e) => {
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy0;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) go((cur + (dx < 0 ? 1 : REEL.length - 1)) % REEL.length);
      }, { passive: true });
      if (!reduce) schedule(HOLD);
    });
  }

  /* ---------- 续读：记住每篇读到哪里；下次打开时轻轻提示一句，不自动跳转 ---------- */
  function setupResume() {
    const b = document.body;
    if (!b.classList.contains("post") || b.classList.contains("archive-page") || !$(".prose")) return;
    const key = "pos:" + location.pathname + location.search;
    const saved = parseFloat(store.get(key) || "0");
    let lastSave = 0;
    onScrollFns.push((y) => {
      const now = Date.now();
      if (now - lastSave < 800 || docMax < vh) return;
      lastSave = now;
      store.set(key, (y / docMax).toFixed(4));
    });
    if (!(saved > 0.12 && saved < 0.94) || scrollY > vh * 0.3 || location.hash) return;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "resume";
    pill.innerHTML = `<i aria-hidden="true"></i>上次读到 <b>${Math.round(saved * 100)}%</b><span aria-hidden="true">·</span>继续`;
    b.appendChild(pill);
    let gone = false;
    const hide = () => { if (gone) return; gone = true; pill.classList.remove("is-on"); setTimeout(() => pill.remove(), 900); };
    setTimeout(() => !gone && pill.classList.add("is-on"), 1100);
    setTimeout(hide, 11000);
    pill.addEventListener("click", () => { glide(saved * docMax); hide(); });
    onScrollFns.push((y) => { if (y / docMax > Math.min(0.3, saved * 0.8)) hide(); });
  }

  /* ---------- 滚动条：一根细线（替代系统滚动条） ---------- */
  function setupScrollbar() {
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const rail = document.createElement("div");
    rail.className = "rail";
    rail.setAttribute("aria-hidden", "true");
    rail.innerHTML = '<i class="rail__thumb"></i>';
    document.body.appendChild(rail);
    const thumb = rail.firstChild;
    let th = 40, track = 1, idle = 0, drag = null;
    const layout = () => {
      const docH = document.documentElement.scrollHeight;
      rail.hidden = docH <= vh + 2;
      th = Math.max(40, (vh * vh) / docH);
      track = Math.max(1, vh - th);
      thumb.style.height = th.toFixed(1) + "px";
      place(scrollY);
    };
    const place = (y) => thumb.style.setProperty("--ty", ((y / docMax) * track).toFixed(1) + "px");
    const wake = () => {
      rail.classList.add("is-active");
      clearTimeout(idle);
      idle = setTimeout(() => { if (!drag) rail.classList.remove("is-active"); }, 1100);
    };
    onResizeFns.push(layout);
    onScrollFns.push((y) => { place(y); wake(); });
    // 内容高度变化由 boot() 里唯一的 body ResizeObserver → measure() → onResizeFns 统一处理

    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      drag = { y0: e.clientY, s0: scrollY };
      thumb.setPointerCapture(e.pointerId);
      rail.classList.add("is-drag", "is-active");
    });
    thumb.addEventListener("pointermove", (e) => {
      if (!drag) return;
      scrollTo(0, drag.s0 + ((e.clientY - drag.y0) / track) * docMax);
    });
    const end = () => { if (!drag) return; drag = null; rail.classList.remove("is-drag"); wake(); };
    thumb.addEventListener("pointerup", end);
    thumb.addEventListener("pointercancel", end);
    // 点轨道：把那一点滚到视口中央附近
    rail.addEventListener("pointerdown", (e) => {
      if (e.target === thumb) return;
      const target = ((e.clientY - th / 2) / track) * docMax;
      scrollTo({ top: target, behavior: reduce ? "auto" : "smooth" });
    });
    layout();
  }

  /* ---------- 云海：随滚动缓缓升起；离开视口就停止漂移 ---------- */
  function setupMist() {
    const mists = $$(".mist");
    if (!mists.length) return;
    const data = mists.map((m) => ({ m, host: m.parentElement, top: 0, h: 1, last: -1 }));
    onResizeFns.push(() => data.forEach((d) => { d.top = d.host.getBoundingClientRect().top + scrollY; d.h = d.host.offsetHeight; }));
    if (!reduce) onScrollFns.push((y) => data.forEach((d) => {
      const p = clamp((y - d.top) / d.h);
      if (Math.abs(p - d.last) < 0.002) return;
      d.last = p;
      d.m.style.setProperty("--mp", p.toFixed(4));
    }));
    // 横向漂移：Web Animations + 像素位移（关键帧里不能有 CSS 变量，否则只能在主线程逐帧计算）。
    // 一个纹理周期 = 云层高度 × 3.2（遮罩图 2048×640 的比例），平移正好一个周期再循环，无缝。
    const SPEED = { base: 180e3, wisp: 110e3, near: 70e3 };
    const anims = new Map();
    const drift = () => {
      if (reduce) return;
      data.forEach((d) => {
        const tile = d.m.offsetHeight * 3.2;
        $$(".mist__layer", d.m).forEach((layer) => {
          const kind = layer.classList.contains("mist__layer--near") ? "near" : layer.classList.contains("mist__layer--wisp") ? "wisp" : "base";
          const old = anims.get(layer);
          if (old && Math.abs(old.__tile - tile) < 1) return;
          const progress = old ? (old.currentTime % SPEED[kind]) / SPEED[kind] : Math.random();
          old && old.cancel();
          const a = layer.animate([{ transform: "translate3d(0,0,0)" }, { transform: `translate3d(${-tile.toFixed(1)}px,0,0)` }], { duration: SPEED[kind], iterations: Infinity });
          a.currentTime = progress * SPEED[kind];
          a.__tile = tile;
          if (d.off) a.pause();
          anims.set(layer, a);
        });
      });
    };
    onResizeFns.push(drift);
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      const d = data.find((x) => x.m === e.target);
      d.off = !e.isIntersecting;
      $$(".mist__layer", e.target).forEach((l) => { const a = anims.get(l); a && (d.off ? a.pause() : a.play()); });
    }));
    mists.forEach((m) => io.observe(m));
  }

  /* ---------- 启动 ---------- */
  function boot() {
    setupReel();          // 手机竖屏：先换成竖版海报轮播，再让 Depth 初始化（避免先给横版大图建 WebGL）
    setupHeroReel();      // 桌面 / 横屏：首页顶部的六个镜头（第一张沿用原有的那张；要在 Depth 初始化之前把它挪进轮播）
    window.Depth && window.Depth.init();
    setupBar();
    setupPhase();
    setupOpeners();
    setupSidenotes();
    setupDrawer();
    setupReveal();
    setupDiptychs();
    setupLightbox();
    setupLoops();
    setupMist();
    setupResume();
    setupScrub();
    setupHome();
    scheduleMeasure();   // 不在这里同步量：正文 / 列表还在往里填，合并到第一帧渲染前量一次
    // 全站唯一的 body 观察者：图片 / 正文 / 留言 / 字体改变版面高度时，合并到下一帧统一重量一次
    // （滚动条、章节、大图、时段标记、2.5D 场景的缓存位置都挂在 onResizeFns 上）
    onResizeFns.push(() => window.Depth && window.Depth.relayout && window.Depth.relayout());
    // 正文里的图/字体/留言陆续到达时，body 高度会变很多次；每次都全量重量代价太大，
    // 合并成 90ms 一次，且高度变化不到 2px 直接跳过
    let roT = 0, roH = 0;
    new ResizeObserver(() => {
      const h = document.documentElement.scrollHeight;
      if (Math.abs(h - roH) < 2) return;
      roH = h;
      clearTimeout(roT);
      roT = setTimeout(() => { measure(); tick(); }, 90);
    }).observe(document.body);
    if (document.body.classList.contains("post")) requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("is-ready")));
    // 字体与图片加载后，版面高度会变，重新量一次
    document.fonts && document.fonts.ready.then(() => { measure(); tick(); });
    addEventListener("load", () => { measure(); tick(); });
  }
  // 对动态内容（边缘层文章）开放的钩子
  window.Kata = {
    refresh() { measure(); tick(); },
    enhance(root) { window.Depth && window.Depth.init(root); observeReveal(root); bindLightbox(root); bindPeek(root); scheduleMeasure(); },
    reduce, store, glide,
  };
  // <body data-await>：正文由 blog.js 异步渲染，等它发出 kata:content 后再启动（章节、侧注、刻度都依赖正文）
  function start() {
    vh = innerHeight;
    setupScrollbar();
    scheduleMeasure(); // 不等正文：滚动条从第一刻就在
    if (document.body.hasAttribute("data-await")) document.addEventListener("kata:content", boot, { once: true });
    else boot();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
