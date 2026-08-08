# 游戏文案的定义与边界 — 研究笔记

> 研究问题：事件文案 / 结果反馈文案该写什么、不该写什么；文案里能不能直接写玩家角色的心理活动；
> diegetic / non-diegetic 文本的区分与第二人称规范；同类游戏（FM / KODP / Reigns / CK）的实际做法。
> 方法：优先追一手来源（厂商公开写作规范、GDC 讲座页、从业者署名文章、专著原文引用）。
> 二手转述一律标注。查不到一手来源的，本文明确写"未能溯源"，不替它编。
> 日期：2026-08-08

---

## 0. 结论摘要（先给可执行的）

1. **"文案"与"叙事描写"不是两个东西，是同一段文字的两个职责，按"槽位"分配。**
   业界最完整的公开成文标准是 Failbetter Games（《Fallen London》）的写作规范：它把文本切成
   **root（情境）/ branch（选项）/ result（结果）** 三个槽位，各自有硬性字数上限和各自的职责——
   result 的职责是"描述一个动作及其结果"，不是写一段散文。
   本项目的 `outcome` 字段就是 result 槽位。

2. **核心争议的主流答案是明确的：不要直接写玩家角色的情绪。**
   Failbetter 的原话是行业里被引用最多的一句：
   > "Be wary of putting words in the player's mouth, thoughts in their head, or feelings in their heart.
   > Focus on the character's senses and what is observable to them. **Don't tell them they're scared; scare them.**"

   这不是"show don't tell"的文学口号，而是一条**代理权（agency）**规则：玩家刚刚做了选择，
   叙述立刻替他规定感受，等于把他的作者身份收回去。

3. **但"不写内心"不是绝对禁令，是有条件的。** 反方立场（Emily Short、Choice of Games 社区）成立于两个条件：
   (a) 主角是**被作者定义的角色**而非玩家化身时，写内心是刻画，不是僭越；
   (b) 情绪被**外化给一个可辨认的说话人**（顾问、教练、媒体、内心的"声音"作为具名角色）时，
   玩家可以不同意它，代理权就保住了。King of Dragon Pass 的"氏族顾问"和 Disco Elysium 的"技能说话"都是这个解法。

4. **第二人称"你"在游戏文本里是默认选择，但"你"指的是角色的处境，不是玩家的内心。**
   安全区是：**你做了什么 / 你看到听到什么 / 别人对你说了什么 / 世界怎么变了**。
   危险区是：**你感到 / 你觉得 / 你想起 / 你心里知道 / 也许你会后悔**。
   前者是玩家能验证的事实，后者是叙述者替玩家写好的心理台词。

5. **必须先分层，再谈标准：功能性 UI 文案与事件叙事文案适用两套不同规则，混用是本项目当前最普遍的错误。**
   前者（菜单、祝福/飞升说明、成就描述、数值说明）是 **non-diegetic**，按 UX writing 标准写：
   术语固定、可扫读、**禁止开发术语泄漏、禁止中英混杂、禁止心理描写、禁止把 TODO 写进玩家可见文本**。
   后者（事件情境/选项/结果）是 **diegetic**，按叙事标准写。
   实测已发现的功能文案事故：`"成长 delta 取值偏向区间下限"`、`"转会 offer 档位 −1"`、
   `"整生涯 0 伤病完成（暂以 ≥20 赛季近似）"`、`"伤病 OVR 扣减减半（向下取整）"`。详见 §3.4。

6. **对本项目最要紧的一条（有实测数据）：`src/engine/events.ts` 里 795 条 outcome 文案中，
   426 条（54%）含"也许"，108 条含"你知道"，69 条"你想起"，62 条"你不知道"。**
   "也许…也许…"这个句式是把**结果的意义**替玩家总结了一遍——而这款游戏的卖点恰恰是
   "赔率明牌、玩家自己承担后果"。这个句式正在稀释它。中位数 112 字、p90 150 字的长度也偏长，
   而转会类 outcome 却只有"你留在 X。"——**同一个字段里并存两种互不兼容的语域**，这是首要问题。

---

## 1. 议题一：事件文案 / 结果文案该写什么，"文案"与"叙事描写"的边界在哪

### 1.1 唯一一份公开成文的厂商级标准：Failbetter Games

Failbetter 把《Fallen London》的内部写作规范公开发表为三篇博客，是这个领域少有的
"一线厂商公开写作规范"。第三篇《Writing for Fallen London》是纯写作规则。

**槽位与硬性字数上限**（[Failbetter Games, *Fallen London Writer Guidelines: Part III*](https://www.failbettergames.com/news/fallen-london-writer-guidelines-part-iii)）：

> "Root descriptions should not go longer than 30 words.
> Branch descriptions should not go longer than 20 words.
> Result descriptions should not go longer than 100 words"

**各槽位的职责定义**（同上，原文）：

> "A branch should almost always be a clear in-character action."
>
> "A result should describe one action (or a couple of closely-related ones) and their results."

规范里还明确：如果一个 result 需要串起好几个不相关的动作，那是设计问题，
应该**拆成多个 branch 或简化**，而不是把它写成一段长叙事。

> 这就是"文案 vs 叙事描写"边界的可操作定义：
> **边界不由文体划定，由槽位划定。** result 槽位允许有文学性，但它的信息负载被限定为
> "一个动作 + 它的后果"。超出这个负载的抒情、回溯、预言、总结，都是溢出。

其余可直接照搬的规则（同一篇）：

> "Direct speech must pass the say-this-shit test, and is better than reported speech."
>
> （维多利亚风格）"A little goes a long way. Treat it as seasoning, not an ingredient."

以及一条与本项目高度相关的"不可假设"规则：不能假设玩家角色的性别、着装、肤色，
遇到就绕开写（原文举例：写 "sleeves" 或 "hems" 是安全的）。

> Part I 和 Part II 我也核过，它们分别讲**流程**（pitch → 开发 → 上线）和**设计**
> （quality parsimony、sporadic play 提醒、linked events 的坑），**不含写作规则**。
> 网上二手文章常把三篇混为一谈，实际只有 Part III 是写作规范。
> 来源：[Part I](https://www.failbettergames.com/news/fallen-london-writer-guidelines-part-i)、
> [Part II](https://www.failbettergames.com/news/fallen-london-writer-guidelines-part-ii)

### 1.2 结果文案的本质是"反馈"，不是"章节"

David Kuelz（《Narrative Design Tips I Wish I'd Known》, Gamasutra / Game Developer, 2016）
把写作直接放进反馈循环里定义：

> **Tip #3: Writing Is A Form Of Feedback** —— 文字最有效的位置是在玩家行动**之后**，
> 作为对行动的回应，而不是打断行动。

他同时给了另一条对系统化叙事游戏很关键的：

> "Video games are the only storytelling medium in which the writer doesn't directly control what happens next."

—— 所以应该设计**有反应的环境/系统**，而不是固定的情节序列。
来源：[Game Developer](https://www.gamedeveloper.com/design/narrative-design-tips-i-wish-i-d-known)

### 1.3 专著：Skolnick 的信息传递优先级

Evan Skolnick 在《Video Game Storytelling: What Every Developer Needs to Know about Narrative Techniques》
中给出的排序（p.57，经 *Journal of Games Criticism* 书评逐字引用）：

> "video game makers first try to find a way to let the player **do** it;
> their second choice is to **show** it; and their last resort is to **tell** it" (p. 57)

即 **do > show > tell**。文字是最后手段。
对本项目的直接含义：**能用数值变化、赔率、奖杯柜、球衣颜色表达的，不要用 outcome 文字重述一遍。**

来源：[Journal of Games Criticism 书评（含 p.57 逐字引用）](https://gamescriticism.org/2023/07/24/tutored-together-around-more-than-dialogue-a-review-of-evan-skolnicks-video-game-storytelling-what-every-developer-needs-to-know-about-narrative-techniques/)；
另见 [Emily Short 对该书的评论](https://emshort.blog/2017/07/04/video-game-storytelling-evan-skolnick/)
（她引 Skolnick 的对白标准："Any line of dialogue that survives the editing process should convey at least one of
the previously listed forms of exposition [plot, character, emotion, gameplay] — ideally, two or more"，
并批评他劝非专业者别碰对白写作的态度）。

> ⚠️ 溯源说明：网上流传的 Skolnick "do, then show, then tell" 版本多为二手转述且措辞不一，
> 上面这条是我能找到的、带页码的逐字引用。

### 1.4 留白本身是技术手段（GDC）

Sam Barlow，GDC 2016《Making 'Her Story' — Telling a Story Using The Player's Imagination》，
讲座页的核心句：

> "A player's brain is still the world's most powerful game engine."

讲座主旨即：**为玩家的想象力写作，而不是把一切说尽**。
来源：[GDC Vault](https://www.gdcvault.com/play/1023430/Making-Her-Story-Telling-a)

Susan O'Connor 在 GDC Masterclass 的问答（GDC 官网发布）里给出同向的方法论：
反馈不必是台词——

> "may involve zero dialogue, if it turns out that's not what the player wants to hear!
> If the goal is to 'make something interesting happen,' that could mean a lot of things.
> Could be animations, could be a musical stinger, could be a thought bubble with images
> from the character's last dream..."

来源：[GDC 官网](https://gdconf.com/news/heres-short-lesson-susan-oconnors-gdc-masterclass)

---

## 2. 议题二（核心争议）：能不能直接写玩家角色的心理活动？

### 2.1 反对方（主流、且是唯一有厂商成文规范背书的一方）

**Failbetter 的规则原文**（[Part III](https://www.failbettergames.com/news/fallen-london-writer-guidelines-part-iii)）：

> "Be wary of putting words in the player's mouth, thoughts in their head, or feelings in their heart.
> Focus on the character's senses and what is observable to them.
> **Don't tell them they're scared; scare them.**"

三个禁区是并列的，且顺序有意义：**嘴里的话 → 脑子里的想法 → 心里的感受**。
替代方案被同一句话给出了：**写角色的感官，写可被观察到的东西**。

**IF 社区的经典反对论证**（Emily Short 主持的 ifMUD 讨论实录，2014-03-01）：
参与者 Roger 的表述被反复引用——

> "'OMG you are so scared right now' which seems very problematic to me."

问题不在于"表现主角的体验"，而在于**强行让玩家认同一种他并未产生的情绪**。
来源：[Emily Short, *Transcript of March 1, 2014 ifMUD Discussion on Interiority*](https://emshort.blog/how-to-play/if-discussion-club/transcript-of-march-1-2014-ifmud-discussion-on-interiority/)

同一场讨论里 jmac 给出选择项层面的对应规则：

> "in choice-based games, the choices should all reflect things that the PC is actually considering saying/doing"

—— 即：**心理活动应该出现在"选项"里（玩家可选），不应该出现在"结果"里（玩家只能被动接受）**。
这条对本项目的 `choices[].text` / `outcome` 分工是直接可用的。

**Choice of Games 社区的实践共识**（论坛长贴《Imposing feelings on the player?》）：
被点名批评的典型句式是 "You were shocked" / "This doesn't look good" 这类
"叙述者替玩家判断局势与情绪"的句子。社区给出的四条替代方案：

1. 用**人格变量**追踪玩家过往选择，再据此定制情绪描写（即：情绪必须是玩家自己挣来的）；
2. **只写具体细节**——感官、动作、环境，让读者自己推断情绪；
3. **只在关键节点**写明确情绪，日常反应留白；
4. 提供**不影响数值的"表态选项"**，让玩家自己说出情绪。

> ⚠️ 可信度标注：这是**社区论坛讨论**，不是 Choice of Games 官方规范。
> 我核实过：CoG 官网未公开发布成文的 house style guide；官方博客上与选择设计最接近的
> 是《5 Rules for Writing Interesting Choices》（见来源清单）。该贴中**没有 CoG 官方编辑参与**。
> 来源：[forum.choiceofgames.com](https://forum.choiceofgames.com/t/imposing-feelings-on-the-player/5442)

### 2.2 支持方（有条件成立，不能忽略）

**条件一：主角是被作者定义的角色，而非玩家化身。**
Emily Short 引 Nick Montfort（*Twisty Little Passages*, p.145）：

> "the player character in interactive fiction is not played at all,
> but is a constraint and possibility defined by the author"

在这个框架下，PC 的内心是**作者给定的约束条件**，写它不是越权，而是在告诉玩家"你在扮演谁"。
Short 进一步指出，IF 的力量恰恰来自**受约束的认同（constrained identification）**，
而不是开放式的角色扮演——因为"表演的乐趣大半来自有观众可娱乐，而电脑无法欣赏这些"。
来源：[Emily Short, *Second Person*](https://emshort.blog/how-to-play/writing-if/books-and-other-resources/second-person/)

**条件二：情绪被外化给一个可辨认的说话人 / 非陈述性的手段。**
同一场 interiority 讨论里，Emily Short 反驳"一律不能写内心"的立场时举的例子是
**非陈述式的手段**——

> "in [Their Angelical Understanding], there are effects where the text changes size or illumination,
> or there's a sound effect, that conveys to me very strongly what the protagonist is feeling about the situation."

要点：**间接手段（排版、光效、音效、叙事框架）比陈述句有效得多**。
Short 也为"反思型选项"辩护（玩家回答"我的角色为什么这么做"、"她对此有何感受"，
即便没有数值后果）：

> "if I'm answering a question about why my character did something or how she felt about something,
> I'm answering it to help build up the story coherently."

—— 注意这仍然是**玩家在选**，不是叙述者在写。
论坛方 Havenstone 的补充也值得记下（承认口味分歧真实存在）：

> "Tastes vary wildly; and on this, there's significant overlap with the difference between
> players who like to imagine themselves as the protagonist and those who prefer a protagonist
> who's a distinct character."

**条件三：主角的心理就是游戏本身。**
Disco Elysium 把技能做成会说话的内心声音，把意识形态/羞耻/成瘾做成可"内化"的 Thought Cabinet——
内心活动被拆成一堆**具名角色**，玩家可以采信也可以反驳。
这是"写内心而不剥夺代理权"的最完整解法。

> ⚠️ 可信度标注：我没能找到 Robert Kurvitz / Helen Hindpere 关于这一点的**一手 GDC 讲座或署名文章**。
> 上述描述基于对游戏机制的公开共识性描述（Wikipedia 及若干评论文章），**属于观察，不是引用**。
> 如需引用级来源，建议去查 Helen Hindpere 的 GDC 2020 讲座。

### 2.3 综合判定

| 情况 | 写内心？ | 依据 |
|---|---|---|
| 玩家刚做完选择，展示结果 | **不写** | Failbetter："feelings in their heart"；此刻玩家正在自己产生情绪 |
| 情绪由 NPC 说出（教练/媒体/队友/经纪人） | **写** | 这是可被玩家反驳的观点，不是既成事实 |
| 情绪由玩家在选项里自选 | **写** | jmac；Short 的"反思型选项" |
| 生理感受（疼、累、心跳） | **写** | Failbetter："focus on the character's senses" —— 感官不是情绪 |
| 叙述者总结意义（"也许你会后悔"） | **不写** | 这是替玩家做解读，破坏 Barlow 的"玩家大脑才是引擎" |

**一句话规则：可以写"身体"，不要写"心里"；可以让别人评价你，不要让叙述者替你下判断。**

---

## 3. 议题三：diegetic / non-diegetic 与第二人称规范

### 3.1 四象限分类法的原始出处

被全行业沿用的 diegetic / non-diegetic / spatial / meta 四分法，出自
**Erik Fagerholt & Magnus Lorentzon, *Beyond the HUD — User Interfaces for Increased Player Immersion in FPS Games*,
硕士论文, Chalmers University of Technology, 2009**。
两个轴：**fiction 轴**（元素是否属于故事世界）× **geometry 轴**（是否存在于游戏 3D 空间中）。
来源：[Semantic Scholar 论文页](https://www.semanticscholar.org/paper/Beyond-the-HUD-User-Interfaces-for-Increased-Player-Fagerholt-Lorentzon/16ee02a8839923752c6bc93f294bec67d73a586e)

从业者侧的经典定义来自 **Marcus Andrews（EA DICE 设计师）**，
《Game UI Discoveries: What Players Want》(Gamasutra, 2010) 原文：

> **Diegetic UI**: "Interface that is included in the game world -- i.e., it can be seen and heard by the game characters.
> Example: the holographic interface in Dead Space."
>
> **Non-diegetic UI**: "Interface that is rendered outside the game world,
> only visible and audible to the players in the real world. Example: most classic heads-up display (HUD) elements."

Andrews 的核心立场（对本项目很重要）：**功能性优先于沉浸感**——

> "regardless of your overall UI direction, be it immersion or a HUD your first priority has to be
> to enable the organism to operate in your game world, otherwise all else will fail."

来源：[Game Developer](https://www.gamedeveloper.com/design/game-ui-discoveries-what-players-want)

### 3.2 对文案的推论

一个游戏里的文字至少分三类，**不能用同一套写作标准**：

| 类别 | 例子（本项目） | 标准 |
|---|---|---|
| **Non-diegetic 功能文案** | 按钮、"传承"、"飞升"、赔率标签、成就名、菜单 | UX writing 标准：简短、一致、可扫读、术语固定 |
| **Diegetic 叙事文案** | 事件情境、选项、结果 | 叙事标准：属于世界，有语域，有说话人 |
| **半 diegetic 数值播报** | "你转会至 X"、"OVR +2"、赛季数据 | 事实播报：中立、格式统一、不抒情 |

**混用是最常见的错误。** 本项目的 `outcome` 字段同时承载第 2 类和第 3 类（见 §5.1），
这是需要优先解决的结构问题。两层的完整标准见 §3.4。

### 3.3 第二人称的规范

**UX 文案侧（Microsoft Writing Style Guide，一手）**：

> "In second person, you write as though you're speaking to the reader.
> Second person often uses the personal pronoun *you*, but sometimes the word *you* is implied."
>
> "Use first person (usually *I* or *me*) only when you need to write from the point of view of the customer."
>
> "First-person plural, which often uses the pronoun *we*, can feel like a daunting corporate presence
> — the opposite of Microsoft's modern voice."

来源：[MicrosoftDocs/microsoft-style-guide, `styleguide/grammar/person.md`](https://github.com/MicrosoftDocs/microsoft-style-guide/blob/main/styleguide/grammar/person.md)

> ⚠️ 溯源更正：搜索摘要常把 "don't imply omniscience / don't assume how someone is feeling"
> 归给 Microsoft Style Guide。我逐条核过 `person.md`，**该页并无此规则**。
> 这条规则的真实出处是 Failbetter（§2.1），不要错误引用给微软。
> 同样，我**没有找到**任天堂或暴雪公开发布的游戏写作规范——公开可查的只有本地化/无障碍指引，
> 不含叙事文案标准。若见到声称"任天堂写作规范"的二手文章，请要求它给出一手链接。

**叙事侧（Emily Short / Montfort）**：
第二人称的"你"在 IF 里承担的是**共谋与认同（complicity and identification）**功能——
它把玩家绑定到一个特定的视角与能力边界上。所以：

- "你"应该定义**处境和能力边界**（你能做什么、你面对什么、别人怎么对你）；
- "你"不应该定义**内心状态**（你此刻感到什么、你如何理解这件事）；
- 这两者的区别就是 Montfort 说的 "constraint and possibility defined by the author"（约束）
  与"替玩家表演"（越权）的区别。

来源：[Emily Short, *Second Person*](https://emshort.blog/how-to-play/writing-if/books-and-other-resources/second-person/)

---

### 3.4 两层标准对照：功能性 UI 文案 vs 事件叙事文案

这是本项目最需要落地的一节。两层的**目标不同**，所以几乎每条规则都相反：
功能文案的目标是**让玩家迅速做出正确判断**（Andrews：功能性优先于沉浸感）；
叙事文案的目标是**让玩家自己产生情绪**（Failbetter / Barlow）。
拿一套规则套两层，必然一层显得干瘪、另一层显得啰嗦。

| 维度 | ① 功能性 UI 文案（non-diegetic） | ② 事件叙事文案（diegetic） |
|---|---|---|
| 覆盖范围 | 菜单/按钮、祝福与飞升说明、成就名与达成条件、数值与概率说明、出道配置、分享卡、确认弹窗 | 事件情境、选项文本、结果（`outcome`） |
| 说话人 | 系统。没有角色，也不假装有 | 世界。有说话人（教练、队医、记者、球迷） |
| 人称 | 第二人称"你"仅指玩家本人（"你的传承分"），或直接省略主语 | 第二人称"你"指球员角色的处境 |
| 情绪 | **零**。不写心理，不煽情，不评价玩家的选择 | 由 NPC 说出或由玩家自选，叙述者不下判断 |
| 长度 | 一句话说完；说明类 ≤ 30 字 | 叙事结果 ≤ 120 字 |
| 术语 | **固定不变**。同一概念全局只有一个词 | 可以有同义变化，服务语感 |
| 歧义 | 不允许。玩家要据此决策 | 允许留白，留白就是手段 |
| 可跳过性 | 必须能扫读（首词即信息） | 可以从头读到尾 |

#### 功能文案的四条禁令（附本项目实测违例）

**禁令一：不泄漏开发术语与代码标识符。**
玩家不认识变量名。实测违例：

- `"成长 delta 取值偏向区间下限（更难成长）。"` —— `delta` 是代码里的词。
  → **"成长判定取两次中的较低值。"**
- `"转会 offer 档位 −1。"` —— `offer` 同上。
  → **"收到的报价档次降低一档。"**
- `"转会窗口每 3 个周期才开一次（攀爬变难）。"` —— "周期"是 `periodIndex` 的直译；
  足球世界里这个东西叫赛季。 → **"每 3 个赛季才有一次转会窗。"**

**禁令二：不中英混杂。** 项目约定是"文案中文、代码英文"，混排即越界。
实测违例（出现在叙事 `outcome` 里，双重错误）：

- `"你 mentoring 新秀，让出出场但球队更强。"`
  → 这句本身也不是结果叙事，是机制说明，应移到选项的 `sub`：**"指导新秀 · 出场减少，球队更强"**

> 例外：**OVR** 属于足球游戏的既有领域词汇（FIFA/FC 系列沿用多年），不算术语泄漏，保留。
> 判据是"球迷是否认得"，不是"是否英文"。

**禁令三：不把实现细节和 TODO 写进玩家可见文本。**
这是最伤信任的一类，玩家会读出"这游戏没做完"。实测违例：

- `"整生涯 0 伤病完成（暂以 ≥20 赛季近似）。"` —— "暂以…近似"是写给开发者的备注。
  → 要么把成就条件改成真的判定 0 伤病，要么直接写实际条件：**"零伤病踢满 20 个赛季。"**
- `"伤病 OVR 扣减减半（向下取整）。"` —— "向下取整"是实现细节。
  → **"伤病造成的 OVR 损失减半。"**
- `"永久：起始俱乐部实力 +1 档（不超顶级）。"` —— 括号里的边界条件是给实现看的。
  → **"起始俱乐部实力提升一档。"**（封顶行为让玩家在游戏里发现，不必预先声明）

**禁令四：不写心理描写、不替玩家评价。**
功能文案里出现情绪就是分类错误。同时也要避免在成就/祝福说明里塞策略评价
（"高风险高回报的成长流"、"频繁跳槽换实力"这类导语可以保留，但它们是**玩法定位**不是情绪，
边界是：描述这个选项适合谁，不描述玩家会有什么感受）。

#### 术语一致性（功能文案专属，叙事文案不受此约束）

功能文案里同一概念必须只有一个说法。当前混用的几组，建议各选一个固定下来：

- 「周期 / 赛季 / 轮回」→ 时间单位统一用 **赛季**；一局生涯统一叫 **轮回**（品牌词）。
- 「好结局概率 / 成功率 / 事件概率」→ 统一用 **成功率**（与"赔率明牌"的产品卖点对齐）。
- 「档 / 档位 / 档次」→ 统一用 **档**。
- 数学记法「×3 / −30% / +1 档」在概率说明里可保留（简洁且可扫读），
  但不要与文字表述混用（同一句里别既写"减半"又写"×0.5"）。

---

## 4. 议题四：同类游戏的实际做法

### 4.1 King of Dragon Pass / Six Ages（最接近本项目的结构）

**结构**：David Dunham 本人在开发博客里把叙事单元称作 **scene / floating module / storylet**：

> "often picked at random, though with conditions to make sure they're relevant or interesting.
> Typically they're written to work in any situation."

**结果如何呈现**：不靠直接分支，靠状态变量与隐式后果——

> "Your response affects relationships (turning down a request has the potential to end an alliance),
> wealth, or internal politics (your own people have opinions too).
> This gives an implicit connection to the next scene."

且后果可以跨年触发："a choice may trigger another scene at a later date"，
可能在 "a year (or more) later, after ten player actions and another batch of scenes" 之后才出现。

来源：[David Dunham, *Not Branching*, Six Ages Development Blog, 2020-11-05](https://blog.sixages.com/index.php/2020/11/05/not-branching/)

**情绪如何处理——这是本项目最该抄的一点**：
KODP / Six Ages 把"对局势的看法"**外化给氏族顾问（the ring）**。
玩家在做决定前可以听顾问各自的意见；他们互相矛盾、有时是错的。
玩家角色（氏族领袖）本身没有内心独白——**意见由具名角色说出，玩家自己决定信谁**。
Robin D. Laws 为 KODP 写了 500+ 个叙事片段、为 Six Ages 写了约 40 万词（412 个交互场景），
量级相当于十本短篇小说，但单个场景仍是短的。

来源：[GDC 2019, *Designing 'Six Ages', a Storytelling Strategy Game*](https://www.gdcvault.com/play/1025740/Designing-Six-Ages-a-Storytelling)
（讲座页原文提及 "how a text-based game achieves immersion" 与 "as much text as the first four Harry Potter novels"）；
[Six Ages Dev Blog](https://blog.sixages.com/)。

> ⚠️ 溯源说明：Dunham 的 GDC 讲座正片与 *Loading...* 期刊访谈全文均在付费墙 / PDF 后，
> 我只拿到了讲座摘要与博客原文。"顾问外化情绪"这一条是**基于游戏机制的公开描述**，
> 不是 Dunham 的逐字引用。

### 4.2 Reigns / Reigns: Her Majesty

**极短卡片文案**。Emily Short 的评论（一手观察）：

> storylets "are each only a sentence or two long"

卡片内容以 **NPC 对国王 / 女王说的话**为主 —— 说话人始终是别人，
玩家角色几乎没有被叙述的内心。玩家在卡片之间自己脑补因果：
François Alliot 说玩家会 "creating meaning between events that I didn't actually link in the game
like a famine and a wedding proposal"。

Leigh Alexander 的剧本**全部写在 Google Sheets 里**，并在其中映射概率与卡片数值如何影响叙事手感。

来源：[Emily Short, *Reigns: Her Majesty*](https://emshort.blog/2018/01/24/reigns-her-majesty/)；
[Game Developer, *Game Design Deep Dive: Creating an adaptive narrative in Reigns*](https://www.gamedeveloper.com/design/game-design-deep-dive-creating-an-adaptive-narrative-in-i-reigns-i-)；
[Game Developer, *There is no right way to be queen in Reigns: Her Majesty*](https://www.gamedeveloper.com/design/there-is-no-right-way-to-be-queen-in-i-reigns-her-majesty-i-)；
[GDC 2018, *Queens of the Phone Age*](https://www.gdcvault.com/play/1024991/Queens-of-the-Phone-Age)（讲座正片在会员墙后）。

> ⚠️ 溯源说明：我**没有找到** Reigns 团队公开的成文写作规则（字数上限之类）。
> "一两句话"是 Emily Short 的观察，不是团队自述的规范。

### 4.3 Crusader Kings

> ⚠️ **未能溯源。** CK3 的开发者日志（DD#30 Event Scripting、DD#75 Court Events）讲的是
> **事件的脚本结构**（title / desc / portrait / options、`ai_chance`、本地化 key），
> **不含写作风格规范**。Paradox 论坛有 Cloudflare 校验，WebFetch 取不到正文。
> CK3 wiki 的 Event modding 页只有 `desc = my_event.0001.desc` 这类语法示例，没有实际文案样本。
>
> 我能确认的只有：CK3 事件描述使用第二人称、通过本地化 key 引用
> （社区 mod 示例如 "After long hours of uneventful travel you come to an inn at a busy crossroad."）。
> **CK 系列事件文案确实经常直接写统治者的情绪**，但这属于我的印象，
> 在本轮检索中未取得可引用的一手证据，**不应作为论据使用**。
> 来源（仅结构层）：[CK3 Wiki, Event modding](https://ck3.paradoxwikis.com/Event_modding)

### 4.4 Football Manager

> ⚠️ **未能溯源。** 我没有找到 Sports Interactive 公开的文案写作规范。
> 检索到的多为玩家攻略与第三方解说 mod。SI 官方手册页返回 403。
>
> 本轮唯一取得的、与"情绪如何处理"相关的可用事实：
> **FM 的新闻发布会把情绪做成了玩家的选项**——回应被标为
> Positive / Neutral / Negative，还有 "Smile Warmly" 这类**姿态选项**，
> 玩家选择自己的情绪表达，游戏据此影响球员士气。
> 这与 §2.1 里 CoG 社区提出的"用表态选项代替叙述者写情绪"是同一个解法，
> 也和 jmac 的"心理活动放进选项里"一致。
> 来源（二手攻略，可信度中等，仅用于描述机制存在）：
> [FM24 Guide: Press Conferences, sortitoutsi](https://sortitoutsi.net/content/68503/fm24-guide-press-conferences)
>
> 关于"FM 新闻用第三人称新闻体"的说法，我只找到玩家自写故事的风格讨论，
> **不足以作为 SI 官方写作标准引用**。

---

## 5. 对本项目（绿茵轮回）的具体建议

### 5.1 首要问题：`outcome` 字段承载了两种互不兼容的语域

实测（`src/engine/events.ts`，795 条 outcome 文案）：

| 指标 | 数值 |
|---|---|
| 长度中位数 | 112 汉字 |
| p10 / p90 / max | 72 / 150 / 258 汉字 |
| ≥100 汉字 | 532 条（67%） |
| ≤20 汉字 | 7 条 |

但转会 / 租借类的 outcome 是这样的：

```
outcome: `你留在 ${currentClub.name}。`
outcome: "未达成转会。"
outcome: `你租借至 ${offer.club.name}。`
```

而叙事事件的 outcome 是这样的（`training_extra:accept`）：

> "一个月的汗水没白流。赛季首战你跑得比所有人都快，教练在场边点头。你的体能多撑了二十分钟——那二十分钟改变了你整个赛季。"

**这是 §3.2 说的"半 diegetic 数值播报"和"diegetic 叙事文案"混在一个字段里。**

**建议**：按 Failbetter 的槽位思路拆开职责，而不是把短的写长。
数值播报保持中立单句（它本来就对），叙事事件走叙事标准。
如果 UI 上两者出现在同一个位置，至少让**长度和语域在各自类别内部一致**。

### 5.2 立刻可执行的删改（按收益排序）

**① 砍掉"也许…也许…"句式（426 / 795 条，54%）**

这是最大的单一问题。典型：

> "你选择按计划来。体能教练看了你一眼，什么也没说。**也许你在赛季中会后悔——也许你省下了自己一身伤。**"

前两句是好的（可观察的动作 + 教练的沉默）。第三句是**叙述者替玩家总结这次选择的意义**，
而且它出现在 54% 的结果里，读者第三次看到就会失效。

违反的规则：Failbetter"不要往玩家心里塞感受"；Barlow"玩家大脑才是引擎"。
更要命的是它和本项目的核心卖点冲突——赔率明牌、后果自负，
玩家**要的就是自己判断这次选择值不值**，文案不该抢答。

**改法：删掉最后一句，句号结束。**

> "你选择按计划来。体能教练看了你一眼，什么也没说。"

留白比"也许"更有力，且省下的字数直接改善移动端阅读。

**② 把内心状态换成生理感受或他人反应（"你知道" 108 条 /"你想起" 69 条 /"你不知道" 62 条 /"心里" 29 条）**

违规例（国家队征召）：

> "你回到俱乐部训练场，主席对你笑了笑——**那种笑让你觉得自己卖了什么。**"

主席笑了 = 可观察，好。"让你觉得自己卖了什么" = 叙述者替玩家下判断。

> 改：**"你回到俱乐部训练场。主席对你笑了笑，笑得比往常久。"**
> —— 同样的不安，但由玩家自己产生。

违规例（世界杯养伤）：

> "你看着队友捧杯，**心里说不出是欣慰还是遗憾。**"

"说不出是 A 还是 B" 是最弱的一种情绪写法：它既规定了玩家在感受，又没说清在感受什么。

> 改：**"你看着队友捧杯。电视关掉之后，房间里安静了很久。"**

违规例（学业事件）：

> "你在补课时学到的东西让你在退役后有了第二条路。**你不知道那有多重要。**"

"你不知道" 是全知叙述者在对玩家说话（也正是被误传给微软的那条"不要暗示全知"的实质）。

> 改：删掉该句。或改成可验证的事实：**"多年以后，这张证书会派上用场。"**（前提是游戏真的会兑现）

**③ 保留写得对的那些——它们已经达标**

> "你走出去的时候，嘘声铺天盖地。你摸到球，有人喊你的名字——带着恨。但你没有低下头。
> 你踢了九十分钟，跑了一万米，最后一分钟你在边线救回了一个球。**嘘声停了一秒。只是一秒，但够了。**"

全是可观察事实（嘘声、跑动、救球、嘘声停了一秒），情绪完全由玩家自己产生。
这是 Failbetter "Don't tell them they're scared; scare them" 的正面样本。
**把这条当作项目内部的参考基准。**

> "你打了封闭上场。**每一次跑动膝盖都在尖叫**，但你咬牙撑了九十分钟。"

"膝盖在尖叫"是**感官**，不是情绪 —— 按 Failbetter 的规则这是允许的，而且比"你很痛苦"强得多。

**④ 修掉语域事故**

```
"你 mentoring 新秀，让出出场但球队更强。"
```

中英混排 + 机制说明文体，混在叙事 outcome 里。这是 §3.2 的分类错误：
它其实是**选项的 `sub` 说明**（机制预告），不是结果叙事。

### 5.3 建议写进 PRODUCT.md 的文案守则（草案）

> **绿茵轮回 · 文案守则**
>
> **第 0 条：先分层。** 每写一句话先问它属于哪层——
> **功能文案**（菜单/祝福/飞升/成就/数值说明/弹窗）走 A 组规则；
> **叙事文案**（事件情境/选项/结果）走 B 组规则。拿错规则比写得不好更糟。
>
> ---
>
> **A 组 · 功能性 UI 文案**
>
> A1. **零情绪。** 不写心理，不煽情，不评价玩家的选择。
> A2. **零开发术语。** 不出现 delta / offer / 周期 / index 这类代码词。
>     判据是"球迷认不认得"——OVR 认得，delta 不认得。
> A3. **零中英混杂。**
> A4. **零实现细节与 TODO。** 不写"向下取整"、"暂以…近似"、"不超顶级"。
>     玩家要知道的是效果，不是算法。
> A5. **术语全局唯一。** 赛季 / 轮回 / 成功率 / 档 —— 一个概念一个词，不换着说。
> A6. **一句话说完，首词即信息**（可扫读）。说明类 ≤ 30 字。
>
> ---
>
> **B 组 · 事件叙事文案**
>
> 1. **只写看得见的。** 动作、感官、别人说的话、比分和数据。
> 2. **不写"你感到 / 你觉得 / 你想起 / 你心里 / 你知道"。** 情绪由玩家产生，不由文案下发。
>    生理感受（疼、累、腿在抖）不算情绪，可以写。
> 3. **不替玩家总结意义。** 禁用"也许你会后悔"、"你不知道那有多重要"、"有些东西比奖杯更重"。
>    结果说完就停。
> 4. **要表达评价，就找个人说出来。** 教练、队医、主席、记者、球迷横幅、更衣室的沉默。
>    玩家可以不同意一个人的看法，但无法不同意叙述者。
> 5. **长度**：叙事结果 ≤ 120 汉字（对齐 Failbetter result ≤ 100 words）；
>    数值播报 1 句；选项文本 ≤ 20 字；选项副标题只写机制，不写故事。
> 6. **一条结果只讲一个动作及其后果**（Failbetter 原则）。要讲两件事，就拆成两个事件。
> 7. **能用数值 / 奖杯 / 赔率表达的，不要用文字重述**（Skolnick：do > show > tell）。
> 8. **第二人称的"你"定义处境，不定义内心。**

### 5.4 一条设计层面的建议（比改文案更值钱）

KODP 的顾问团、FM 的发布会选项、Disco Elysium 的技能声音，
解决的是同一个问题：**如何在不剥夺玩家代理权的前提下让游戏有心理深度**。
答案都是**把内心外化成一个可以被反驳的说话人**。

本项目已经有天然的候选角色：**教练、队医、经纪人、队友、球迷、媒体**。
现有文案其实已经在用（"教练在场边点头"、"队医说你至少休养两个月"），
只是常常在这些好句子后面又追加一句叙述者旁白。

**最省力的改动：把每条 outcome 的最后一句读一遍，如果它没有说话人，多半可以删。**

---

## 6. 来源清单

**厂商 / 一手写作规范**
- Failbetter Games — [Fallen London Writer Guidelines: Part III](https://www.failbettergames.com/news/fallen-london-writer-guidelines-part-iii)（**本文最核心来源**）
- Failbetter Games — [Part I](https://www.failbettergames.com/news/fallen-london-writer-guidelines-part-i)、[Part II](https://www.failbettergames.com/news/fallen-london-writer-guidelines-part-ii)（流程与设计，非写作规则）
- Microsoft — [Writing Style Guide, `grammar/person.md`](https://github.com/MicrosoftDocs/microsoft-style-guide/blob/main/styleguide/grammar/person.md)

**GDC**
- Sam Barlow, GDC 2016 — [Making 'Her Story': Telling a Story Using The Player's Imagination](https://www.gdcvault.com/play/1023430/Making-Her-Story-Telling-a)
- David Dunham, GDC 2019 — [Designing 'Six Ages', a Storytelling Strategy Game](https://www.gdcvault.com/play/1025740/Designing-Six-Ages-a-Storytelling)
- Leigh Alexander, GDC 2018 — [Queens of the Phone Age: The Narrative Design of 'Reigns: Her Majesty'](https://www.gdcvault.com/play/1024991/Queens-of-the-Phone-Age)（正片在会员墙后）
- Susan O'Connor, GDC Masterclass Q&A — [gdconf.com](https://gdconf.com/news/heres-short-lesson-susan-oconnors-gdc-masterclass)

**专著**
- Evan Skolnick, *Video Game Storytelling*, p.57 — 经 [Journal of Games Criticism 书评](https://gamescriticism.org/2023/07/24/tutored-together-around-more-than-dialogue-a-review-of-evan-skolnicks-video-game-storytelling-what-every-developer-needs-to-know-about-narrative-techniques/) 逐字引用
- Nick Montfort, *Twisty Little Passages*, p.145 — 经 [Emily Short, *Second Person*](https://emshort.blog/how-to-play/writing-if/books-and-other-resources/second-person/) 引用
- Fagerholt & Lorentzon, *Beyond the HUD*, Chalmers 硕士论文 2009 — [Semantic Scholar](https://www.semanticscholar.org/paper/Beyond-the-HUD-User-Interfaces-for-Increased-Player-Fagerholt-Lorentzon/16ee02a8839923752c6bc93f294bec67d73a586e)

**从业者署名文章 / 博客**
- Emily Short — [Transcript of March 1, 2014 ifMUD Discussion on Interiority](https://emshort.blog/how-to-play/if-discussion-club/transcript-of-march-1-2014-ifmud-discussion-on-interiority/)
- Emily Short — [Second Person](https://emshort.blog/how-to-play/writing-if/books-and-other-resources/second-person/)
- Emily Short — [Beyond Branching: Quality-Based, Salience-Based, and Waypoint Narrative Structures](https://emshort.blog/2016/04/12/beyond-branching-quality-based-and-salience-based-narrative-structures/)
- Emily Short — [Reigns: Her Majesty](https://emshort.blog/2018/01/24/reigns-her-majesty/)、[Video Game Storytelling (Evan Skolnick)](https://emshort.blog/2017/07/04/video-game-storytelling-evan-skolnick/)
- David Kuelz — [Narrative Design Tips I Wish I'd Known](https://www.gamedeveloper.com/design/narrative-design-tips-i-wish-i-d-known)
- Marcus Andrews (EA DICE) — [Game UI Discoveries: What Players Want](https://www.gamedeveloper.com/design/game-ui-discoveries-what-players-want)
- David Dunham — [Not Branching](https://blog.sixages.com/index.php/2020/11/05/not-branching/), Six Ages Dev Blog
- Game Developer — [Game Design Deep Dive: Creating an adaptive narrative in Reigns](https://www.gamedeveloper.com/design/game-design-deep-dive-creating-an-adaptive-narrative-in-i-reigns-i-)、[There is no right way to be queen in Reigns: Her Majesty](https://www.gamedeveloper.com/design/there-is-no-right-way-to-be-queen-in-i-reigns-her-majesty-i-)

**社区讨论（可信度中等，已在正文标注）**
- Choice of Games Forum — [Imposing feelings on the player?](https://forum.choiceofgames.com/t/imposing-feelings-on-the-player/5442)
- Choice of Games 官方博客 — [5 Rules for Writing Interesting Choices in Multiple-Choice Games](https://www.choiceofgames.com/2010/03/5-rules-for-writing-interesting-choices-in-multiple-choice-games/)
- sortitoutsi — [FM24 Guide: Press Conferences](https://sortitoutsi.net/content/68503/fm24-guide-press-conferences)

**未能溯源（明确记录，勿当论据）**
- Sports Interactive 官方文案写作规范 — 不存在公开版本；官方手册页返回 403
- Paradox / CK3 事件写作风格规范 — 开发者日志只讲脚本结构；论坛有 Cloudflare 校验取不到正文
- 任天堂 / 暴雪公开叙事写作规范 — 未检索到；公开可查的只有本地化与无障碍指引
- Choice of Games 官方 house style guide — 官网未发布成文版本
- Chris Bateman, *Game Writing: Narrative Skills for Videogames* — 本轮未取得可引用的原文段落
- Disco Elysium 团队关于"技能作为内心声音"的一手讲座 / 署名文章 — 未找到；建议查 Helen Hindpere GDC 2020
