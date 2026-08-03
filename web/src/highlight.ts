/**
 * Lazy shiki wrapper. Diff lines render plain first; components call
 * highlightLines after mount and swap in tokens when they arrive, so shiki
 * never blocks first paint. Fine-grained core + JS regex engine: only the
 * grammars below are bundled (as lazy chunks), no wasm.
 */

import type { Scheme } from "./theme";

export interface Token {
  content: string;
  color?: string;
}
export type TokenLine = Token[];

const THEMES: Record<Scheme, string> = {
  dark: "github-dark-default",
  light: "github-light-default",
};

const LANG_LOADERS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
} as const;

type LangId = keyof typeof LANG_LOADERS;

const EXT_LANG: Record<string, LangId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  rs: "rust",
  go: "go",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

export function langForPath(path: string): LangId | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXT_LANG[ext] ?? null;
}

type HighlighterCore = Awaited<
  ReturnType<typeof import("shiki/core").createHighlighterCore>
>;

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<LangId>();
const cache = new Map<string, Promise<TokenLine[] | null>>();

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
    return createHighlighterCore({
      themes: [
        import("shiki/themes/github-dark-default.mjs"),
        import("shiki/themes/github-light-default.mjs"),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighterPromise;
}

/**
 * Tokenizes diff line texts for a file. Lines are joined and tokenized as one
 * block — old/new lines interleave, so multi-line constructs can mis-lex at
 * hunk boundaries; acceptable for a diff. Returns null for unknown languages.
 */
export function highlightLines(
  path: string,
  contentHash: string,
  lines: string[],
  scheme: Scheme,
): Promise<TokenLine[] | null> {
  const lang = langForPath(path);
  if (!lang) return Promise.resolve(null);

  const key = `${path}@${contentHash}:${scheme}:${lines.length}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = (async () => {
      try {
        const hl = await getHighlighter();
        if (!loadedLangs.has(lang)) {
          await hl.loadLanguage(LANG_LOADERS[lang]());
          loadedLangs.add(lang);
        }
        const tokens = hl.codeToTokensBase(lines.join("\n"), {
          lang,
          theme: THEMES[scheme],
        });
        if (tokens.length < lines.length) return null;
        return tokens
          .slice(0, lines.length)
          .map((line) => line.map((t) => ({ content: t.content, color: t.color })));
      } catch {
        return null;
      }
    })();
    cache.set(key, entry);
  }
  return entry;
}
