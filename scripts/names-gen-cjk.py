#!/usr/bin/env python3
"""
Name-fragment generator: split real footballers' names (from Wikidata SPARQL
pulls in scripts/names-data/) into surname/given pools, then emit a TypeScript
fragment of the NAME_SPECS entries for chn/jpn/kor.

Approach (per user): real-player fragments recombined — take A's surname + B's
given, so the result reads as a plausible native name with football-fan resonance
WITHOUT ever reproducing a single real player's full name.

Run:  python3 scripts/names-gen-cjk.py   (emits TS to stdout)
"""
import json, sys
from collections import Counter

DATA = "scripts/names-data"

# ── China ─────────────────────────────────────────────────────────────────
ZH_SURNAMES = set("""王 李 张 刘 陈 杨 赵 黄 周 吴 徐 孙 马 朱 胡 郭 何 高 林 罗 郑 梁 谢 宋 唐 许 韩 冯 邓 曹 彭 曾 田 董 袁 潘 于 蒋 蔡 余 杜 叶 程 苏 魏 吕 丁 任 沈 姚 卢 姜 崔 钟 谭 陆 汪 范 金 石 廖 贾 夏 韦 付 方 白 邹 孟 熊 秦 邱 江 尹 薛 闫 段 雷 侯 龙 史 陶 黎 贺 顾 毛 郝 龚 邵 万 钱 严 覃 武 戴 莫 孔 向 汤 蒿 郜 曲 肇 区 宫 容 柴 翟 詹 申 麦 井 焦 巴 乌 鄂 羊 贲 琚 查 戚 滕 晏 倪 康 颜 柏 窦 章 鲍 费 蒲 翁 谷 车 宓 蓬 乔 蒙 易 宗 禹 支 祈 兰 关 蓟 融 宿 聂 尚 冷 鲜 赫 钦 哈 呼 苟 贡 劳 居 巩 厍 晁 勾 丰 仉 督 暴 利 滑 冀 仇 佟 祁 梅 安 傅 鞠 宿 么 佘 阙 丛 郗 刁 蔺 茅 池 迟 桑 党 冉 慎 言 辛 简 邰 靳 卞 亢 岑 全 蒲 邬 宁 寇 荣 蒙 栾 燕 桓 公 汉 蒙 鄢 朴 伋 宰 蒙 乞 练 蒙 郅 况 琴 后 红 邰 湛 蓟""".split())
ZH_TRAD2SIMP = {'賈':'贾','陳':'陈','蘇':'苏','葉':'叶','劉':'刘','張':'张','趙':'赵','黃':'黄','吳':'吴','孫':'孙','馬':'马','鄭':'郑','謝':'谢','許':'许','韓':'韩','馮':'冯','鄧':'邓','蔣':'蒋','盧':'卢','鐘':'钟','譚':'谭','陸':'陆','範':'范','鍾':'钟','顏':'颜','龔':'龚','萬':'万','錢':'钱','嚴':'严','閻':'阎','閆':'闫','鮑':'鲍','費':'费','鄒':'邹','閔':'闵','顧':'顾','龍':'龙','聶':'聂','賀':'贺','塗':'涂','鄺':'邝','區':'区','簡':'简','賴':'赖','魏':'魏','薛':'薛','韋':'韦','戴':'戴','龐':'庞', '鐵':'铁','鴻':'鸿','輝':'辉','進':'进','鈞':'钧','濤':'涛','國':'国','東':'东','東':'东','偉':'伟','麗':'丽','曉':'晓','華':'华','強':'强','榮':'荣','軍':'军','蘭':'兰','鳳':'凤','龍':'龙','鳥':'鸟','島':'岛','橋':'桥','頭':'头','點':'点','邊':'边','變':'变','寶':'宝','實':'实','廣':'广','慶':'庆','應':'应','齊':'齐','藝':'艺','蘇':'苏','艦':'舰','關':'关','陽':'阳','陰':'阴','雙':'双','參':'参','叢':'丛','動':'动','場':'场','塊':'块','壇':'坛','壘':'垒','壟':'垄','壩':'坝','寬':'宽','賓':'宾','導':'导','層':'层','屢':'屡','嶼':'屿','巒':'峦','峰':'峰','帥':'帅','師':'师','帶':'带','幣':'币','幹':'干','廢':'废','廟':'庙','廠':'厂','廳':'厅','弒':'弑','待':'待','後':'后','徑':'径','復':'复','微':'微','德':'德','憶':'忆','懣':'懑','懲':'惩','懷':'怀','懶':'懒','戲':'戏','扎':'扎','托':'托','扣':'扣','執':'执','擴':'扩','掃':'扫','揚':'扬','換':'换','損':'损','搶':'抢','換':'换','搗':'捣','搥':'搥','搶':'抢','搾':'榨','搿':'搿','攄':'摅','攔':'拦','擱':'搁','擋':'挡','擠':'挤','攏':'拢','攔':'拦','攙':'搀','攆':'撵','攔':'拦','攖':'攖','攙':'搀','擯':'摈','攢':'攒'}

def split_zh(full):
    if not any(0x4e00 <= ord(c) <= 0x9fff for c in full): return None
    if any(c in '·・ ' for c in full): return None
    if any('a' <= c.lower() <= 'z' for c in full): return None
    n = ''.join(ZH_TRAD2SIMP.get(c, c) for c in full)
    if len(n) >= 2 and n[0] in ZH_SURNAMES: return (n[0], n[1:])
    return None

# ── Korea ──────────────────────────────────────────────────────────────────
# Hangul only, surname = first syllable. Korean surnames are extremely concentrated.
KO_SURNAMES = set("김 이 박 최 정 강 조 윤 장 임 한 신 오 서 권 황 안 송 전 홍 유 노 정 문 배 심 백 송 곽 차 주 나 하 전 유 강 변 엄 추 양 구".split())
def split_ko(full):
    if any(' ' in full for _ in [0]): return None
    if not all(0xac00 <= ord(c) <= 0xd7af for c in full): return None
    if len(full) < 2: return None
    if full[0] not in KO_SURNAMES: return None
    return (full[0], full[1:])

# ── Japan ───────────────────────────────────────────────────────────────────
# Kanji-only. Surname usually 2 chars; given 2 chars. Use a surname library +
# length heuristics for the long tail.
JP_SURNAMES_3 = {'長谷部','佐々木','久保田','小比類','阿比留','大久保','宇佐美','日比野','伊野波','五味川','四十宮'}
JP_SURNAMES_2 = set("""佐藤 鈴木 高橋 田中 渡辺 伊藤 山本 中村 小林 加藤 吉田 山田 佐々木 山口 松本 井上 木村 林 斎藤 清水 山崎 森 池田 橋本 阿部 石川 前田 藤田 岡田 後藤 石井 小野 遠藤 中田 本田 長谷部 長友 岡崎 乾 南野 大迫 吉田 川島 酒井 武藤 柴崎 宇佐美 浅野 大久保 中澤 今野 昌子 川口 森重 森本 阿部 岡田 楢崎 玉田 原口 谷口 中山 権田 永井 駒野 稲本 松井 藤春 興梠 塩谷 青山 柿谷 松田 前田 井原 西川 山口 久保 山村 森島 秋田 大黒 矢野 柳沢 伊野波 細貝 宮市 安田 倉田 岩政 小笠原 藤本 宮本 槙野 巻 福西 岡野 豊田 齋藤 平野 曽ヶ端 扇原 相馬 金崎 徳永 名波 大津 服部 前園 三浦 清武 釜本 内田 森保 浅野 永井 駒野 藤春 塩谷 柿谷 松田 井原 中田 西川 山口 久保 森島 大黒 矢野 柳沢 細貝 宮市 倉田 岩政 藤本 宮本 槙野 福西 岡野 豊田 扇原 相馬 金崎 徳永 名波 大津 服部 前園""".split())
def split_ja(full):
    if not all(0x4e00 <= ord(c) <= 0x9fff or 0x3040 <= ord(c) <= 0x309f for c in full): return None
    if any(' ' in full for _ in [0]): return None
    n = full.replace('ヶ','')  # 曽ヶ端 etc — keep core
    if not all(0x4e00 <= ord(c) <= 0x9fff for c in n): return None
    # 3-char surname
    if len(n) >= 5 and n[:3] in JP_SURNAMES_3: return (n[:3], n[3:])
    # 2-char surname (most common: 4-char total)
    if len(n) >= 4 and n[:2] in JP_SURNAMES_2: return (n[:2], n[2:])
    # heuristic: 3-char names often 1-char surname (rare) — skip, too risky
    # 5-char: try 2-char surname if in lib
    if len(n) == 5 and n[:2] in JP_SURNAMES_2: return (n[:2], n[2:])
    return None

def load(path):
    try:
        d = json.load(open(path))
        return [r['name']['value'] for r in d['results']['bindings']]
    except: return []

def emit(label, surnames, givens):
    """Emit a TS pool literal. Dedup + sort by frequency for readability."""
    sc = Counter(surnames); gc = Counter(givens)
    s_items = [repr(s) for s, _ in sc.most_common()]
    g_items = [repr(g) for g, _ in gc.most_common()]
    print(f"  // {label}: {len(s_items)} surnames, {len(g_items)} givens (from real footballers)")
    print(f"  surnames: [{', '.join(s_items)}],")
    print(f"  givens: [{', '.join(g_items)}],")

def main():
    # China
    zh_names = load(f"{DATA}/zh_players.json")
    zh = [r for r in (split_zh(n) for n in zh_names) if r]
    zh_sur = [s for s, _ in zh]; zh_giv = [g for _, g in zh]
    # Korea
    ko_names = load(f"{DATA}/ko_players.json")
    ko = [r for r in (split_ko(n) for n in ko_names) if r]
    ko_sur = [s for s, _ in ko]; ko_giv = [g for _, g in ko]
    # Japan
    ja_names = load(f"{DATA}/ja_players.json")
    ja = [r for r in (split_ja(n) for n in ja_names) if r]
    ja_sur = [s for s, _ in ja]; ja_giv = [g for _, g in ja]

    print(f"// === auto-generated from real footballer fragments (Wikidata SPARQL) ===")
    print(f"// chn: {len(zh)}/{len(zh_names)} split | jpn: {len(ja)}/{len(ja_names)} | kor: {len(ko)}/{len(ko_names)}")
    print(f"// Recombined at runtime — never reproduces a single real player's full name.")
    print()
    print("// CHN pools:")
    emit("chn", zh_sur, zh_giv)
    print("// JPN pools:")
    emit("jpn", ja_sur, ja_giv)
    print("// KOR pools:")
    emit("kor", ko_sur, ko_giv)
    print()
    print(f"// sample recombined: chn {zh_sur[0]!r}+{zh_giv[3]!r}={zh_sur[0]+zh_giv[3]!r}", file=sys.stderr)
    print(f"// sample recombined: jpn {ja_sur[0]!r}+{ja_giv[2]!r}={ja_sur[0]+ja_giv[2]!r}", file=sys.stderr)
    print(f"// sample recombined: kor {ko_sur[0]!r}+{ko_giv[1]!r}={ko_sur[0]+ko_giv[1]!r}", file=sys.stderr)

main()
