/**
 * Minimal Cloudflare Pages Functions + D1 runtime types.
 *
 * functions/ is NOT covered by the project tsconfig (only `src` + vite.config
 * are), and wrangler transpiles these with esbuild (no type-check) on deploy
 * and `pages dev`. So instead of pulling @cloudflare/workers-types, we hand-roll
 * the exact shapes wrangler injects — enough for the leaderboard handlers.
 */

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta: { last_row_id?: number; changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface Env {
  DB: D1Database;
}

/** Pages Functions EventContext — the `context` handed to every onRequest* handler. */
export interface EventContext<E = Env> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  next: () => Promise<Response>;
  waitUntil(p: Promise<unknown>): void;
}
