import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type CommandPreset,
  SESSION_SPAWN_PLACEHOLDERS,
  SESSION_SPAWN_PRESETS,
  WORKTREE_CMD_PLACEHOLDERS,
  WORKTREE_CMD_PRESETS,
} from "#shared/commands";
import * as api from "../api";
import {
  type DiffMode,
  type FeatureFlags,
  loadDiffMode,
  loadFeatures,
  saveDiffMode,
  saveFeatures,
  VIEW_FEATURES,
} from "../features";
import { setThemePref, type ThemePref, useThemePref } from "../theme";
import { cx } from "../util";
import type { WsStatus } from "../ws";
import { Checkbox } from "./Checkbox";
import { LiveDot } from "./LiveDot";

/** Review-page state surfaced in the modal; absent on pages without a diff. */
export interface ReviewSettings {
  features: FeatureFlags;
  onFeatures: (f: FeatureFlags) => void;
  mode: DiffMode;
  onMode: (m: DiffMode) => void;
  status: WsStatus;
}

type SectionId = "features" | "appearance" | "commands" | "keyboard";

const SECTION_TITLE: Record<SectionId, string> = {
  features: "review features",
  appearance: "appearance",
  commands: "commands",
  keyboard: "keyboard",
};

/* ---------------------------------------------------------------- glyphs */

function CogGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="transition-transform duration-300 motion-safe:group-hover:rotate-45"
    >
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SectionGlyph({ id }: { id: SectionId }) {
  if (id === "features")
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M3 3h10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M5 6.25h8" stroke="currentColor" strokeLinecap="round" />
        <path
          d="M3 9.75h10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M5 13h8" stroke="currentColor" strokeLinecap="round" />
      </svg>
    );
  if (id === "appearance")
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" />
        <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
      </svg>
    );
  if (id === "commands")
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M3 4.5l4 3.5-4 3.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M8.5 12h4.5" stroke="currentColor" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="1.5"
        y="3.5"
        width="13"
        height="9"
        rx="1.5"
        stroke="currentColor"
      />
      <path
        d="M4 6.25h.75M6.75 6.25h.75M9.5 6.25h.75M12.25 6.25h.01M4 8.5h.75M6.75 8.5h.75M9.5 8.5h.75M12 8.5h.25M5.5 10.75h5"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------- option previews */

function ModeArt({ mode }: { mode: DiffMode }) {
  return (
    <svg viewBox="0 0 44 30" fill="none" aria-hidden className="h-auto w-full">
      <rect
        x="0.5"
        y="0.5"
        width="43"
        height="29"
        rx="2.5"
        className="stroke-edge"
      />
      {mode === "unified" ? (
        <>
          <rect
            x="5"
            y="5"
            width="24"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
          <rect
            x="5"
            y="10"
            width="31"
            height="2.5"
            rx="1.25"
            className="fill-del"
          />
          <rect
            x="5"
            y="15"
            width="31"
            height="2.5"
            rx="1.25"
            className="fill-add"
          />
          <rect
            x="5"
            y="20"
            width="19"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
        </>
      ) : mode === "split" ? (
        <>
          <path d="M22 .5v29" className="stroke-edge" />
          <rect
            x="4.5"
            y="5"
            width="12"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
          <rect
            x="4.5"
            y="10"
            width="14"
            height="2.5"
            rx="1.25"
            className="fill-del"
          />
          <rect
            x="4.5"
            y="15"
            width="10"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
          <rect
            x="26"
            y="5"
            width="12"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
          <rect
            x="26"
            y="10"
            width="14"
            height="2.5"
            rx="1.25"
            className="fill-add"
          />
          <rect
            x="26"
            y="15"
            width="10"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
        </>
      ) : (
        <>
          <path d="M.5 15.5h43M22 .5v15" className="stroke-edge" />
          <rect
            x="4.5"
            y="4.5"
            width="12"
            height="2.5"
            rx="1.25"
            className="fill-del"
          />
          <rect
            x="26"
            y="4.5"
            width="14"
            height="2.5"
            rx="1.25"
            className="fill-add"
          />
          <rect
            x="4.5"
            y="9.5"
            width="9"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
          <rect
            x="26"
            y="9.5"
            width="9"
            height="2.5"
            rx="1.25"
            className="fill-mute/50"
          />
          <rect
            x="5"
            y="19.5"
            width="31"
            height="2.5"
            rx="1.25"
            className="fill-add"
          />
          <rect
            x="5"
            y="24"
            width="24"
            height="2.5"
            rx="1.25"
            className="fill-add"
          />
        </>
      )}
    </svg>
  );
}

/* Literal colors: each row previews its own theme, so the art must not
   follow the active token values. */
function ThemeMini({ bg, edge, bar, add, del }: Record<string, string>) {
  return (
    <>
      <rect
        x="0.5"
        y="0.5"
        width="43"
        height="29"
        rx="2.5"
        fill={bg}
        stroke={edge}
      />
      <rect x="5" y="5" width="16" height="2.5" rx="1.25" fill={bar} />
      <rect x="3" y="11" width="38" height="4.5" rx="1" fill={add} />
      <rect x="3" y="17.5" width="38" height="4.5" rx="1" fill={del} />
      <rect x="5" y="25" width="22" height="2" rx="1" fill={bar} />
    </>
  );
}

const THEME_ART_LIGHT = {
  bg: "#f4f5f7",
  edge: "#d8dce2",
  bar: "#a9b1bc",
  add: "#e2efe6",
  del: "#f3e4e1",
};
const THEME_ART_DARK = {
  bg: "#0e1115",
  edge: "#252c36",
  bar: "#414c59",
  add: "#1c2b21",
  del: "#2b1d1a",
};

function ThemeArt({ pref }: { pref: ThemePref }) {
  return (
    <svg viewBox="0 0 44 30" fill="none" aria-hidden className="h-auto w-full">
      {pref === "auto" ? (
        <>
          <clipPath id="theme-art-left">
            <rect x="0" y="0" width="22" height="30" />
          </clipPath>
          <clipPath id="theme-art-right">
            <rect x="22" y="0" width="22" height="30" />
          </clipPath>
          <g clipPath="url(#theme-art-left)">
            <ThemeMini {...THEME_ART_LIGHT} />
          </g>
          <g clipPath="url(#theme-art-right)">
            <ThemeMini {...THEME_ART_DARK} />
          </g>
          <path d="M22 1v28" stroke="#8d97a5" strokeDasharray="2 2" />
        </>
      ) : (
        <ThemeMini {...(pref === "light" ? THEME_ART_LIGHT : THEME_ART_DARK)} />
      )}
    </svg>
  );
}

/* ------------------------------------------------------- section content */

const FEATURE_ROWS: {
  key: keyof FeatureFlags;
  label: string;
  blurb: string;
}[] = [
  {
    key: "grouping",
    label: "group by kind",
    blurb:
      "Order the rail and diff by file class: code, tests, tooling, docs, generated.",
  },
  {
    key: "classDefaults",
    label: "class defaults",
    blurb: "Generated files start collapsed; test bodies fold to their names.",
  },
  {
    key: "importFolds",
    label: "fold imports",
    blurb: "Collapse import blocks at the top of each file.",
  },
  {
    key: "symbols",
    label: "symbol panel",
    blurb: "Click an identifier to list its occurrences across the diff.",
  },
  {
    key: "entities",
    label: "entity outline",
    blurb:
      "Per-file strip of changed functions and classes (needs the sem CLI).",
  },
];

function GroupHeading({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-mute">
        {children}
      </h3>
      {aside}
    </div>
  );
}

function FeatureRow({
  row,
  on,
  hint,
  onToggle,
}: {
  row: (typeof FEATURE_ROWS)[number];
  on: boolean;
  hint?: string;
  onToggle: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 px-3.5 py-3 transition-colors duration-150 hover:bg-raise/40">
      <Checkbox checked={on} onChange={onToggle} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span
            className={cx(
              "font-mono text-[12.5px]",
              on ? "text-accent" : "text-fg",
            )}
          >
            {row.label}
          </span>
          {hint && (
            <kbd className="rounded-sm bg-raise px-1.5 py-0.5 font-mono text-[10.5px] text-mute">
              {hint}
            </kbd>
          )}
        </span>
        <span className="mt-0.5 block text-[11.5px] leading-snug text-mute">
          {row.blurb}
        </span>
      </span>
    </label>
  );
}

function FeaturesSection({
  features,
  onFeatures,
}: {
  features: FeatureFlags;
  onFeatures: (f: FeatureFlags) => void;
}) {
  const onCount = VIEW_FEATURES.filter((k) => features[k]).length;
  const allOn = onCount === VIEW_FEATURES.length;
  const setAll = (v: boolean) => {
    const next = { ...features };
    for (const k of VIEW_FEATURES) next[k] = v;
    onFeatures(next);
  };
  const preset = (active: boolean, label: string, v: boolean) => (
    <button
      type="button"
      onClick={() => setAll(v)}
      className={cx(
        "rounded-sm border px-2 py-0.5 font-mono text-[11px] transition-colors duration-150",
        active
          ? "border-accent/50 bg-accent-soft text-accent"
          : "border-edge text-mute hover:border-mute/60 hover:text-fg",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-6">
      <section>
        <GroupHeading
          aside={
            <span className="flex items-center gap-1.5">
              <span className="mr-1 font-mono text-[10.5px] text-faint">
                {onCount}/{VIEW_FEATURES.length} on
              </span>
              {preset(onCount === 0, "classic", false)}
              {preset(allOn, "semantic", true)}
            </span>
          }
        >
          view
        </GroupHeading>
        <div className="divide-y divide-edge-soft rounded-md border border-edge-soft">
          {FEATURE_ROWS.map((r) => (
            <FeatureRow
              key={r.key}
              row={r}
              on={features[r.key]}
              onToggle={() =>
                onFeatures({ ...features, [r.key]: !features[r.key] })
              }
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] text-faint">
          all off = classic · all on = semantic
        </p>
      </section>
      <section>
        <GroupHeading>pointer</GroupHeading>
        <div className="rounded-md border border-edge-soft">
          <FeatureRow
            row={{
              key: "crosshair",
              label: "crosshair",
              blurb:
                "Pointer line and column highlight over the diff. Not part of the presets.",
            }}
            on={features.crosshair}
            hint="x"
            onToggle={() =>
              onFeatures({ ...features, crosshair: !features.crosshair })
            }
          />
        </div>
      </section>
    </div>
  );
}

function OptionCard({
  active,
  name,
  blurb,
  art,
  onSelect,
}: {
  active: boolean;
  name: string;
  blurb: string;
  art: ReactNode;
  onSelect: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: styled card acting as a radio; a native input would need a full restyle
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cx(
        "flex flex-col gap-1.5 rounded-md border p-2.5 text-left transition-colors duration-150",
        active
          ? "border-accent/60 bg-accent-soft"
          : "border-edge hover:border-mute/60 hover:bg-raise/40",
      )}
    >
      {art}
      <span
        className={cx(
          "font-mono text-[12px]",
          active ? "text-accent" : "text-fg",
        )}
      >
        {name}
      </span>
      <span className="text-[11px] leading-snug text-mute">{blurb}</span>
    </button>
  );
}

const MODE_OPTIONS: { value: DiffMode; blurb: string }[] = [
  {
    value: "unified",
    blurb: "One column — removed and added lines interleaved in order.",
  },
  {
    value: "split",
    blurb: "Two columns — old version on the left, new on the right.",
  },
  {
    value: "mixed",
    blurb:
      "Split, but files with only additions or only deletions render as one column.",
  },
];

const THEME_OPTIONS: { value: ThemePref; blurb: string }[] = [
  { value: "dark", blurb: "Graphite. The native look." },
  { value: "light", blurb: "Ink on paper; diff tints re-inked for daylight." },
  { value: "auto", blurb: "Follows the OS scheme, live." },
];

function AppearanceSection({
  mode,
  onMode,
}: {
  mode: DiffMode;
  onMode: (m: DiffMode) => void;
}) {
  const themePref = useThemePref();
  return (
    <div className="space-y-6">
      <section>
        <GroupHeading>diff layout</GroupHeading>
        <div
          role="radiogroup"
          aria-label="Diff layout"
          className="grid gap-2 sm:grid-cols-3"
        >
          {MODE_OPTIONS.map((o) => (
            <OptionCard
              key={o.value}
              active={mode === o.value}
              name={o.value}
              blurb={o.blurb}
              art={<ModeArt mode={o.value} />}
              onSelect={() => onMode(o.value)}
            />
          ))}
        </div>
      </section>
      <section>
        <GroupHeading>theme</GroupHeading>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid gap-2 sm:grid-cols-3"
        >
          {THEME_OPTIONS.map((o) => (
            <OptionCard
              key={o.value}
              active={themePref === o.value}
              name={o.value}
              blurb={o.blurb}
              art={<ThemeArt pref={o.value} />}
              onSelect={() => setThemePref(o.value)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

const KEY_GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "navigate",
    keys: [
      ["j / k", "next / previous unseen or stale file"],
      ["J / K", "next / previous file"],
      ["n / p", "next / previous hunk, landed at eye level"],
      ["d / u", "scroll half a page down / up"],
      ["g g / G", "jump to the top / bottom"],
    ],
  },
  {
    title: "review",
    keys: [
      ["s, v or .", "toggle seen on the current file"],
      ["c", "comment on the line under the pointer"],
      ["f", "hint labels on visible actions — type one to click it"],
      ["a", "send pending comments to the agent now"],
      ["click id", "symbol panel on: list occurrences of an identifier"],
    ],
  },
  {
    title: "view",
    keys: [
      ["e", "expand / collapse the current file"],
      ["E", "expand every fold in the current file (again folds back)"],
      ["z", "collapse / expand the hunk under the pointer, else at eye level"],
      ["x", "toggle pointer crosshair (line/column/word/char)"],
      ["?", "open this cheatsheet"],
      ["Esc", "close dialogs and panels"],
    ],
  },
];

function KeyboardSection({ onReviewPage }: { onReviewPage: boolean }) {
  return (
    <div className="space-y-6">
      {KEY_GROUPS.map((g) => (
        <section key={g.title}>
          <GroupHeading>{g.title}</GroupHeading>
          <dl className="space-y-2.5">
            {g.keys.map(([key, desc]) => (
              <div key={key} className="flex items-baseline gap-3">
                <dt className="w-20 shrink-0 rounded-sm bg-raise px-1.5 py-0.5 text-center font-mono text-[11px] text-fg">
                  {key}
                </dt>
                <dd className="text-[12px] text-mute">{desc}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {!onReviewPage && (
        <p className="text-[11px] text-faint">
          Shortcuts apply on the review page.
        </p>
      )}
    </div>
  );
}

function CommandEditor({
  title,
  description,
  field,
  presets,
  placeholders,
  ariaLabel,
  saved,
  loading,
}: {
  title: ReactNode;
  description: ReactNode;
  field: "worktreeCreate" | "sessionSpawn";
  presets: CommandPreset[];
  placeholders: Record<string, string>;
  ariaLabel: string;
  saved: string;
  loading: boolean;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const save = useMutation({
    mutationFn: (template: string) => api.putCommands({ [field]: template }),
    onSuccess: (res) => {
      qc.setQueryData(["commands"], res);
      setDraft(null);
    },
  });
  const dirty = draft !== null && draft !== saved;
  return (
    <section>
      <GroupHeading>{title}</GroupHeading>
      <p className="mb-3 text-[11.5px] leading-snug text-mute">{description}</p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.name}
            type="button"
            title={`${p.blurb}\n${p.template}`}
            onClick={() => setDraft(p.template)}
            className={cx(
              "rounded-sm border px-2 py-0.5 font-mono text-[11px] transition-colors duration-150",
              value === p.template
                ? "border-accent/50 text-accent"
                : "border-edge text-mute hover:border-accent/50 hover:text-fg",
            )}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={loading ? "loading…" : value}
          disabled={loading}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) save.mutate(value);
          }}
          aria-label={ariaLabel}
          className="min-w-0 flex-1 rounded-sm border border-edge bg-panel px-2.5 py-1.5 font-mono text-[12px] text-fg transition-colors duration-150 focus:border-accent/50"
        />
        <button
          type="button"
          onClick={() => save.mutate(value)}
          disabled={!dirty || save.isPending}
          className="shrink-0 rounded-sm border border-edge px-2.5 py-1.5 font-mono text-[11.5px] text-mute transition-colors duration-150 hover:border-accent/50 hover:text-fg disabled:opacity-50 disabled:hover:border-edge disabled:hover:text-mute"
        >
          {save.isPending ? "saving…" : dirty ? "save" : "saved"}
        </button>
      </div>
      {save.isError && (
        <p className="mt-1.5 text-[11.5px] text-del">{(save.error as Error).message}</p>
      )}
      <dl className="mt-3 space-y-1">
        {Object.entries(placeholders).map(([ph, desc]) => (
          <div key={ph} className="flex items-baseline gap-3">
            <dt className="w-24 shrink-0 rounded-sm bg-raise px-1.5 py-0.5 text-center font-mono text-[11px] text-fg">
              {ph}
            </dt>
            <dd className="text-[11.5px] text-mute">{desc}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The commands the server runs for UI actions. Presets autofill the input;
 * nothing is saved until the save button.
 */
function CommandsSection() {
  const cmdQ = useQuery({ queryKey: ["commands"], queryFn: api.getCommands });
  return (
    <div className="space-y-6">
      <CommandEditor
        title="worktree creation"
        description={
          <>
            Run for “+ worktree” on a PR branch. Split into argv (quotes group,
            no shell), executed in the repo's main checkout after a{" "}
            <code className="font-mono text-[11px]">git fetch origin</code>.
          </>
        }
        field="worktreeCreate"
        presets={WORKTREE_CMD_PRESETS}
        placeholders={WORKTREE_CMD_PLACEHOLDERS}
        ariaLabel="Worktree create command"
        saved={cmdQ.data?.worktreeCreate ?? ""}
        loading={cmdQ.isPending}
      />
      <CommandEditor
        title="session spawn"
        description={
          <>
            Run when comments are sent to a checkout with no agent session
            listening; the batch is held until the new session's watcher picks
            it up. Executed in the checkout. Empty = never spawn (comments just
            queue).
          </>
        }
        field="sessionSpawn"
        presets={SESSION_SPAWN_PRESETS}
        placeholders={SESSION_SPAWN_PLACEHOLDERS}
        ariaLabel="Session spawn command"
        saved={cmdQ.data?.sessionSpawn ?? ""}
        loading={cmdQ.isPending}
      />
      <p className="text-[11px] leading-snug text-faint">
        Anyone who can reach rev can change these commands — trusted networks
        only.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------- the control */

const STATUS_NOTE: Record<WsStatus, string> = {
  live: "diffs and comments update in realtime",
  fixture: "fixture mode — canned data, no server",
  connecting: "connecting to the rev server…",
  reconnecting: "connection lost — retrying with backoff",
};

/**
 * Header cog + centered settings modal. Global `?` opens the keyboard
 * section (and toggles it closed again); Esc closes. The Esc listener runs
 * in the capture phase and stops propagation so page-level Esc handlers
 * (symbol panel) don't also fire while the modal is up.
 */
export function SettingsControl({ review }: { review?: ReviewSettings }) {
  const sections: SectionId[] = [
    "features",
    "appearance",
    "commands",
    "keyboard",
  ];
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SectionId>("features");

  // Off the review page there is no live state to bind to, so the modal
  // edits the same server-backed store the next review will load from.
  const [stored, setStored] = useState(() => ({
    features: loadFeatures(new URLSearchParams()),
    mode: loadDiffMode(),
  }));
  const features = review?.features ?? stored.features;
  const onFeatures =
    review?.onFeatures ??
    ((f: FeatureFlags) => {
      saveFeatures(f);
      setStored((s) => ({ ...s, features: f }));
    });
  const mode = review?.mode ?? stored.mode;
  const onMode =
    review?.onMode ??
    ((m: DiffMode) => {
      saveDiffMode(m);
      setStored((s) => ({ ...s, mode: m }));
    });
  const openRef = useRef(open);
  openRef.current = open;
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "?") return;
      e.preventDefault();
      if (openRef.current && sectionRef.current === "keyboard") {
        setOpen(false);
        btnRef.current?.focus();
      } else {
        setSection("keyboard");
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Tab") {
        // Minimal focus trap: wrap Tab / Shift-Tab at the panel's edges.
        const els = panelRef.current?.querySelectorAll<HTMLElement>(
          'button, input, [href], select, [tabindex]:not([tabindex="-1"])',
        );
        if (!els || els.length === 0) return;
        const first = els[0]!;
        const last = els[els.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panelRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Settings"
        aria-haspopup="dialog"
        className="group relative flex items-center self-stretch px-3 text-mute transition-colors duration-150 hover:bg-raise/60 hover:text-fg"
      >
        <CogGlyph />
        {review && review.status !== "live" && (
          <span
            title={STATUS_NOTE[review.status]}
            className={cx(
              "absolute right-2 top-3.5 size-1.5 rounded-full",
              review.status === "fixture" && "bg-agent",
              review.status === "connecting" && "bg-mute",
              review.status === "reconnecting" && "bg-del",
            )}
          />
        )}
      </button>

      {open && (
        <div
          className="backdrop-in fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]"
          onClick={close}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            ref={panelRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="modal-in flex max-h-[min(760px,100%)] w-full max-w-[860px] flex-col overflow-hidden rounded-md border border-edge bg-panel shadow-pop outline-none sm:h-[min(700px,100%)] sm:flex-row"
          >
            <nav
              aria-label="Settings sections"
              className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-edge-soft bg-raise/30 p-2 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r"
            >
              <div className="hidden px-2.5 pb-2.5 pt-1.5 sm:block">
                <span className="font-mono text-[13px] font-bold text-fg">
                  rev<span className="text-accent">_</span>
                </span>
                <span className="ml-1.5 text-[11px] text-faint">settings</span>
              </div>
              {sections.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-current={section === id || undefined}
                  onClick={() => setSection(id)}
                  className={cx(
                    "flex shrink-0 items-center gap-2 rounded-sm px-2.5 py-1.5 text-left font-mono text-[12px] transition-colors duration-150",
                    section === id
                      ? "bg-accent-soft text-accent"
                      : "text-mute hover:bg-raise/60 hover:text-fg",
                  )}
                >
                  <SectionGlyph id={id} />
                  {id}
                </button>
              ))}
            </nav>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-edge-soft py-2 pl-5 pr-2.5">
                <h2 className="text-[13px] font-semibold text-fg">
                  {SECTION_TITLE[section]}
                </h2>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close settings"
                  className="grid size-7 place-items-center rounded-sm text-mute transition-colors duration-150 hover:bg-raise hover:text-fg"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {section === "features" && (
                  <FeaturesSection
                    features={features}
                    onFeatures={onFeatures}
                  />
                )}
                {section === "appearance" && (
                  <AppearanceSection mode={mode} onMode={onMode} />
                )}
                {section === "commands" && <CommandsSection />}
                {section === "keyboard" && (
                  <KeyboardSection onReviewPage={review != null} />
                )}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-edge-soft px-5 py-2">
                {review ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <LiveDot status={review.status} />
                    <span className="truncate text-[11px] text-faint">
                      {STATUS_NOTE[review.status]}
                    </span>
                  </span>
                ) : (
                  <span className="text-[11px] text-faint">
                    saved on the server — shared by every browser
                  </span>
                )}
                <span className="shrink-0 font-mono text-[10.5px] text-faint">
                  ? keyboard · esc close
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
