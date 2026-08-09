/**
 * SFX — a tiny Web Audio synth for UI feedback (P-A9).
 *
 * No external assets (CSP-safe): every sound is synthesized from oscillators.
 * The lesson from Balatro/Hades is that audio is half the dopamine loop — a
 * click without a sound feels dead. Sounds are short (<300ms), pitched up for
 * good outcomes and down for bad, with a triumphant arpeggio for milestones.
 *
 * Lazy-initialized: the AudioContext is created on first use (browsers block
 * audio before a user gesture), and resumed if suspended.
 */
let ctx: AudioContext | null = null;
let enabled = true;
let hapticsEnabled = true;

/** Enable/disable all sfx (driven by the meta.soundOn toggle). */
export function setSfxEnabled(on: boolean): void { enabled = on; }

/** Enable/disable haptics (driven by the meta.hapticsOn toggle). Independent of
 *  sound — a player may mute the speakers but still want the phone to buzz. */
export function setHapticsEnabled(on: boolean): void { hapticsEnabled = on; }

/** Fire a vibration pattern, gated + guarded. Many browsers (iOS Safari, all
 *  desktop) silently no-op `navigator.vibrate`, so every call is wrapped in a
 *  try/catch — a missing motor must never break a choice. The Vibration API
 *  pattern alternates buzz/pause: `[buzz, pause, buzz, ...]`. */
function buzz(pattern: number | number[]): void {
  if (!hapticsEnabled) return;
  try { navigator.vibrate?.(pattern); } catch { /* motor off / unsupported */ }
}

function ac(): AudioContext | null {
  if (!enabled) return null;
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}

/** A single synthesized tone. */
function tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  // quick attack, exponential decay — a percussive "blip"
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** A short frequency sweep (for rising/falling effects). */
function sweep(fromF: number, toF: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fromF, t0);
  osc.frequency.exponentialRampToValueAtTime(toF, t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// ── the sound palette ──

/** A decision tap — short, neutral, the baseline interaction sound. */
export function sfxTap(): void { tone(440, 0.08, "triangle", 0.12); }

/** One notch of the 结算跑马灯 — a tiny detent click, the wheel passing a stop. */
export function sfxTick(): void { tone(1180, 0.025, "square", 0.045); }

/** A good outcome — rising two-note (C→G), bright triangle. */
export function sfxGood(): void { tone(523, 0.1, "triangle", 0.14); tone(784, 0.14, "triangle", 0.14, 0.08); }

/** A bad outcome — falling two-note (C→F below), dull sawtooth. */
export function sfxBad(): void { tone(330, 0.1, "sawtooth", 0.12); tone(220, 0.16, "sawtooth", 0.12, 0.08); }

/** A trophy win — a bright arpeggio (C-E-G-C), the reward sound. */
export function sfxTrophy(): void {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, "triangle", 0.15, i * 0.07));
}

/** A milestone/achievement — a longer triumphant sweep + arpeggio. */
export function sfxMilestone(): void {
  sweep(400, 800, 0.25, "triangle", 0.13);
  [659, 784, 988, 1319].forEach((f, i) => tone(f, 0.14, "triangle", 0.16, 0.12 + i * 0.08));
}

/** A boss event appears — a tense low rumble, the "stakes just rose" cue. */
export function sfxBoss(): void { sweep(200, 120, 0.3, "sawtooth", 0.14); tone(110, 0.4, "square", 0.06, 0.1); }

// ── haptics — the vibration twin of each sfx (mobile feedback loop) ──
// The lesson from Balatro/Hades is that haptics are half the dopamine loop on
// a phone: a tap without a buzz feels dead, and a win should *feel* different
// from a loss even with the sound off. Each pattern is short and distinct so
// a thumb can tell a tap from a win from a trophy without looking at the
// screen. Paired 1:1 with the sfx above and fired alongside it.

/** A decision tap — a single short blip, the neutral selection ack. */
export function hapticTap(): void { buzz(10); }

/** A decisive click — the roll wheel landing on its stop. */
export function hapticClick(): void { buzz(16); }

/** A good outcome — two short rising pulses, a bright "yes". */
export function hapticGood(): void { buzz([15, 35, 25]); }

/** A bad outcome — one longer dull thud, the sting of a miss. */
export function hapticBad(): void { buzz(42); }

/** A trophy win — a celebratory triple pulse, the reward flourish. */
export function hapticTrophy(): void { buzz([20, 45, 20, 45, 30]); }

/** A boss event appears — a tense double-thump, the "stakes just rose" cue. */
export function hapticBoss(): void { buzz([25, 55, 45]); }

/** A milestone/achievement — a longer triumphant pulse chain. Legendary
 *  milestones (Ballon d'Or, World Cup…) get a fuller flourish than a plain
 *  OVR-tier-up. */
export function hapticMilestone(legendary?: boolean): void {
  buzz(legendary ? [20, 40, 20, 40, 20, 40, 35] : 25);
}
