/**
 * 生涯结算分享卡 — the career-settlement share image (P-share-card).
 *
 * Two exports:
 *   ShareCard        — the pure visual card at a fixed 430px design width.
 *                      Rendered off-screen while the overlay rasterizes it.
 *   ShareCardOverlay — the modal flow: generate QR → rasterize the card to a
 *                      PNG (html-to-image, lazy-loaded) → show the PNG as a
 *                      plain <img> so mobile browsers give the native
 *                      long-press menu (保存图片 / 发送给朋友 — in WeChat's
 *                      in-app browser this IS the 转发到会话 path). Buttons:
 *                      系统分享 (navigator.share with files → the OS sheet
 *                      lists WeChat/抖音) and 保存图片 (download fallback).
 *
 * A web page cannot invoke WeChat's 转发到会话 directly — that needs the
 * WeChat JSSDK with a verified 公众号 + backend signature, impossible from a
 * static site. Long-press + system share sheet is the honest maximum.
 *
 * The card is presentation-only: App.tsx's SummaryScreen builds the data
 * (it owns the label/epitaph helpers). Both libs are dynamic imports so the
 * main bundle carries neither QR nor rasterize code.
 */
import { useEffect, useRef, useState } from "react";

export interface ShareTrophyEntry {
  /** Trophy image path (null → emoji circle is rendered). */
  img: string | null;
  emoji: string;
  label: string;
  count: number;
  /** Major honor — the ×N badge goes gold. */
  gold: boolean;
}

export interface ShareClubEntry {
  id: string;
  crest: string | null;
  name: string;
  seasons: number;
}

export interface ShareCardData {
  name: string;
  flagPath: string | null;
  nation: string;
  posLabel: string;
  peakOvr: number;
  /** Foil tier (bronze/silver/gold/cyan/elite/special) — drives badge + title hue. */
  tier: string;
  seasons: number;
  clubCount: number;
  peakMv: string;    // "€12.5M"
  totalWage: string; // "€3.4M"
  legacy: number;
  rankName: string;
  title: string;     // 足球之神
  percentile: number;
  epitaph: string;
  achievements: { name: string; desc: string }[]; // already capped
  extraAchievements: number;
  /** National-team line + deepest tournament runs, null when never capped. */
  national: { line: string; best: string } | null;
  trophies: ShareTrophyEntry[];
  stats: { label: string; value: number }[];
  clubs: ShareClubEntry[]; // already capped
  extraClubs: number;
  seed: string;
  /** QR target — the challenge link (seed + setup baked in). */
  url: string;
  /** Footer site text (window.location.host). */
  host: string;
}

/** The fixed design width the card is laid out + rasterized at. */
export const SHARE_CARD_WIDTH = 430;

/** Foil hue per tier for the OVR badge + banner title (paired with numerals). */
const TIER_HUE: Record<string, { badgeFrom: string; badgeTo: string; badgeText: string; title: string }> = {
  bronze:  { badgeFrom: "#a16207", badgeTo: "#713f12", badgeText: "#fef3c7", title: "#d6d3d1" },
  silver:  { badgeFrom: "#9ca3af", badgeTo: "#4b5563", badgeText: "#f9fafb", title: "#e5e7eb" },
  gold:    { badgeFrom: "#f5c518", badgeTo: "#b45309", badgeText: "#1c0a00", title: "#f5c518" },
  cyan:    { badgeFrom: "#22d3ee", badgeTo: "#0e7490", badgeText: "#083344", title: "#67e8f9" },
  elite:   { badgeFrom: "#a855f7", badgeTo: "#6d28d9", badgeText: "#faf5ff", title: "#c084fc" },
  special: { badgeFrom: "#f5c518", badgeTo: "#a855f7", badgeText: "#ffffff", title: "#f5c518" },
};
const hueOf = (tier: string) => TIER_HUE[tier] ?? TIER_HUE.elite!;

/** The share card itself — fixed width, dark pitch-night face. All styling via
 *  the sc-* component classes in index.css (hex values, so the DOM→PNG clone
 *  never depends on resolving Tailwind tokens). */
export function ShareCard({ data, qr }: { data: ShareCardData; qr: string | null }) {
  const hue = hueOf(data.tier);
  return (
    <div className="sc-card" style={{ width: SHARE_CARD_WIDTH }}>
      {/* ── 头部：巅峰 OVR 徽章 + 身份 + 身价/收入 ── */}
      <div className="sc-head">
        <div className="sc-ovr" style={{ background: `linear-gradient(160deg, ${hue.badgeFrom}, ${hue.badgeTo})` }}>
          <span className="sc-ovr-lbl" style={{ color: hue.badgeText }}>巅峰</span>
          <span className="sc-ovr-num" style={{ color: hue.badgeText }}>{data.peakOvr}</span>
        </div>
        <div className="sc-id">
          <div className="sc-name">{data.name}</div>
          <div className="sc-sub">{data.seasons} 个赛季 · {data.clubCount} 家俱乐部</div>
          <div className="sc-pills">
            <span className="sc-pill">
              {data.flagPath && <img src={data.flagPath} alt="" className="sc-flag" />}
              {data.nation}
            </span>
            <span className="sc-pill sc-pill-accent">{data.posLabel}</span>
          </div>
        </div>
        <div className="sc-money">
          <span className="sc-money-lbl">巅峰身价</span>
          <span className="sc-money-val">€{data.peakMv}</span>
          <span className="sc-money-lbl">生涯总收入</span>
          <span className="sc-money-val sc-money-wage">€{data.totalWage}</span>
        </div>
      </div>

      {/* ── 生涯结局横幅 ── */}
      <div className="sc-banner">
        <span className="sc-banner-eyebrow">生涯结局</span>
        <span className="sc-banner-title" style={{ color: hue.title }}>{data.title}</span>
        <span className="sc-banner-pct">巅峰能力超越了 {data.percentile}% 的球员</span>
        <span className="sc-banner-epitaph">{data.epitaph}</span>
        <span className="sc-banner-legacy">传承分 {data.legacy} · {data.rankName}</span>
      </div>

      {/* ── 生涯成就 ── */}
      {data.achievements.length > 0 && (
        <div className="sc-achs">
          {data.achievements.map((a) => (
            <div className="sc-ach" key={a.name}>
              <span className="sc-ach-star">✦</span>
              <span className="sc-ach-name">{a.name}</span>
              <span className="sc-ach-desc">{a.desc}</span>
            </div>
          ))}
          {data.extraAchievements > 0 && (
            <div className="sc-ach-more">+{data.extraAchievements} 项生涯成就</div>
          )}
        </div>
      )}

      {/* ── 国家队 ── */}
      {data.national && (
        <div className="sc-nat">
          <span className="sc-nat-line">{data.national.line}</span>
          {data.national.best && <span className="sc-nat-best">大赛最佳 · {data.national.best}</span>}
        </div>
      )}

      {/* ── 荣誉室 ── */}
      {data.trophies.length > 0 && (
        <div className="sc-trophies">
          {data.trophies.map((t) => (
            <div className="sc-trophy" key={t.label}>
              <span className="sc-trophy-ico">
                {t.img
                  ? <img src={t.img} alt={t.label} className="sc-trophy-img" />
                  : <span className="sc-trophy-emoji">{t.emoji}</span>}
                {t.count > 1 && (
                  <span className={`sc-trophy-n ${t.gold ? "sc-trophy-gold" : ""}`}>×{t.count}</span>
                )}
              </span>
              <span className="sc-trophy-lbl">{t.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── 生涯数据 ── */}
      <div className="sc-stats">
        {data.stats.map((s) => (
          <div className="sc-stat" key={s.label}>
            <span className="sc-stat-lbl">{s.label}</span>
            <span className="sc-stat-val">{s.value}</span>
          </div>
        ))}
      </div>

      {/* ── 效力球队 ── */}
      {data.clubs.length > 0 && (
        <div className="sc-clubs">
          {data.clubs.map((c) => (
            <div className="sc-club" key={c.id}>
              {c.crest
                ? <img src={c.crest} alt={c.name} className="sc-crest" />
                : <span className="sc-crest-mono">{c.name.slice(0, 1)}</span>}
              <span className="sc-club-name">{c.name}</span>
              <span className="sc-club-n">{c.seasons} 个赛季</span>
            </div>
          ))}
        </div>
      )}
      {data.extraClubs > 0 && <div className="sc-clubs-more">+{data.extraClubs} 家俱乐部</div>}

      {/* ── 底部 CTA + 二维码 ── */}
      <div className="sc-footer">
        <div className="sc-cta">
          <span className="sc-cta-title">走一遍你自己的球员生涯</span>
          <span className="sc-cta-sub">绿茵轮回 · Roguelike 足球生涯模拟器</span>
          <span className="sc-cta-url">{data.host}</span>
          <span className="sc-cta-seed">种子 {data.seed} · 扫码挑战这段生涯</span>
        </div>
        {qr && (
          <span className="sc-qr">
            <img src={qr} alt="扫码开玩" className="sc-qr-img" />
          </span>
        )}
      </div>
    </div>
  );
}

type GenState = "idle" | "working" | "ready" | "error";

/** The modal overlay: rasterize the card → present the PNG for long-press
 *  save/share, with system-share + download buttons alongside. */
export function ShareCardOverlay({ data, onClose }: { data: ShareCardData; onClose: () => void }) {
  const [state, setState] = useState<GenState>("idle");
  const [png, setPng] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [canFiles, setCanFiles] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // 1) QR first — the card waits for it so the rasterized PNG contains it.
  useEffect(() => {
    let cancelled = false;
    import("qrcode").then((QR) =>
      QR.toDataURL(data.url, { width: 220, margin: 0, errorCorrectionLevel: "M", color: { dark: "#141419", light: "#ffffff" } }),
    ).then((url) => { if (!cancelled) setQr(url); })
     .catch(() => { if (!cancelled) setQr(""); }); // "" = give up on the QR, still render the card
    return () => { cancelled = true; };
  }, [data.url]);

  // 2) QR settled → rasterize the off-screen card to a PNG.
  useEffect(() => {
    if (qr === null) return;
    let cancelled = false;
    setState("working");
    // two frames: let the hidden card paint (images decoded) before cloning
    const t = setTimeout(() => {
      const node = cardRef.current;
      if (!node) { setState("error"); return; }
      import("html-to-image")
        .then(({ toPng }) => toPng(node, { pixelRatio: 2.5, backgroundColor: "#0b0b0f" }))
        .then((url) => {
          if (cancelled) return;
          setPng(url);
          setState("ready");
          // can the OS sheet take a file? (iOS Safari / Chrome Android → WeChat/抖音 targets)
          fetch(url).then((r) => r.blob()).then((blob) => {
            const file = new File([blob], `lvyin-career-${data.seed}.png`, { type: "image/png" });
            if (!cancelled && typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) setCanFiles(true);
          }).catch(() => { /* noop — button stays hidden */ });
        })
        .catch(() => { if (!cancelled) setState("error"); });
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [qr, data.seed]);

  const shareSystem = async () => {
    if (!png) return;
    try {
      const blob = await (await fetch(png)).blob();
      const file = new File([blob], `lvyin-career-${data.seed}.png`, { type: "image/png" });
      await navigator.share({ files: [file], title: "绿茵轮回 · 生涯战报" });
    } catch { /* user dismissed or unsupported — the long-press hint still covers it */ }
  };
  const download = () => {
    if (!png) return;
    const a = document.createElement("a");
    a.href = png;
    a.download = `lvyin-career-${data.seed}.png`;
    a.click();
  };

  return (
    <div className="share-overlay" role="dialog" aria-modal="true" aria-label="生涯分享卡">
      {/* off-screen render source (never visible — the overlay shows the PNG) */}
      <div className="share-render" aria-hidden="true">
        <div ref={cardRef}>
          <ShareCard data={data} qr={qr || null} />
        </div>
      </div>

      <div className="share-panel">
        <div className="share-body">
          {state === "ready" && png ? (
            <img className="share-img" src={png} alt="生涯分享卡" draggable={false} />
          ) : state === "error" ? (
            <div className="share-fallback">
              <ShareCard data={data} qr={qr || null} />
              <p className="share-hint">图片生成失败，请直接截图保存这张生涯卡</p>
            </div>
          ) : (
            <div className="share-loading">
              <span className="share-spinner" />
              正在生成生涯卡…
            </div>
          )}
        </div>
        {state === "ready" && <p className="share-hint">长按图片 · 保存到相册 / 发送给朋友</p>}
        <div className="share-actions">
          {canFiles && <button className="btn btn-primary share-btn" onClick={shareSystem}>分享</button>}
          {state === "ready" && <button className="btn share-btn" onClick={download}>保存图片</button>}
          <button className="btn share-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
