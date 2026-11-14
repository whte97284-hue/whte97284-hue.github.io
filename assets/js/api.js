/* ==========================================================================
   かたわれ時 — 边缘层数据（Cloudflare Worker → WordPress）
   - 与 Worker 的路由一一对应：/blog/posts · /blog/post?id · /blog/categories · /blog/comments
   - stale-while-revalidate：先给本地缓存，再静默刷新；离线时整站仍可读
   - 所有 HTML 都经过白名单清洗后才进入页面
   - “写下的时刻”：按文章发布的钟点，把它放进电影里同一时段的天空
   ========================================================================== */
(function () {
  "use strict";
  const C = Object.assign({ api: "", mirrorHosts: [], perPage: 12, timeout: 9000, cacheTTL: 300000 }, window.KATA_CONFIG || {});
  const isDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const mirror = (C.mirrorHosts || []).includes(location.hostname) || location.protocol === "file:";
  const BASE = (mirror || !C.api ? "" : C.api).replace(/\/$/, "");
  const PREFIX = "kata:api:";

  /* ---------- 缓存 ---------- */
  const cache = {
    get(k) { try { const v = localStorage.getItem(PREFIX + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, data, source) {
      try { localStorage.setItem(PREFIX + k, JSON.stringify({ t: Date.now(), data, source })); }
      catch (e) { // 配额满：清掉最旧的一半再试
        try {
          const keys = Object.keys(localStorage).filter((x) => x.startsWith(PREFIX));
          keys.map((x) => [x, (JSON.parse(localStorage.getItem(x)) || {}).t || 0]).sort((a, b) => a[1] - b[1])
            .slice(0, Math.ceil(keys.length / 2)).forEach(([x]) => localStorage.removeItem(x));
          localStorage.setItem(PREFIX + k, JSON.stringify({ t: Date.now(), data, source }));
        } catch (e2) {}
      }
    },
  };

  const status = { source: null, at: 0, offline: false };
  function report(source, offline) {
    status.source = source; status.at = Date.now(); status.offline = !!offline;
    document.dispatchEvent(new CustomEvent("edge:status", { detail: { ...status } }));
  }

  async function raw(path, params = {}, init = {}) {
    const url = new URL(BASE + path, BASE ? undefined : location.origin);
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && url.searchParams.set(k, v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), C.timeout);
    const { bg, ...rest } = init; init = rest;
    if (bg) live.add(ctrl);
    try {
      // cache:"no-cache"：每次都问一下边缘（边缘缓存才是速度层，几十毫秒）。不加的话，浏览器会先用自己 HTTP 缓存里的旧副本
      // （Worker 给的 max-age=300 + stale-while-revalidate=86400）——本地缓存过期后的“静默刷新”拿到的还是旧数据，新文章要多刷新一次才出现
      const res = await fetch(url, { cache: "no-cache", ...init, signal: ctrl.signal, headers: { Accept: "application/json", ...(init.headers || {}) } });
      const source = res.headers.get("X-MAGI-Source") || (BASE ? "edge" : "local");
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const err = new Error((data && (data.message || data.msg || data.error)) || "HTTP " + res.status);
        err.status = res.status; err.code = data && (data.code || data.error); err.data = data;
        throw err;
      }
      return { data, source };
    } finally { clearTimeout(timer); live.delete(ctrl); }
  }
  /* 离开页面时放弃还在路上的后台请求（已有缓存时的静默刷新、空闲预热）：页面带着未完成的请求进 bfcache，
     响应一大（预热那一批是二十几篇全文）就会被浏览器逐出——返回时整页重载，卡片配不上转场。
     页面正等着的请求（没有缓存的首次加载、正在取的单篇正文）不动。 */
  const live = new Set(); let gone = false;
  addEventListener("pagehide", () => { gone = true; live.forEach((c) => c.abort()); live.clear(); });
  addEventListener("pageshow", () => { gone = false; });

  /* GET + 缓存。onUpdate(data) 会在后台刷新拿到新数据（且与旧数据不同）时被调用 */
  const inflight = new Map(); // 同一请求只发一次（悬停预取与页面本身可能同时要同一篇）
  // 缓存键：只含有值的参数（undefined / 空串不进键，否则同一请求会因参数顺序或空值得到不同的键）
  const keyOf = (path, params) => path + "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  // 一次性清理旧格式的键（含 "=undefined"）
  try { Object.keys(localStorage).filter((k) => k.startsWith(PREFIX) && k.includes("=undefined")).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
  async function get(path, params = {}, { onUpdate, fresh = C.cacheTTL, seedOnly = false } = {}) {
    const key = keyOf(path, params);
    const hit = seedOnly ? null : cache.get(key);
    const fullList = path === "/blog/posts" && params._embed;
    let lastSource = "";
    const revalidate = (bg = !!hit || seedOnly) => {
      if (!inflight.has(key)) {
        inflight.set(key, raw(path, params, bg ? { bg: true } : {}).then(({ data, source }) => {
          report(source, false); lastSource = source || "";
          if (fullList && Array.isArray(data)) {
            seed(data, source);                                   // 完整正文 → 单篇缓存
            data = data.map(slim);                                // 列表本身只留摘要
          }
          if (!seedOnly) cache.set(key, data, source);
          return data;
        }).finally(() => inflight.delete(key)));
      }
      return inflight.get(key).then((data) => ({ data, changed: !hit || JSON.stringify(hit.data) !== JSON.stringify(data) }));
    };
    // 边缘给的是旧副本（edge-stale / stale-cache：它正在后台回源）：过几秒再问一次，拿到不同的内容就更新页面。只追问一次
    const recheck = (shown) => {
      if (!/stale/.test(lastSource) || !onUpdate || seedOnly) return;
      setTimeout(() => {
        if (gone) return;
        revalidate(true).then((r) => { if (JSON.stringify(shown) !== JSON.stringify(r.data)) onUpdate(r.data); }).catch(() => {});
      }, 4000);
    };
    if (hit) {
      if (Date.now() - hit.t > fresh) {
        revalidate().then((r) => { if (r.changed && onUpdate) onUpdate(r.data); recheck(r.data); }).catch(() => { if (!gone) report(hit.source, true); });
      } else report(hit.source + "·cache", false);
      return hit.data;
    }
    try { const r = await revalidate(); recheck(r.data); return r.data; }
    catch (e) { report(null, true); throw e; }
  }

  /* 列表里已经带着完整正文：顺手写成单篇缓存，点开文章时无需再等网络 */
  const postKey = (id) => keyOf("/blog/post", { id, _embed: "true" });
  const POST_BUDGET = 2.4e6;   // 单篇正文缓存的总预算（字符数，约占 localStorage 5MB 的一半）
  // 写入在空闲时分批进行：localStorage 是同步写，一口气写二十几篇正文会卡住一帧
  const seedQueue = [];
  let seeding = false;
  const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 16));
  function seed(list, source) {
    list.forEach((p) => { if (p && p.id && p.content) seedQueue.push([p, source]); });
    if (seeding || !seedQueue.length) return;
    seeding = true;
    idle(function step(deadline) {
      while (seedQueue.length && deadline.timeRemaining() > 4) {
        const [p, src] = seedQueue.shift();
        const k = postKey(p.id), old = cache.get(k);
        if (!old || old.data.modified !== p.modified || Date.now() - old.t > C.cacheTTL) cache.set(k, p, src);
      }
      if (seedQueue.length) idle(step, { timeout: 1000 });
      else { seeding = false; prunePosts(); }
    }, { timeout: 1000 });
  }
  // 超出预算时，从最久没更新的单篇开始清
  function prunePosts() {
    try {
      const items = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX + "/blog/post?"))
        .map((k) => { const v = localStorage.getItem(k) || ""; let t = 0; try { t = JSON.parse(v).t || 0; } catch (e) {} return { k, n: v.length, t }; })
        .sort((a, b) => a.t - b.t);
      let total = items.reduce((a, x) => a + x.n, 0);
      while (total > POST_BUDGET && items.length > 8) { const x = items.shift(); localStorage.removeItem(x.k); total -= x.n; }
    } catch (e) {}
  }
  // 列表项瘦身：去掉正文，换成预先算好的阅读时长
  function slim(p) {
    if (!p || !p.content) return p;
    const { content, ...rest } = p;
    rest._kata_minutes = readingMinutes(content.rendered);
    rest._kata_auto = isAutoExcerpt(p.excerpt && p.excerpt.rendered, content.rendered);
    return rest;
  }
  // 摘要只是正文开头（WordPress 自动截的）？这种摘要放在题图上，往下一屏正文又原样出现一遍——题图上就不放了
  function isAutoExcerpt(excerptHtml, contentHtml) {
    const squash = (s) => text(s).replace(/\[…\]|\[&hellip;\]|…/g, "").replace(/\s+/g, "");
    const e = squash(excerptHtml).slice(0, 40);
    return !e || squash(contentHtml).slice(0, 200).includes(e);
  }
  function readingMinutes(htmlStr) {
    const plain = text(htmlStr);
    const han = (plain.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
    const words = (plain.replace(/[\u3400-\u9fff\u3040-\u30ff]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;
    return Math.max(1, Math.round(han / 400 + words / 220));
  }
  /* 同步读取：任何缓存里能找到的这篇文章（完整正文优先，其次是列表摘要） */
  function peekRaw(id) {
    const full = cache.get(postKey(id));
    if (full) return full.data;
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(PREFIX + "/blog/posts?")) continue;
        const v = JSON.parse(localStorage.getItem(k));
        const p = v && Array.isArray(v.data) && v.data.find((x) => x.id === id);
        if (p) return p;
      }
    } catch (e) {}
    return null;
  }

  /* ---------- 白名单清洗 ---------- */
  const ALLOW = new Set("p br hr h1 h2 h3 h4 h5 h6 a em strong b i u s del ins mark small sub sup code kbd pre blockquote q cite ul ol li dl dt dd figure figcaption img picture source table thead tbody tfoot tr th td caption span div ruby rt rp abbr time details summary iframe video audio".split(" "));
  const DROP = new Set(["script", "style", "noscript", "object", "embed", "form", "input", "button", "select", "textarea", "link", "meta", "base", "svg", "math", "template", "title", "head"]);
  const ATTR = { a: ["href", "title"], img: ["src", "srcset", "sizes", "alt", "width", "height"], source: ["src", "srcset", "type", "media", "sizes"],
    iframe: ["src", "allowfullscreen", "title"], video: ["src", "poster", "controls", "loop", "muted", "playsinline"], audio: ["src", "controls"],
    td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"], code: ["class"], pre: ["class"], ol: ["start", "reversed"], time: ["datetime"], abbr: ["title"], details: ["open"] };
  const IFRAME_OK = /^https:\/\/(player\.bilibili\.com|www\.youtube(-nocookie)?\.com|player\.vimeo\.com|music\.163\.com|open\.spotify\.com)\//;
  const safeUrl = (u) => { try { const x = new URL(u, location.href); return /^(https?|mailto):$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } };

  function sanitize(html, { minimal = false } = {}) {
    const doc = new DOMParser().parseFromString("<body>" + (html || "") + "</body>", "text/html");
    const allow = minimal ? new Set(["p", "br", "a", "em", "strong", "b", "i", "code", "blockquote", "del"]) : ALLOW;
    (function walk(node) {
      Array.from(node.childNodes).forEach((n) => {
        if (n.nodeType === 8) return n.remove();
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        if (DROP.has(tag)) return n.remove();
        if (!allow.has(tag)) { walk(n); n.replaceWith(...n.childNodes); return; }
        const keep = ATTR[tag] || [];
        // 古腾堡的对齐只写在 class / style 上，先记下来，走完通用清洗再放回去
        const origClass = n.getAttribute("class") || "";
        const origStyle = (n.getAttribute("style") || "").trim();
        Array.from(n.attributes).forEach((a) => {
          const name = a.name.toLowerCase();
          if (!keep.includes(name) && !(name === "class" && /^(pre|code)$/.test(tag))) n.removeAttribute(a.name);
        });
        // 只放行「对齐」这一种 class / style —— 否则正文会被 .prose p 的两端对齐覆盖掉
        const alignCls = origClass.split(/\s+/).filter((c) => /^has-text-align-(left|center|right)$/.test(c));
        if (alignCls.length && tag !== "pre" && tag !== "code") n.setAttribute("class", alignCls.join(" "));
        if (/^text-align\s*:\s*(left|center|right|justify|start|end)\s*;?$/i.test(origStyle)) n.setAttribute("style", origStyle);
        ["href", "src", "poster"].forEach((k) => {
          if (!n.hasAttribute(k)) return;
          const u = safeUrl(n.getAttribute(k));
          if (!u || (tag === "iframe" && !IFRAME_OK.test(u))) { tag === "iframe" ? n.remove() : n.removeAttribute(k); }
          else n.setAttribute(k, u.replace(/^http:\/\/(api\.wh1te\.top)/, "https://$1"));
        });
        if (n.hasAttribute("srcset")) n.setAttribute("srcset", n.getAttribute("srcset").split(",").filter((s) => /^\s*https:\/\//.test(s)).join(","));
        if (tag === "a" && n.hasAttribute("href")) {
          const u = new URL(n.href, location.href);
          if (u.origin !== location.origin) { n.target = "_blank"; n.rel = "noopener noreferrer"; }
        }
        if (n.isConnected) walk(n);
      });
    })(doc.body);
    return doc.body.innerHTML;
  }
  const text = (html) => { const d = new DOMParser().parseFromString(html || "", "text/html"); return (d.body.textContent || "").replace(/\s+/g, " ").trim(); };

  /* ---------- 时间 & 时段 ---------- */
  const KANJI = "〇一二三四五六七八九";
  const kanjiNum = (n) => String(n).split("").map((d) => KANJI[+d]).join("");
  const kanjiSmall = (n) => n <= 10 ? (n === 10 ? "十" : KANJI[n]) : n < 20 ? "十" + KANJI[n % 10] : KANJI[Math.floor(n / 10)] + "十" + (n % 10 ? KANJI[n % 10] : "");
  // WordPress 的 date 是站点本地时间（无时区），按字面解析即可
  const parse = (s) => { const m = /(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(s || ""); return m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] } : null; };
  const fmt = {
    kanji: (s) => { const t = parse(s); return t ? `${kanjiNum(t.y)} · ${kanjiSmall(t.mo)} · ${kanjiSmall(t.d)}` : ""; },
    short: (s) => { const t = parse(s); return t ? `${t.y}.${String(t.mo).padStart(2, "0")}.${String(t.d).padStart(2, "0")}` : ""; },
    md: (s) => { const t = parse(s); return t ? `${String(t.mo).padStart(2, "0")}.${String(t.d).padStart(2, "0")}` : ""; },
    clock: (s) => { const t = parse(s); return t ? `${String(t.h).padStart(2, "0")}:${String(t.mi).padStart(2, "0")}` : ""; },
    rel(s) {
      const d = new Date((s || "").replace(/(\.\d+)?$/, "")), diff = (Date.now() - d) / 1000;
      if (!isFinite(diff)) return "";
      if (diff < 60) return "刚刚";
      if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
      if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
      if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
      return fmt.short(s);
    },
  };

  /* 一天里的五个时段，与 main.css 的 data-phase 对应；每个时段配电影里同一时刻的画面 */
  const PHASES = {
    asa:      { name: "朝", kana: "あさ",     latin: "Morning", sky: ["#c3ddf3", "#7fb3d5", "#426ea0"], scenes: ["bg01", "bg13", "bg12", "sw09"] },
    hiru:     { name: "昼", kana: "ひる",     latin: "Day",     sky: ["#c3ddf3", "#f3eee3", "#db9d5d"], scenes: ["bg06", "bg10", "bg09", "bg04", "ad09"] },
    tasogare: { name: "黄昏", kana: "誰そ彼時", latin: "Dusk",    sky: ["#efc39c", "#dab2b7", "#9e84a6"], scenes: ["kt09", "kt05", "ps08", "kt11", "cm03"] },
    yoru:     { name: "夜", kana: "よる",     latin: "Night",   sky: ["#5279bc", "#244072", "#061535"], scenes: ["cm06", "bg02"] },
  };
  const SCENES = { // 深度图可用的画面：tint 为平均色（加载前的底色），alt 为替代文本
    bg01: ["#9fb8ab", "清晨的糸守湖，湖岸的小镇"], bg13: ["#4f7cae", "从山上望见的糸守湖"], bg12: ["#967768", "晨光从雾气弥漫的山谷后升起"], sw09: ["#868a70", "清晨阳光下的铁轨"],
    bg06: ["#5095a3", "东京的天际线与树林"], bg10: ["#5e7f53", "林间的红色鸟居"], bg09: ["#8298aa", "新宿站前的人潮"], bg04: ["#7d8c58", "绿草覆盖的环形山"], ad09: ["#9aa3a2", "须贺神社前的长阶梯"],
    kt09: ["#90757f", "黄昏的云海"], kt05: ["#6a5f7d", "山顶上相对而立的两人"], ps08: ["#a1808d", "彗星划过黄昏的湖面"], kt11: ["#aa93a8", "云海之上的泷与三叶"], cm03: ["#6a6ea4", "云海上的彗星光芒"],
    cm06: ["#142c52", "夜空中分裂的彗星"], bg02: ["#3c4567", "夜色里环绕高楼的轨道"],
  };
  function phaseOf(hour) {
    if (hour >= 5 && hour < 10) return "asa";
    if (hour >= 10 && hour < 16) return "hiru";
    if (hour >= 16 && hour < 19) return "tasogare";
    return "yoru";
  }
  function hash(n) { let x = (n | 0) * 2654435761; x ^= x >>> 15; return Math.abs(x); }
  function sceneFor(post) {
    const t = parse(post.date) || { h: 12 };
    const ph = phaseOf(t.h);
    const list = PHASES[ph].scenes;
    const key = list[hash(post.id) % list.length];
    return { key, phase: ph, tint: SCENES[key][0], alt: SCENES[key][1] };
  }

  const LITE_FIELDS = "id,date,modified,title,excerpt,categories,sticky,comment_status";
  const CAT_PARAMS = { per_page: 100, _fields: "id,name,slug,count,description" };

  /* ---------- 文章模型 ---------- */
  const LOCAL = [ // 站内特辑（静态长文），与 WordPress 文章一起出现在首页与文库
    { local: true, id: "tasogare", href: "posts/tasogare.html", title: "誰そ彼", sub: "关于《你的名字。》的光、时间与名字", date: "2026-10-04T17:40:00", cat: "特辑", minutes: 25, cover: "kt09" },
    { local: true, id: "two-cities", href: "posts/two-cities.html", title: "两座城的色温", sub: "东京与糸守的对照笔记", date: "2026-09-12T14:20:00", cat: "特辑", minutes: 10, cover: "bg02" },
    { local: true, id: "kumihimo", href: "posts/kumihimo.html", title: "组纽", sub: "把时间编成一根绳", date: "2026-08-21T18:05:00", cat: "特辑", minutes: 8, cover: "pr12" },
  ];

  function model(p, cats) {
    const emb = p._embedded || {};
    const media = (emb["wp:featuredmedia"] || [])[0];
    const terms = (emb["wp:term"] || []).flat();
    if (!cats && !API.catMap) { // 首帧同步渲染时分类接口还没回来：先用缓存里的
      const c = cache.get(keyOf("/blog/categories", CAT_PARAMS));
      if (c && Array.isArray(c.data)) API.catMap = Object.fromEntries(c.data.map((x) => [x.id, text(x.name)]));
    }
    cats = cats || API.catMap;
    const catNames = (p.categories || []).map((id) => (cats && cats[id]) || (terms.find((t) => t.id === id) || {}).name).filter(Boolean);
    // 技术分类：命中就走宽屏 + GitHub 样式（阅读页只看这一条）
    const tc = C.techCategories || {};
    const tNames = (tc.names || []).map((s) => String(s).toLowerCase());
    const tIds = tc.ids || [];
    const isTech = (p.categories || []).some((id) => tIds.includes(id))
      || catNames.some((n) => tNames.some((t) => String(n).toLowerCase().includes(t)));
    const plain = text(p.content && p.content.rendered);
    const han = (plain.match(/[㐀-鿿぀-ヿ]/g) || []).length;
    const words = (plain.replace(/[㐀-鿿぀-ヿ]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;
    const minutes = p.content ? Math.max(1, Math.round(han / 400 + words / 220)) : (p._kata_minutes || null);
    const t = parse(p.date) || { h: 12 };
    const scene = sceneFor(p);
    const img = media && media.source_url ? { src: media.source_url.replace(/^http:/, "https:"), alt: media.alt_text || "", w: media.media_details && media.media_details.width, h: media.media_details && media.media_details.height } : null;
    return {
      id: p.id, href: "post.html?id=" + p.id, title: text(p.title && p.title.rendered) || "无题",
      excerpt: tidyExcerpt(text(p.excerpt && p.excerpt.rendered).replace(/\s*\[…\]$|\s*\[&hellip;\]$/, "…")
        .replace(/(^|\s)(#{1,6}|>)\s+/g, "$1").replace(/\*\*|`/g, "").replace(/\s{2,}/g, " ").trim()),
      html: p.content && p.content.rendered, date: p.date, modified: p.modified, hour: t.h,
      phase: phaseOf(t.h), scene, img, cats: catNames, catIds: p.categories || [], minutes, chars: han,
      isTech,
      autoExcerpt: p.content ? isAutoExcerpt(p.excerpt && p.excerpt.rendered, p.content.rendered) : p._kata_auto !== false,
      sticky: !!p.sticky, commentsOpen: p.comment_status === "open",
      replies: ((emb.replies || [])[0] || []).length,
    };
  }

  /* 被截断的摘要：截在半个括号 / 引号里（“……【EVA…”）就退回到那个括号之前，结尾的逗号顿号也去掉；退得太多（剩不到 24 字）则保持原样 */
  const OPEN = "【「『（《〈“‘([", CLOSE = "】」』）》〉”’)]";
  function tidyExcerpt(s) {
    if (!s || !/…$/.test(s)) return s;
    const body = s.replace(/…+$/, "");
    const stack = [];
    for (let i = 0; i < body.length; i++) {
      if (OPEN.includes(body[i])) stack.push(i);
      else if (CLOSE.includes(body[i]) && stack.length) stack.pop();
    }
    let t = stack.length ? body.slice(0, stack[0]) : body;
    t = t.replace(/[\s，、：；,:;·—-]+$/, "");
    if (t.length < 24) return s;
    return /[。！？!?」』）》]$/.test(t) ? t : t + "…";   // 停在一句话的末尾：本身就完整，不再加省略号
  }

  /* ---------- 视图片段（阅读页首屏要在第一帧之前同步画好，所以放在这里） ---------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const HAZE = { asa: ["#e3edf5", 0.14, 0, -0.12], hiru: ["#e9eef0", 0.1, 0, 0], tasogare: ["#f0cfc0", 0.16, 0.5, 0.18], yoru: ["#1d2d5c", 0.2, 0.6, -0.25] };
  function sceneHTML(scene, { sizes = "100vw", eager = false, strength = 0.026, big = false, reveal = true } = {}) {
    const [hc, haze, motes, grade] = HAZE[scene.phase] || HAZE.hiru;
    const k = scene.key;
    return `<div class="depth${reveal ? "" : " is-in"}" style="--tint:${scene.tint}" data-depth="assets/depth/${k}.webp" data-strength="${strength}" data-focus=".5" data-haze="${haze}" data-haze-color="${hc}" data-motes="${motes}" data-grade="${grade}"${reveal ? "" : ' data-reveal="off"'}>
      <img src="assets/img/${k}-${big ? 1600 : 960}.webp" srcset="assets/img/${k}-960.webp 960w, assets/img/${k}-1600.webp 1600w" sizes="${sizes}" alt="${esc(scene.alt)}" width="1600" height="900" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="${eager ? "sync" : "async"}"></div>`;
  }
  /* 阅读页题图：写下那一刻的天空。instant=true 时不做任何入场（第一帧就是最终状态，供页面转场衔接） */
  function fillHero(post, { instant = false } = {}) {
    const root = document.querySelector("[data-post]");
    if (!root) return;
    const ph = PHASES[post.phase];
    document.documentElement.dataset.phase = post.phase;
    const stage = root.querySelector("[data-slot=hero]");
    if (stage.dataset.scene !== post.scene.key) {
      stage.innerHTML = sceneHTML(post.scene, { eager: true, big: true, strength: 0.03, reveal: !instant });
      stage.dataset.scene = post.scene.key;
    }
    root.querySelector("[data-slot=kicker]").innerHTML = `<span>${esc(post.cats.join(" · ") || "随笔")}</span><span class="latin">${ph.latin}</span>`;
    root.querySelector(".post-hero__head h1").textContent = post.title;
    root.querySelector("[data-slot=sub]").textContent = post.autoExcerpt ? "" : post.excerpt.length > 60 ? post.excerpt.slice(0, 58) + "…" : post.excerpt;
    root.querySelector("[data-slot=meta]").innerHTML = `写于 ${fmt.clock(post.date)} · ${ph.kana}<br>${fmt.kanji(post.date)}${post.minutes ? `<br>约 ${post.minutes} 分钟` : ""}`;
    document.title = `${post.title} — かたわれ時`;
    const md = document.querySelector('meta[name="description"]'); md && md.setAttribute("content", post.excerpt.slice(0, 120));
    const tc = document.querySelector('meta[name="theme-color"]'); tc && tc.setAttribute("content", post.scene.tint);
    root.dataset.filled = String(post.id);
    // 冷启动加载层：淡出（1.4s）后移出文档——它的呼吸光、拉丝都是无限动画，隐藏着也会每帧重算样式
    const loader = root.querySelector(".post-loader");
    if (loader) setTimeout(() => loader.remove(), 1500);
    if (instant) { document.documentElement.classList.add("kata-prefilled"); document.body.classList.add("is-ready"); }
  }
  /* 在 post.html 题图之后同步调用：缓存里有这篇 → 第一帧就是完整题图 */
  function prefill() {
    const id = +(new URLSearchParams(location.search).get("id") || 0);
    if (!id) return null;
    const p = peekRaw(id);
    if (!p) return null;
    try {
      const m = model(p);
      // 首帧就要用对的版式：技术文在填题图之前先挂上 .is-tech，否则会先画大再缩
      if (document.body) document.body.classList.toggle("is-tech", !!m.isTech);
      fillHero(m, { instant: true });
      return m;
    } catch (e) { return null; }
  }

  /* ---------- 字体：按“这段文字实际用到的字”提前取回需要的那几个分层文件 ----------
     fonts.css 里每个 @font-face 的 unicode-range 互不重叠（tools/fonts.py 保证）。这里把它们读出来，
     给一段文字算出会用到哪几个文件，再用低优先级 fetch 放进 HTTP 缓存——等版面真的需要这些字时就是缓存命中，
     不必等到“文字上了屏、浏览器才发现缺字、再去下载”。三种时机：
       · 阅读页第一帧（缓存里已有这篇）；  · 指针停到文章链接上（意图预取）；  · 首页 / 文库空闲时预热最新的几篇。 */
  const fonts = (() => {
    let index = null, sheets = -1;                 // index[字重] = 按起点排序的 [lo, hi, url]
    const parse = () => {
      sheets = document.styleSheets.length;
      index = { 300: [], 400: [], 600: [] };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const r of rules) {
          if (r.type !== 5 || !/Kata Serif/.test(r.style.getPropertyValue("font-family"))) continue;
          const w = +r.style.getPropertyValue("font-weight"), m = /url\(["']?([^"')]+)/.exec(r.style.getPropertyValue("src"));
          if (!index[w] || !m) continue;
          const url = new URL(m[1], sheet.href || location.href).href;
          r.style.getPropertyValue("unicode-range").split(",").forEach((p) => { const [a, b] = p.trim().slice(2).split("-"); index[w].push([parseInt(a, 16), parseInt(b || a, 16), url]); });
        }
      }
      for (const w in index) index[w].sort((x, y) => x[0] - y[0]);
    };
    const find = (list, cp) => {                   // 范围互不重叠：二分
      let lo = 0, hi = list.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1, r = list[mid]; if (cp < r[0]) hi = mid - 1; else if (cp > r[1]) lo = mid + 1; else return r[2]; }
      return null;
    };
    const fetched = new Set();
    const slow = () => { const c = navigator.connection; return !!c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || "")); };
    /* texts: { 300: 标题与大字, 400: 正文, 600: 小标题与加粗 } */
    function warm(texts) {
      if (slow()) return 0;
      if (!index || sheets !== document.styleSheets.length) parse();
      let n = 0;
      for (const w of [300, 400, 600]) {
        const list = index[w], seen = new Set();
        for (const ch of texts[w] || "") {
          const cp = ch.codePointAt(0);
          if (cp < 0x2E80 || seen.has(cp)) continue;
          seen.add(cp);
          const url = find(list, cp);
          if (url && !fetched.has(url)) {
            fetched.add(url); n++;
            fetch(url, { priority: "low" }).then((r) => r.arrayBuffer()).catch(() => fetched.delete(url));
          }
        }
      }
      return n;
    }
    /* p: { title, excerpt, html } —— 对应测量时各字重的用法：300 = 标题 / 摘要 / 首字下沉 / 引文，400 = 正文，600 = 小标题与加粗 */
    function warmPost(p) {
      if (!p) return;
      const run = () => {
        const root = document.createElement("template");
        root.innerHTML = p.html || "";
        const c = root.content;
        c.querySelectorAll("style,script,noscript,template").forEach((e) => e.remove());   // 不会上屏的文字别去取字体
        const pick = (sel) => [...c.querySelectorAll(sel)].map((e) => e.textContent).join("");
        const first = ((c.querySelector("p") || {}).textContent || "").trim().slice(0, 1);   // 首字下沉（300）/ lede 首字加粗（600）
        warm({ 300: (p.title || "") + (p.excerpt || "").slice(0, 58) + first + pick("blockquote"), 400: c.textContent, 600: pick("h1,h2,h3,h4,h5,h6,strong,b,th") + first });
      };
      (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(run, { timeout: 250 });
    }
    return { warm, warmPost };
  })();

  /* ---------- 对外接口 ---------- */
  const API = {
    view: { esc, sceneHTML, fillHero }, prefill, peekRaw, fonts,
    cached(id) { const v = cache.get(postKey(id)); return !!v && Date.now() - v.t < C.cacheTTL; },
    base: BASE || location.origin, isDev, config: C, status, sanitize, text, fmt, PHASES, SCENES, phaseOf, sceneFor, LOCAL, parse,
    catMap: null,
    /* Pixiv 日榜（边缘层 /pixiv/rank）：一天才变一次，本地缓存 30 分钟内不重新请求；过滤掉“不可查看”的占位图 */
    async pixiv(opts) {
      const clean = (d) => ({ date: d && d.date, list: ((d && d.list) || []).filter((x) => x && x.url && /\/img-master\//.test(x.url) && x.width && x.height) });
      const d = await get("/pixiv/rank", {}, { fresh: 30 * 60e3, onUpdate: opts && opts.onUpdate ? (v) => opts.onUpdate(clean(v)) : undefined });
      return clean(d);
    },
    /* Bangumi 每周放送表（经 Worker /bgm/calendar）：一周才变几次，本地缓存 6 小时内不重新请求 */
    async bgmCalendar(opts) {
      const d = await get("/bgm/calendar", {}, { fresh: 6 * 3600e3, onUpdate: opts && opts.onUpdate });
      return Array.isArray(d) ? d : [];
    },
    async categories(opts) {
      const list = (await get("/blog/categories", CAT_PARAMS, opts)) || [];
      API.catMap = Object.fromEntries(list.map((c) => [c.id, text(c.name)]));
      return list;
    },
    /* lite: 只要列表字段（文库用），不取正文与嵌入数据，几百篇也很轻 */
    async posts({ page = 1, perPage = C.perPage, category, search, offset, lite = false, seedOnly = false } = {}, opts) {
      const params = lite
        ? { per_page: perPage, page, offset, categories: category, search, _fields: LITE_FIELDS }
        : { per_page: perPage, page, offset, _embed: "true", categories: category, search };
      if (seedOnly) { await get("/blog/posts", params, { seedOnly: true }); return []; }
      const list = await get("/blog/posts", params, opts && opts.onUpdate ? { onUpdate: (d) => opts.onUpdate(d.map((p) => model(p))) } : undefined)
        .catch((e) => { if (e.status === 400 && e.code === "rest_post_invalid_page_number") return []; throw e; });
      return (list || []).map((p) => model(p));
    },
    /* 同步读列表缓存：首页首帧就靠它把卡片画出来，
       否则返回时 pagereveal 那一刻卡片还不存在，跨页转场的共享元素配不上 */
    peekPosts({ perPage = C.perPage, page = 1, lite = false } = {}) {
      const params = lite ? { per_page: perPage, page, _fields: LITE_FIELDS } : { per_page: perPage, page, _embed: "true" };
      const v = cache.get(keyOf("/blog/posts", params));
      if (!v || !Array.isArray(v.data) || (!v.data.length && page === 1)) return null;
      try { return v.data.map((x) => model(x)); } catch (e) { return null; }
    },
    peekCategories() {
      const v = cache.get(keyOf("/blog/categories", CAT_PARAMS));
      if (!v || !Array.isArray(v.data)) return null;
      API.catMap = Object.fromEntries(v.data.map((c) => [c.id, text(c.name)]));
      return v.data;
    },
    /* 任意 GET 的同步缓存读（画廊、追番的首帧用）；fresh 给了就只要还新鲜的 */
    peek(path, params = {}) { const v = cache.get(keyOf(path, params)); return v ? v.data : null; },
    async post(id, opts) {
      const p = await get("/blog/post", { id, _embed: "true" }, opts && opts.onUpdate ? { onUpdate: (d) => opts.onUpdate(model(d)) } : undefined);
      return model(p);
    },
    async comments(postId) {
      const list = await get("/blog/comments", { post: postId, per_page: 100, order: "asc", _fields: "id,parent,author_name,date,content,author_avatar_urls" }, { fresh: 60e3 });
      return list || [];
    },
    async comment({ post, parent = 0, author_name, author_email, content }) {
      const { data } = await raw("/blog/comments", {}, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post, parent, author_name, author_email, content }),
      });
      try { Object.keys(localStorage).filter((k) => k.startsWith(PREFIX + "/blog/comments?post=" + post)).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
      return data;
    },
  };
  window.KataAPI = API;
})();
