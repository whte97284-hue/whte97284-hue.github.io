/* ==========================================================================
   かたわれ時 — 翻开 / 合上（跨页共享元素转场）
   · 列表里的画面（大卡片的图，或悬停时跟随光标的那张小画）展开成文章题图，
     标题从列表飞到题图上；合上（按钮 / Esc / 浏览器返回）时原路收回。
   · 只在双方元素都在视口内时才配对，否则退回普通的整页转场，绝不“从屏幕外飞进来”。
   · 悬停约 200ms 的站内链接会被预取（Speculation Rules · prefetch）。
   必须在 <head> 里同步加载：pagereveal 发生在第一帧之前。
   诊断：localStorage.setItem("kata:debug","1") 后，每次转场两端的配对记录在 sessionStorage["kata:vt"]。
   ========================================================================== */
(function () {
  "use strict";
  const html = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DEBUG = (() => { try { return localStorage.getItem("kata:debug") === "1"; } catch (e) { return false; } })();

  function keyOf(url) {
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) return null;
      if (/\/post\.html$/.test(u.pathname)) { const id = u.searchParams.get("id"); return id && /^\d+$/.test(id) ? "wp:" + id : null; }
      const m = u.pathname.match(/\/posts\/([\w-]+)\.html$/);
      return m ? "local:" + m[1] : null;
    } catch (e) { return null; }
  }
  const selfKey = keyOf(location.href);

  const HERO = ".lead__media, .feature__media";
  const TITLE = ".lead__title, .feature h3, .jr__title, .ar__title, .index__title, .post-next strong";
  const STAMP = ".lead__stamp";

  const inView = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  let named = [];
  function name(el, n) { if (!inView(el)) return false; el.style.viewTransitionName = n; named.push(el); return true; }
  /* 首页没有顶栏（用的是封面里自带的导航）：和首页之间切换时，顶栏不能单独成一组——
     否则只有一边有它，它会悬在新页面上方慢慢淡出：在深色封面上就是一条发白的长条。让它跟着整页一起走 */
  const isHome = (u) => { try { return /\/(index\.html)?$/.test(new URL(u, location.href).pathname); } catch (e) { return false; } };
  function barWithPage() { const b = document.querySelector(".bar"); if (b) { b.style.viewTransitionName = "none"; named.push(b); } }
  function clear() { named.forEach((e) => (e.style.viewTransitionName = "")); named = []; html.classList.remove("vt-open", "vt-close"); }
  function note(side, type) {
    if (!DEBUG) return;
    try {
      const log = JSON.parse(sessionStorage.getItem("kata:vt") || "{}");
      log[side] = { type, at: Date.now(), page: location.pathname + location.search, names: named.map((e) => e.style.viewTransitionName + ":" + String(e.className || e.tagName).split(" ")[0]) };
      sessionStorage.setItem("kata:vt", JSON.stringify(log));
    } catch (e) {}
  }

  /* 文章页自己的题图与标题（题图已经滚出视口时不参与） */
  function nameSelf() {
    if (scrollY > innerHeight * 0.45) return false;
    const filled = !selfKey.startsWith("wp:") || html.classList.contains("kata-prefilled") || document.querySelector("[data-post][data-filled]");
    if (!filled) return false;
    const ok = name(document.querySelector(".post-hero .depth[data-depth]"), "kata-hero");
    const t = document.querySelector(".post-hero h1");
    if (t && t.textContent.trim()) name(t, "kata-title");
    name(document.querySelector(".post-hero__meta"), "kata-stamp");
    return ok;
  }
  /* 列表里指向 key 的那张卡片 */
  function nameCard(key, { cursorPeek = false } = {}) {
    const link = Array.from(document.querySelectorAll("a[href]:not(.sky__star)")).find((a) => keyOf(a.href) === key && inView(a));
    if (!link) return false;
    let hero = link.querySelector(HERO);
    if (!hero && cursorPeek) { const pk = document.querySelector(".peek.is-on"); if (pk && link.matches(":hover")) hero = pk; }
    name(hero, "kata-hero");
    name(link.querySelector(TITLE), "kata-title");
    name(link.querySelector(STAMP), "kata-stamp");
    return true;
  }

  // 旧页：在截图之前给要飞走的元素起名
  addEventListener("pageswap", (e) => {
    if (!e.viewTransition || reduce) return;
    clear();
    const to = e.activation && e.activation.entry && e.activation.entry.url;
    if (to && isHome(to)) barWithPage();
    const toKey = to && keyOf(to);
    if (toKey && toKey !== selfKey && nameCard(toKey, { cursorPeek: true })) return note("swap", "open"); // 翻开（含文末“上/下一篇”）
    if (selfKey && !toKey) { nameSelf(); note("swap", "close"); }                                      // 合上
  });

  // 新页：在第一帧之前给接住它们的元素起同样的名字
  addEventListener("pagereveal", (e) => {
    clear();
    if (!e.viewTransition) {
      note("reveal", "none");
      // 直接打开（无转场）但首帧已从缓存画好：仍然让标题按原来的节奏浮现一次
      if (html.classList.contains("kata-prefilled") && document.body && !reduce) {
        document.body.classList.remove("is-ready");
        requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("is-ready")));
      }
      return;
    }
    if (reduce) { e.viewTransition.skipTransition(); return; }
    // 转场进行中：重活（正文排版、WebGL 启动）等它结束再做，动画期间主线程保持空闲
    let release; const busy = new Promise((r) => (release = r)); busy.done = false;
    e.viewTransition.finished.finally(() => { busy.done = true; release(); });
    api.busy = busy;
    const from = window.navigation && navigation.activation && navigation.activation.from && navigation.activation.from.url;
    if (from && isHome(from)) barWithPage();
    const fromKey = from && keyOf(from);
    if (selfKey && fromKey !== selfKey) {
      nameSelf();
      html.classList.add("vt-open", "vt-arrived"); // vt-arrived：题图文字直接处于最终状态，飞行中的标题不会半透明
      const hero = document.querySelector(".post-hero .depth");
      if (hero) { hero.dataset.reveal = "off"; hero.classList.add("is-in"); } // 落地即定格：不再从雾里“二次显影”
    } else if (!selfKey && fromKey) {
      // 列表页的卡片是异步取回来的：只有页面走 bfcache（DOM 还在）时这里才配得上。
      // 整页重载时卡片还没上屏，nameCard 会返回 false —— 只剩整页淡入淡出，看起来像“动画丢了”。
      nameCard(fromKey);
      html.classList.add("vt-close");
    }
    note("reveal", html.classList.contains("vt-open") ? "open" : html.classList.contains("vt-close") ? "close" : "plain");
    e.viewTransition.finished.finally(clear);
  });

  /* ---------- 合上：回到来处（保留原来的滚动位置，走 bfcache），没有来处就回首页 ---------- */
  function closePost(fallback) {
    let back = false;
    try {
      if (window.navigation && navigation.canGoBack) {
        const prev = navigation.entries()[navigation.currentEntry.index - 1];
        back = !!prev && new URL(prev.url).origin === location.origin;
      } else if (document.referrer) back = new URL(document.referrer).origin === location.origin && history.length > 1;
    } catch (e) {}
    if (back) history.back(); else location.href = fallback;
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("[data-close-post]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    closePost(a.getAttribute("href"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !selfKey || e.defaultPrevented) return;
    if (document.body.classList.contains("drawer-open") || document.querySelector(".lightbox.is-open")) return;
    if (/input|textarea|select/i.test((document.activeElement || {}).tagName || "")) return;
    const a = document.querySelector("[data-close-post]");
    if (a) closePost(a.getAttribute("href"));
  });

  /* ---------- 预取：悬停约 200ms 即在后台取回要去的那一页（文章，以及文库 / 画廊 / 追番 / 首页之间的导航） ----------
     用 prefetch 而不是 prerender：实测预渲染的长文页在激活时会卡住（导航不提交），
     而文章页首帧本就由缓存同步画好（FCP 约 50–90ms），预渲染收益很小，风险与开销（重复的 API / WebGL）不小。 */
  if (HTMLScriptElement.supports && HTMLScriptElement.supports("speculationrules")) {
    const s = document.createElement("script");
    s.type = "speculationrules";
    s.textContent = JSON.stringify({
      prefetch: [{ where: { and: [{ href_matches: "/*" }, { selector_matches: "a[href*='.html']" }, { not: { selector_matches: "[data-close-post], [download], [target=_blank]" } }] }, eagerness: "moderate" }],
    });
    document.head.appendChild(s);
  }

  // busy：当前转场的 Promise（.done 表示已结束）；没有转场时是已完成的 Promise
  const idle = Promise.resolve(); idle.done = true;
  // warm：本地已有文章列表的缓存——列表页的脚本能在第一帧之前把内容同步画好。
  // 这时让那几个脚本阻塞首帧（blocking="render"）：没有“骨架 → 内容”的一跳，返回时卡片也赶得上转场；
  // 第一次来（没有缓存，等脚本也画不出内容）则由页面里的一行内联脚本摘掉 blocking，先把骨架画出来
  const warm = (() => { try { for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i).startsWith("kata:api:/blog/posts")) return true; } catch (e) {} return false; })();
  const api = { keyOf, close: closePost, busy: idle, warm };
  window.KataVT = api;
})();
