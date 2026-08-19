/**
 * Who is looking at which review, right now.
 *
 * A review page holds a WS subscription to its dir for as long as it is open
 * (web/src/ws.ts), so the subscribe/unsubscribe pair in index.ts is an exact
 * "someone is reviewing this checkout" signal. Counts are per socket, and the
 * last-seen stamp outlives the last viewer so a hook firing shortly after the
 * tab closes still sees the review as recent.
 *
 * State is in-memory: a server restart forgets it, and reconnecting clients
 * re-announce within their backoff window.
 */

interface Entry {
  viewers: number;
  lastSeen: number;
}

const entries = new Map<string, Entry>();

function entry(dir: string): Entry {
  let e = entries.get(dir);
  if (!e) {
    e = { viewers: 0, lastSeen: 0 };
    entries.set(dir, e);
  }
  return e;
}

/** A viewer opened dir. */
export function enter(dir: string): void {
  const e = entry(dir);
  e.viewers++;
  e.lastSeen = Date.now();
}

/** A viewer closed dir (or its socket dropped). */
export function leave(dir: string): void {
  const e = entries.get(dir);
  if (!e) return;
  e.viewers = Math.max(0, e.viewers - 1);
  e.lastSeen = Date.now();
}

/** Live viewer count and the last time one was seen (0 = never). */
export function presence(dir: string): { viewers: number; lastSeen: number } {
  const e = entries.get(dir);
  return { viewers: e?.viewers ?? 0, lastSeen: e?.lastSeen ?? 0 };
}

/** Tests only. */
export function reset(): void {
  entries.clear();
}
