// Shared helpers: deterministic time, ids, and small encodings.
// The forge never reads a live clock for state: every timestamp derives from
// MAKEFUN_TRIAL_NOW (fixed in a trial; a fixed fallback locally), so two runs
// of the same trial produce the same state.

/** The trial's frozen "now", parsed once at startup. */
let trialNowMs = 0;

function parseTrialNow(raw: string | undefined): number {
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n > 1e12 ? n : n * 1_000;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Fixed fallback for local runs (never Date.now(): state must be replayable).
  return Date.parse('2026-11-16T00:00:00.000Z');
}

trialNowMs = parseTrialNow(process.env.MAKEFUN_TRIAL_NOW);

/** The trial's frozen now, as epoch milliseconds. */
export function nowMs(): number {
  return trialNowMs;
}

/** The trial's frozen now, as epoch seconds (git commit timestamps). */
export function nowSec(): number {
  return Math.floor(trialNowMs / 1_000);
}

/** The trial's frozen now, as an ISO-8601 string (REST created_at / updated_at). */
export function nowIso(): string {
  return new Date(trialNowMs).toISOString();
}

/** A git identity line's timestamp+zone: `<epoch> +0000`. */
export function gitTimestamp(): string {
  return `${nowSec()} +0000`;
}

// ---------------------------------------------------------------- ids

let requestCounter = 0;

/** The next X-GitHub-Request-Id: a monotonic hex counter, deterministic per run. */
export function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(16, '0');
}

let globalIdCounter = 0;

/** A globally unique, monotonically increasing integer id (repos, issues, comments). */
export function nextGlobalId(): number {
  globalIdCounter += 1;
  return globalIdCounter;
}

// ---------------------------------------------------------------- encoding

/** URL-safe base64 without padding (GraphQL global ids). */
export function base64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a URL-safe base64 string, or null when it is not one. */
export function base64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Whether `value` is a 40-hex lowercase sha1. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The all-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Whether `value` is a plain record (an object, not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON value as a string, or `fallback` when it is not a string. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** A JSON value as a boolean, or `fallback` when it is not a boolean. */
export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
