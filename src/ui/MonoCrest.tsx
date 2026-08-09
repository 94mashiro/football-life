/**
 * MonoCrest — the default club badge for clubs without a crest asset.
 * A heater-shield with a deterministic per-club enamel hue (same hashStr
 * scheme as the ledger plate, so a club keeps its color across surfaces),
 * per-pale shading, top gloss and an inner rim. Pure vector geometry: crisp
 * from 15px to 42px and survives html-to-image rasterization (share card).
 */
import { useId } from "react";

// minimal deterministic hash for UI-only hue/flavor picking (not the sim engine).
export function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0 || 1;
}

const SHIELD = "M8 4.5 H32 C33.7 4.5 35 5.8 35 7.5 V18.5 C35 27.8 28.9 34.9 20 38 C11.1 34.9 5 27.8 5 18.5 V7.5 C5 5.8 6.3 4.5 8 4.5 Z";

export function MonoCrest({ clubId, label, size }: { clubId: string; label: string; size: number }) {
  const uid = useId();
  const h = hashStr(clubId) % 360;
  return (
    <svg className="mono-crest" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`oklch(0.47 0.1 ${h})`} />
          <stop offset="1" stopColor={`oklch(0.26 0.08 ${h})`} />
        </linearGradient>
        <clipPath id={`${uid}c`}><path d={SHIELD} /></clipPath>
      </defs>
      <path d={SHIELD} fill={`url(#${uid}g)`} />
      <g clipPath={`url(#${uid}c)`}>
        <rect x="20" width="20" height="40" fill="oklch(0 0 0 / 0.16)" />
        <path d="M0 0 H40 V8.5 C26.5 13 13.5 13 0 8.5 Z" fill="oklch(1 0 0 / 0.09)" />
      </g>
      <path d={SHIELD} fill="none" stroke={`oklch(0.82 0.07 ${h} / 0.55)`} strokeWidth="1.3"
        transform="translate(20 21.25) scale(0.88) translate(-20 -21.25)" />
      <text x="20" y="19.8" textAnchor="middle" dominantBaseline="central" fontWeight="800"
        fontSize="18" fill={`oklch(0.95 0.03 ${h})`}>{label}</text>
    </svg>
  );
}
