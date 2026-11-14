/* ==========================================================================
   かたわれ時 — 博客层：首页“最新” · 文库 · 阅读页 · 留言
   数据全部来自边缘层（api.js）；排版、动效沿用 site.js / depth.js
   ========================================================================== */
(function () {
  "use strict";
  const A = window.KataAPI;
  if (!A) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const html = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const enhance = (root) => window.Kata && window.Kata.enhance(root);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 让出主线程直到下一帧画完：把一大段工作拆开，中间的帧照常绘制（题图文字的浮现动画不会被卡住）
  const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /* ---------- 画面片段（与阅读页首屏共用 api.js 里的实现） ---------- */
  const sceneHTML = A.view.sceneHTML;
  const peekSrc = (p) => (p.img ? p.img.src : `assets/img/${p.local ? p.cover : p.scene.key}-960.webp`);
  const phaseLabel = (p) => { const ph = A.PHASES[p.phase]; return `${ph.name}<span class="latin">${ph.latin}</span>`; };
  /* 从文章“返回”且整页重载（没走 bfcache）：列表直接处于显影后的状态——
     转场那一刻卡片必须是看得见的，否则标题飞回来落在一片空白上 */
  const returning = (() => { try { return performance.getEntriesByType("navigation")[0].type === "back_forward"; } catch (e) { return false; } })();
  const skyDot = (phase) => `<i class="sky-dot" data-ph="${phase}" aria-hidden="true"></i>`;

  /* ---------- 边缘层状态（页脚的小字） ---------- */
  function setupEdgeStatus() {
    const el = $("[data-edge]");
    if (!el) return;
    const show = ({ source, offline }) => {
      el.dataset.state = offline ? "off" : "on";
      el.innerHTML = offline
        ? `<i></i>云层之上信号中断 · 正在显示上次保存的内容`
        : `<i></i><span>边缘节点 · ${esc(source || "—").replace("edge-cache", "边缘缓存").replace("edge-stale", "边缘缓存").replace("stale-cache", "边缘旧缓存").replace("primary", "主源").replace("fallback", "备用源").replace("·cache", " · 本地缓存")}</span>`;
    };
    document.addEventListener("edge:status", (e) => show(e.detail));
    if (A.status.at) show(A.status);
  }

  /* ---------- 错误态 ---------- */
  function errorHTML(e, retry) {
    return `<div class="edge-error" role="status">
      <p class="edge-error__title">信号在云层之上中断了。</p>
      <p class="edge-error__msg">${esc(e && e.message ? e.message : "无法连接边缘节点")}</p>
      ${retry ? '<button class="pill" data-retry>重新连接</button>' : ""}</div>`;
  }

  /* ==========================================================================
     首页 · 最新
     ========================================================================== */
  function journalRow(p, i) {
    return `<li data-reveal-row style="--i:${i}">
      <a href="${p.href}" data-peek="${esc(peekSrc(p))}">
        <span class="jr__when"><span class="jr__date latin">${A.fmt.md(p.date)}</span><span class="jr__clock">${skyDot(p.phase)}${A.fmt.clock(p.date)} · ${A.PHASES[p.phase].name}</span></span>
        <span class="jr__body"><span class="jr__title">${esc(p.title)}</span>${p.excerpt ? `<span class="jr__excerpt">${esc(p.excerpt)}</span>` : ""}</span>
        <span class="jr__meta">${esc(p.cats.join(" · ") || "随笔")}</span>
      </a></li>`;
  }
  function leadHTML(p) {
    const ph = A.PHASES[p.phase];
    return `<a class="lead" href="${p.href}">
      <div class="lead__media">${sceneHTML(p.scene, { sizes: "(min-width: 900px) 60vw, 100vw" })}
        <span class="lead__stamp">写于 ${A.fmt.clock(p.date)}<br>${ph.kana}</span></div>
      <div class="lead__text">
        <span class="lead__kicker"><span class="latin">Latest</span>${esc(p.cats.join(" · ") || "随笔")}</span>
        <h3 class="lead__title">${esc(p.title)}</h3>
        ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}
        <div class="feature__meta"><span>${A.fmt.kanji(p.date)}</span><span>${skyDot(p.phase)} ${ph.name}</span>${p.minutes ? `<span>约 ${p.minutes} 分钟</span>` : ""}</div>
        <span class="readmore">继续阅读 <i></i></span>
      </div></a>`;
  }
  async function setupHome() {
    const root = $("[data-journal]");
    if (!root) return;
    const lead = $("[data-slot=lead]", root), list = $("[data-slot=list]", root);
    const skelLead = lead.innerHTML, skelList = list.innerHTML; // 页面自带的同构骨架，重试时原样恢复
    let lastSig = "";
    const render = (posts) => {
      const sig = posts.map((p) => p.id).join(",");
      if (sig && sig === lastSig) return;      // 同步预渲染与网络回来是同一批，不重复重建
      lastSig = sig;
      if (!posts.length) { lead.innerHTML = '<p class="empty">这里还没有文字。</p>'; list.innerHTML = ""; return; }
      const pinned = posts.find((p) => p.sticky) || posts[0];
      lead.innerHTML = leadHTML(pinned);
      list.removeAttribute("aria-busy");
      list.innerHTML = posts.filter((p) => p !== pinned).slice(0, 6).map(journalRow).join("");
      enhance(root);
      $$("[data-reveal-row]", list).forEach((li) => { li.setAttribute("data-reveal", ""); if (returning && !shown) li.classList.add("is-in"); });
      shown = true;
      enhance(list);
    };
    let shown = false;
    // 首帧同步画：缓存里有就直接上屏（不等网络），返回时的跨页转场才配得上卡片
    const seed = A.peekPosts({ perPage: 7 });
    if (seed) render(seed);
    const load = async () => {
      try {
        A.categories().catch(() => {});
        render(await A.posts({ perPage: 7 }, { onUpdate: render }));
      } catch (e) {
        lead.innerHTML = errorHTML(e, true); list.innerHTML = "";
        const b = $("[data-retry]", lead); b && b.addEventListener("click", () => { lead.innerHTML = skelLead; list.innerHTML = skelList; load(); });
      }
    };
    load();
  }
  const skeleton = () => '<div class="skel"><i></i><i></i><i></i></div>';

  /* ==========================================================================
     文库：筛选（分类 · 时段 · 关键词）+ 年份时间线 + 二十四小时天空
     ========================================================================== */
  async function setupArchive() {
    const root = $("[data-archive]");
    if (!root) return;
    const body = $("[data-slot=years]", root), chips = $("[data-slot=cats]", root), sky = $("[data-slot=sky]", root);
    const input = $("input[type=search]", root), count = $("[data-slot=count]", root), stats = $("[data-slot=stats]");
    const params = new URLSearchParams(location.search);
    const state = { cat: params.get("cat") || "all", phase: params.get("phase") || "all", q: params.get("q") || "" };
    input.value = state.q;
    let all = [], remoteHits = new Set(), cats = [], rendered = false;

    // onUpdate：本地缓存先给旧的、后台刷新到不同的新数据时会被调用（文库打开时画的是缓存，没有它新文章 / 新分类要再刷新一次才出现）
    async function fetchAll(onUpdate) {
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const chunk = await A.posts({ page, perPage: 100, lite: true }, onUpdate ? { onUpdate } : undefined);
        out.push(...chunk);
        if (chunk.length < 100) break;
      }
      return out;
    }
    function persist() {
      const u = new URL(location.href);
      ["cat", "phase", "q"].forEach((k) => (state[k] && state[k] !== "all" ? u.searchParams.set(k, state[k]) : u.searchParams.delete(k)));
      history.replaceState(null, "", u);
    }
    function match(p) {
      if (state.cat === "feature" && !p.local) return false;
      if (state.cat !== "all" && state.cat !== "feature" && !(p.catIds || []).includes(+state.cat)) return false;
      if (state.phase !== "all" && p.phase !== state.phase) return false;
      if (state.q) {
        const q = state.q.toLowerCase();
        const hay = (p.title + " " + (p.excerpt || p.sub || "") + " " + (p.cats || [p.cat]).join(" ")).toLowerCase();
        if (!hay.includes(q) && !remoteHits.has(p.id)) return false;
      }
      return true;
    }
    function mark(s) {
      if (!state.q) return esc(s);
      const i = s.toLowerCase().indexOf(state.q.toLowerCase());
      return i < 0 ? esc(s) : esc(s.slice(0, i)) + "<mark>" + esc(s.slice(i, i + state.q.length)) + "</mark>" + esc(s.slice(i + state.q.length));
    }
    function row(p) {
      const ph = A.PHASES[p.phase];
      return `<li class="ar${p.local ? " ar--feature" : ""}" data-ph="${p.phase}">
        <a href="${p.href}" data-peek="${esc(peekSrc(p))}">
          <span class="ar__date"><span class="latin">${A.fmt.md(p.date)}</span><small>${A.fmt.clock(p.date)} ${ph.name}</small></span>
          <span class="ar__node" aria-hidden="true">${skyDot(p.phase)}</span>
          <span class="ar__body"><span class="ar__title">${mark(p.title)}</span>
            ${(p.excerpt || p.sub) ? `<span class="ar__excerpt">${mark(p.excerpt || p.sub)}</span>` : ""}</span>
          <span class="ar__cat">${esc(p.local ? "特辑" : p.cats.join(" · ") || "随笔")}</span>
        </a></li>`;
    }
    function renderSky(items) {
      // 二十四小时：每篇文章落在它被写下的钟点上
      const byHour = Array.from({ length: 24 }, () => []);
      items.forEach((p) => byHour[(A.parse(p.date) || { h: 12 }).h].push(p));
      const segs = [["yoru", 0, 5], ["asa", 5, 10], ["hiru", 10, 16], ["tasogare", 16, 19], ["yoru", 19, 24]];
      sky.innerHTML = `
        <div class="sky__band">${segs.map(([ph, a, b]) => `<button class="sky__seg" data-ph="${ph}" style="--a:${a};--b:${b}" aria-pressed="${state.phase === ph}" title="${A.PHASES[ph].name} · ${a}:00–${b}:00"><span>${A.PHASES[ph].name}</span></button>`).join("")}
          ${byHour.map((list, h) => list.map((p, j) => `<a class="sky__star" href="${p.href}" style="--h:${h + (+(A.parse(p.date) || {}).mi || 0) / 60};--j:${j % 5}" data-tip="${esc(p.title)}" data-at="${A.fmt.md(p.date)} ${A.fmt.clock(p.date)}" aria-label="${esc(p.title)}"></a>`).join("")).join("")}
        </div>
        <p class="sky__tip" aria-hidden="true"><b></b><span class="latin"></span></p>
        <div class="sky__axis latin">${[0, 6, 12, 18, 24].map((h) => `<span style="--h:${h}">${String(h).padStart(2, "0")}:00</span>`).join("")}</div>`;
    }
    function render() {
      const items = all.filter(match);
      count.innerHTML = `<span>${items.length === all.length ? `共 ${all.length} 篇` : `${items.length} / ${all.length} 篇`}</span><span>由近及远</span>`;
      // 天上的星：被筛掉的文章，它的那颗星也暗下去
      const on = new Set(items.map((p) => p.href));
      $$(".sky__star", sky).forEach((s) => s.classList.toggle("is-off", !on.has(s.getAttribute("href"))));
      if (!items.length) {
        body.innerHTML = `<p class="empty">${state.q ? `没有找到与「${esc(state.q)}」有关的文字。` : "这个时刻还没有被写下的文字。"}<button class="pill" data-reset>回到全部</button></p>`;
      } else {
        const years = {};
        items.forEach((p) => (years[p.date.slice(0, 4)] = years[p.date.slice(0, 4)] || []).push(p));
        // 只有第一次渲染做“浮现”；之后的筛选 / 搜索直接换内容，再整体做一次很短的淡入（不会每敲一个字就闪一遍）
        const attr = rendered ? "" : " data-reveal", cls = !rendered && returning ? "year is-in" : "year";
        const last = items[items.length - 1], whole = items.length === all.length;
        // 屏外的年份先不排版（content-visibility），高度按条目数预估；从文章返回时要原样落回离开的位置，那一次按真实高度排
        body.classList.toggle("is-exact", returning && !rendered);
        body.innerHTML = Object.keys(years).sort((a, b) => b - a).map((y) => `
          <section class="${cls}"${attr} style="contain-intrinsic-size:auto ${years[y].length * 118 + 24}px">
            <h2 class="year__no latin">${y}<small>${A.fmt.kanji(y + "-01-01T00:00").split(" · ")[0]} · ${years[y].length} 篇</small></h2>
            <ol class="ar-list">${years[y].map(row).join("")}</ol>
          </section>`).join("") + `
          <p class="arch__end"><span>${whole ? "最初写下的一篇" : "这一段到此为止"}<i class="latin">${A.fmt.short(last.date)}</i></span></p>`;
      }
      $$(".chip", chips).forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.cat === state.cat)));
      $$(".sky__seg", sky).forEach((s) => s.setAttribute("aria-pressed", String(s.dataset.ph === state.phase)));
      sky.classList.toggle("is-filtered", state.phase !== "all");
      sky.dataset.phase = state.phase;
      html.dataset.phase = state.phase === "all" ? "asa" : state.phase;
      persist();
      body.removeAttribute("aria-busy");
      enhance(body);
      if (rendered && !reduce) body.animate([{ opacity: 0.35, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.22,.61,.36,1)" });
      rendered = true;
    }
    function renderChips() {
      const used = cats.filter((c) => c.count > 0);
      chips.innerHTML = [["all", "全部", all.length], ["feature", "特辑", A.LOCAL.length], ...used.map((c) => [String(c.id), A.text(c.name), c.count])]
        .map(([id, name, n]) => `<button class="chip" data-cat="${id}" aria-pressed="false">${esc(name)}<small>${n}</small></button>`).join("");
    }

    // 星与条目互相指认：指着一颗星，浮出它的名字；指着一行字，天上那颗星亮起来
    const tipOn = (s) => {
      const tip = $(".sky__tip", sky); if (!tip) return;
      if (!s) return tip.classList.remove("is-on");
      $("b", tip).textContent = s.dataset.tip; $("span", tip).textContent = s.dataset.at;
      const w = sky.clientWidth, x = s.offsetLeft, half = tip.offsetWidth / 2;
      tip.style.left = Math.max(half, Math.min(w - half, x)) + "px";
      tip.classList.add("is-on");
    };
    sky.addEventListener("pointerover", (e) => { const s = e.target.closest(".sky__star"); if (s && e.pointerType !== "touch") tipOn(s); });
    sky.addEventListener("pointerout", (e) => { if (e.target.closest(".sky__star")) tipOn(null); });
    sky.addEventListener("focusin", (e) => { const s = e.target.closest(".sky__star"); if (s) tipOn(s); });
    sky.addEventListener("focusout", () => tipOn(null));
    let lit = null;
    const light = (a) => {
      if (lit) lit.classList.remove("is-lit");
      lit = a ? $$(".sky__star", sky).find((s) => s.getAttribute("href") === a.getAttribute("href")) || null : null;
      if (lit) lit.classList.add("is-lit");
    };
    body.addEventListener("pointerover", (e) => { const a = e.target.closest(".ar a"); if (a && e.pointerType !== "touch") light(a); });
    body.addEventListener("pointerleave", () => light(null));
    body.addEventListener("focusin", (e) => light(e.target.closest(".ar a")));

    chips.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; state.cat = b.dataset.cat; render(); });
    sky.addEventListener("click", (e) => { const b = e.target.closest(".sky__seg"); if (!b) return; state.phase = state.phase === b.dataset.ph ? "all" : b.dataset.ph; render(); });
    body.addEventListener("click", (e) => { if (e.target.closest("[data-reset]")) { state.cat = "all"; state.phase = "all"; state.q = ""; input.value = ""; render(); } });
    let t = 0;
    input.addEventListener("input", () => {
      state.q = input.value.trim(); remoteHits = new Set(); render();
      clearTimeout(t);
      const q = state.q;
      if (q.length >= 2) t = setTimeout(async () => { // 正文全文检索交给 WordPress；只采纳仍是当前关键词的结果
        try { const r = await A.posts({ search: q, perPage: 50, lite: true }); if (q !== state.q) return; r.forEach((p) => remoteHits.add(p.id)); if (r.length) render(); } catch (e) {}
      }, 450);
    });
    addEventListener("keydown", (e) => { if (e.key === "/" && document.activeElement !== input && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); } });

    const build = (wp) => {
      all = wp.concat(A.LOCAL.map((l) => ({ ...l, phase: A.phaseOf(A.parse(l.date).h), catIds: [], cats: ["特辑"] })))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const first = all[all.length - 1];
      if (stats) stats.innerHTML = `<span>${all.length} 篇</span><span>${cats.filter((c) => c.count).length + 1} 个分类</span><span>自 ${A.fmt.short(first.date).slice(0, 7)}</span>`;
    };
    // 后台刷新到新数据：缓存已经更新，重新读一遍（命中新鲜缓存，不再发请求），整页重画；多个更新合并成一次
    let resyncing = false;
    const resync = () => {
      if (resyncing) return;
      resyncing = true;
      setTimeout(async () => {
        resyncing = false;
        try {
          cats = await A.categories();
          build(await fetchAll());
          renderChips(); renderSky(all); render();
        } catch (e) {}
      }, 60);
    };
    // 首帧同步画：分类与全部列表都在本地缓存里时，不等任何 await 就把整页排好——
    // 没有“先骨架、后内容”的那一跳；从文章返回（整页重载）时，转场那一刻条目已经在原位
    const sigOf = (wp, cs) => wp.map((p) => p.id + ":" + p.modified + ":" + p.catIds).join() + "|" + cs.map((c) => c.id + ":" + c.count + ":" + c.name).join();
    const paint = () => { renderChips(); renderSky(all); render(); };
    let sig = "";
    const seedCats = A.peekCategories(), seedPosts = seedCats && (() => {
      const out = [];
      for (let page = 1; page <= 20; page++) { const chunk = A.peekPosts({ page, perPage: 100, lite: true }); if (!chunk) return null; out.push(...chunk); if (chunk.length < 100) break; }
      return out;
    })();
    if (seedPosts) { cats = seedCats; sig = sigOf(seedPosts, cats); build(seedPosts); paint(); }
    try {
      cats = await A.categories({ onUpdate: resync }).catch(() => []);
      const wp = await fetchAll(resync);
      if (sigOf(wp, cats) !== sig) { build(wp); paint(); }
    } catch (e) {
      if (!seedPosts) {
        all = A.LOCAL.map((l) => ({ ...l, phase: A.phaseOf(A.parse(l.date).h), catIds: [], cats: ["特辑"] }));
        root.insertAdjacentHTML("afterbegin", errorHTML(e, false));
        paint();
      }
    }
    if (state.q) input.dispatchEvent(new Event("input"));
  }

  /* ==========================================================================
     阅读页
     ========================================================================== */
  /* WordPress 正文的排版修复：Markdown 残留、粘贴进来的整页 HTML、徽章、站内锚点…… */
  function normalize(root) {
    // 0) 软换行还原
    //    WordPress 用 MultiMarkdown 渲染正文（证据：图注 id="attachment_mmd_xx"）。
    //    MultiMarkdown 把「单个换行」当 soft break，输出的是一个裸 \n —— 而 HTML 会把 \n
    //    折叠成一个空格，于是作者「一句一行」的写法在页面上粘成一整段。
    //    这里把段落里的软换行还原成 <br>，并打上 data-br（这类段落不做两端对齐）。
    $$("p, li, blockquote, td", root).forEach((el) => {
      if (el.closest("pre, code")) return;
      if (el.hasAttribute("data-br")) return;          // 幂等：重复渲染时不翻倍
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
      let hit = 0;
      nodes.forEach((n) => {
        if (!n.nodeValue.includes("\n")) return;
        // 先把连续换行收成一个，避免出现空行
        const v = n.nodeValue.replace(/[ \t]*\r?\n[ \t\r\n]*/g, "\n");
        if (!v.includes("\n")) { n.nodeValue = v; return; }
        const frag = document.createDocumentFragment();
        v.split("\n").forEach((s, i) => {
          if (i) { frag.appendChild(document.createElement("br")); hit++; }
          if (s) frag.appendChild(document.createTextNode(s));
        });
        n.replaceWith(frag);
      });
      if (hit) {
        el.setAttribute("data-br", "");
        // 换行正好落在两个文本节点的边界上时会连出两个 <br>，收成一个。
        // 注意不能用 "br + br" 选择器：兄弟组合符会跳过文本节点，那样会把整段的换行全删光。
        Array.from(el.childNodes).forEach((n) => {
          if (n.nodeName === "BR" && n.previousSibling && n.previousSibling.nodeName === "BR") n.remove();
        });
        while (el.firstChild && el.firstChild.nodeName === "BR") el.firstChild.remove();
        while (el.lastChild && el.lastChild.nodeName === "BR") el.lastChild.remove();
      }
    });
    // 1) 段落里的 Markdown 残留
    $$("p", root).forEach((p) => {
      const t = p.textContent.replace(/ /g, " ").trim();
      if (!t && !p.querySelector("img,iframe,video")) return p.remove();
      if (/^[—–-]{1,3}$/.test(t)) return p.replaceWith(document.createElement("hr"));
      const h = !p.hasAttribute("data-br") && /^(#{1,4})\s+(.+)$/.exec(t);
      if (h) { const el = document.createElement(h[1].length <= 2 ? "h2" : "h3"); el.textContent = h[2].replace(/\*\*/g, ""); return p.replaceWith(el); }
      if (/^>\s?/.test(t) && !p.querySelector("img")) {
        const q = document.createElement("blockquote"); const np = document.createElement("p");
        np.innerHTML = p.innerHTML.replace(/^(\s|&nbsp;)*&gt;\s?/, ""); q.appendChild(np); return p.replaceWith(q);
      }
    });
    // 行内：**粗体** 与 `代码`
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = []; while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach((n) => {
      if (n.parentElement.closest("pre,code")) return;
      let v = n.nodeValue;
      if (v.includes("**")) v = v.replace(/\*\*/g, "");
      if (/`[^`]+`|(^|[^*\w])\*[^*\s][^*\n]*\*(?![*\w])/.test(v)) {
        const span = document.createElement("span");
        span.innerHTML = esc(v).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
        n.replaceWith(...span.childNodes);
      } else if (v !== n.nodeValue) n.nodeValue = v;
    });
    // 以“– ”开头的连续段落 → 列表
    let ul = null;
    $$(":scope > p", root).forEach((p) => {
      const t = p.textContent.replace(/ /g, " ").trim();
      if (/^[–\-•·*]\s+/.test(t)) {
        if (!ul || ul.nextElementSibling !== p) { ul = document.createElement("ul"); p.before(ul); }
        const li = document.createElement("li"); li.innerHTML = p.innerHTML.replace(/^(\s|&nbsp;)*[–\-•·*]\s+/, ""); ul.appendChild(li); p.remove();
      } else ul = null;
    });
    // 1.5) Markdown 管道表格 → 真正的 <table>
    //      古腾堡里如果只是把 Markdown 文本粘成段落块，会留下一堆「| a | b |」的段落。
    //      这里把连续的这类段落收成一张表：第一行当表头，`| --- |` 那种分隔行丢掉。
    {
      const UP = root.dataset.uploads || "";
      const imgOf = (src) => {
        if (/^https?:\/\//.test(src)) return src;
        if (src.startsWith("/wp-content/") || src.startsWith("/wp-includes/")) return "https://api.wh1te.top" + src;
        if (!src.startsWith("/") && UP) return UP + src;      // 裸文件名：按上传目录补全
        return null;
      };
      // 单元格里允许 **粗体** 与 ![alt](src)
      const cellHTML = (raw) => {
        const t = raw.replace(/\*\*/g, "");
        let out = "", last = 0, m;
        const re = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)(?:\{[^}]*\})?/g;
        while ((m = re.exec(t))) {
          out += esc(t.slice(last, m.index));
          const u = imgOf(m[2]);
          out += u ? `<img src="${esc(u)}" alt="${esc(m[1] || "")}" loading="lazy">` : esc(m[0]);
          last = re.lastIndex;
        }
        return out + esc(t.slice(last));
      };
      const SEP = (c) => /^:?[-\u2013\u2014]{1,}:?$/.test(c);
      let wrap = null, tbody = null;
      $$(":scope > p", root).forEach((p) => {
        const t = p.textContent.trim();
        if (!/^\|.*\|$/.test(t)) { wrap = null; tbody = null; return; }
        const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
        if (cells.length && cells.every(SEP)) return p.remove();      // | --- | :--: |
        if (!wrap) {
          wrap = document.createElement("div"); wrap.className = "table-wrap";
          const table = document.createElement("table");
          const thead = document.createElement("thead"), tr = document.createElement("tr");
          cells.forEach((c) => { const th = document.createElement("th"); th.innerHTML = cellHTML(c); tr.appendChild(th); });
          thead.appendChild(tr); table.appendChild(thead);
          tbody = document.createElement("tbody"); table.appendChild(tbody);
          wrap.appendChild(table); p.before(wrap);
        } else {
          const tr = document.createElement("tr");
          cells.forEach((c) => { const td = document.createElement("td"); td.innerHTML = cellHTML(c); tr.appendChild(td); });
          tbody.appendChild(tr);
        }
        p.remove();
      });
    }
    // 2) 标题层级：h1 → h2；粘贴整页 HTML 时留下的 header/footer 外壳展开
    $$("h1", root).forEach((h) => { const n = document.createElement("h2"); n.innerHTML = h.innerHTML; h.replaceWith(n); });
    // 3) 徽章（shields 等小图）收拢成一行
    $$("img", root).filter((img) => /shields\.io|badge/i.test(img.getAttribute("src") || "")).forEach((img) => {
      (img.closest("figure") || img.closest("p") || img).setAttribute("data-badge", "");
      img.setAttribute("data-badge-img", "");
    });
    $$("[data-badge]", root).forEach((el) => {
      const img = el.hasAttribute("data-badge-img") ? el : el.querySelector("[data-badge-img]");
      const prev = el.previousElementSibling;
      if (prev && prev.classList.contains("badges")) { prev.appendChild(img); if (el !== img) el.remove(); }
      else { const row = document.createElement("p"); row.className = "badges"; el.replaceWith(row); row.appendChild(img); }
    });
    // 3.5) 没被渲染的 Markdown 图片：正文里会留下 ![alt](/path.webp){.alignnone} 的原始写法。
    //      Worker 在不同来源下会返回两种正文（一种已转成 <figure>，一种还是裸 Markdown），
    //      这里把裸写法补成真 <img>，交给下面的「图片 → 显影图」统一处理。
    $$("p, li, blockquote", root).forEach((el) => {
      if (el.closest("pre, code")) return;
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const tnodes = []; while (tw.nextNode()) tnodes.push(tw.currentNode);
      tnodes.forEach((n) => {
        if (!n.nodeValue.includes("![")) return;
        const re = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)(?:\{[^}]*\})?/g;
        if (!re.test(n.nodeValue)) return;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0, m;
        while ((m = re.exec(n.nodeValue))) {
          const src = m[2];
          // 三种写法都认：完整 URL、/wp-content/… 站内路径、裸文件名（按上传目录补全）
          const UP = root.dataset.uploads || "";
          let abs = src;
          if (src.startsWith("/wp-content/") || src.startsWith("/wp-includes/")) abs = "https://api.wh1te.top" + src;
          else if (!/^https?:\/\//.test(src)) {
            if (src.startsWith("/") || !UP) continue;
            abs = UP + src;
          }
          if (m.index > last) frag.appendChild(document.createTextNode(n.nodeValue.slice(last, m.index)));
          const img = document.createElement("img");
          img.setAttribute("src", abs);
          img.setAttribute("alt", m[1] || "");
          frag.appendChild(img);
          last = re.lastIndex;
        }
        if (!last) return;
        if (last < n.nodeValue.length) frag.appendChild(document.createTextNode(n.nodeValue.slice(last)));
        n.replaceWith(frag);
      });
    });
    // 4) 图片 → 可放大的显影图（包裹图片的链接交给灯箱）
    $$("img", root).forEach((img) => {
      if (img.closest(".badges")) return;
      const link = img.parentElement && img.parentElement.tagName === "A" && img.parentElement.textContent.trim() === "" ? img.parentElement : null;
      if (link) link.replaceWith(img);
      const w = +img.getAttribute("width") || 0, h = +img.getAttribute("height") || 0;
      let fig = img.parentElement && img.parentElement.tagName === "FIGURE" ? img.parentElement : null;
      if (!fig) {
        const p = img.closest("p");
        const host = p && p.textContent.trim() === "" && p.querySelectorAll("img").length === 1 ? p : null;
        fig = document.createElement("figure");
        if (host) host.replaceWith(fig);
        else if (p) p.after(fig); else img.before(fig);
        fig.appendChild(img);
      }
      const cap = fig.querySelector("figcaption");
      const frame = document.createElement("div"); frame.className = "fig__frame";
      img.replaceWith(frame); frame.appendChild(img);
      if (cap) fig.appendChild(cap);
      fig.className = "fig fig--auto" + (w && h && w / h > 1.25 && w >= 1000 ? " fig--wide" : "") + (w && h && h > w ? " fig--tall" : "");
      fig.setAttribute("data-reveal", "");
      if (w && h) frame.style.aspectRatio = `${w} / ${h}`;
      if (w && h) fig.style.setProperty("--ar", (w / h).toFixed(4));
      img.loading = "lazy"; img.decoding = "async";
      img.setAttribute("sizes", "(min-width: 1100px) 1100px, 100vw");
    });
    // 画廊：一个 figure 里有多张图（WordPress gallery）
    $$("figure:not(.fig)", root).forEach((f) => { if (f.querySelectorAll(".fig").length > 1) { f.className = "gallery"; f.querySelectorAll(".fig").forEach((x) => x.classList.remove("fig--wide")); } });
    // 套娃的 figure（WordPress 的图片区块里又包了一层 figure）：外层只装着一张图时拆掉，免得浏览器默认的 40px 外边距把图推离左边线
    $$("figure:not(.fig):not(.gallery)", root).forEach((f) => { const inner = f.querySelector(".fig"); if (inner && f.children.length === 1 && f.firstElementChild === inner) f.replaceWith(inner); });
    // 5) 代码块：语言名统一写法（c → C、assembly → Assembly……）；
    //    用制表符画出来的框图 / 流程图（含 ─│┌ 等字符）不是“代码”：不要语言栏和复制，只留一块安静的底
    $$("pre", root).forEach((pre) => {
      const code = pre.querySelector("code");
      const m = ((code && code.className) || pre.className || "").match(/(?:language|lang)-([\w+#-]+)/);
      const key = m ? m[1].toLowerCase() : "";
      pre.removeAttribute("class");
      if (code) code.removeAttribute("class");
      const art = /[\u2500-\u257F]/.test(pre.textContent) && (!key || /^(text|plain|plaintext|txt|none)$/.test(key));
      const wrap = document.createElement("div"); wrap.className = art ? "code code--art" : "code";
      if (art) {
        // 框图里的 ⊕ ► → 等符号，作者是按“一格”对齐的；等宽字体缺字时回落到中文字体会变成两格宽，右边框就歪了——
        // 把它们各自装进一个恰好 1ch 宽的格子里
        const tw = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT), ns = [];
        while (tw.nextNode()) if (AMBI.test(tw.currentNode.nodeValue)) ns.push(tw.currentNode);
        ns.forEach((n) => {
          const frag = document.createDocumentFragment();
          n.nodeValue.split(AMBI_SPLIT).forEach((t, i) => {
            if (!t) return;
            if (i % 2) { const c = document.createElement("span"); c.className = "cell"; c.textContent = t; frag.appendChild(c); }
            else frag.appendChild(document.createTextNode(t));
          });
          n.replaceWith(frag);
        });
        // 记下最宽一行占几格（汉字两格）：窄屏上按它把字号缩到恰好放得下（有下限，太宽的仍横向滚动）
        const cols = Math.max(...pre.textContent.split("\n").map((l) => l.replace(/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/g, "..").length));
        pre.style.setProperty("--cols", cols);
      } else {
        const label = Object.prototype.hasOwnProperty.call(LANG, key) ? LANG[key] : key ? key.charAt(0).toUpperCase() + key.slice(1) : "Code";
        wrap.innerHTML = `<div class="code__bar"><span class="code__lang latin">${esc(label)}</span><button type="button" class="code__copy">复制</button></div>`;
      }
      pre.replaceWith(wrap); wrap.appendChild(pre);
    });
    // 6) 表格、嵌入
    // 表格：一律在正文栏内、与正文同宽（首末列的字对齐正文栏，列多时块内横向滚动）；
    //   五列以上或放着截图的表另记一个 table-wrap--wide（目前只作标记，版面上不再伸进宽栏）
    $$("table", root).forEach((t) => {
      const cols = Math.max(0, ...Array.from(t.rows).map((r) => r.cells.length));
      const w = document.createElement("div"); w.className = "table-wrap" + (cols >= 5 || t.querySelector("img") ? " table-wrap--wide" : "");
      // WordPress 的表格区块是 <figure class="wp-block-table"><table>：只装着这张表的 figure 拆掉，表格自己成为网格的一员
      const host = t.parentElement && t.parentElement.tagName === "FIGURE" && t.parentElement.children.length === 1 && !t.parentElement.querySelector("img") ? t.parentElement : t;
      w.style.setProperty("--tcols", cols);
      host.replaceWith(w); w.appendChild(t);
    });
    $$("iframe", root).forEach((f) => { const w = document.createElement("div"); w.className = "embed"; f.replaceWith(w); w.appendChild(f); f.setAttribute("allowfullscreen", ""); f.setAttribute("loading", "lazy"); });
    // 7) 展开无语义的 div/span/article/header 外壳，让段落直接成为网格的子元素
    for (let pass = 0; pass < 4; pass++) $$(":scope > div:not(.code):not(.table-wrap):not(.embed), :scope > article, :scope > header, :scope > footer, :scope > section, :scope > span", root).forEach((d) => d.replaceWith(...d.childNodes));
    Array.from(root.childNodes).forEach((n) => { if (n.nodeType === 3 && n.nodeValue.trim()) { const p = document.createElement("p"); p.textContent = n.nodeValue.trim(); n.replaceWith(p); } else if (n.nodeType === 3) n.remove(); });
    // 7b) 全文没有二级标题、却有两个以上三级标题：这些三级标题其实就是“章”——整体升一级，
    //     编号、细线、页边章节导航与其它文章保持同一套层级
    if (!root.querySelector("h2") && root.querySelectorAll("h3").length >= 2) {
      $$("h3, h4", root).forEach((h) => { const n = document.createElement(h.tagName === "H3" ? "h2" : "h3"); n.innerHTML = h.innerHTML; h.replaceWith(n); });
    }
    // 7c) 对话体：连续的“**我**：……”“**Gemini**：……”段落 → 一段对话（说话人一列、台词一列；第一个开口的人记作 a，其余记作 b）
    const containers = [root].concat($$("blockquote", root));
    containers.forEach((box) => {
      let run = [];
      const flush = () => {
        const names = [];
        run.forEach((r) => names.includes(r.w.name) || names.push(r.w.name));
        if (run.length >= 2 && names.length >= 2) {
          const dlg = document.createElement("div"); dlg.className = "dialog";
          run.forEach(({ p, w }) => {
            let n = p.firstChild; while (n && n !== w.label) { const x = n.nextSibling; n.remove(); n = x; }   // 名字前的空白
            w.label.remove(); w.after.nodeValue = w.after.nodeValue.replace(/^\s*[：:]\s*/, "");
            const line = document.createElement("p");
            line.className = "dialog__line"; line.dataset.turn = names.indexOf(w.name) === 0 ? "a" : "b";
            // 冒号留在文档里（复制、读屏仍是“我：……”），只是视觉上藏起来
            line.innerHTML = `<span class="dialog__who">${esc(w.name)}<span class="dialog__sep">：</span></span><span class="dialog__say"></span>`;
            line.lastChild.append(...p.childNodes);
            dlg.appendChild(line);
          });
          run[0].p.before(dlg); run.forEach((r) => r.p.remove());
          // 整个引用块里只有这段对话：去掉引用的外壳，对话自己就是一种“引用”
          if (box !== root && box.children.length === 1 && box.firstElementChild === dlg && !box.textContent.replace(dlg.textContent, "").trim()) box.replaceWith(dlg);
        }
        run = [];
      };
      Array.from(box.children).forEach((el) => { const w = el.tagName === "P" ? speaker(el) : null; if (w) run.push({ p: el, w }); else flush(); });
      flush();
    });
    // 7d) 公式行：只有一段行内代码的段落 / 列表，以及“……：”后面紧跟的一长段行内代码 → 等宽的公式行
    //     （不再是一行一个灰色小块、前面再挂一根破折号）；相邻的公式行并成一块
    const eqBox = (codes) => { const d = document.createElement("div"); d.className = "eq"; codes.forEach((c) => { c.removeAttribute("class"); d.appendChild(c); }); return d; };
    $$(":scope > p, :scope > blockquote > p", root).forEach((p) => {
      const c = solo(p);
      if (c) return p.replaceWith(eqBox([c]));
      const kids = Array.from(p.childNodes).filter((n) => !(n.nodeType === 3 && !n.nodeValue.trim()) && !(n.nodeType === 1 && n.tagName === "BR"));
      const last = kids[kids.length - 1], prev = kids[kids.length - 2];
      if (!last || last.nodeType !== 1 || last.tagName !== "CODE" || !prev || prev.nodeType !== 3) return;
      if (!/[：:]\s*$/.test(prev.nodeValue) || last.textContent.trim().length < 8 || !/[=^|&<>⊕+*]/.test(last.textContent)) return;
      while (p.lastChild !== last) p.lastChild.remove();
      p.after(eqBox([last]));
      while (p.lastChild && ((p.lastChild.nodeType === 3 && !p.lastChild.nodeValue.trim()) || p.lastChild.tagName === "BR")) p.lastChild.remove();
      p.lastChild && p.lastChild.nodeType === 3 && (p.lastChild.nodeValue = p.lastChild.nodeValue.replace(/\s+$/, ""));
    });
    $$(":scope > ul, :scope > ol, :scope > blockquote > ul, :scope > blockquote > ol", root).forEach((list) => {
      const lis = Array.from(list.children);
      const codes = lis.map((li) => (li.tagName === "LI" ? solo(li) : null));
      if (lis.length && codes.every(Boolean)) list.replaceWith(eqBox(codes));
    });
    $$(".eq", root).forEach((d) => { const n = d.nextElementSibling; if (n && n.classList.contains("eq") && d.isConnected) { n.prepend(...d.childNodes); d.remove(); } });
    // 7e) “**标签**：值”组成的短列表（仓库、作者、协议……）→ 一张安静的信息表（标签一列、值一列）
    $$("ul", root).forEach((ul) => {
      if (ul.closest("li")) return;
      const lis = Array.from(ul.children);
      if (lis.length < 2) return;
      const rows = lis.map((li) => {
        if (li.tagName !== "LI" || li.querySelector("ul, ol, pre, img, .eq")) return null;
        const w = speaker(li);
        if (!w) return null;
        let len = li.textContent.length - w.name.length;
        $$("a", li).forEach((a) => (len -= a.textContent.length));   // 链接本身再长也算“短”：它就是值
        return len <= 32 ? w : null;
      });
      if (!rows.every(Boolean)) return;
      const dl = document.createElement("dl"); dl.className = "wp-meta";
      lis.forEach((li, i) => {
        const w = rows[i];
        w.label.remove(); w.after.nodeValue = w.after.nodeValue.replace(/^\s*[：:]\s*/, "");
        const row = document.createElement("div");
        row.innerHTML = `<dt>${esc(w.name)}</dt><dd></dd>`;
        row.lastChild.append(...li.childNodes);
        dl.appendChild(row);
      });
      ul.replaceWith(dl);
    });
    // 7f) 以冒号收尾、引出下一块（公式、代码、列表、表格）的段落：与那一块贴近些——它们本是一句话
    $$(":scope > p", root).forEach((p) => {
      const n = p.nextElementSibling;
      if (n && /[：:]\s*$/.test(p.textContent) && n.matches(".eq, .code, ul, ol, .table-wrap, .wp-meta")) p.classList.add("is-leadin");
    });
    // 7g) 正文里裸露的网址（链接文字就是网址本身）：去掉 https:// 与末尾斜杠，用西文字体排
    $$("a[href]", root).forEach((a) => {
      const t = a.textContent.trim();
      if (!/^https?:\/\/\S+$/.test(t) || a.children.length) return;
      // 每个“/”之后留一个可折行点（<wbr>）：窄屏上网址在路径的分隔处换行，而不是从单词中间断开
      a.replaceChildren();
      t.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").split(/(?<=\/)/).forEach((seg, i) => { if (i) a.appendChild(document.createElement("wbr")); a.appendChild(document.createTextNode(seg)); });
      a.classList.add("url");
    });
    // 8) 标题编号 + 站内目录锚点（标题开头的 emoji —— 📦 🔗 ✨ —— 去掉：彩色图标与细线、小编号的克制气质不合）
    const heads = $$("h2, h3", root);
    heads.forEach((h, i) => { h.id = "s-" + (i + 1); h.textContent = h.textContent.replace(EMOJI_HEAD, "").trim(); });
    // 二级标题自带“一、”“1.”“第二章”这样的序号（至多一个例外，比如文末的“项目与源码”）：分节编号（i, ii, iii）会再编一遍，
    // 去掉手写的那一份，免得双重编号
    const h2s = heads.filter((h) => h.tagName === "H2");
    const numbered = h2s.filter((h) => ORDINAL.test(h.textContent) && h.textContent.replace(ORDINAL, "").trim());
    if (numbered.length >= 2 && numbered.length >= h2s.length - 1) numbered.forEach((h) => (h.textContent = h.textContent.replace(ORDINAL, "").trim()));
    // 标题的字距是给汉字的（.14–.2em）；夹在里面的西文、数字（“Gemini”“118 MB/s”）被拉成一个个散字母——单独收紧
    heads.forEach((h) => {
      const t = h.textContent;
      if (!/[A-Za-z0-9]/.test(t)) return;
      const frag = document.createDocumentFragment();
      t.split(LAT_RUN).forEach((x, i) => {
        if (!x) return;
        if (i % 2) { const s = document.createElement("span"); s.className = "lat"; s.textContent = x; frag.appendChild(s); }
        else frag.appendChild(document.createTextNode(x));
      });
      h.replaceChildren(frag);
    });
    $$('a[href*="#"]', root).forEach((a) => {
      const u = new URL(a.href, location.href);
      if (!u.hash || (u.pathname !== "/" && u.origin === location.origin && u.pathname !== location.pathname && !/wh1te/.test(u.host))) return;
      const want = decodeURIComponent(u.hash.slice(1)).replace(/-/g, " ").trim();
      const hit = heads.find((h) => h.textContent.trim() === want || h.textContent.replace(/\s+/g, " ").includes(want));
      if (hit) { a.setAttribute("href", "#" + hit.id); a.removeAttribute("target"); a.removeAttribute("rel"); }
    });
    // 9) 正文里手写的“目录行”（一段只有几个指向本页标题的链接，用 • | / 隔开）→ 一行安静的目次
    $$("p", root).forEach((p) => {
      const links = $$("a", p);
      if (links.length < 3 || !links.every((a) => /^#s-\d+$/.test(a.getAttribute("href") || ""))) return;
      const rest = Array.from(p.childNodes).filter((n) => !(n.nodeType === 1 && n.tagName === "A")).map((n) => n.textContent).join("");
      if (!/^[\s•·・|｜/／、,，-]*$/.test(rest)) return;
      const nav = document.createElement("nav");
      nav.className = "wp-index";
      nav.setAttribute("aria-label", "本文目次");
      nav.innerHTML = `<span class="wp-index__label">目次</span>` + links.map((a) => `<a href="${a.getAttribute("href")}">${esc(a.textContent.trim())}</a>`).join("");
      p.replaceWith(nav);
    });
    // 10) 行内 LaTeX 残留（“$33 \times 33$”“$\leftrightarrow$”）→ 对应的字符；有不认识的命令就保持原样
    const texWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest("pre, code") ? NodeFilter.FILTER_REJECT : /\$[^$]*\\[^$]*\$/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const texNodes = [];
    while (texWalker.nextNode()) texNodes.push(texWalker.currentNode);
    texNodes.forEach((n) => {
      n.nodeValue = n.nodeValue.replace(/\$([^$\n]{1,80})\$/g, (m, body) => {
        if (!body.includes("\\")) return m;
        const out = body.replace(/\^\s*\{?\\circ\}?/g, "°").replace(/\\([A-Za-z]+|[%,; ])/g, (x, k) => (Object.prototype.hasOwnProperty.call(TEX, k) ? TEX[k] : x))
          .replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
        return out.includes("\\") ? m : out;
      });
    });
    // 11) 表格里很短的格子（“33 × 33 × 33”“—”、不长的文件名）不折行：折成两行反而难读；长路径照常折，把宽度留给说明文字
    //     （放在最后：要按 LaTeX 换成字符之后的长度算）
    $$(".table-wrap td, .table-wrap th", root).forEach((c) => {
      const n = c.textContent.trim().length, code = solo(c);
      if (!c.querySelector("img") && (n <= 14 || (code && n <= 18))) c.classList.add("nw");
    });
    return heads;
  }
  // 元素里（除去空白与 <br>）只有一段行内代码：返回那个 <code>，否则 null
  const solo = (el) => { const kids = Array.from(el.childNodes).filter((n) => !(n.nodeType === 3 && !n.nodeValue.trim()) && !(n.nodeType === 1 && n.tagName === "BR")); return kids.length === 1 && kids[0].nodeType === 1 && kids[0].tagName === "CODE" ? kids[0] : null; };
  // “**名字**：”开头的段落 / 列表项：返回说话人（名字不超过 12 个字），否则 null
  function speaker(el) {
    let f = el.firstChild;
    while (f && f.nodeType === 3 && !f.nodeValue.trim()) f = f.nextSibling;
    if (!f || f.nodeType !== 1 || !/^(STRONG|B)$/.test(f.tagName)) return null;
    const name = f.textContent.trim(), after = f.nextSibling;
    if (!name || name.length > 12 || /[：:]$/.test(name) || !after || after.nodeType !== 3 || !/^\s*[：:]/.test(after.nodeValue)) return null;
    return { name, label: f, after };
  }
  const EMOJI_HEAD = /^(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\uFE0F\u200D]?\s*)+/u;
  const ORDINAL = /^\s*(?:第?[一二三四五六七八九十百]+[、.．章节]|\d{1,2}[.、．)）](?!\d)|[IVXivx]{1,4}[.、])\s*/;
  const LAT_RUN = /([A-Za-z0-9](?:[A-Za-z0-9 .,'\/+\-_&%]*[A-Za-z0-9%])?)/;
  const AMBI = /[\u2190-\u23FF\u25A0-\u25FF]/, AMBI_SPLIT = /([\u2190-\u23FF\u25A0-\u25FF])/;
  const LANG = { c: "C", h: "C", cpp: "C++", "c++": "C++", cc: "C++", hpp: "C++", cs: "C#", csharp: "C#", "c#": "C#", js: "JavaScript", javascript: "JavaScript", mjs: "JavaScript",
    ts: "TypeScript", typescript: "TypeScript", jsx: "JSX", tsx: "TSX", py: "Python", python: "Python", sh: "Shell", bash: "Shell", shell: "Shell", zsh: "Shell", console: "Shell",
    ps: "PowerShell", ps1: "PowerShell", powershell: "PowerShell", bat: "Batch", cmd: "Batch", asm: "Assembly", assembly: "Assembly", nasm: "Assembly", x86asm: "Assembly", armasm: "Assembly",
    json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI", xml: "XML", html: "HTML", css: "CSS", scss: "SCSS", sql: "SQL", go: "Go", golang: "Go", rust: "Rust", rs: "Rust",
    java: "Java", kotlin: "Kotlin", kt: "Kotlin", swift: "Swift", php: "PHP", rb: "Ruby", ruby: "Ruby", lua: "Lua", qml: "QML", cmake: "CMake", make: "Makefile", makefile: "Makefile",
    dockerfile: "Dockerfile", nginx: "Nginx", diff: "Diff", md: "Markdown", markdown: "Markdown", glsl: "GLSL", hlsl: "HLSL", vue: "Vue", dart: "Dart",
    text: "Text", txt: "Text", plain: "Text", plaintext: "Text", none: "Text" };
  const TEX = { times: "×", cdot: "·", div: "÷", pm: "±", leftrightarrow: "↔", Leftrightarrow: "⇔", rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
    approx: "≈", sim: "∼", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", infty: "∞", circ: "°", degree: "°", ldots: "…", cdots: "⋯",
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", Sigma: "Σ", omega: "ω", "%": "%", ",": " ", ";": " ", " ": " " };

  // 章节：有两个以上二级标题就按二级标题分节，否则按全部标题（目录、页边章节导航、键盘跳转共用这一份）
  const sectionHeads = (heads) => { const top = heads.filter((h) => h.tagName === "H2"); return (top.length >= 2 ? top : heads).slice(0, 40); };
  const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];
  const roman = (i) => ROMAN[i] || String(i + 1);

  function tocHTML(heads, title) {
    const top = heads.filter((h) => h.tagName === "H2");
    const list = top.length >= 2 ? top : heads;
    const roman = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
    const items = [`<li><a href="#p-0"><span class="toc__num">0</span><span class="toc__title">${esc(title)}</span><span class="toc__jp">はじめに</span></a></li>`]
      .concat(list.slice(0, 40).map((h, i) => `<li${h.tagName === "H3" && top.length >= 2 ? ' class="toc__sub"' : ""}><a href="#${h.id}"><span class="toc__num">${roman[i] || i + 1}</span><span class="toc__title">${esc(h.textContent)}</span><span class="toc__jp"></span></a></li>`));
    return items.join("");
  }

  /* ==========================================================================
     章节导航：页边的章节刻度（宽屏）· 底部的上一节 / 下一节（窄屏）· 键盘 J / K、[ / ]
     · 当前章节用 IntersectionObserver 判断（标题越过视口 45% 那条线即算进入），滚动时从不读版面
     · 跳转统一走 Kata.glide：近处缓滑，远处“淡出—落下—滑完最后半屏—淡回”；到达的标题轻轻亮一下
     · 二级标题第一次进入视口时，编号和细线从左边画出来（只动透明度与位移，正文段落不做动画）
     ========================================================================== */
  function setupSections(article, heads, title) {
    const list = sectionHeads(heads);
    const numbered = heads.filter((h) => h.tagName === "H2").length >= 2;
    article.classList.toggle("has-sections", numbered);
    if (!reduce) {
      article.classList.add("sec-anim");
      const seenIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-seen"); seenIO.unobserve(e.target); } }), { rootMargin: "0px 0px -12% 0px" });
      $$("h2, h3", article).forEach((h) => seenIO.observe(h));
    }
    if (list.length < 2) return;

    const items = [{ el: article, id: "p-0", no: "序", label: "はじめに" }].concat(list.map((h, i) => ({ el: h, id: h.id, no: roman(i), label: h.textContent.trim() })));
    const N = items.length;
    const glide = (y, o) => (window.Kata && window.Kata.glide ? window.Kata.glide(y, o) : scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" }));

    // 宽屏：页边刻度
    const rail = document.createElement("nav");
    rail.className = "secnav";
    rail.setAttribute("aria-label", "章节");
    rail.innerHTML = `<ol>${items.map((it, i) => `<li><a href="#${it.id}" data-i="${i}"><i aria-hidden="true"></i><span class="secnav__no">${it.no}</span><span class="secnav__t">${esc(it.label)}</span></a></li>`).join("")}</ol>`;
    rail.classList.toggle("is-dense", N > 12);
    // 窄屏：上一节 / 当前 / 下一节
    const pill = document.createElement("div");
    pill.className = "secpill";
    pill.innerHTML = `<button class="secpill__btn" data-step="-1" aria-label="上一节"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5"/></svg></button>
      <button class="secpill__label" aria-label="打开目录"><span class="secpill__no"></span><span class="secpill__t"></span></button>
      <button class="secpill__btn" data-step="1" aria-label="下一节"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>`;
    document.body.append(rail, pill);
    const links = $$("a", rail), pNo = $(".secpill__no", pill), pT = $(".secpill__t", pill), [prevB, , nextB] = $$("button", pill);

    // 当前章节：标题越过视口 45% 那条线即算进入
    const passed = new Array(N).fill(false);
    let cur = -1, inRange = false;
    const sync = () => {
      let c = -1;
      for (let i = 0; i < N; i++) if (passed[i]) c = i;
      if (c === cur) return;
      cur = c;
      links.forEach((a, i) => a.setAttribute("aria-current", String(i === cur)));
      const it = items[Math.max(0, cur)];
      pNo.textContent = cur <= 0 ? "" : `${it.no} / ${roman(N - 2)}`;
      pT.textContent = cur <= 0 ? title : it.label;
      prevB.disabled = cur <= 0; nextB.disabled = cur >= N - 1;
    };
    // 观察带从视口 45% 那条线一直向上延伸到“无穷远”：标题在线以上即为相交——
    // 只有越过这条线时状态才变，远距离跳转（一下越过好几节）也不会漏掉（若只观察视口内，在上方与在下方都是“不相交”，跳回去时收不到回调）
    const lineIO = new IntersectionObserver((es) => {
      es.forEach((e) => { const i = items.findIndex((it) => it.el === e.target); if (i >= 0) passed[i] = e.isIntersecting; });
      sync();
    }, { rootMargin: "1000000px 0px -55% 0px" });
    items.forEach((it) => lineIO.observe(it.el));
    sync();
    // 只在正文范围内出现（题图上、留言区里都收起来）
    const rangeIO = new IntersectionObserver((es) => { inRange = es[0].isIntersecting; show(); }, { rootMargin: "-35% 0px -35% 0px" });
    rangeIO.observe(article);
    const bar = $(".bar");
    let lastY = scrollY, barOut = false, raf = 0;
    const show = () => {
      rail.classList.toggle("is-shown", inRange);
      // “上次读到 · 继续”那颗提示还在时先让它（两者都在底部正中）
      pill.classList.toggle("is-shown", inRange && !barOut && !document.body.classList.contains("drawer-open") && !document.querySelector(".resume.is-on"));
    };
    addEventListener("scroll", () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; const y = scrollY; barOut = bar ? bar.classList.contains("is-hidden") : y > lastY; lastY = y; show(); });
    }, { passive: true });

    // 跳转：标题落在视口上方约 18% 处（不贴着顶栏），到达后轻轻亮一下
    function toEl(el, id, isStart) {
      const off = isStart ? Math.min(120, innerHeight * 0.14) : Math.min(150, innerHeight * 0.18);
      history.replaceState(null, "", "#" + id);
      el.classList.add("is-seen");   // 浮现（10px 位移）在滑行途中完成；落点每帧重算，跟着标题走（图片还在加载、版面在变时也不偏）
      glide(() => el.getBoundingClientRect().top + scrollY - off, { done: () => {
        if (isStart || reduce) return;
        el.classList.remove("is-target"); void el.offsetWidth; el.classList.add("is-target");
        setTimeout(() => el.classList.remove("is-target"), 1800);
      } });
      return true;
    }
    const go = (i) => { i = Math.max(0, Math.min(N - 1, i)); return toEl(items[i].el, items[i].id, i === 0); };
    // 不在章节列表里的小标题（h3）：同样的落点与提示
    const goHash = (hash) => {
      const i = items.findIndex((it) => "#" + it.id === hash);
      if (i >= 0) return go(i);
      const h = heads.find((x) => "#" + x.id === hash);
      return h ? toEl(h, h.id, false) : false;
    };
    const step = (d) => go(cur < 0 ? (d > 0 ? 1 : 0) : cur + d);
    rail.addEventListener("click", (e) => { const a = e.target.closest("a"); if (!a) return; e.preventDefault(); go(+a.dataset.i); });
    pill.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.step) step(+b.dataset.step);
      else { const open = $("[data-open-drawer]"); open && open.click(); }
    });
    // 正文里的站内锚点（含手写目录行）也走同样的跳转
    article.addEventListener("click", (e) => {
      const a = e.target.closest('a[href^="#"]'); if (!a) return;
      if (goHash(a.getAttribute("href"))) e.preventDefault();
    });
    addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      const t = document.activeElement;
      if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
      if (document.body.classList.contains("drawer-open")) return;
      if (e.key === "j" || e.key === "]") { e.preventDefault(); step(1); }
      else if (e.key === "k" || e.key === "[") { e.preventDefault(); step(-1); }
    });
    // 目录抽屉里的条目也交给这里（site.js 的目录点击会先问 KataSections）
    window.KataSections = { go: goHash };
    // 带着章节锚点打开（分享出来的链接）：等正文展开后再滑过去
    // 先把地址里的锚点拿掉：否则浏览器在图片陆续加载时会反复按原生锚点把页面拉回去，盖掉这次滑行；到达后 toEl 会把锚点写回来
    const h = decodeURIComponent(location.hash || "");
    if (/^#s-\d+$/.test(h)) {
      history.replaceState(null, "", location.pathname + location.search);
      // 等图片大多到齐（版面稳定）再滑，最多等 2.5 秒
      const start = () => { clearTimeout(cap); removeEventListener("load", start); setTimeout(() => goHash(h), 200); };
      const cap = setTimeout(start, 2500);
      if (document.readyState === "complete") start(); else addEventListener("load", start, { once: true });
    }
  }

  async function setupPost() {
    const root = $("[data-post]");
    if (!root) return;
    const id = new URLSearchParams(location.search).get("id");
    const done = () => document.dispatchEvent(new CustomEvent("kata:content"));
    if (!id || !/^\d+$/.test(id)) { location.replace("archive.html"); return; }

    const t0 = performance.now();
    // 文库列表（只为算上一篇/下一篇）与正文没有依赖，先发出去，别等正文回来再串一次
    const neighbors = A.posts({ perPage: 100, lite: true }).catch(() => []);
    let post;
    try { post = await A.post(id); }
    catch (e) {
      root.classList.add("is-error");
      $("[data-slot=body]", root).innerHTML = `<div class="prose lost"><p class="lost__title">${e.status === 404 ? "这一页在时间里走丢了。" : "信号在云层之上中断了。"}</p><p>${esc(e.status === 404 ? "也许它被收回了，也许从来没有被写下。" : e.message)}</p><p><a href="archive.html">回到文库</a> · <a href="index.html">回到首页</a></p></div>`;
      $(".post-hero__head h1", root).textContent = e.status === 404 ? "……" : "未能取回";
      $("[data-slot=kicker]", root).innerHTML = `<span>${e.status === 404 ? "不存在的一页" : "信号中断"}</span>`;
      $("[data-slot=sub]", root).textContent = e.status === 404 ? "也许它被收回了，也许从来没有被写下。" : "云层之上的信号暂时断了，稍后再来看看。";
      document.body.dataset.postState = "ready";
      done(); return;
    }
    const ph = A.PHASES[post.phase];
    // 技术分类的版式（宽栏 / 固定夜间 / 题图 78vh）必须在填题图之前就位，
    // 否则题图会先按默认尺寸画一遍，再被 .is-tech 缩一次 —— 标题「先大后小」、壁纸跟着跳。
    document.body.classList.toggle("is-tech", !!post.isTech);
    // 题图：写下那一刻的天空。若首帧已从缓存画好（同一画面），只校正文字，不重建 WebGL
    A.view.fillHero(post);

    // 翻开文章的转场还在进行：正文在首屏之外，等转场结束再排版，动画期间不占主线程
    const vt = window.KataVT && window.KataVT.busy;
    if (vt && !vt.done) {
      await vt;
      await new Promise((r) => (window.requestIdleCallback || ((f) => setTimeout(f, 50)))(r, { timeout: 300 }));
    }

    // 正文：分三步，每步之间让出一帧——
    //   ① 在文档外清洗、整理（纯脚本） ② 插入版面并排版（正文仍透明） ③ 目录、文末、留言
    // 原来这些挤在一个任务里（4 倍降速下约 260ms），正好撞上题图文字的逐行浮现，动画会顿一下
    const article = $("[data-slot=body]", root);
    const draft = document.createElement("div");
    draft.innerHTML = A.sanitize(post.html);
    if (post.img && !draft.querySelector(`img[src="${CSS.escape(post.img.src)}"]`)) {
      draft.insertAdjacentHTML("afterbegin", `<figure><img src="${esc(post.img.src)}" alt="${esc(post.img.alt)}" width="${post.img.w || ""}" height="${post.img.h || ""}"></figure>`);
    }
    draft.dataset.uploads = `https://api.wh1te.top/wp-content/uploads/${String(post.date).slice(0, 4)}/${String(post.date).slice(5, 7)}/`;
    const heads = normalize(draft);
    await nextPaint();
    const body = document.body;
    const waitedNet = performance.now() - t0 > 120;
    body.dataset.postState = "arriving";
    article.classList.add("is-arriving");
    article.setAttribute("data-chapter", post.title);
    article.replaceChildren(...draft.childNodes);
    void article.offsetHeight;                      // 立即排版 → 触发所需字体的加载（见下方“一次性展开”）
    await nextPaint();
    heads.forEach((h) => h.setAttribute("data-chapter", h.textContent.length > 18 ? h.textContent.slice(0, 17) + "…" : h.textContent));
    const first = $(":scope > p", article);
    if (first && !first.hasAttribute("data-br") && first.textContent.trim().length > 30 && first === article.firstElementChild) {
      first.classList.add("lede");
      const t = first.firstChild;
      if (t && t.nodeType === 3) { const ch = t.nodeValue.trimStart(); if (/^[㐀-鿿]/.test(ch)) { t.nodeValue = ch.slice(1); first.insertAdjacentHTML("afterbegin", `<span class="dropcap">${ch[0]}</span>`); } }
    }
    if (!heads.length) $("[data-open-drawer] span") && ($("[data-open-drawer] span").textContent = "设置");
    $(".toc").innerHTML = tocHTML(heads, post.title);
    setupSections(article, heads, post.title);
    $(".bar__chapter span").dataset.default = post.title;
    $(".bar__chapter span").textContent = post.title;
    $$(".code__copy", article).forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.closest(".code").querySelector("pre").innerText); b.textContent = "已复制"; }
      catch (e) { b.textContent = "无法复制"; }
      setTimeout(() => (b.textContent = "复制"), 1600);
    }));

    // 文末
    const end = $("[data-slot=end]", root);
    end.innerHTML = `
      <p class="post-end__sign">— ${esc(A.config.author || "")}${post.modified && post.modified.slice(0, 10) !== post.date.slice(0, 10) ? `<br><small>修订于 ${A.fmt.short(post.modified)}</small>` : ""}</p>
      <div class="thread" aria-hidden="true"><svg viewBox="0 0 1000 90" preserveAspectRatio="none"><path d="M0 45 C 180 15, 340 75, 500 42 C 540 34, 560 62, 520 64 C 480 66, 492 26, 560 30 S 830 72, 1000 40"/><path class="thread__b" d="M0 50 C 190 22, 350 80, 505 48 S 820 76, 1000 46"/></svg></div>
      <nav class="post-next" aria-label="继续阅读" data-slot="next"></nav>`;
    loadNeighbors(post, $("[data-slot=next]", end), neighbors);
    setupComments(post);

    // 一次性展开：正文已以透明状态进入版面——浏览器排字时只会去取真正缺字的那几个字体分层；
    // 等这些字体到齐（最多 1.5s），版面与文字再同时出现。
    // 不会先用系统字体排一遍再“跳”成衬线体，也不会一段一段地冒出来。
    await nextPaint();
    let waitedFont = false;
    if (document.fonts && document.fonts.status === "loading") {
      waitedFont = true;
      await Promise.race([document.fonts.ready, sleep(1500)]);
    }
    enhance(root);
    done(); // site.js 在此刻量版面、建目录刻度（正文已在流里，只是透明）
    if ((waitedNet || waitedFont) && !reduce) {
      requestAnimationFrame(() => requestAnimationFrame(() => { body.dataset.postState = "ready"; article.classList.remove("is-arriving"); }));
    } else { // 缓存 + 字体都在：直接就位，不做任何淡入
      article.style.transition = "none";
      body.dataset.postState = "ready"; article.classList.remove("is-arriving");
      void article.offsetHeight; article.style.transition = "";
    }
  }


  async function loadNeighbors(post, nav, pending) {
    try {
      const list = await (pending || A.posts({ perPage: 100, lite: true }));
      const i = list.findIndex((p) => p.id === post.id);
      const newer = i > 0 ? list[i - 1] : null, older = i >= 0 ? list[i + 1] : null;
      const cell = (p, label) => p ? `<a href="${p.href}" data-peek="${esc(peekSrc(p))}"><small>${label} · ${A.fmt.short(p.date)} ${A.PHASES[p.phase].name}</small><strong>${esc(p.title)}</strong></a>` : `<a href="archive.html"><small>${label}</small><strong>回到文库</strong></a>`;
      nav.innerHTML = cell(older, "上一篇") + cell(newer, "下一篇");
      enhance(nav);
    } catch (e) { nav.innerHTML = `<a href="archive.html"><small>文库</small><strong>全部文章</strong></a><a href="index.html"><small>首页</small><strong>かたわれ時</strong></a>`; }
  }

  /* ---------- 留言 ---------- */
  function setupComments(post) {
    const box = $("[data-comments]");
    if (!box) return;
    const list = $("[data-slot=comments]", box), form = $("form", box), note = $("[data-slot=form-note]", box), cnt = $("[data-slot=ccount]", box);
    const store = window.Kata ? window.Kata.store : { get() {}, set() {} };
    let loaded = false;

    const initial = (s) => (s || "?").trim().charAt(0).toUpperCase();
    // 头像底色：按名字散列到原作色卡（同一个人永远是同一种颜色）
    const HUES = ["#9e84a6", "#48517f", "#b87e7b", "#5279bc", "#6c8fa8", "#c08a5a", "#7a6a8f", "#8f3830"];
    const hue = (n) => { let h = 0; for (const ch of String(n || "?")) h = (h * 31 + ch.codePointAt(0)) >>> 0; return HUES[h % HUES.length]; };
    const isAuthor = (n) => (n || "").trim().toLowerCase() === String(A.config.author || "").toLowerCase();
    function tree(items) {
      const by = {}; items.forEach((c) => (by[c.parent] = by[c.parent] || []).push(c));
      const node = (c, depth) => `<li class="cm${isAuthor(c.author_name) ? " cm--author" : ""}" id="c-${c.id}">
          <span class="cm__avatar" aria-hidden="true" style="--hue:${hue(c.author_name)}">${esc(initial(c.author_name))}</span>
          <div class="cm__main">
            <div class="cm__head"><span class="cm__name">${esc(c.author_name || "匿名")}</span>${isAuthor(c.author_name) ? '<span class="cm__badge">作者</span>' : ""}<time datetime="${esc(c.date)}" title="${esc(c.date.replace("T", " "))}">${A.fmt.rel(c.date)}</time></div>
            <div class="cm__body">${A.sanitize(c.content && c.content.rendered, { minimal: true })}</div>
            ${post.commentsOpen && depth < 4 ? `<div class="cm__actions"><button class="cm__reply" data-reply="${c.id}" data-name="${esc(c.author_name)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4 2.5 7.5 6 11M3 7.5h6.5a4 4 0 0 1 4 4V13"/></svg>回复</button></div>` : ""}
          </div>
          ${by[c.id] ? `<ol class="cm__children">${by[c.id].map((x) => node(x, depth + 1)).join("")}</ol>` : ""}</li>`;
      return (by[0] || []).map((c) => node(c, 0)).join("");
    }
    // 骨架与真实留言同结构（载入时列表不跳）
    const skel = () => Array.from({ length: 3 }, () => '<li class="cm is-skel" aria-hidden="true"><span class="cm__avatar">　</span><div class="cm__main"><div class="cm__head"><span class="cm__name">　　　</span><time>　　</time></div><div class="cm__body"><p>　</p></div></div></li>').join("");
    async function load() {
      loaded = true;
      list.innerHTML = skel();
      try {
        const items = await A.comments(post.id);
        cnt.textContent = items.length ? String(items.length) : "";
        list.innerHTML = items.length ? tree(items) : '<li class="cm-empty"><p>暂无留言</p></li>';
      } catch (e) { cnt.textContent = ""; list.innerHTML = `<li class="cm-empty"><p>留言加载失败</p></li>`; }
    }
    if (!post.commentsOpen) { form.insertAdjacentHTML("beforebegin", '<p class="cm-closed">留言已关闭</p>'); form.remove(); return; }
    // 关闭留言的文章不必请求评论：观察器要放在这个判断之后
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting && !loaded) { load(); io.disconnect(); } }, { rootMargin: "60% 0px" });
    io.observe(box);

    const name = form.elements.author_name, email = form.elements.author_email, content = form.elements.content, parent = form.elements.parent;
    const chars = $("[data-slot=chars]", form);
    const count = () => { const n = content.value.length; chars.textContent = n > content.maxLength * 0.9 ? `${n} / ${content.maxLength}` : ""; };
    content.addEventListener("input", count);
    name.value = store.get("cm:name") || ""; email.value = store.get("cm:email") || "";
    const replyTag = $("[data-slot=replying]", form);
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-reply]"); if (!b) return;
      parent.value = b.dataset.reply;
      replyTag.innerHTML = `回复 <b>${esc(b.dataset.name)}</b> <button type="button" data-cancel>取消</button>`;
      replyTag.hidden = false;
      content.focus({ preventScroll: true });
      form.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    });
    replyTag.addEventListener("click", (e) => { if (e.target.closest("[data-cancel]")) { parent.value = "0"; replyTag.hidden = true; } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = content.value.trim();
      if (!name.value.trim() || !/^\S+@\S+\.\S+$/.test(email.value.trim()) || body.length < 2) {
        note.dataset.state = "err"; note.textContent = "请填写称呼、邮箱和留言内容"; return;
      }
      const btn = $("button[type=submit]", form);
      btn.disabled = true; form.classList.add("is-sending"); note.dataset.state = ""; note.textContent = "发送中…";
      try {
        const res = await A.comment({ post: post.id, parent: +parent.value || 0, author_name: name.value.trim(), author_email: email.value.trim(), content: body });
        store.set("cm:name", name.value.trim()); store.set("cm:email", email.value.trim());
        content.value = ""; count(); parent.value = "0"; replyTag.hidden = true;
        note.dataset.state = "ok";
        note.textContent = res && res.status === "approved" ? "已发送" : "已发送，审核后显示";
        if (res && res.status === "approved") load();
      } catch (err) {
        note.dataset.state = "err";
        note.textContent = err.status === 401 || err.code === "rest_comment_login_required" ? "暂不支持匿名留言"
          : err.status === 409 ? "重复的留言" : "发送失败，请稍后再试";
      } finally { btn.disabled = false; form.classList.remove("is-sending"); }
    });
  }

  /* ---------- 意图预取：指针停上、获得焦点或手指按下的那一刻，就把文章数据、题图与深度图取回来 ----------
     （支持 Speculation Rules 的浏览器还会整页预渲染，见 vt.js；这里覆盖其余浏览器，并让预渲染本身更快） */
  const rawText = (raw) => ({ title: A.text(raw.title && raw.title.rendered), excerpt: A.text(raw.excerpt && raw.excerpt.rendered), html: raw.content && raw.content.rendered });
  function setupPrefetch() {
    const seen = new Set();
    const warm = (src) => { const i = new Image(); i.decoding = "async"; i.src = src; };
    // 指向画廊 / 追番的链接：先把那一页要的数据取回本地缓存（画廊再顺手取首屏的几张图），点进去第一帧就能排好
    let wall = false, week = false;
    const page = (a) => {
      const href = a.getAttribute("href") || "";
      if (!wall && /gallery\.html/.test(href)) {
        wall = true;
        A.pixiv().then((d) => {
          const n = innerWidth >= 1150 ? 4 : innerWidth >= 760 ? 3 : 2;
          d.list.slice(0, n * 2).forEach((x, i) => {
            const im = new Image(); im.referrerPolicy = "no-referrer"; im.decoding = "async";
            im.src = x.url.replace(/\/c\/[^/]+\/img-master\//, `/c/${i === 0 && n >= 3 ? "1200x1200" : "600x1200"}_90_webp/img-master/`);
          });
        }).catch(() => { wall = false; });
      }
      if (!week && /bangumi\.html/.test(href)) { week = true; A.bgmCalendar().catch(() => { week = false; }); }
    };
    const go = (e) => {
      const any = e.target.closest && e.target.closest('a[href*=".html"]');
      if (any) page(any);
      const a = any && any.matches('a[href*="post.html?id="]') ? any : null;
      if (!a) return;
      const m = /post\.html\?id=(\d+)/.exec(a.getAttribute("href") || "");
      const id = m && +m[1];
      if (!id || seen.has(id)) return;
      seen.add(id);
      const raw = A.peekRaw(id);
      if (raw && raw.date) {
        const sc = A.sceneFor(raw);
        warm(`assets/img/${sc.key}-${innerWidth > 960 ? 1600 : 960}.webp`);
        warm(`assets/depth/${sc.key}.webp`);
      }
      if (raw && raw.content) A.fonts.warmPost(rawText(raw));
      if (!A.cached(id)) A.post(id).then((m) => A.fonts.warmPost(m)).catch(() => seen.delete(id));
    };
    document.addEventListener("pointerover", go, { passive: true });
    document.addEventListener("touchstart", go, { passive: true });
    document.addEventListener("focusin", go);
  }

  /* ---------- 空闲时预热：把最近 30 篇的完整正文取回本地缓存（一次请求，边缘缓存 5 分钟）----------
     之后从首页 / 文库点开任何一篇，第一帧就有完整题图与正文 */
  function warmLibrary() {
    if (!$("[data-journal], [data-archive]")) return;
    if (navigator.connection && navigator.connection.saveData) return;
    const onHome = !!$("[data-journal]");
    // 正文入缓存之后，顺手把最靠前的两篇（最可能被点开的）要用的字体分层也取回来
    const leads = () => [...document.querySelectorAll('a[href*="post.html?id="]')].map((a) => +(/id=(\d+)/.exec(a.getAttribute("href")) || [])[1]).filter((id, i, all) => id && all.indexOf(id) === i).slice(0, 2)
      .forEach((id) => { const raw = A.peekRaw(id); if (raw && raw.content) A.fonts.warmPost(rawText(raw)); });
    const go = () => A.posts(onHome ? { perPage: 23, offset: 7, seedOnly: true } : { perPage: 30, seedOnly: true }).then(leads).catch(() => {});
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1200));
    // 等开场动画结束、首页稳定下来再开始（不和开场的最后一幕抢主线程）
    const start = () => setTimeout(() => idle(go, { timeout: 4000 }), 1500);
    const afterIntro = () => (document.querySelector(".intro") ? setTimeout(afterIntro, 400) : start());
    addEventListener("load", afterIntro, { once: true });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    warmLibrary();
    setupPrefetch();
    setupEdgeStatus();
    setupHome();
    setupArchive();
    setupPost();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
