/**
 * Per-file fold state (manually expanded strips + show-bodies toggle),
 * persisted in localStorage so it survives a refresh. Entries are keyed by
 * dir+path and pinned to the file's contentHash: when the file changes the
 * hunk-relative fold keys are meaningless, so a hash mismatch drops the entry.
 */

const KEY = "rev.foldState";
const MAX_ENTRIES = 300;

export interface FoldState {
  folds: string[];
  showBodies: boolean;
}

interface Entry extends FoldState {
  hash: string;
  at: number;
}

type Store = Record<string, Entry>;

const entryKey = (dir: string, path: string) => `${dir}\n${path}`;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed != null ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota/private-mode failures just lose persistence, not the session state.
  }
}

export function loadFoldState(dir: string, path: string, hash: string): FoldState | null {
  const e = readStore()[entryKey(dir, path)];
  if (!e || e.hash !== hash) return null;
  return { folds: e.folds ?? [], showBodies: e.showBodies ?? false };
}

export function saveFoldState(
  dir: string,
  path: string,
  hash: string,
  state: FoldState,
) {
  const store = readStore();
  const k = entryKey(dir, path);
  if (state.folds.length === 0 && !state.showBodies) {
    if (!(k in store)) return;
    delete store[k];
  } else {
    store[k] = { ...state, hash, at: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (store[a]!.at ?? 0) - (store[b]!.at ?? 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((old) => delete store[old]);
    }
  }
  writeStore(store);
}
