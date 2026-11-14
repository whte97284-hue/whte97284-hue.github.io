/* ==========================================================================
   かたわれ時 — 追番
   · 在追：B 站的追番列表。B 站拒绝 Cloudflare 的 IP，所以由本机的 tools/bangumi-sync.py 定期生成快照（assets/data/bangumi.json）
   · 本季放送：Bangumi 每周放送表（经 Worker /bgm/calendar，本地缓存 6 小时），默认停在今天
   · 新海诚 · 年表：同一份快照；一根红绳从左到右穿过八部作品，进入视口时画出来
   动效只用透明度与位移；版面位置只在 ResizeObserver 的回调里读（那时排版已完成，读取是免费的）
   ========================================================================== */
(function () {
  "use strict";
  const A = window.KataAPI;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s·・:：!！?？,，.。'"“”‘’()（）\-—_~～]/g, "");
  const kilo = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + " 万" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0));

  const WEEK = [
    { id: 1, jp: "月", cn: "周一", day: "月曜日" }, { id: 2, jp: "火", cn: "周二", day: "火曜日" }, { id: 3, jp: "水", cn: "周三", day: "水曜日" },
    { id: 4, jp: "木", cn: "周四", day: "木曜日" }, { id: 5, jp: "金", cn: "周五", day: "金曜日" }, { id: 6, jp: "土", cn: "周六", day: "土曜日" },
    { id: 7, jp: "日", cn: "周日", day: "日曜日" },
  ];
  const now = new Date();
  const todayId = now.getDay() || 7;
  const season = ["冬", "冬", "冬", "春", "春", "春", "夏", "夏", "夏", "秋", "秋", "秋"][now.getMonth()];
  const seasonLatin = { 冬: "Winter", 春: "Spring", 夏: "Summer", 秋: "Autumn" }[season];

  // 封面：Bangumi 的大图按 400 宽取（r/400），http → https
  const cover400 = (it) => {
    const im = it.images || {};
    const src = im.large || im.common || im.medium;
    if (!src) return "";
    return src.replace(/^http:/, "https:").replace("lain.bgm.tv/pic/", "lain.bgm.tv/r/400/pic/");
  };
  // 封面图：进入视口才取，到了以后从柔焦里浮现
  const lazyImg = (src, alt, cls = "") => src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="this.classList.add('is-loaded')" onerror="this.closest('[data-cover]').classList.add('is-empty')">` : "";

  /* ---------- 首屏 ---------- */
  function setupHero() {
    const hero = $(".bg-hero"), head = $(".bg-hero__head", hero), sun = $(".bg-hero__sun", hero);
    const d = WEEK[todayId - 1];
    $("[data-slot=today]").innerHTML = `今日 · <b>${d.day}</b>`;
    requestAnimationFrame(() => requestAnimationFrame(() => hero.classList.add("is-on")));
    if (reduce) return;
    // 向下滚动：标题先于画面离开（更快地上移、淡去），太阳的光随之收起——镜头本身的升起交给 depth.js 的滚动视差
    let raf = 0, h = innerHeight;
    addEventListener("resize", () => { h = innerHeight; }, { passive: true });
    addEventListener("scroll", () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const p = Math.min(1, scrollY / (h * 0.9));
        if (p >= 1 && head.__p >= 1) return;
        head.__p = p;
        head.style.transform = `translate3d(0, ${(-p * 70).toFixed(1)}px, 0)`;
        head.style.opacity = (1 - p * 1.25).toFixed(3);
        sun.style.opacity = (1 - p).toFixed(3);
      });
    }, { passive: true });
  }

  /* ---------- 在追 ---------- */
  function renderFollowing(list) {
    const host = $("[data-slot=following]");
    const sec = host.closest("section");
    if (!list.length) { sec.hidden = true; return; }
    host.innerHTML = list.map((f, i) => {
      const meta = f.styles.slice(0, 3).join(" · ");
      const ep = f.finished ? (f.latest || `全 ${f.total} 话`) : f.release && /敬请期待|即将/.test(f.release) ? "敬请期待" : f.latest || (f.total ? `${f.total} 话` : "连载中");
      return `<a class="bg-follow__card" href="${esc(f.url)}" target="_blank" rel="noopener" style="--c:${f.color};--g:${f.glow};--i:${i}" data-reveal>
        <span class="bg-follow__cover" data-cover>${lazyImg(f.cover, f.title)}<i class="bg-follow__glow" aria-hidden="true"></i></span>
        <span class="bg-follow__text">
          <span class="bg-follow__status"><i></i>${esc(f.status)}<span class="latin">${f.finished ? "Completed" : "Airing"}</span></span>
          <strong class="bg-follow__title">${esc(f.title)}</strong>
          <span class="bg-follow__meta">${esc(meta)}</span>
          <span class="bg-follow__ep">${esc(ep)}</span>
        </span>
      </a>`;
    }).join("");
    window.Kata && window.Kata.enhance(host);
  }

  /* ---------- 本季放送 ---------- */
  function setupWeek(following, snapCal) {
    const sec = $("#week"), days = $("[data-slot=days]"), shelf = $("[data-slot=shelf]");
    $("[data-slot=season]").textContent = `${seasonLatin} ${now.getFullYear()} — by weekday`;
    const mine = new Set(following.map((f) => norm(f.title)));
    const narrow = matchMedia("(max-width: 720px)");
    let cal = null, sig = "", cur = todayId, switching = 0, cols = 6, expanded = false;

    days.innerHTML = WEEK.map((d) => `<button type="button" role="tab" class="bg-day${d.id === todayId ? " is-today" : ""}" data-id="${d.id}" aria-selected="${d.id === cur}" tabindex="${d.id === cur ? 0 : -1}">
      <span class="bg-day__jp">${d.jp}</span><span class="bg-day__cn">${d.id === todayId ? "今日" : d.cn}</span><span class="bg-day__n latin" data-n>·</span></button>`).join("")
      + '<i class="bg-days__ink" aria-hidden="true"></i>';            // 一根共用的下划线，在星期之间滑动
    const tabs = $$(".bg-day", days);
    const moveInk = () => days.style.setProperty("--k", cur - 1);
    moveInk();
    const more = document.createElement("button");
    more.type = "button";
    more.className = "bg-more";
    more.hidden = true;
    shelf.after(more);

    // 封面按显示尺寸取：手机与 1 倍屏 200 宽就够，2 倍屏才要 400
    const covers = (it) => {
      const im = it.images || {};
      const src = (im.large || im.common || im.medium || "").replace(/^http:/, "https:");
      if (!src) return null;
      const r = (w) => src.replace("lain.bgm.tv/pic/", `lain.bgm.tv/r/${w}/pic/`);
      return { src: r(400), srcset: `${r(200)} 200w, ${r(400)} 400w` };
    };
    const cardHTML = (it, i) => {
      const title = it.name_cn || it.name;
      const r = it.rating || {};
      const score = r.total >= 20 && r.score ? `<b>★ ${r.score.toFixed(1)}</b>` : "";
      const watching = (it.collection && it.collection.doing) || 0;
      const isMine = mine.has(norm(title)) || mine.has(norm(it.name));
      const c = covers(it);
      const img = c ? `<img src="${esc(c.src)}" srcset="${esc(c.srcset)}" sizes="(max-width: 720px) 32vw, 180px" alt="${esc(title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="this.classList.add('is-loaded')" onerror="this.remove()">` : "";
      return `<a class="bg-card${isMine ? " is-mine" : ""}" href="https://bgm.tv/subject/${it.id}" target="_blank" rel="noopener" style="--i:${i}">
        <span class="bg-card__cover" data-cover><span class="bg-card__ph" aria-hidden="true">${esc(title.slice(0, 1))}</span>${img}${i < 3 ? `<span class="bg-card__rank latin" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span>` : ""}${isMine ? '<span class="bg-card__mine">在追</span>' : ""}</span>
        <span class="bg-card__t">${esc(title)}</span>
        <span class="bg-card__m">${score}${watching ? `<span>${kilo(watching)} 在看</span>` : ""}</span>
      </a>`;
    };
    const itemsOf = (id) => {
      const day = cal && cal.find((d) => d.weekday && d.weekday.id === id);
      return day ? [...day.items].sort((a, b) => ((b.collection && b.collection.doing) || 0) - ((a.collection && a.collection.doing) || 0)) : [];
    };
    // 默认只显示两行：切换星期时页面高度基本不变（周二 10 部、周日 26 部），首屏也少取一半封面
    function clamp() {
      const cards = $$(".bg-card", shelf), limit = cols * 2;
      const folded = !expanded && cards.length > limit + 1;
      cards.forEach((c, i) => c.classList.toggle("is-folded", folded && i >= limit));
      more.hidden = !folded;
      if (folded) more.innerHTML = `展开其余 <b class="latin">${cards.length - limit}</b> 部`;
    }
    function fill(id, animate) {
      const items = itemsOf(id);
      shelf.removeAttribute("aria-busy");
      shelf.classList.toggle("is-entering", !!animate && !reduce);
      shelf.innerHTML = items.length ? items.map(cardHTML).join("") : `<p class="bg-empty">这一天没有在播的番。</p>`;
      clamp();
    }
    function swap(id) {                               // 旧的一组轻轻沉下去（0.18s），新的一组逐张浮上来
      clearTimeout(switching);
      if (reduce) return fill(id, false);
      shelf.classList.add("is-leaving");
      switching = setTimeout(() => { shelf.classList.remove("is-leaving"); fill(id, true); }, 180);
    }
    function select(id, focus) {
      if (id === cur || !cal) return;
      cur = id; expanded = false;
      tabs.forEach((t) => { const on = +t.dataset.id === id; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
      moveInk();
      swap(id);
    }
    days.addEventListener("click", (e) => { const t = e.target.closest(".bg-day"); if (t) select(+t.dataset.id); });
    days.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      select(((cur - 1 + (e.key === "ArrowRight" ? 1 : 6)) % 7) + 1, true);
    });
    more.addEventListener("click", () => {
      expanded = true;
      // 新露出来的卡片从头编号，逐张浮上来
      $$(".bg-card.is-folded", shelf).forEach((c, i) => { c.style.setProperty("--i", i); c.classList.add("is-unfolding"); c.classList.remove("is-folded"); });
      more.hidden = true;
    });
    // 每行几张：在 ResizeObserver 回调里算（排版刚完成，读宽度是免费的）
    new ResizeObserver((es) => {
      const w = es[0].contentRect.width, min = narrow.matches ? 104 : 150, gap = narrow.matches ? 12 : 22;
      const n = Math.max(2, Math.floor((w + gap) / (min + gap)));
      if (n !== cols) { cols = n; clamp(); }
    }).observe(shelf);

    // 骨架：两行，数据到达时版面高度不变
    shelf.innerHTML = Array.from({ length: 12 }, () => '<span class="bg-card is-skel"><span class="bg-card__cover"></span><span class="bg-card__t">　</span><span class="bg-card__m">　</span></span>').join("");
    const signature = (data) => data.map((d) => d.weekday.id + ":" + d.items.map((x) => x.id).join(",")).join("|");
    const apply = (data, quiet) => {
      if (!Array.isArray(data) || !data.length) return;
      const s = signature(data);
      if (s === sig && cal) { cal = data; return; }          // 内容一样（只是评分、人数变了）：不打扰
      const first = !cal;
      const before = cal ? itemsOf(cur).map((x) => x.id).join(",") : "";
      cal = data; sig = s;
      tabs.forEach((t) => { const d = cal.find((x) => x.weekday && x.weekday.id === +t.dataset.id); $("[data-n]", t).textContent = d ? d.items.length : 0; });
      if (first) fill(cur, true);
      else if (itemsOf(cur).map((x) => x.id).join(",") !== before) (quiet ? fill(cur, false) : swap(cur));
    };
    // 先用快照（本机同步时存下的放送表）立刻画出来；实时数据（本地缓存 / Worker）到了，内容有变才替换
    if (Array.isArray(snapCal) && snapCal.length) apply(snapCal, true);
    A.bgmCalendar({ onUpdate: (d) => apply(d) }).then((d) => apply(d)).catch(() => {
      if (cal) return;
      shelf.removeAttribute("aria-busy");
      shelf.innerHTML = `<p class="bg-empty">放送表暂时取不到，过一会儿再来看看。</p>`;
    });
  }

  /* ---------- 新海诚 · 年表 ---------- */
  function renderFilms(films) {
    const ol = $("[data-slot=films]"), wrap = ol.parentElement, svg = $(".bg-cord", wrap), path = $("path", svg);
    if (!films.length) { ol.closest("section").hidden = true; return; }
    ol.innerHTML = films.map((f, i) => `<li class="bg-film${f.id === 160209 ? " is-ours" : ""}" style="--c:${f.color};--g:${f.glow};--i:${i}" data-reveal>
      <a href="${esc(f.url)}" target="_blank" rel="noopener">
        <span class="bg-film__year latin">${f.year}</span>
        <i class="bg-film__knot" aria-hidden="true"></i>
        <span class="bg-film__cover" data-cover>${lazyImg(f.cover, f.cn)}</span>
        <strong class="bg-film__t">${esc(f.cn)}</strong>
        <span class="bg-film__jp">${esc(f.name)}</span>
        <span class="bg-film__score">${f.score ? `★ ${f.score.toFixed(1)}` : ""}${f.id === 160209 ? "<em>本站</em>" : ""}</span>
        <span class="bg-film__line">${esc(f.line)}</span>
      </a></li>`).join("");
    window.Kata && window.Kata.enhance(ol);

    // 红绳：穿过每部作品的结点。位置在 ResizeObserver 回调里读（排版刚完成，免费），宽屏横穿、窄屏竖穿
    const draw = () => {
      const W = wrap.clientWidth, H = wrap.clientHeight, base = wrap.getBoundingClientRect();
      const pts = $$(".bg-film__knot", ol).map((k) => { const r = k.getBoundingClientRect(); return [r.left + r.width / 2 - base.left, r.top + r.height / 2 - base.top]; });
      if (pts.length < 2) return;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const vertical = pts[1][1] - pts[0][1] > Math.abs(pts[1][0] - pts[0][0]);
      const lead = vertical ? [pts[0][0], pts[0][1] - 60] : [Math.max(0, pts[0][0] - 80), pts[0][1] - 18];
      const tail = vertical ? [pts[pts.length - 1][0], pts[pts.length - 1][1] + 60] : [Math.min(W, pts[pts.length - 1][0] + 80), pts[pts.length - 1][1] + 18];
      const P = [lead, ...pts, tail];
      // Catmull-Rom → 三次贝塞尔：一根松松地垂着的绳
      let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
      for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6 + (vertical ? 0 : 10)];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6 + (vertical ? 0 : 10)];
        d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      }
      path.setAttribute("d", d);
      try { svg.style.setProperty("--len", Math.ceil(path.getTotalLength()) + 2); } catch (e) {}
    };
    new ResizeObserver(draw).observe(wrap);
    new IntersectionObserver((es, io) => es.forEach((e) => { if (e.isIntersecting) { wrap.classList.add("is-drawn"); io.disconnect(); } }), { threshold: 0.18 }).observe(wrap);
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    setupHero();
    let snap = { following: [], shinkai: [], calendar: [], updated: "" };
    try {
      const res = await fetch("assets/data/bangumi.json", { cache: "no-cache" });
      if (res.ok) snap = await res.json();
    } catch (e) {}
    setupWeek(snap.following || [], snap.calendar);
    renderFollowing(snap.following || []);
    renderFilms(snap.shinkai || []);
    const sync = $("[data-slot=sync]");
    if (sync && snap.updated) sync.textContent = `数据：B 站 · Bangumi · 快照 ${A.fmt.short(snap.updated)}`;
  }
  if (!A) return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
