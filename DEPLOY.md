# 部署上线 · 绿茵轮回

游戏是一个纯静态 SPA（Vite 构建，无后端）。`dist/` 可托管到任何静态站点。
配置文件已就绪，**一条命令即可上线**。上线后才有真实用户 / DAU / TikTok 传播。

---

## 快速上线（任选一个）

### 1. Vercel（推荐 · 最快拿到 URL）
```bash
npm i -g vercel        # 首次安装 CLI
vercel                 # 按提示登录（浏览器授权），一路回车
# → 得到一个 https://xxx.vercel.app 公网 URL，立即可玩可分享
vercel --prod          # 正式域名（可选绑自定义域名）
```
`vercel.json` 已配置：自动 `npm run build`、SPA fallback、资源长缓存。

### 2. Netlify
```bash
npm i -g netlify-cli
netlify deploy --build --prod
# → 得到 https://xxx.netlify.app
```
`netlify.toml` 已配置。

### 3. Cloudflare Pages
- 推送代码到 GitHub → Cloudflare Pages 连接仓库
- 构建命令 `npm run build`，输出目录 `dist`
- `public/_redirects` 已处理 SPA fallback

### 4. GitHub Pages
```bash
npm run build
npx gh-pages -d dist   # 需先建仓库并设 base path
```

---

## 上线后的传播动作（K-factor 增长）

1. **种子挑战链接**：游戏内"挑战好友"按钮已生成完整编码链接
   `#s=种子&n=国籍&p=位置&l=联赛&m=节奏`，接收者点开**自动开踢**同一生涯。
   - 这是 TikTok 核心传播物：录一段"我用这颗种子拿了世界杯"→贴链接→观众点开直接挑战。
2. **Open Graph 预览卡**：`public/og-card.svg` 已接入 og:image / twitter:image，
   分享链接在微信/Twitter/即时通讯里有预览图而非白板。
3. **PWA 安装**：manifest.json + apple-mobile-web-app-capable 已配置，
   手机可"添加到主屏幕"像 App 一样体验（提高回访/DAU）。

---

## 待办（需要人工，无法代劳）
- [ ] og:image 目前是 SVG。微信/Twitter 部分场景需 PNG/JPG。
      上线后用截图工具导出 `public/og-card.png`（1200×630）并在 index.html 加一行
      `<meta property="og:image" content="/og-card.png" />`（SVG 行保留作现代平台兼容）。
      受项目约束无法在此生成位图。
- [ ] 绑定自定义域名（可选，vercel/netlify 均支持）。
- [ ] 部署后把公网 URL 填入分享文案 / TikTok 简介。
