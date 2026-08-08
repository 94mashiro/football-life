# copero 参照数据库 (Reference Dataset)

本目录是从 **copero 职业生涯模拟器**（<https://copero.com.ar/juegos/simulador-carrera>）提取的结构化参照数据，用作本游戏 `src/engine/data.ts` 数据库的校准与扩展参照，以及 `public/img/` 配套图片的来源依据。

> 这是**参照**，不是游戏运行时数据。游戏实际使用 `src/engine/data.ts`（已按本项目的平衡调校过）+ `src/engine/images.ts`（图片路径解析）。本目录的 JSON 仅供查阅、校准与未来扩展。

## 来源与提取方法

copero 是一个单页应用，全部球队/联赛/奖杯数据内联在其 Vite 打包产物里：

- 入口页 bundle：`https://copero.com.ar/assets/index-vNwXZy7w.js`
- 业务 bundle：`https://copero.com.ar/assets/CareerSimulatorPage-DW_0IenV.js`（~640 KB，内含全部数据字面量）

提取脚本（一次性，未入库）用括号平衡 + 正则从 bundle 里解析出以下结构，所有图片 URL 都带 `Referer: https://copero.com.ar/` 头下载（队徽/联赛 logo 多为 `.svg`，奖杯多为 `.png`，少数 `.webp`）。

## 文件说明

| 文件 | 内容 |
|------|------|
| `leagues.json` | 41 个联赛，每个含 `id / name / country / confederation / tier / domestic_cup_id / logo_url / league_trophy_url / teamCount / teams[]`。`teams[]` 每个含 `id / name / short_name / abbreviation / logo_url / primary_color / domRep / contRep / intlRep`（三项声望均为 0–5）。 |
| `domestic-cups.json` | 29 个国内杯赛，`{ id, name, country, trophy_url }`，按杯赛 id 索引。 |
| `continental-trophies.json` | 6 个足联（UEFA/CONMEBOL/CONCACAF/AFC/CAF/OFC）的洲际俱乐部奖杯（primary/secondary）与国家队洲际杯（national_continental）。 |
| `nations.json` | 206 个国家/地区：`iso / fifa / slug / flag / crest / confederation / contRep / fifaRep / intlRep`。`crest` 为国家队队徽（仅 57 个有；copero 对很多国家队只提供国旗）。 |
| `club-image-map.json` | 本游戏 305 家俱乐部 → copero slug 的映射结果（`{ coperoSlug, country, ext, path, coperoName }` 或 `null`）。 |

## 与本游戏数据库的对照

本游戏数据库（`src/engine/data.ts`）：28 联赛 / 305 俱乐部 / 61 国家。copero：41 联赛 / 711 俱乐部 / 206 国家。

### 联赛覆盖

- **20 / 28** 联赛有 copero 对应物（有联赛 logo + 联赛奖杯图）。
- 本游戏有、copero 没有的 8 个联赛：希腊超、瑞士超、奥甲、捷克甲、乌超、埃及超、中甲、巴乙。这些联赛的俱乐部无 copero 队徽，`images.ts` 返回 `null`（UI 走占位兜底）。
- copero 有、本游戏没有的联赛：阿根廷乙级（36 队）、玻利维亚/智利/哥伦比亚/委内瑞拉/乌拉圭/秘鲁/厄瓜多尔/巴拉圭顶级、哥斯达黎加/洪都拉斯/危地马拉/萨尔瓦多/尼加拉瓜/多米尼加/巴拿马、俄罗斯、克罗地亚、法乙、葡超(18)、荷甲(18)、土超(18)、苏超(12)、波兰甲(18)、墨甲(18)、美职联(30)、沙特联(18)。这些是**扩展候选**，图片与数据均已就绪。

### 俱乐部覆盖

- **226 / 305** 俱乐部有 copero 队徽（79 无图：59 个在 copero 未覆盖的联赛 + 20 个 copero 选中名单里没有的俱乐部，如 leicester / wolfsburg / hellas-verona / fortaleza 等）。
- 映射规则（见 `src/engine/images.ts` 的 `CLUB_CREST`）：本游戏 club id == copero slug 时直接用（159 个）；不等时用人工核对的别名表（如 `man-city→manchester-city`、`psg→paris-saint-germain`、`bayern→bayern-munchen`、`sporting-cp→sporting-lisboa` 等）。声望排序匹配不可靠（copero 与本游戏声望标度不同，见下），故不采用。

### 声望标度差异（重要）

copero 的三项声望（`domestic_reputation` / `continental_reputation` / `international_reputation`）都是 **0–5**；本游戏 `Club` 的 `domRep`/`contRep` 也是 0–5，但 `intlRep` 与复合 `rep` 用的是 **0–9** 标度（`rep = max(domRep, contRep)` 经映射后；见 `data.ts` 的 `SQUAD_BASE`/`repTier`）。所以**不能直接把 copero 的声望拷进本游戏**——本游戏的奖杯概率表（`LEAGUE_PROB` 等）按 0–9 rep 索引，声望标度不同会导致概率错乱。`images.ts` 只取 copero 的**图片**，不取其声望数值。

### 国家队覆盖

- **61 / 61** 国家有国旗（英格兰/苏格兰用 `gb-eng` / `gb-sct`，copero 无独立 FIFA 条目）。
- **45 / 61** 有国家队队徽（copero 对 14 个国家只提供国旗、无队徽：den/pol/srb/ukr/gre/jpn/tha/vie/idn/nga/cmr/gha/jam/fij）。`nationCrestPath` 返回 `null` 时 UI 用国旗兜底。

### 奖杯图覆盖

- 联赛奖杯：20/28 有图。
- 国内杯赛奖杯：19/20（仅日皇杯 `emperors-cup.png` 缺失——copero CDN 对该文件返回 403 AccessDenied，文件实际不存在；J1 的 `domesticCupPath` 返回 `null`）。
- 洲际：UEFA/CONMEBOL primary+secondary 齐全；CONCACAF/AFC 仅 primary；**CAF/OFC 无俱乐部洲际奖杯图**。
  - 注意 copero 的 **CAF 数据有 bug**：其 `continental_primary`/`national_continental` 指向了 CONCACAF 的奖杯（copy-paste 错误）。本游戏 `images.ts` 已修正——CAF primary 设为 `null`（无 CAF 冠军联赛图），CAF 国家洲际杯用实际下载到的 `afcon.svg`。
- 世界杯 / 世俱杯：均有图。

### 3 个无法获取的奖杯图

copero CDN 对这 3 个文件返回 403 AccessDenied（文件不存在，非防盗链）：
- `trophies/football/national/GUA/supercopa-guatemala.png`
- `trophies/football/national/JAP/emperors-cup.png`
- `trophies/football/national/NCA/copa-primera-de-nicaragua.png`

其中仅日皇杯与本项目相关（J1 联赛国内杯），其余两个属于本项目未收录的联赛。

## 图片资源

全部图片镜像在 `public/img/`，共 **1096** 个文件 / ~37 MB：

```
public/img/
  clubs/<COUNTRY>/<slug>.<ext>     711 俱乐部队徽
  national/<CODE>.svg              59 国家队队徽
  leagues/<COUNTRY>/<slug>.<ext>   41 联赛 logo
  trophies/...                     77 奖杯（洲际+国内+世界杯+世俱杯）
  flags/<iso>.svg                 208 国旗
```

运行时由 `src/engine/images.ts` 解析为 `/img/...` 路径（Vite 以 `public/` 为静态根）。解析器对无图条目返回 `null`，UI 负责兜底（队徽用缩写 monogram，奖杯用奖杯 emoji/通用图），绝不渲染破损 `<img>`。

## 重新提取（如需更新 copero 数据）

1. `curl -s https://copero.com.ar/assets/CareerSimulatorPage-DW_0IenV.js -o career.js`（hash 会变，从入口页 `index-*.js` 里的 preload 链找最新 `CareerSimulatorPage-*.js`）。
2. 用括号平衡解析 leagues（含内嵌 teams）/ 正则解析 domestic-cups / continental-trophies / nations。
3. 图片带 `Referer: https://copero.com.ar/` + 浏览器 UA 下载；队徽/联赛 logo 多为 `.svg`，注意 URL 里的扩展名要与 `logo_url` 字段一致（copero 对不同俱乐部用 `.svg`/`.png`/`.webp`，拼错扩展名会 403）。
