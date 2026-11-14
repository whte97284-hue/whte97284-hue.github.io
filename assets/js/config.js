/* ==========================================================================
   站点配置 —— 部署时只需要改这里
   ========================================================================== */
window.KATA_CONFIG = {
  /* Cloudflare Worker（cloudflare wokers.js）的地址，不带结尾斜杠，例如
       "https://magi.<你的子域>.workers.dev"  或  "https://edge.wh1te.top"
     留空 = 与页面同源（本地 tools/serve.py 已镜像 /blog/* 路由）。
     注意：Worker 的 ALLOWED_ORIGINS 需包含站点域名，否则 CORS 头会指向别的域。 */
  api: "https://api-worker.wh1te.top",

  /* 这些主机名不在 Worker 的 CORS 白名单里（白名单含 localhost，不含 127.0.0.1:端口），
     改走同源镜像 tools/serve.py（它会转发给同一个 Worker） */
  mirrorHosts: ["127.0.0.1"],

  perPage: 12,          // 首页 / 文库每次拉取的文章数
  timeout: 15000,       // 单次请求超时（毫秒）。源站 WordPress 响应在 1–9 秒间波动
  cacheTTL: 5 * 60e3,   // 本地缓存“新鲜”时长：之内不重新请求；之外先显示旧数据再静默刷新
  author: "wh1te",

  /* 技术分类：命中这些分类的文章，阅读页切到「宽屏 + GitHub 正文样式」
     names 按子串匹配（“技术”“技术笔记”都算），ids 用于分类改名后仍能命中 */
  techCategories: { names: ["技术", "技術"], ids: [] },
};
