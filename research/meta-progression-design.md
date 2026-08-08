# Roguelite 跨局元进程设计研究

> 研究对象：Slay the Spire、Balatro、Hades、Dead Cells、Rogue Legacy
> 研究问题：新存档开局时到底锁了什么（内容 / 数值 / 难度）？第一局能不能摸到天花板？设计师自己怎么说？
> 日期：2026-08-08 ｜ 所有事实均附 URL，设计师原话保留英文并附中文转述

---

## 0. 三条轴：CONTENT / POWER / DIFFICULTY

分析这五款游戏时，把"跨局解锁"拆成三条互不等价的轴：

| 轴 | 定义 | 对新玩家的影响 |
|---|---|---|
| **CONTENT（内容）** | 池子里能出现什么（卡牌、Joker、武器、蓝图） | 影响 **多样性**，不影响单局强度上限 |
| **POWER（数值）** | 开局自带的永久属性/复活次数/金币 | 直接影响 **单局强度**，前期存档天然弱 |
| **DIFFICULTY（难度）** | Ascension / Stake / Heat / Boss Cell / NG+ | 让游戏 **更难**，通常是通关后才开放 |

**核心结论先给**：五款游戏里，只有 Rogue Legacy 和 Hades 把 POWER 放进元进程；Slay the Spire 和 Balatro 完全没有 POWER；Dead Cells 有少量 POWER 但把它的上限锁在 DIFFICULTY 轴后面。而 **五款全部都有 DIFFICULTY 轴，且全部是"通关后才开"**。

---

## 1. Slay the Spire（Mega Crit, 2019）

### 1.1 新存档锁了什么

| 轴 | 内容 | 引用 |
|---|---|---|
| CONTENT | 3 个角色（Silent / Defect / Watcher）；每角色 5 级解锁 × 3 件 = **36 张卡 + 24 个遗物**，共 60 件 | [Ironclad](https://slaythespire.wiki.gg/wiki/Ironclad) [Silent](https://slaythespire.wiki.gg/wiki/Silent) [Defect](https://slaythespire.wiki.gg/wiki/Defect) [Watcher](https://slaythespire.wiki.gg/wiki/Watcher) |
| CONTENT | Act 4（腐化之心）：需三个基础角色各通关一次 | [The Ending](https://slaythespire.wiki.gg/wiki/The_Ending) |
| CONTENT | Custom Mode：打一次 Daily Climb 解锁 | [Custom Mode](https://slaythespire.wiki.gg/wiki/Custom_Mode) |
| **POWER** | **无。完全没有。** | 见 1.2 |
| DIFFICULTY | Ascension 1–20，每角色独立，需通关后逐级解锁 | [Ascension](https://slaythespire.wiki.gg/wiki/Ascension) |

角色解锁条件极轻：

> "The Silent is unlocked by completing (does not have to be a win) a run with the Ironclad."
> （打完一局 Ironclad 即可，**输赢不论**）
> — [Silent wiki](https://slaythespire.wiki.gg/wiki/Silent)

**解锁计数器的精确参数**（wiki 从未公布，来自反编译源码）：起始 `CurrentCost = 300`，随后 `300 → 750 → 1000 → 1500 → 2000`，每角色累计 **5,550 分**。且溢出分数会被 clamp 到 `nextCost − 1`——**一局绝不可能连升两级**。
— [UnlockTracker.java](https://github.com/Voyage-for-the-ideal/aiplayspire/blob/master/cardcrawl/unlock/UnlockTracker.java)

**关键设计细节**：解锁的卡不是"更强的卡"，而是"更奇怪的卡"。Ironclad 三级解锁里有 Wild Strike（往牌库塞伤口），Silent 四级解锁里有 Pandora's Box。**解锁增加的是 breadth，不是 strength。**

### 1.2 完全没有永久数值

存档跨局携带的全部内容是：角色解锁、5 级卡/遗物阶梯、Ascension 等级、成就、Custom Mode、Act 4 可用性。**没有任何一项是属性、货币或开局加成。** Ironclad 第 1 局和第 1000 局都是 80 HP / Burning Blood / 5 Strike 4 Defend 1 Bash。
— [Ironclad](https://slaythespire.wiki.gg/wiki/Ironclad)、[Score](https://slaythespire.wiki.gg/wiki/Score)

Ascension 的 20 级 **每一级都是纯惩罚**：A1 精英 +60%、A6 开局掉 10% 血、A10 开局带一张 Ascender's Bane、A11 少一个药水位、A14 减最大生命、A20 双 Boss。
— [Ascension](https://slaythespire.wiki.gg/wiki/Ascension)

**而且难度轴反哺解锁**："+5% score per Ascension level"（每级 Ascension 得分 +5%）——**打得越难，解卡越快**。这是替代"变强"的那个循环。
— [Score](https://slaythespire.wiki.gg/wiki/Score)

### 1.3 第一局能通关吗

**结构上可以。** Ironclad 默认池只少 9 张卡，Ascension 默认 0，Act 1–3 通关就是胜利。第一局唯一够不到的是 Act 4。

Steam 全球成就数据（2026-08-08 拉取自 [Valve 公开接口](https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=646570)）：

| 成就 | 含义 | 全球比例 |
|---|---|---|
| Guardian | 杀 Act 1 Boss | 85.1% |
| Champ | Act 3 Boss | 70.9% |
| **Ascend 0** | **首次通关（任意角色打过 Act 3 Boss）** | **66.5%** |
| Ruby | Ironclad 通关 | 56.2% |
| Amethyst | Watcher 通关 | 26.0% |
| The Ending | 击败腐化之心 | 13.1% |
| Ascend 20 | A20 通关 | 7.3% |

85% → 66.5% 的落差说明：首胜发生在第一局之后，但**没有被解锁系统挡住**——挡住的是技术。

### 1.4 设计师原话

Giovannetti，GDC 2019《Metrics Driven Design and Balance》，讲 Ascension（[视频](https://www.youtube.com/watch?v=7rqfbvnO_H0)｜[官方 slides PDF](https://media.gdcvault.com/gdc2019/presentations/Giovannetti_Anthony_SlayTheSpire.pdf) p.15，标题为 "Ascension: Player Skill Stratification"）：

> "One challenge with balance is always how to handle differing difficulty modes. We primarily balanced Slay the Spire around the base difficulty level, but Slay also has twenty levels of progressively harder difficulty that we call Ascension. Players have to unlock these one level at a time, meaning that as players' skill improves, so too will they climb up the Ascension ladder. Because playing Ascension is optional but it offers achievements and a sense of accomplishment, **players will naturally gravitate to the Ascension level that makes sense for them.** … Consequently what we did is we actually **turned difficulty levels from a challenge in design into a strength**."

> 中文转述：我们主要按基础难度做平衡，然后用 20 级 Ascension 做技术分层。玩家逐级解锁，技术涨则阶梯涨，**每个人会自然停在适合自己的那一级**。这让"难度设定"从设计难题变成了设计优势——既能按玩家分层看数据，也能针对不同硬核度做定向调整。

同一场演讲里，他还讲了 Custom / Daily 是往**更简单**方向拓展的：

> "Furthermore, our Custom and Daily modes also added additional ways to alter the difficulty of the game with unique modifiers that greatly change up play, **usually to make things actually easier this time around**. Again, this gives further customization outside of the typical easy/medium/hard paradigm. **I really highly recommend experimenting with systems like this, as the Ascension levels turned out to be a big hit.**"

> 中文转述：Custom 和 Daily 用独特词条改变难度，**通常是把游戏变简单**。这提供了传统"简单/普通/困难"之外的定制维度。强烈推荐做类似系统，Ascension 大获成功。

**Mega Crit 对解锁系统本身的态度，最清楚的一手证据是他们主动砍解锁墙的补丁说明**：

> "**We removed one level of unlocks!** Three additional cards are now available by default in the card pool for both The Silent and Ironclad."
> （我们**删掉了一整级解锁**，Silent 和 Ironclad 各有三张卡改为默认可用）
> — Weekly Patch 13: Thinking Ahead，见 [Entrench](https://slaythespire.wiki.gg/wiki/Entrench) / [Carnage](https://slaythespire.wiki.gg/wiki/Carnage) 的更新历史

> "**We're looking into lowering the requirement to unlock Custom Mode**, adding more goodies…"
> — [Weekly Patch 33 – Terror](https://slaythespire.wiki.gg/wiki/Weekly_Patch_33_-_Terror)

**注意**：我们找不到 Giovannetti/Yano 任何一处**正面辩护解锁系统存在意义**的原话（r/slaythespire 无法抓取，Spelunky Showlike ep.25 与 Justin Gary 访谈均无解锁相关内容）。**有据可查的方向是单向的：解锁越做越少。**

### 1.5 Slay the Spire 2 的变化（2026-03-05 EA 上线）

> "The Timeline is a metaprogression mechanic added in Slay the Spire 2. **It replaces Slay the Spire 1's per-character unlock system in favor of a single progression mechanic**… These Epochs are unlocked by completing various milestones… and give **a small section of story along with art** as well as rewards that unlock new things in the game."
> — [StS2: Timeline](https://slaythespire.wiki.gg/wiki/Slay_the_Spire_2:Timeline)

变化三点：(1) 四条角色阶梯 → **一条全局阶梯**；(2) 每个 Epoch 是一段**剧情**（Preon → Scribbles → The Architect → … → The Spire），解锁包在叙事里而不是包在刷分里；(3) 门槛用全局累计分数，跨度大得多（200 / 700 / 3,700 / … / 30,800）。**但仍然是纯内容解锁，仍然没有永久数值。**
[Mega Crit EA 上线公告](https://www.megacrit.com/news/2026-03-05-early-access-launch/)

---

## 2. Balatro（LocalThunk, 2024）

### 2.1 新存档锁了什么

| 轴 | 内容 | 引用 |
|---|---|---|
| CONTENT | **45 / 150 个 Joker 锁定**（105 个第一局可用） | [Jokers](https://balatrowiki.org/w/Jokers) |
| CONTENT | 14 / 15 副牌组锁定（只有 Red Deck 可用） | [Decks](https://balatrowiki.org/w/Decks) |
| CONTENT | 16 个升级版 Voucher 锁定（**16 个基础 Voucher 全部无条件可用**） | [Voucher](https://balatrowiki.org/w/Voucher) |
| — | Tarot / Planet / Spectral **全部不锁** | [Spectral Cards](https://balatrowiki.org/w/Spectral_Cards) |
| **POWER** | **无。一点都没有。** | 见 2.2 |
| DIFFICULTY | Stake 8 级（White→Gold），**按牌组各自解锁** | [Stakes](https://balatrowiki.org/w/Stakes) |

> "Excluding unlockable content outside of the Collection, there are **75 items to be unlocked: 45 Jokers, 14 Decks, and 16 Vouchers**."
> — [Unlockables](https://balatrowiki.org/w/Unlockables)

Stake 的 8 级 **每一级都是纯惩罚**：Red 小盲无奖金、Green 分数需求加速、Black 30% Joker 带 Eternal、Blue −1 弃牌、Purple 再加速、Orange Perishable、Gold Rental。**没有任何一级增加内容。**
— [Stakes](https://balatrowiki.org/w/Stakes)

### 2.2 完全没有永久数值——最硬的证据是"全解锁"按钮

Balatro 提供一键解锁全部 340 项收藏的按钮。**一个有永久数值成长的游戏不可能提供这个按钮；一个解锁只是内容多样性的游戏才可以。**

> "One additional option that can be done through the profile system is by clicking the dark gray '**Unlock All**' button, which allows for the player to unlock all 340 items in the Collection."
> — [Profile](https://balatrowiki.org/w/Profile)

LocalThunk 解释为什么加这个按钮（TouchArcade，2024-03-18）：

> "I personally would never click that option myself, nor would I in other games, but when it was suggested I thought – why wouldn't I add that as an option? **It's simply a net positive mechanic.**"
> 中文转述：我自己绝不会点，但既然有人提了——为什么不加？**这纯粹是个净收益的机制。**
> — [TouchArcade 访谈](https://toucharcade.com/2024/03/18/balatro-interview-mobile-port-localthunk-dlc-plans-updates-new-jokers-demo-feedback/)

**一处诚实的保留**：牌组是**开局选择的 sidegrade**，后期解锁的部分牌组客观上更强（Plasma：Chips/Mult 均衡化但盲注 ×2；Anaglyph：每个 Boss 后送 Double Tag）。但 (a) 是横向选择不是叠加加成；(b) 无"牌组等级"，有上限；(c) 玩家主动选，是 build 宣言不是被动 buff。这是 Balatro 最接近"永久数值"的地方，且**刻意做成不可累积**。

### 2.3 第一局能赢吗——能，而且很多人真的赢了

- **105 / 150 个 Joker 第一局就在池子里（70%）**；按商店出现率加权还更高，因为 45 个锁定的偏向 Rare（5% 出率）和 Legendary（5 个全锁，只能通过 The Soul 0.3% 抽到）。
- 全部 Tarot / Planet / Spectral / 基础 Voucher 第一局可用。
- Red Deck 相对原版是纯增益（每轮 +1 弃牌）。

Steam 全球成就（[来源](https://steamcommunity.com/stats/2379780/achievements)，2026-08-08）：

| 成就 | 条件 | 比例 |
|---|---|---|
| Ante Up! | 到 Ante 4 | 90.0% |
| Ante Upper! | 到 Ante 8 | 74.7% |
| **Heads Up** | **赢下一局** | **71.7%** |
| Low Stakes | Red Stake 以上通关 | 43.8% |
| Mid Stakes | Black Stake 以上 | 30.3% |
| High Stakes | Gold Stake 以上 | **12.1%** |
| Completionist+ | 全牌组 Gold Stake 通关 | 1.6% |

**读法**：71.7% 的持有者赢过。难度曲线完全活在 stake 里（71.7 → 43.8 → 30.3 → 12.1），**而不是活在被锁住的强度里**。

### 2.4 设计师原话——本研究最重要的一段

LocalThunk，博客《Solitaire》，2025-02-26（[原文](https://localthunk.com/blog/solitaire)）：

> "Things like achievements, stake levels, unlocks, and challenges **certainly can be looked at as a way to artificially inflate playtime, but those things were added for 2 other reasons** I was more concerned about:
> 1. **To force players to get out of their comfort zone and explore the design of the game in a way they might not if this were a fully unguided gaming experience.** … I feel like even I learned a lot from these guiding goals that I wasn't anticipating many months after the game launched.
> 2. **To give the players that already enjoy the game loop a sort of checklist to work through if they so choose.** … I do really appreciate when I play other games and they give me tasks to accomplish and shape my long-form play around while I enjoy the shorter play sessions individually."

> 中文转述：成就、stake、解锁、挑战这些东西**确实可以被看作是人为拉长游玩时长，但我加它们是为了另外两个我更在意的理由**：
> 1. **逼玩家走出舒适区，用他们在完全无引导时不会用的方式去探索这个游戏的设计。**（连我自己都在游戏上线好几个月后从这些引导目标里学到了没预料到的东西。）
> 2. **给已经喜欢这个循环的玩家一份可选的清单。**我自己玩别的游戏时就很喜欢有任务可做、能把长线游玩组织起来，同时每一局又是短的。

**这是"解锁为什么存在"的直接答案：课程表 + 清单。从来不是数值。**

同一篇里解释为什么根本没有角色/血量/敌人：

> "I wanted it to feel evergreen, comforting, and enjoyable in a very low-stakes way. I think that's one of the reasons why **there isn't a player character, health, or classic 'enemies' in the game** as well. I wanted this game to be as low stakes as a crossword or a sudoku puzzle while still exercising the problem solving part of the brain."

Stake 的来源，《The Balatro Timeline》（[原文](https://localthunk.com/blog/balatro-timeline-3aarh)）：

> "The biggest addition is the inclusion of a sort of '**ascension**' system. **This is from Slay the Spire** (see? Told you I'd steal from it) but I think it was a super cool way to add difficulty and **give players a sort of checklist to work through**."

注意血统：Balatro 的 stake 明确抄自 StS 的 Ascension——同样是**纯难度、永不加数值**。

他对 RPG 数值语汇的排斥（TouchArcade）：

> "**I dislike the 'gamery' language of fantasy and combat that seem to be way overrepresented in video games.** Since Balatro is ultimately a game for me, I wanted to lean on different verbiage and visuals."

---

## 3. Hades（Supergiant, 2020）

Hades 是五款里 **POWER 轴最重** 的（与 Rogue Legacy 并列），但用了一整套装置来对冲。

### 3.1 新存档锁了什么

| 轴 | 内容 | 引用 |
|---|---|---|
| **POWER** | **暗影之镜（Mirror of Night）**：12 个槽 × 红/绿两版 = 24 个天赋 | [Mirror of Night](https://hades.fandom.com/wiki/Mirror_of_Night) |
| POWER | 武器 Aspect（用 Titan Blood 升级） | [Titan Blood](https://hades.fandom.com/wiki/Titan_Blood) |
| POWER | 纪念品（Keepsakes，靠送 Nectar 获得）、伙伴（Companions，靠 Ambrosia） | [Keepsakes](https://hades.fandom.com/wiki/Keepsakes) [Companions](https://hades.fandom.com/wiki/Companions) |
| CONTENT | 6 把武器：Stygius 默认，其余共需 **24 把冥界钥匙** | [Infernal Arms](https://hades.fandom.com/wiki/Infernal_Arms) |
| DIFFICULTY | 惩罚契约（Pact of Punishment / Heat），**首次通关后才出现** | [Pact of Punishment](https://hades.fandom.com/wiki/Pact_of_Punishment) |
| DIFFICULTY↓ | God Mode，**开局即可用，随时开关** | [God Mode](https://hades.fandom.com/wiki/God_Mode) |

**Mirror 的数值量级（这是关键）**：

- **Death Defiance**：3 级，每级在生命归零时恢复 50% 血 = **+3 条命**（30 / 500 / 1,000 = 1,530 黑暗）
- **Thick Skin**：10 级 × +5 = **+50 最大生命**（Zagreus 基础 50 生命，**等于翻倍**）
- **Greater Reflex**：**+1 次冲刺**（50 黑暗）
- Olympian Favor：40 级 × +1% = **稀有恩赐概率 +40%**

> "It takes a total of **65** Chthonic Keys to unlock all upgrades on the Mirror."
> "…the total required to max out the Mirror is **35,365** Darkness."
> — [Mirror of Night](https://hades.fandom.com/wiki/Mirror_of_Night)

满镜子约等于 **有效生命 5 倍** 的摆幅（翻倍血量 × 3 次半血复活），恩赐质量还大幅提升。**这是实打实的永久数值。**

**并且武器 Aspect 的燃料被难度轴锁住**：全部 306 份 Titan Blood 里，**240 份来自 Heat 1–20 的 Bounties**——约 78% 的武器强化燃料在惩罚契约后面。
— [Titan Blood](https://hades.fandom.com/wiki/Titan_Blood)

### 3.2 God Mode：不是"简单模式"，是"失败触发的斜坡"

> "God Mode is a difficulty option that **can be toggled at any time from the menu**… God Mode grants **20% damage resistance, increasing by 2% each time a run ends in death** (rather than escape). The damage resistance **caps at 80%**. This mode was added to make the game more accessible, as well as to give players a way to experience the story of Hades more quickly if they wish."
> "This mode may be turned on and off via the options menu **at any point without consequence**… **Using God Mode will not lock players out of Achievements or content.**"
> — [God Mode](https://hades.fandom.com/wiki/God_Mode)

三个结构特征值得抄：
1. **不是开档时选的**——是选项菜单里的开关，局中都能翻。
2. **只随失败增长**——它是"失败触发的斜坡"，不是"玩家自我贬低的声明"，这正是它绕开"选简单模式=承认自己菜"这个心理门槛的方式。
3. **不锁成就、不锁内容**。

Supergiant 官推（[2020-09-25](https://twitter.com/SupergiantGames/status/1309542802196324353)）：

> "With Hades, we wanted to open up the thrilling experience of rogue-like games to more players. Here's a quick look at God Mode, which makes it so those of us who aren't gods ourselves can still get through, and experience the story that unfolds."

[官方 FAQ](https://www.supergiantgames.com/blog/hades-faq/)：

> "one of our foremost design goals on the project was to **open up the thrills of rogue-like games to more players**."

### 3.3 Heat：难度轴，且反向删除元数值

> "In a regular playthrough (save file), **the Pact will only appear after the Final Boss is defeated at least once**."
> — [Pact of Punishment](https://hades.fandom.com/wiki/Pact_of_Punishment)

**最值得记的一条**：Pact 里有一个条件叫 **Routine Inspection**——

> "**Routine Inspection** — Your Talents from the Mirror of Night are deactivated, −3 per rank, (from the bottom up). 4 ranks (−12 Talents). 2 Heat per rank (Total: 8)."
> （逐级停用你在暗影之镜上的天赋，满级停用 12 个）

设计师**专门造了一个把元数值扒回去的拉杆**。这是"POWER 轴长歪了怎么办"的官方答案。

另一个演化信号：1.0 时 Pact 每点 Heat 给 **+2% 黑暗**——即难度**喂养**元数值；2024 Superstar 更新删掉了这条，换成按武器计的 Bounty 阶梯（上限 20 Heat），**把难度和刷黑暗解耦**。
— [Pact of Punishment](https://hades.fandom.com/wiki/Pact_of_Punishment) "Notes"

### 3.4 第一局能通关吗

**结构上没有硬门，但实际上只有把技术从别处带进来的人做得到。** speedrun.com 有专门的 "Fresh File" 分类（新建存档到杀最终 Boss），存在第一次尝试就通关的记录（[17:41 fresh file first run](https://www.youtube.com/watch?v=bcka0RA3UPo)），Supergiant 自己还录过对 25 分钟 fresh file 的反应视频（[链接](https://www.youtube.com/watch?v=VKepf4jyn4o)）。
— [speedrun.com/hades](https://www.speedrun.com/hades)

人群数据（[Steam 全球成就](https://steamcommunity.com/stats/1145360/achievements)）：

| 成就 | 含义 | 比例 |
|---|---|---|
| Escaped Tartarus | 过第一区 | 81.9% |
| Escaped Elysium | 过第三区 | 59.0% |
| **Is There No Escape?** | **首次逃脱成功** | **46.8%** |
| Blood Bound | 任一 Aspect 满级 | 31.8% |

**不到一半的买家逃出去过一次。**

> ⚠️ **辟谣**：网上流传的"Kasavin 说平均约 30 局才首次逃脱"**查无实据**。已检索 Supergiant 博客、gamedeveloper.com、GDC Podcast ep.16、GDC 2021 演讲、Hades FAQ 及 1.0 上线期多家访谈，**没有任何 Supergiant 公布过这个遥测数字**。该说法只在 Steam / Reddit / 攻略站流传。请用 46.8% 这个可引数据。

**真正的官方结构数字**：真结局需要 **10 次成功逃脱**，不是 1 次。
— [Endings](https://hades.wiki.fextralife.com/Endings)

### 3.5 设计师原话

Greg Kasavin，GDC Podcast ep.16（[gdconf.com](https://gdconf.com/article/roguelikes-and-narrative-design-with-hades-creative-director-greg-kasavin-gdc-podcast-ep-16/)｜[Game Developer 镜像](https://www.gamedeveloper.com/design/roguelikes-and-narrative-design-with-i-hades-i-creative-director-greg-kasavin)）：

> "There's nothing more frustrating in games where you're really engaged with the story, but then you just hit a difficulty wall, and you just want to see how the story ends. But you can't… **So we try to build systems into our games that mitigate those kinds of moments**, so that if you are engaged in the narrative, but you haven't been playing games since you were six or whatever, **you can still work your way through and have a good experience**."

> 中文转述：最让人挫败的莫过于你被剧情吸引住了，却撞上难度墙，想看结局却看不到。**所以我们会在游戏里建一些系统去缓和这种时刻**——哪怕你不是六岁就开始打游戏的人，也能一路走完，有个好体验。

同一场，关于"跨局到底带走了什么"：

> "Even in the hardest-core roguelike game where it resets you completely to nothing from one playthrough to another, **there is in fact something that you carry forward, which is your knowledge of the mechanics in the game.**"
> 中文转述：哪怕最硬核的 roguelike 把你清零，**你其实还是带走了一样东西：你对机制的理解。**

Kasavin 论 God Mode（[Inverse 访谈，2021-08-11](https://www.inverse.com/gaming/hades-god-mode-interview)）：

> "**The part where roguelikes can be brutally difficult is, ironically, directly at odds with the part where they're so replayable.**"
> 中文转述：roguelike 之所以耐玩和之所以残酷，**讽刺的是这两点直接互相打架。**

> "**If you could just blow through it, what's interesting about the game goes away**, because dying in this game and looping through it over and over is a really important part of the experience."
> 中文转述：**如果你能一路碾过去，这游戏有意思的地方就没了**——死亡和反复循环本身就是体验的核心。

> "That got us talking, and that's where God Mode emerged. **What if we just make you a little bit tougher?**"

> "**God Mode reinforces our belief that the way to approach difficulty settings may need to be proprietary to the game. It's not a one size fits all solution.**"
> 中文转述：难度设定的做法可能需要**为每个游戏量身定做**，没有万能解。

论"死亡即奖励时刻"（[Game Developer](https://www.gamedeveloper.com/design/how-supergiant-weaves-narrative-rewards-into-i-hades-i-cycle-of-perpetual-death)）：

> "**It was an explicit goal of our early development, to take the pain out of dying and having to restart.**"
> "If the whole game is structured around dying and restarting, then we had to make sure the moment of death isn't about rage-quitting. **You have to be compelled to explore further and feel the time you spent wasn't a waste of your time.**"

论元进程的整体主张（[GameDaily.biz](https://www.gamedaily.biz/escaping-the-underworld-supergiants-greg-kasavin-on-the-development-and-success-of-hades/)）：

> "We wanted to see if we could make the thrills of this style of game available to more players **through our approach to narrative and by having a sense of permanent progression built into the game**."
> "**Every run should count.**"
> "Knowing that dying and restarting would be a big part of this game inherently, we wanted to make that experience as interesting and un-frustrating as possible, through having **a continuous story that mostly unravels from one playthrough to the next, as well as permanent progression systems you can access after you die**."

论"在哪停下"——**这条对我们尤其重要**：

> "**We did want the true ending to serve as a valid, satisfying end point for many players.** While there's a lot of exciting stuff waiting to be discovered past that point, we're mindful that players have limited time, and **we didn't want players to feel pressured to have to keep going just to get to some sense of closure.**"
> 中文转述：我们**希望真结局对多数玩家来说就是一个有效、令人满足的终点**。后面还有精彩内容，但玩家时间有限，**我们不想让人觉得"必须继续玩下去才能有个了结"。**

论内在动机（[Vice](https://www.vice.com/en/article/how-hades-made-a-genre-known-for-being-impossibly-hard-accessible/)）：

> "We wanted players to keep coming back to this game only for **intrinsic** reasons such as wanting to see more of the story pan out or trying new ability combinations."

---

## 4. Dead Cells（Motion Twin / Evil Empire, 2018）

### 4.1 新存档锁了什么

| 轴 | 内容 | 引用 |
|---|---|---|
| CONTENT | 蓝图：约 **298 个**（256 常规 + 42 隐藏）；武器共 125 件，**开局仅 10 件可用（约 8%）** | [Blueprints](https://deadcells.wiki.gg/wiki/Blueprints) [Weapons](https://deadcells.wiki.gg/wiki/Weapons) |
| CONTENT | 符文（Vine / Teleportation / Ram / Spider / Explorer's / Homunculus / Challenger's / Customization），**开启支线生态区** | [Runes](https://deadcells.wiki.gg/wiki/Runes) |
| POWER | 血瓶 I–IV（1→4 次充能）、金币储备 I–V（死亡保留 500→2500 金）、回收管（4 套起始装备）、背包、Advanced Forge | [Runes and upgrades](https://deadcells.wiki.gg/wiki/Runes_and_upgrades) |
| **POWER（关键）** | **传奇熔炉**：永久提高掉落品质下限，三档 500 / 3,000 / 10,000 细胞 | [Legendary Forge](https://deadcells.wiki.gg/wiki/Legendary_Forge) |
| DIFFICULTY | Boss Stem Cell 0–5 | [Boss Stem Cells](https://deadcells.wiki.gg/wiki/Boss_Stem_Cells) |

**Dead Cells 最值得抄的结构：两条轴被强制耦合。**

传奇熔炉的**上限本身被难度锁住**：Normal 只能把 "+" 档买到 100%；Hard(1BSC) 才解锁 "++" 到 100%；Very Hard(2BSC) 解锁 "S" 到 25%；Expert 50%；Nightmare & Hell 100%。
— [Legendary Forge](https://deadcells.wiki.gg/wiki/Legendary_Forge)

反过来，难度也喂养元数值：2BSC 细胞 ×2，4BSC 细胞 ×3。
— [Boss Stem Cells](https://deadcells.wiki.gg/wiki/Boss_Stem_Cells)

**结论：你没法靠在 0BSC 刷细胞买穿游戏——阶梯才是让"买"变得值得的东西。这是 Rogue Legacy 缺的那个防刷阀门。**

BSC 各级同时解锁内容：

| 级 | 名称 | 难度变化 | 解锁的内容/数值 |
|---|---|---|---|
| 1 | Hard | Boss 阶段变化；泉水减半 | 熔炉 ++ 到 100%；回收管蓝图 |
| 2 | Very Hard | 泉水全撤；**细胞 ×2** | 熔炉 S 到 25% |
| 3 | Expert | 全程仅 3 次血瓶；物品等级 +1 | 卷轴碎片；诅咒箱出 S 品质 |
| 4 | Nightmare | 通道内不回血瓶；物品等级 +3；**细胞 ×3** | 熔炉 S 到 100% |
| 5 | Hell | **瘴气（Malaise）激活** | **Astrolab 第七区**；真结局路径 |

### 4.2 第一局能通关吗——能（这一点常被误解）

**符文不挡主线。** wiki 的生态区图显示存在无符文主路：Prisoners' Quarters → Promenade → Ramparts → Black Bridge → Stilt Village → Clock Tower → Throne Room。所有符文解锁的生态区（毒水道、藏骨堂、古代下水道、监狱深处等）**全是可选支线**。
— [Biomes](https://deadcells.wiki.gg/wiki/Biomes)

所以：**Dead Cells 用技术把关基础结局，用元进程（5BSC 阶梯）把关真结局。符文管的是 breadth，不是终点线。**

真结局：

> "The Collector is the true final boss… encountered in the Observatory, **which can only be reached with 5 BSC active**."
> — [The Collector / 5 BSC](https://deadcells.fandom.com/wiki/The_Collector/5_BSC)

Steam 全球成就（[来源](https://steamcommunity.com/stats/588650/achievements)）：

| 成就 | 含义 | 比例 |
|---|---|---|
| The Fat and The Furious | 首个 Boss | 70.7% |
| **The last rampart falls…** | **击败国王之手（基础通关）** | **40.4%** |
| Let's get down to the nitty gritty… | **4 BSC 通关** | **5.36%** |

40.4% → 5.36% 是 **约 7.5 倍的落差**。**长线留存活在难度轴上，不活在内容轴上。**

### 4.3 设计师原话

**关于永久死亡的定位**，Sébastien Bénard（首席设计师），GDC 2019《Dead Cells: What the F*n!?》官方 slides（[PDF](https://media.gdcvault.com/gdc2019/presentations/Benard-Sebastian-DeepCells.pdf)｜[视频](https://www.youtube.com/watch?v=OfSpBoA6TWw)）：

> "Gameplay overview — 3 pillars: **Combat / Progression / Replayability**"
> "**Permadeath was a hot topic! No back-tracking between levels. Each run counts.**"（slide 标题："Modernizing permadeath"）

> ⚠️ 提醒：这场演讲绝大部分讲手感和操作，"Progression" 只有一页 slide。要引 Motion Twin 谈元进程，**补丁说明是更好的一手来源**（见下）。

**Dead Cells 的进程模型上线时是错的，在 EA 期间被推翻重做了两次**——这是最有价值的一手证据：

*Brutal Update（v0.4, 2017-05, [patchnotes/4](https://dead-cells.com/patchnotes/4)）*：
> "**The Collector can no longer upgrade items using Cells.**"
> "**A whole new upgrade mechanic will come back in the next update**, which should come shortly after this one!"
> "**Your level-up decisions are much more important than ever.**"

*Foundry Update（v0.5, 2017-12, [patchnotes/5](https://dead-cells.com/patchnotes/5)）*：
> "The leveling system has been updated and deeply re-balanced. The old secondary bonuses have been moved to the new Mutations mechanics."
> "**The philosophy here is to give the player ways to specialize and experiment.**"
> "**The health bonus gets smaller as you keep investing on a single stat.**"（+50%、+45%、+40%… 换属性则重置回 +50%——**明确反单一堆叠**）
> "mono-tiered builds are glass canons…, 2-tiers builds are balanced, 3-tiers build are resistant but weak."

*Rise of the Giant / Update 12（2019, [patchnotes/12](https://dead-cells.com/patchnotes/12)）——系统性放松元门槛*：
> "**Community suggestion: Custom Mode will be now unlocked after few runs (no need to beat the final boss anymore).**"
> "**You'll now get access to the Cavern level after you beat the game for the first time.**"
> "Community suggestion: Decreased every mob tiers in BC1, BC4 and BC5."

**关于难度哲学**，Bénard（[Game Informer, 2018-12](https://www.gameinformer.com/interview/2018/12/30/dead-cells-designer-discusses-scrapped-ideas-roguelikes-and-the-potential-for)）：

> "**We knew at the beginning we wanted something difficult, but not unfair.**"
> "**You need to know why it was your fault.**"

关于最初的转向（[MCV/DEVELOP "When We Made… Dead Cells"](https://mcvuk.com/development-news/when-we-made-dead-cells/)）：

> "After the first month in Early Access, we had so much interesting feedback… **we decided to change tons of important things, especially how you build your character.**"

---

## 5. Rogue Legacy（Cellar Door Games, 2013）

**五款里 POWER 轴最纯粹、最无遮拦的一个。** 也是唯一一个"第一局基本不可能通关"的。

### 5.1 庄园升级树 = 纯永久数值

**32 个升级项**，全部用金币购买，全部永久（[Upgrades wiki](https://roguelegacy.wiki.gg/wiki/Upgrades)）：

| 类别 | 项目 |
|---|---|
| 生存 | Health Up（+10 HP/级，75 级）、Armor Up（+4/级，50 级）、Death Defy（+1.5% 免死/级）、Invuln Time Up |
| 攻击 | Attack Up（+2 STR/级，75 级）、Magic Damage Up（75 级）、Crit Chance/Damage Up、Down Strike Up |
| 资源 | Mana Up（75 级）、**Equip Up（+10 装备负重/级，50 级）**、Gold Gain Up、Potion Up、Mana Cost Down、**Haggle（Charon 过路费 −10%/级）** |
| 职业/商人 | Smithy（铁匠）、Enchantress（符文）、Architect（锁城）、以及九条职业解锁/升级线 |

升级之间**互相涨价**：

> "every time you buy/level up an upgrade the level displayed above the HP bar increases by 1, **the cost of every other Manor upgrade increases by 10 gold**"

wiki 的经济学注记：**"each upgrade will require ten times its cost to break even."**（每个升级要赚回十倍成本才回本）

### 5.2 Charon：强制花钱阀门

> Charon "will demand **all your gold** for passage each time you attempt to enter the castle, and will continue to stand there until you do."
> — [Charon](https://roguelegacy.wiki.gg/wiki/Charon)

Haggle 最多减 50%，永远无法归零。**金币不能存 → 只能全砸进永久升级。**

### 5.3 NG+：难度轴，但它喂养同一棵树

> "New Game Plus (NG+) is a feature allowing repeat playthroughs of the game **while retaining all upgrades**."
> "On NG+1 most enemies will be tier 2, on NG+2 and higher most enemies will be tier 3."
> "**There's no cap on how high NG+ can go**… +50% gold gain per every completed cycle"
> — [New Game Plus](https://roguelegacy.wiki.gg/wiki/New_Game_Plus)

**对比 Dead Cells**：BSC 上限 5 且**门控内容**；Rogue Legacy 的 NG+ 无上限、**不门控任何东西，只是把经济放大 +50%/圈，继续喂同一棵永久数值树**。这是本研究里最清晰的"元进程膨胀"反面样本。

### 5.4 第一局能通关吗——基本不能

游戏架构上，角色成长**只发生在局外**：

> "**We resolved this by removing all forms of character development during a run inside the castle.**" — Teddy Lee, GDC 2014

Steam 全球成就（[来源](https://steamcommunity.com/stats/241600/achievements)）：

| 成就 | 含义 | 比例 |
|---|---|---|
| Paterphobia | 击败最终 Boss | 22.6% |
| Geminiphobia | 通关两次（NG+1） | 11.6% |
| **Thanatophobia** | **不用 Architect，死亡 ≤15 次通关** | **1.2%** |

**Thanatophobia 1.2%** 是最干净的可引数据：不到 2% 的玩家能在 16 条命内通关。**中位通关是几十局起步。**

### 5.5 设计师原话（GDC 2014 全文转录）

一手来源：[archive.org GDC2014-Lee 全文转录（含讲者备注）](https://archive.org/download/GDC2014Lee/GDC2014-Lee_djvu.txt)｜[视频](https://www.youtube.com/watch?v=apfNODay1_s)

**为什么要有永久性——并且他们知道自己在做什么交易**：

> "The first thing we wanted to fix was the harsh punishment of death. But for us it wasn't about making death less painful, but actually **making it fun**. So we decided to add permanency to the game through the manor skill tree and equipment system. That way you never had to start from scratch. **It was a contentious decision, because we knew we were diluting the spirit of roguelikes.**"

> 中文转述：我们想修的第一件事是死亡的严酷惩罚。但对我们来说重点不是让死亡不那么疼，而是**让死亡变得好玩**。所以我们用庄园技能树和装备系统加了永久性，你永远不用从零开始。**这是个有争议的决定，因为我们知道自己在稀释 roguelike 的精神。**

> "Rogue Legacy is **a casual man's roguelike**. Even though many people still find it very difficult, it is far more accessible because we added permanency."

**最可迁移的一条结构性洞见——RPG 机制放在局外**：

> "It looks like a fairly standard loop, **except the RPG mechanics happen after death and before you explore the castle; instead of during play like most games.** It seems like a minor change, however, almost all of the previous design choices we spoke of were built to support it. **By putting the RPG mechanics after dying, you had something to look forward to, making death fun.** And because no character development happened during gameplay, we could lessen downtime… **And best of all, it gave that 'one more time' feel.**"

> 中文转述：这看起来是个标准循环，**只有一点不同：RPG 机制发生在死亡之后、进城堡之前，而不是像大多数游戏那样发生在游玩过程中。**看起来是小改动，但我们前面讲的几乎所有设计选择都是为了支撑它。**把 RPG 机制放在死亡之后，你就有了可期待的东西，死亡因此变得好玩。**而且因为局内没有角色成长，我们能压缩停顿时间……**最棒的是，它给出了那种"再来一局"的感觉。**

**削减随机、提高技术占比**：

> "We also wanted the game to have **more skill and less chance**. A lot of roguelikes put emphasis on the roll of the dice. It often plays a bigger role in the player's success than their skill so we removed as much of it as we could. Rogue Legacy has no critical misses, no instant death events…"

**Charon 引发的退化 build 问题——本研究最实用的一段警告**：

> "The original skill tree economy was fairly straightforward. Every time you spent money to upgrade a skill, that particular skill's price would raise. It seems simple, but there's a hidden problem."
> "**Since there was no way to save money in the game, because Charon takes it at the beginning of every run, optimal skill builds always meant putting an equal number of points into each skill.** So 10 points in health, then 10 points in damage, and so on. **In other words, no skill diversity.**"
> "In the end we decided to use a universal modifier. Every time you upgraded a skill, **the cost of all other skills would go up by a very small amount**… What this did was it deterred players from evenly leveling up their character…"

> 中文转述：**因为 Charon 在每局开始时拿走所有钱，游戏里没法存钱，所以最优加点永远是每项平均加。**10 点血，10 点伤害，以此类推——**换句话说，毫无 build 多样性。**最后我们用了一个全局涨价修正：升任一项，其他所有项都微涨一点。

**而且他们自评这个补丁很烂**：

> "Even though this solution worked, **it was terrible for a lot of reasons.**" Cons: "**Bad feel. More punishing towards casual players. Fix is apparent, but the problem is not.**" Pros: "Cost $0. < 10 minutes to add. Minimal balance required."
> "This example sort of encompasses our design mantra of '**good, but not perfect**.'"

**关于刷（grinding）的事后承认**（[Siliconera Rogue Legacy 2 访谈](https://www.siliconera.com/rogue-legacy-2-interview/)）：

> Teddy Lee: "**The whole point of Rogue Legacy was you didn't have to grind, right? That was the original intent, but a lot of people felt like grinding was mandatory, a lot of people wanted to grind.**"
> 中文转述：**Rogue Legacy 的初衷就是你不必刷。这是原始意图，但很多人觉得刷是强制的，也有很多人就是想刷。**

同一访谈里，Teddy Lee 自己给出了本研究最好的对比框架：

> "**Rogue Legacy also has so much permanent progression, compared to Dead Cells' more lateral progression.**"
> 中文转述：**Rogue Legacy 有非常多的永久成长，相比之下 Dead Cells 更偏横向成长。**

Rogue Legacy 2 的解法——**给劣势付钱**：

> Teddy Lee: "it makes a character who dies in one hit. You have 1 HP no matter what you do. But we added a thing called the **Universal Health Care System. You get bonuses based on how detrimental your trait is.**"
> 中文转述：有个特质让角色一击必死，永远 1 血。但我们加了"全民医保系统"：**你的特质越不利，得到的加成越多。**

---

## 6. 对比总表：第 1 局天花板 vs 第 50 局天花板

| 游戏 | 第 1 局能做到的上限 | 第 50 局能做到的上限 | 差距的本质 | 首胜人群比例 |
|---|---|---|---|---|
| **Slay the Spire** | **能通关 Act 1–3**（默认池只少 9 张卡）。够不到 Act 4 | 全 4 角色 + 60 件解锁物 + A20；Act 4 | **纯内容广度 + 自选难度**。单局强度上限完全相同 | 66.5% 通关过 |
| **Balatro** | **能通关 Ante 8 White Stake**（105/150 Joker、全部消耗牌可用） | 150 Joker、15 牌组、Gold Stake | **纯内容广度 + 自选难度**。**零永久数值** | 71.7% 赢过 |
| **Hades** | 结构上可通关，实际需外部带入的技术。0 额外命、50 血、1 把武器 | +50 血、+3 命、+40% 稀有恩赐、6 武器 × 4 Aspect | **约 5 倍有效生命的真实数值差** | 46.8% 逃脱过 |
| **Dead Cells** | **基础结局可达**（无符文主路存在）。10/125 武器、无血瓶、掉落品质最低档 | ~298 蓝图、4 次血瓶、S 品质掉落、5BSC 真结局 | **内容广度为主 + 中等数值 + 真结局锁在难度阶梯后** | 40.4% 基础通关 / 5.36% 4BSC |
| **Rogue Legacy** | **基本不可能通关**。基础属性 + 无职业 + 无铁匠/符文商人 | +750 HP、+150 STR、9 职业、全装备符文、无上限 NG+ | **纯粹的永久数值门槛** | 22.6% 通关 / 1.2% ≤15 死 |

**读法**：上半两款（StS / Balatro）的第 1 局和第 50 局在**单局强度上限**上是**完全相同**的——变的只是"能遇到什么"和"你自己选多难"。下半 Rogue Legacy 是另一极：第 1 局的角色跟第 50 局的角色不是一个量级的生物。Hades 和 Dead Cells 在中间，且各自带了对冲装置（God Mode + Routine Inspection / 熔炉上限被难度锁住）。

---

## 7. 每日挑战与种子局的公平性处理

| 游戏 | 是否有每日 | 是否中和解锁 | 机制细节 |
|---|---|---|---|
| **Slay the Spire** | 有（Daily Climb） | **完全中和** | 见下 |
| **Balatro** | **没有**（2024-03 宣布过，至今未上线） | 种子局/挑战局**只读元存档** | 见下 |
| **Hades** | 没有 | — | 无竞速榜设计 |
| **Dead Cells** | 有（Daily Challenge） | **部分中和**（有坑） | 见下 |
| **Rogue Legacy** | 没有 | — | — |

### Slay the Spire —— 教科书式的完全中和

游戏源码里一行明确开关：

```java
public static boolean treatEverythingAsUnlocked() { return (isDailyRun || isTrial); }
```
— [Settings.java](https://github.com/Voyage-for-the-ideal/aiplayspire/blob/master/cardcrawl/core/Settings.java)

所有卡池构建函数都检查它（`addRedCards` / `addGreenCards` / `addBlueCards` / `getAnyColorCard`）：
— [CardLibrary.java](https://github.com/Voyage-for-the-ideal/aiplayspire/blob/master/cardcrawl/helpers/CardLibrary.java)

社区侧的同一事实表述：

> "**When you play a daily nothing is locked because it would imbalance the score.**"
> — [Steam 讨论区](https://steamcommunity.com/app/646570/discussions/0/1733207382031436549)

反向也做了：Daily 被排除在标准局统计之外——`isStandardRun() { return (!isDailyRun && !isTrial && !seedSet); }`。而且解锁相关的事件在 Daily 里被禁用：

> "Playing the Daily Climb also disables this event."
> — [A Note For Yourself](https://slaythespire.wiki.gg/wiki/A_Note_For_Yourself)

**这是"竞技模式把整个元进程关掉"的干净范例。**

### Balatro —— 种子局/挑战局是只读沙盒

> "When playing a seeded run, **achievements and unlocks cannot be obtained**, as most would be trivialized by choosing a favorable seed. Statistics such as number of times a consumable has been used and high scores like Best Hand/Highest Ante do still get updated."
> — [Seed](https://balatrowiki.org/w/Seed)

> "When playing Challenge Decks, **achievements and unlocks cannot be obtained**… **Collectibles are not discovered when using the Challenge Decks and will not count towards progress.**"
> — [Challenge Decks](https://balatrowiki.org/w/Challenge_Decks)、[Collection](https://balatrowiki.org/w/Collection)

方向与 StS **相反**：StS 的 Daily 是"把元进程调到满"，Balatro 的种子局是"**读元进程，但不写回**"。种子局用的是**你自己账号已解锁的池子**，不是全池（否则种子分享就能白嫖解锁）——见 [Unlockables](https://balatrowiki.org/w/Unlockables)（解锁后才 "discoverable in an **unseeded** game"）及 [Steam 讨论](https://steamcommunity.com/app/2379780/discussions/0/4364626348106188287/)。

**每日挑战确认不存在**：Steam 商店页只列 "8 difficulties, as well as challenge and seeded runs"（[商店页](https://store.steampowered.com/app/2379780/Balatro/)）。2024-03 LocalThunk 曾宣布 Daily Challenge "100% assured"（[GoNintendo](https://www.gonintendo.com/contents/33117-balatro-to-get-a-daily-challenge-mode)），**到 2026-08 仍未上线**。

### Dead Cells —— 有坑，值得引以为戒

同种子对所有人：

> "The Daily Challenge is refreshed each day at midnight, UTC+1."
> "At the end of the run, regardless of whether or not you beat the boss, your final score will be put on the leaderboards. **If Assist Mode is enabled, your final score will not be put on the leaderboards.**"
> — [Daily Challenge](https://deadcells.wiki.gg/wiki/Daily_Challenge)

**但它没有完全中和存档差异**：

> "**Using a save slot that has completed the game on the hardest difficulty will change the type of gear found throughout the map.**"
> （用一个已在最高难度通关的存档进每日，地图里掉的装备类型会变）
> — [Daily Challenge](https://deadcells.wiki.gg/wiki/Daily_Challenge)

而且每日**会写回元存档**（累计完成 1/5/10 次分别给 Swift Sword / Lacerating Aura / Meat Skewer 蓝图）。**同种子 + 存档影响掉落 + 有解锁奖励 = 榜单不完全可比。** 这是三种做法里最不干净的一种。

---

## 8. 提炼出的设计原则（8 条，每条附证据）

### 原则 1｜**默认不做 POWER 轴。做 CONTENT + DIFFICULTY 就够了**

StS 和 Balatro 是本世代最成功的两款 roguelite，两者跨局携带的东西里**没有任何一项是数值**。Balatro 甚至提供一键全解锁按钮——这个按钮的存在本身就证明它的解锁纯粹是内容多样性。
— [Balatro Profile](https://balatrowiki.org/w/Profile)、[StS Ascension](https://slaythespire.wiki.gg/wiki/Ascension)

对应到「绿茵轮回」：现有的 **9 个祝福（blessings）就是 POWER 轴**（`golden_boy` 开局 +3 OVR、`oracle`、`talisman`、`ironman` 等）。这是全书里最需要警惕的部分。**7 级飞升是 DIFFICULTY 轴，方向完全正确。**

### 原则 2｜**难度轴反哺解锁速度，用它替代"变强"**

StS：`+5% score per Ascension level`——**打得越难，解卡越快**。Dead Cells：2BSC 细胞 ×2，4BSC ×3，且传奇熔炉上限只有爬难度才能解锁。**"变强"的欲望被重定向到"打更难"上。**
— [StS Score](https://slaythespire.wiki.gg/wiki/Score)、[Legendary Forge](https://deadcells.wiki.gg/wiki/Legendary_Forge)

### 原则 3｜**解锁增加的是"奇怪"，不是"更强"**

StS 三级解锁给 Ironclad 的是 Wild Strike（往牌库塞伤口）；Silent 四级给 Pandora's Box。**解锁扩的是策略宽度，不是功率。** 这样新老存档的单局强度上限相同，只是老存档见过更多花样。
— [Ironclad](https://slaythespire.wiki.gg/wiki/Ironclad)、[Silent](https://slaythespire.wiki.gg/wiki/Silent)

### 原则 4｜**解锁的正当理由是"课程表"和"清单"，不是"留存"**

LocalThunk 明确点名并否认了留存动机：

> "**certainly can be looked at as a way to artificially inflate playtime, but those things were added for 2 other reasons**… To force players to get out of their comfort zone… To give the players that already enjoy the game loop a sort of checklist."
> — [Solitaire](https://localthunk.com/blog/solitaire)

**判据**：每一条解锁条件，问自己"它教会了玩家什么？"。教不出东西的解锁条件（纯累计计数），是拉时长。

### 原则 5｜**RPG 成长放在局外、死亡之后——这是"再来一局"的来源**

Teddy Lee，GDC 2014：

> "**By putting the RPG mechanics after dying, you had something to look forward to, making death fun.** … **And best of all, it gave that 'one more time' feel.**"

Kasavin 表述的是同一件事：

> "**It was an explicit goal of our early development, to take the pain out of dying and having to restart.**"

注意这条**独立于 POWER/CONTENT 之争**：把死亡后那一刻做成奖励时刻，不必然要给数值——StS 给的是解锁进度条，Hades 给的是新对话。
— [GDC 2014 转录](https://archive.org/download/GDC2014Lee/GDC2014-Lee_djvu.txt)、[Game Developer](https://www.gamedeveloper.com/design/how-supergiant-weaves-narrative-rewards-into-i-hades-i-cycle-of-perpetual-death)

### 原则 6｜**难度选择要让玩家"自然停在合适的一级"，且必须能反向拆掉元数值**

Giovannetti：

> "**players will naturally gravitate to the Ascension level that makes sense for them.**"

如果你做了 POWER 轴，就必须同时做**拆除杆**。Hades 的 Routine Inspection 直接停用暗影之镜天赋（每级 −3，满 −12），Heat 2 点/级。**这是"元数值长歪了"的官方补丁形态。**
— [GDC 2019 视频](https://www.youtube.com/watch?v=7rqfbvnO_H0)、[Pact of Punishment](https://hades.fandom.com/wiki/Pact_of_Punishment)

### 原则 7｜**简单模式要做成"失败触发的斜坡"，不是"开局的自我贬低"**

God Mode 的三个结构特征：随时可开关、只随失败增长（20% → +2%/死 → 80% 封顶）、不锁成就不锁内容。它绕开了"选简单模式=承认自己菜"的心理门槛。

> "**What if we just make you a little bit tougher?**"
> "**God Mode reinforces our belief that the way to approach difficulty settings may need to be proprietary to the game. It's not a one size fits all solution.**"
— [God Mode](https://hades.fandom.com/wiki/God_Mode)、[Inverse](https://www.inverse.com/gaming/hades-god-mode-interview)

### 原则 8｜**"无法储蓄的货币"会直接产生退化 build，必须配防御措施**

Rogue Legacy 的 Charon 拿走所有金币，结果是：

> "**optimal skill builds always meant putting an equal number of points into each skill… In other words, no skill diversity.**"

他们的补丁（全局涨价）自评："**Bad feel. More punishing towards casual players. Fix is apparent, but the problem is not.**"

Dead Cells 用了更好的解法：**投单一属性时血量收益递减**（+50%、+45%、+40%…，换属性重置），明确惩罚单堆。
— [GDC 2014 转录](https://archive.org/download/GDC2014Lee/GDC2014-Lee_djvu.txt)、[Foundry Update](https://dead-cells.com/patchnotes/5)

### 附加原则｜**竞技/分享模式必须明确选一种元进程语义**

三种可选语义，各有先例：

| 语义 | 先例 | 做法 |
|---|---|---|
| **全开**（最公平） | StS Daily Climb | `treatEverythingAsUnlocked()`，全池，且不计入标准局统计 |
| **只读**（次公平，防白嫖） | Balatro 种子局/挑战局 | 用你已解锁的池子，但不给成就/解锁/发现 |
| **半开**（**别学**） | Dead Cells Daily | 同种子但存档影响掉落，且给蓝图奖励 → 榜单不可比 |

**对「绿茵轮回」的直接含义**：本项目的种子分享（同 seed + 同选择 = 同生涯）是核心卖点。**但祝福（9 个）和飞升（7 级）会破坏这个等式**——同一个 seed 在买了 `golden_boy`（开局 53 而非 50 OVR）的存档上跑出的是另一条生涯。分享种子前必须决定：分享的字符串是否要编码祝福/飞升状态，或者分享模式是否强制中和。

---

## 9. 数据速查表

| 游戏 | 首次通关人群比例 | 最高难度通关比例 | 落差 |
|---|---|---|---|
| Balatro | 71.7%（赢一局） | 12.1%（Gold Stake） | 5.9× |
| Slay the Spire | 66.5%（Ascend 0） | 7.3%（A20） | 9.1× |
| Hades | 46.8%（首次逃脱） | — | — |
| Dead Cells | 40.4%（国王之手） | 5.36%（4BSC） | 7.5× |
| Rogue Legacy | 22.6%（最终 Boss） | 1.2%（≤15 死无 Architect） | 18.8× |

**注意排序**：POWER 轴越重的游戏，首次通关比例越低（Balatro 71.7% → Rogue Legacy 22.6%）。而"最高难度 / 首次通关"的落差在 5–9 倍区间的三款（Balatro / StS / Dead Cells），都是把长线留存放在难度轴上的。

---

## 10. 已知的证据缺口（勿引用的传言）

1. **"Kasavin 说平均 30 局才首次逃脱 Hades"——查无实据。** 已检索 Supergiant 博客、gamedeveloper.com、GDC Podcast ep.16、GDC 2021 演讲、官方 FAQ、多家 1.0 上线访谈，均无此遥测数据。仅在社区论坛和攻略站流传。**请用 Steam 46.8% 代替。**
2. **Giovannetti/Yano 从未正面辩护过解锁系统的存在意义。** 找不到任何一手引用。有据可查的只有他们**主动删减解锁**的补丁说明。
3. **Motion Twin 没有说过"我们删掉了 RPG 数值刷"这样的原话。** 最接近的一手证据是 Brutal Update 的 "The Collector can no longer upgrade items using Cells" 和 Bénard 的 "especially how you build your character"。别把更强的措辞归给他们。
4. **AIAS Game Maker's Notebook 的 LocalThunk 那期（2h16m）没有公开转录稿。** 设计相关段落在 56:33 / 1:32:01 / 2:05:51，需要人工听。
5. **Hades wiki 的数字是 2024 Superstar 更新后的。** 若要引 2020 原版，Pact 的数字不同（上限 200 Heat、无 Bounty、奖励门槛 15/60/120）。

---

## 主要来源索引

**Slay the Spire**：[Ascension](https://slaythespire.wiki.gg/wiki/Ascension) · [Score](https://slaythespire.wiki.gg/wiki/Score) · [Ironclad](https://slaythespire.wiki.gg/wiki/Ironclad) · [The Ending](https://slaythespire.wiki.gg/wiki/The_Ending) · [StS2 Timeline](https://slaythespire.wiki.gg/wiki/Slay_the_Spire_2:Timeline) · [GDC 2019 视频](https://www.youtube.com/watch?v=7rqfbvnO_H0) · [GDC 2019 slides](https://media.gdcvault.com/gdc2019/presentations/Giovannetti_Anthony_SlayTheSpire.pdf) · [Settings.java](https://github.com/Voyage-for-the-ideal/aiplayspire/blob/master/cardcrawl/core/Settings.java) · [Steam 成就 API](https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=646570)

**Balatro**：[Solitaire 博客](https://localthunk.com/blog/solitaire) · [Balatro Timeline](https://localthunk.com/blog/balatro-timeline-3aarh) · [Jokers](https://balatrowiki.org/w/Jokers) · [Unlockables](https://balatrowiki.org/w/Unlockables) · [Stakes](https://balatrowiki.org/w/Stakes) · [Profile](https://balatrowiki.org/w/Profile) · [Seed](https://balatrowiki.org/w/Seed) · [Challenge Decks](https://balatrowiki.org/w/Challenge_Decks) · [TouchArcade 访谈](https://toucharcade.com/2024/03/18/balatro-interview-mobile-port-localthunk-dlc-plans-updates-new-jokers-demo-feedback/) · [Steam 成就](https://steamcommunity.com/stats/2379780/achievements)

**Hades**：[Mirror of Night](https://hades.fandom.com/wiki/Mirror_of_Night) · [God Mode](https://hades.fandom.com/wiki/God_Mode) · [Pact of Punishment](https://hades.fandom.com/wiki/Pact_of_Punishment) · [Infernal Arms](https://hades.fandom.com/wiki/Infernal_Arms) · [Titan Blood](https://hades.fandom.com/wiki/Titan_Blood) · [GDC Podcast ep.16](https://gdconf.com/article/roguelikes-and-narrative-design-with-hades-creative-director-greg-kasavin-gdc-podcast-ep-16/) · [Inverse God Mode 访谈](https://www.inverse.com/gaming/hades-god-mode-interview) · [GameDaily.biz 访谈](https://www.gamedaily.biz/escaping-the-underworld-supergiants-greg-kasavin-on-the-development-and-success-of-hades/) · [Game Developer](https://www.gamedeveloper.com/design/how-supergiant-weaves-narrative-rewards-into-i-hades-i-cycle-of-perpetual-death) · [官方 FAQ](https://www.supergiantgames.com/blog/hades-faq/) · [Steam 成就](https://steamcommunity.com/stats/1145360/achievements)

**Dead Cells**：[Boss Stem Cells](https://deadcells.wiki.gg/wiki/Boss_Stem_Cells) · [Legendary Forge](https://deadcells.wiki.gg/wiki/Legendary_Forge) · [Runes and upgrades](https://deadcells.wiki.gg/wiki/Runes_and_upgrades) · [Biomes](https://deadcells.wiki.gg/wiki/Biomes) · [Daily Challenge](https://deadcells.wiki.gg/wiki/Daily_Challenge) · [Brutal Update patchnotes](https://dead-cells.com/patchnotes/4) · [Foundry Update patchnotes](https://dead-cells.com/patchnotes/5) · [Rise of the Giant patchnotes](https://dead-cells.com/patchnotes/12) · [GDC 2019 slides](https://media.gdcvault.com/gdc2019/presentations/Benard-Sebastian-DeepCells.pdf) · [Game Informer 访谈](https://www.gameinformer.com/interview/2018/12/30/dead-cells-designer-discusses-scrapped-ideas-roguelikes-and-the-potential-for) · [Steam 成就](https://steamcommunity.com/stats/588650/achievements)

**Rogue Legacy**：[GDC 2014 全文转录](https://archive.org/download/GDC2014Lee/GDC2014-Lee_djvu.txt) · [GDC 2014 视频](https://www.youtube.com/watch?v=apfNODay1_s) · [Upgrades](https://roguelegacy.wiki.gg/wiki/Upgrades) · [Charon](https://roguelegacy.wiki.gg/wiki/Charon) · [New Game Plus](https://roguelegacy.wiki.gg/wiki/New_Game_Plus) · [Siliconera RL2 访谈](https://www.siliconera.com/rogue-legacy-2-interview/) · [Steam 成就](https://steamcommunity.com/stats/241600/achievements)
