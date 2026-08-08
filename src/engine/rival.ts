/**
 * Career-long rival (P5) — the narrative engine that gives the player someone
 * to measure against across a whole career, the Messi-to-their-Ronaldo tension.
 *
 * The rival is generated deterministically from the run seed: same age, same
 * position, a different nationality (so it feels like a contrast), and a
 * fixed club. Their career is simulated in simplified form each season — just
 * enough to produce a parallel arc (goals / trophies / Ballon d'Or) that the
 * UI can set beside the player's. The rival's OVR arc is a fixed competitive
 * curve so the player can "overtake" them by building well.
 *
 * Pure + deterministic: no RNG state of its own (seed-derived), no side effects.
 */
import type { Rival, RivalSeason } from "./types";
import { CLUBS, NATIONS, generatePlayerName, type Position } from "./data";
import { hash } from "./rng";

/** A fixed competitive OVR arc — a strong-but-beatable rival. Peaks ~88 at 26,
 *  holds, then declines. Deterministic by age so every run's rival follows the
 *  same shape (the player's arc is what varies). */
function rivalOvrAt(age: number): number {
  if (age <= 16) return 58;
  if (age <= 18) return 58 + (age - 16) * 6;       // 58 → 70
  if (age <= 22) return 70 + (age - 18) * 3;       // 70 → 82
  if (age <= 26) return 82 + (age - 22) * 1.5;    // 82 → 88
  if (age <= 30) return 88;                        // plateau
  if (age <= 34) return 88 - (age - 30) * 2;      // 88 → 80
  if (age <= 38) return 80 - (age - 34) * 3;      // 80 → 68
  return 68 - (age - 38) * 2;                      // tail
}

/** Goals per season by position group (the rival is a good-but-not-great
 *  scorer unless they're a forward). Deterministic via the seed hash so the
 *  same seed always yields the same rival career. */
function rivalGoals(seed: string, age: number, position: Position, ovr: number): number {
  const h = hash(`${seed}:rival-goals:${age}`);
  const base = position === "ST" || position === "LW" || position === "RW" ? 18
    : position === "CAM" ? 10
    : position === "CM" || position === "LM" || position === "RM" ? 6
    : 2;
  // scale by how close to peak, ±40% variance from seed
  const peakFactor = Math.max(0.3, (ovr - 50) / 38);
  const variance = 0.6 + (h % 100) / 100 * 0.8;   // 0.6–1.4
  return Math.round(base * peakFactor * variance);
}

/** Trophy count this season (rival is at a strong club, so a steady trickle). */
function rivalTrophies(seed: string, age: number): number {
  const h = hash(`${seed}:rival-trophies:${age}`);
  // ~35% chance of a trophy any given season, 10% of two
  const r = h % 100;
  if (r < 10) return 2;
  if (r < 45) return 1;
  return 0;
}

/** Ballon d'Or: the rival wins it in their peak years ~12% of the time.
 *  Deterministic so a given seed's rival has a fixed career story. */
function rivalBallonDor(seed: string, age: number): boolean {
  if (age < 23 || age > 31) return false;
  const h = hash(`${seed}:rival-bd:${age}`);
  return h % 100 < 12;
}

/** Pick a rival club — a strong club (rep >= 4) so they compete for honors,
 *  different from the player's start so it's a contrast. Deterministic. */
function rivalClub(seed: string): string {
  const strong = CLUBS.filter((c) => c.rep >= 4);
  const pool = strong.length > 0 ? strong : CLUBS;
  const h = hash(`${seed}:rival-club`);
  return pool[h % pool.length]!.id;
}

/** Pick a rival nationality — different from the player's for contrast,
 *  preferring "big" football nations for narrative weight. Deterministic. */
function rivalNationality(seed: string, playerNatId: string): string {
  const big = ["bra", "arg", "fra", "eng", "esp", "ger", "ita", "por", "ned", "bel"];
  const pool = big.filter((n) => n !== playerNatId);
  const final = pool.length > 0 ? pool : NATIONS.map((n) => n.id);
  const h = hash(`${seed}:rival-nat`);
  return final[h % final.length]!;
}

/** Generate and simulate the rival's full career (16→40) deterministically. */
export function generateRival(seed: string, playerPosition: Position, playerNatId: string): Rival {
  const nationalityId = rivalNationality(seed, playerNatId);
  const clubId = rivalClub(seed);
  // rival name — use a distinct seed salt so it never collides with the player
  const name = generatePlayerName(`${seed}:rival`, nationalityId);

  const seasons: RivalSeason[] = [];
  let totalGoals = 0;
  let totalTrophies = 0;
  let totalAwards = 0;
  let peakOverall = 0;
  for (let age = 16; age <= 40; age++) {
    const ovr = Math.round(rivalOvrAt(age));
    peakOverall = Math.max(peakOverall, ovr);
    const goals = rivalGoals(seed, age, playerPosition, ovr);
    const trophies = rivalTrophies(seed, age);
    const wonBallonDor = rivalBallonDor(seed, age);
    totalGoals += goals;
    totalTrophies += trophies;
    if (wonBallonDor) totalAwards += 1;
    seasons.push({ age, goals, trophies, wonBallonDor, overall: ovr });
  }

  return {
    name, nationalityId, clubId, position: playerPosition,
    seasons, totalGoals, totalTrophies, totalAwards, peakOverall,
  };
}

/** The rival's record at a given age (for per-season UI comparison). */
export function rivalAtAge(rival: Rival, age: number): RivalSeason | undefined {
  return rival.seasons.find((s) => s.age === age);
}
