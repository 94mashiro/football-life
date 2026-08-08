# 部署到 Cloudflare Pages · 研究笔记

> 研究对象：把本仓库《绿茵轮回》（Vite 8 + React 19 + Tailwind v4，**纯静态 SPA，无后端**）部署到 **Cloudflare Pages**。
> 方法：通读 Cloudflare 官方文档全量 Markdown（`https://developers.cloudflare.com/pages/llms-full.txt`）+
> wrangler `pages` CLI 参考（`.../workers/wrangler/commands/pages/`），并实际核查本仓库 `package.json` /
> `vite.config.ts` / `index.html` / `public/` / 构建产物。
> 结论：**无需改一行代码即可部署；现有 `public/_redirects` 直接兼容 Cloudflare Pages；唯一要做的决定是
> 「Git 集成」还是「Direct Upload」。** 可选地补一个 `public/_headers` 和 `.node-version` 让缓存/版本更稳。

---

## 一句话结论

这是一个 `npm run build` → `dist/` 的纯静态 SPA，**完全落在 Cloudflare Pages 的甜点区**：
框架预设「React (Vite)」就是 `npm run build` / `dist`；CF v3 构建镜像默认 Node 22.16.0 满足 Vite 8 的
`^20.19.0 || >=22.12.0`；CF 对「无顶层 `404.html`」的项目**内置 SPA fallback**，所以现有的 `public/_redirects`
（`/* /index.html 200`）既兼容又可移植。最快的路径是**Git 集成**：连仓库 → 填两行 → 推 `master` 即上线
`football-life.pages.dev`。

---

## 1. 项目现状盘点

| 项 | 现状 | 对 CF Pages 的影响 |
|---|---|---|
| 构建命令 | `npm run build` = `tsc -b && vite build` | ✅ 直接用。实测通过（见 §6「构建已修复」）|
| 输出目录 | `dist/`（`index.html` + `/assets/*` + `favicon.svg` 等）| ✅ CF 预设 `dist` |
| 框架 | React 19 + Vite 8.2.1 | ✅ 对应预设「React (Vite)」 |
| `base` 路径 | `vite.config.ts`：`process.env.VITE_BASE ?? '/'` | ✅ CF 服务在根 `/`，用默认即可，**不用**像 GitHub Pages 那样设 `VITE_BASE` |
| SPA 路由 | 哈希路由 `#s=…`；`public/_redirects` = `/* /index.html 200` | ✅ CF 原生支持 `_redirects`；且无 `404.html` 时 CF **内置 SPA fallback** |
| 响应头缓存 | `vercel.json`/`netlify.toml` 各自配了 `/assets/*` immutable + SVG 1 天；CF **无** `_headers` | ⚠️ CF 默认头已够用；要复刻长缓存可加 `public/_headers`（见 §5）|
| Functions | 无 `functions/`、无 `_worker.js` | ✅ 纯静态 → `_redirects`/`_headers` 对**所有**响应生效，无 Functions 豁免问题 |
| `dist/` | 已在 `.gitignore` | ✅ Git 集成时 CF 现场构建；Direct Upload 时本地构建后上传 |
| 默认分支 | `master`（非 `main`）| ⚠️ 生产分支要填 `master` |
| OG 分享图 | `index.html` 硬编码 `https://94mashiro.github.io/football-life/og-card.png` | ⚠️ 上 CF 后社交预览仍指向 GitHub Pages；建议改 CF 域名（见 §6）|
| PWA | `manifest.json` + apple-mobile-web-app-capable 已就绪 | ✅ CF 直接托管 |

---

## 2. Cloudflare Pages 的关键机制（决定配置的事实）

### 2.1 构建命令 & 输出目录
CF 维护框架预设表，「React (Vite)」= **build command `npm run build`，build directory `dist`**，与本仓库完全一致。
CF 用**构建命令的退出码**判断成败：非 0 即失败，0 即成功（即使 stderr 有输出也算成功）。
> 来源：[Build configuration · Framework presets](https://developers.cloudflare.com/pages/configuration/build-configuration/)

### 2.2 Node 版本（关键）
- **v3 构建镜像默认 Node 22.16.0、npm 10.9.2**。本仓库 Vite 8.2.1 的 `engines` 为
  `^20.19.0 || >=22.12.0`（实测 `node_modules/vite/package.json`）——**默认 22.16.0 满足**，开箱即用。
- 覆盖方式（二选一）：环境变量 `NODE_VERSION=22`，或在仓库根放 `.nvmrc` / `.node-version`（内容 `22`）。
- ⚠️ **v3 不再从 `package.json` 的 `engines`、`yarn.lock`、`pnpm-lock.yaml` 推断版本**——必须显式指定。
  建议放一个 `.node-version`（同时也让本机 fnm 对齐，当前本机是 v26.7.0）。
> 来源：[Build image · Supported languages](https://developers.cloudflare.com/pages/configuration/build-image/)、[v3 limitations](https://developers.cloudflare.com/pages/configuration/build-image/#v3-build-system)

### 2.3 `base` 路径
CF 的 `*.pages.dev` 子域与自定义域名都服务在**根 `/`**，所以 Vite `base` 用默认 `/` 即可，
**不需要** `VITE_BASE`（GitHub Pages 才需要 `VITE_BASE=/football-life/`）。`index.html` 里的
`/favicon.svg`、`/icons.svg`、`/manifest.json`、`/src/main.tsx` 都是根相对路径，CF 上正常解析。
> 来源：本仓库 `vite.config.ts`；[Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)

### 2.4 SPA 路由（两种等价机制，可叠加）
1. **内置 SPA fallback**：项目无顶层 `404.html` 时，CF「假定你在部署 SPA」，把所有未命中静态文件的路径
   都回退到根 `index.html`（官方明确点名 React/Vue/Angular）。本仓库 `dist/` 无 `404.html`，**自动命中**。
2. **`_redirects`**：`public/_redirects`（`/* /index.html 200`）会被 Vite 拷进 `dist/_redirects`。
   `200` 是「代理/重写」（serve index.html at that path，HTTP 200），静态文件优先于该规则——
   即 `/assets/index-xxx.js` 照常返回真文件，只有非资源路径才落到 index.html。

两者结果一致（非资源路径 → index.html）。**保留 `public/_redirects` 的好处是跨服务商可移植**
（Netlify 也读这个文件）；它对 CF 无害，技术上因内置 fallback 而冗余。建议保留。
> 来源：[Serving Pages · SPA rendering](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering)、[Redirects](https://developers.cloudflare.com/pages/configuration/redirects/)

### 2.5 缓存 / 响应头
CF 默认就给静态资源发：`Cache-Control: public, max-age=0, must-revalidate`、`Etag`、
`X-Content-Type-Options: nosniff`、`Access-Control-Allow-Origin: *`、`Referrer-Policy: strict-origin-when-cross-origin`，
并支持 `If-None-Match`→`304`、Gzip/Brotli。资源在 CDN 缓存到**下次部署**为止。
官方**建议**：一般不要在自定义域名上叠自定义缓存（可能导致部署后陈旧、干扰 redirect/function）；
但**带内容哈希的 `/assets/*`** 适合加 `immutable` 长缓存——正好对应 `vercel.json`/`netlify.toml` 现有策略。
要复刻就加 `public/_headers`（见 §5）。
> 来源：[Serving Pages · Caching & Headers](https://developers.cloudflare.com/pages/configuration/serving-pages/#caching-and-performance)、[Headers](https://developers.cloudflare.com/pages/configuration/headers/)

### 2.6 纯静态 → 规则全量生效
本仓库无 `functions/`、无 `_worker.js`。`_headers`/`_redirects` 的「不适用于 Pages Functions 响应」的
警告对本案**不适用**——所有响应都是静态资源，规则全量生效。
> 来源：[Headers caution](https://developers.cloudflare.com/pages/configuration/headers/)、[Redirects caution](https://developers.cloudflare.com/pages/configuration/redirects/)

---

## 3. 四种部署方式（任选其一）

> ⚠️ **单向选择**：Git 集成 ↔ Direct Upload 不可互转。选了 Direct Upload 之后想自动构建，只能另建一个
> Git 集成项目；选了 Git 集成后想手动传，可以「关闭自动部署」再用 `wrangler pages deploy`。
> 来源：[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)、[Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)

### 3.1 Git 集成（推荐 · 推 `master` 即上线，PR 自动出预览）
1. Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
   （会要求 GitHub 授权，可只授权 `94mashiro/football-life`）。
2. 选仓库 `football-life`。
3. **Set up builds and deployments**：
   - Project name：`football-life`（→ `football-life.pages.dev`）
   - Production branch：**`master`**（本仓库默认分支是 master，不是 main）
   - Build command：`npm run build`
   - Build output directory：`dist`
   - Environment variables（可选但建议）：`NODE_VERSION = 22`
4. **Save and Deploy** → 推一次 `master` 即触发构建，得到 `https://football-life.pages.dev`。
   之后每次 push `master` 自动重建；PR/非生产分支自动出**预览部署**
   `<branch>.football-life.pages.dev`。
> 来源：[Git integration guide](https://developers.cloudflare.com/pages/get-started/git-integration/)、[Vite framework guide](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/)

### 3.2 Direct Upload · Wrangler CLI（手动 / 自建 CI）
```bash
npm i -g wrangler            # 或直接用 npx
npx wrangler login           # 浏览器授权
npx wrangler pages project create football-life --production-branch master
npm run build
npx wrangler pages deploy dist --project-name=football-life
# 在 git 工作区里会自动识别分支；否则加 --branch=master
# 预览分支：--branch=<name> → <name>.football-life.pages.dev
```
- 项目名 + 生产分支会缓存到 `node_modules/.cache/wrangler`，后续部署复用。
- 限制：**20,000 文件 / 单文件 25 MiB**。本仓库 `dist/` 约 10 个文件，最大 `og-card.png` 377 KB，远在限内。
> 来源：[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)、[wrangler pages deploy](https://developers.cloudflare.com/workers/wrangler/commands/pages/#pages-deploy)

### 3.3 Direct Upload · 拖拽（最快一次性）
`npm run build` 后，控制台 → Workers & Pages → Create → **Drag and drop**，把 `dist/`（或其 zip）拖进去。
限制：**1,000 文件 / 25 MiB**（比 wrangler 的 20,000 少）。
> 来源：[Direct Upload · Drag and drop](https://developers.cloudflare.com/pages/get-started/direct-upload/#drag-and-drop)

### 3.4 GitHub Actions CI（把 Direct Upload 自动化，不绑定 CF 的 Git 集成）
在 GitHub 仓库 Secrets 加 `CLOUDFLARE_API_TOKEN`（权限：Account / Cloudflare Pages / Edit）+
`CLOUDFLARE_ACCOUNT_ID`，新建 `.github/workflows/cloudflare-pages.yml`：
```yaml
name: Deploy to Cloudflare Pages
on:
  push:
    branches: [master]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { contents: read, deployments: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy dist --project-name=football-life
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```
> 来源：[Use Direct Upload with continuous integration](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
> （注：官方示例未固定 Node；这里补 `setup-node@v4` + `node-version: 22`，避免依赖 v3 默认版本漂移。）

---

## 4. 本地预览（`wrangler pages dev`）

`npm run dev`（Vite）带 HMR 但**不**模拟 CF 的 `_redirects`/`_headers`。要在本地**忠实复现 CF 行为**：
```bash
npm run build
npx wrangler pages dev dist      # 默认在本机端口起服务（命令会打印 URL，可用 --port 指定）
```
它会应用 `_redirects`/`_headers`、托管 `dist/` 静态资源，是上线前最贴近生产的预览。
（`wrangler pages dev` 的 `[COMMAND]` 代理参数已 deprecated；要 HMR 就直接用 `vite`。）
> 来源：[wrangler pages dev](https://developers.cloudflare.com/workers/wrangler/commands/pages/#pages-dev)

---

## 5. 建议新增 / 修改的文件（全部可选）

### 5.1 `.node-version`（建议）
内容：`22`。让 CF v3 构建用 Node 22（默认即 22.16，此举是显式锁定，防默认版本漂移），
顺便让本机 fnm 也对齐。
> 来源：[Build image · Override default versions](https://developers.cloudflare.com/pages/configuration/build-image/#override-default-versions)

### 5.2 `public/_headers`（可选 · 复刻现有缓存策略）
CF 默认头已可用；要和 `vercel.json`/`netlify.toml` 对齐长缓存，加：
```text
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```
说明：`/assets/*` 是 Vite 带哈希的资源，`immutable` 安全（内容变哈希就变）；
只影响静态资源响应（本案无 Functions）。**不要给自定义域名全局加粗缓存**，以免部署后陈旧 / 干扰 redirect。
> 来源：[Headers · fingerprinted assets](https://developers.cloudflare.com/pages/configuration/headers/#examples)

### 5.3 `wrangler.toml`（可选 · 仅当你想用 `wrangler deploy` 统一命令）
Direct Upload（`wrangler pages deploy dist --project-name=...`）**不需要任何配置文件**。
若想用较新的统一命令 `wrangler deploy`，可加：
```toml
name = "football-life"
pages_build_output_dir = "./dist"
```
> 来源：[Wrangler configuration for Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)

### 5.4 `package.json` 脚本（可选）
现有 `"deploy": "npm run build && vercel --prod"`。可加一个 CF 专用脚本，避免改掉 Vercel 的：
```json
"deploy:cf": "npm run build && wrangler pages deploy dist --project-name=football-life"
```

### 5.5 `index.html` OG 图 URL（建议改）
当前 `og:image` / `twitter:image` 硬编码为
`https://94mashiro.github.io/football-life/og-card.png`（GitHub Pages 路径）。上 CF 后站点在
`https://football-life.pages.dev/`，`og-card.png` 会服务在 `https://football-life.pages.dev/og-card.png`。
建议把这两处改成 CF 域名（或改成相对路径 `/og-card.png`——但微信/X 抓 OG 图**需要绝对 URL**，所以用
`https://football-life.pages.dev/og-card.png`）。绑定自定义域名后再改成最终域名。
> 来源：本仓库 `index.html` 第 23、33 行；[Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)

---

## 6. 坑 / 注意事项

1. **Git 集成 ↔ Direct Upload 单向**：选之前想清楚。详见 §3 开头。
2. **OG 图硬编码到 GitHub Pages**：上 CF 后社交分享预览仍指向 GH Pages 的图。若 GH Pages 下线或路径变，
   预览会失效。建议按 §5.5 改到 CF 域名。
3. **`AGENTS.md` 的「构建失败」说明已过期**：文中称 `npm run build` 因 `engine/` TS 报错而失败。
   实测 `tsc -b && vite build` **全绿**（`dist/index.html` + `index-*.css` 67KB + `index-*.js` 745KB）。
   CF 可直接用 `npm run build`。建议更新 `AGENTS.md` 的 Known build state 段。
4. **生产分支是 `master` 不是 `main`**：CF 配置里 Production branch 填 `master`。
5. **v3 不读 `package.json` 的 `engines`**：别指望 Vite 的 engines 约束自动选 Node；用 `NODE_VERSION` 环境变量或 `.node-version` 文件。
6. **包体积警告（非阻塞）**：Vite 提示 `index-*.js` 745KB（gzip 247KB）> 500KB。CF 单文件限 25 MiB，
   完全不卡。后续可用动态 `import()` / `codeSplitting` 优化首屏，但与部署无关。
7. **文件/大小限制**：Wrangler 20,000 文件 / 25 MiB；拖拽 1,000 文件 / 25 MiB。本案均远在限内。
8. **自定义域名 + 缓存**：绑自定义域名后，避免在域上叠粗缓存（除非是带哈希的 `/assets/*`），
   否则部署后可能陈旧、或干扰 `_redirects`。
9. **DNS 传播**：首次部署后访问若 DNS 报错，等传播或换网络/设备即可（官方说明）。

---

## 7. 推荐方案

- **要「推了就上线 + PR 预览」→ 选 §3.1 Git 集成**。零新文件（顶多加 `.node-version`），最省心，
  与现有 GitHub Pages workflow 并存不冲突（两者可同时部署到不同域名）。
- **要「自己掌控构建产物、或不想把仓库权限授给 CF」→ 选 §3.2 Wrangler Direct Upload**，
  配 §3.4 的 GitHub Actions 实现自动化。
- **一次性试水**：§3.3 拖拽 `dist/`，30 秒拿到 URL。
- 无论哪种，建议顺手做 §5.1（`.node-version`）和 §5.5（OG 图改 CF 域名）；§5.2 `_headers` 看是否要复刻长缓存。

---

## 8. 来源（Sources · 全部一手）

- Cloudflare Pages 全量官方文档（Markdown 镜像）：`https://developers.cloudflare.com/pages/llms-full.txt`
  - [Cloudflare Pages 总览](https://developers.cloudflare.com/pages/)
  - [Get started · Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)
  - [Get started · Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
  - [Framework guide · Vite 3](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/)（构建命令 `npm run build` / 输出 `dist`）
  - [Build configuration · Framework presets](https://developers.cloudflare.com/pages/configuration/build-configuration/)（React(Vite)=npm run build/dist；退出码判成败）
  - [Build image](https://developers.cloudflare.com/pages/configuration/build-image/)（v3 默认 Node 22.16.0；`NODE_VERSION`/`.nvmrc`/`.node-version`；v3 不读 engines）
  - [Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)（无 `404.html` → 内置 SPA fallback；默认响应头；缓存建议）
  - [Redirects](https://developers.cloudflare.com/pages/configuration/redirects/)（`_redirects` 语法；`200`=代理/重写；限制 2000+100）
  - [Headers](https://developers.cloudflare.com/pages/configuration/headers/)（`_headers` 语法；带哈希资源 `immutable` 示例）
  - [Migrating from Vercel to Pages](https://developers.cloudflare.com/pages/migrations/migrating-from-vercel/)
  - [Use Direct Upload with continuous integration](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)（GitHub Actions + `cloudflare/wrangler-action@v3`）
  - [Wrangler configuration for Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)（`pages_build_output_dir`）
- wrangler `pages` CLI 参考：`https://developers.cloudflare.com/workers/wrangler/commands/pages/`
  （`pages dev` / `pages project create` / `pages deploy` / `pages deployment list`）
- 本仓库核查：`package.json`、`vite.config.ts`、`index.html`、`public/_redirects`、`.gitignore`、
  `.github/workflows/deploy.yml`、`vercel.json`、`netlify.toml`、`node_modules/vite/package.json`（engines）、
  `git symbolic-ref`（默认分支 = master）、实测 `npm run build` 产物 `dist/`。
