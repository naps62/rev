/**
 * Filesystem watching for repos with live viewers.
 *
 * Reference-counted: first WS subscriber to a dir starts a chokidar watcher
 * (ignoring WATCH_IGNORE and .git internals except HEAD/refs, which signal
 * commits/checkouts); last unsubscribe stops it. Events are debounced
 * (WATCH_DEBOUNCE_MS) and delivered as one callback with the batch of
 * repo-relative paths.
 */

export type WatchCallback = (dir: string, paths: string[]) => void;

/** Register the single global sink for change events (index.ts wires this to WS broadcast). */
export function onRepoChange(cb: WatchCallback): void {
  throw new Error("not implemented");
}

/** Increment watch refcount for dir, starting the watcher if first. */
export function subscribe(dir: string): void {
  throw new Error("not implemented");
}

/** Decrement refcount, stopping the watcher when it hits zero. */
export function unsubscribe(dir: string): void {
  throw new Error("not implemented");
}
