import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Comment,
  CommentAnchor,
  CommentPatchRequest,
  VisualHostMessage,
  VisualOverlayMessage,
  VisualSession,
} from "#shared/types";
import * as api from "../api";
import { AppHeader, HEADER_PX } from "../components/AppHeader";
import { CommentThread } from "../components/CommentThread";
import { Composer } from "../components/Composer";
import { PendingSubmit } from "../components/PendingSubmit";
import { buildThreads, cx } from "../util";
import { useRevSocket } from "../ws";
import { useSearch } from "wouter";

/**
 * Visual review (#71): the target page in an iframe with a pin overlay.
 * Threads reuse the whole comments pipeline (pending batch, agent long-poll,
 * replies, resolve) keyed to `dir` like any code review.
 *
 * Two modes:
 * - overlay: the page is framed through the injecting proxy
 *   (POST /api/visual/sessions), which serves server/overlay.js inside it.
 *   The overlay does element picking and renders pins in-page (they track
 *   scroll/layout); the dashboard talks to it over postMessage
 *   (VisualOverlayMessage / VisualHostMessage) and anchors comments to a
 *   CSS selector + offset, falling back to viewport coordinates.
 * - fallback (no proxy session, or the overlay never reported ready): the
 *   original spike behavior — direct iframe, comment-mode click shield,
 *   dashboard-rendered pins at fractional frame coordinates.
 */

/** How long to wait for rev-overlay-ready before falling back to coordinates. */
const OVERLAY_READY_TIMEOUT_MS = 3000;

type Mode = "connecting" | "overlay" | "fallback";

interface Draft {
  x: number;
  y: number;
  selector?: string;
  ex?: number;
  ey?: number;
  outerHtml?: string;
}

export function Visual() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const dir = params.get("dir") ?? "";
  const url = params.get("url") ?? "";
  const base = params.get("base") ?? "visual";
  const qc = useQueryClient();

  const commentsQ = useQuery({
    queryKey: ["comments", dir],
    queryFn: () => api.getComments(dir),
    enabled: !!dir,
  });
  useRevSocket(dir || undefined, (msg) => {
    if (msg.type === "comments-changed" && msg.dir === dir) {
      qc.invalidateQueries({ queryKey: ["comments", dir] });
    }
  });
  const createMut = useMutation({
    mutationFn: api.postComment,
    onSettled: () => qc.invalidateQueries({ queryKey: ["comments", dir] }),
  });
  const patchMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CommentPatchRequest }) =>
      api.patchComment(id, patch),
    onSettled: () => qc.invalidateQueries({ queryKey: ["comments", dir] }),
  });

  const [mode, setMode] = useState<Mode>("connecting");
  const [session, setSession] = useState<VisualSession | null>(null);
  // Bumped per rev-overlay-ready so mode/pins are re-pushed after the framed
  // app does a full page load (each load boots a fresh overlay instance).
  const [readySeq, setReadySeq] = useState(0);
  // URL threads are filtered by; starts as the target and follows rev-route.
  const [pageUrl, setPageUrl] = useState(url);
  const [commentMode, setCommentMode] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [openPin, setOpenPin] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const postToFrame = useCallback((msg: VisualHostMessage) => {
    frameRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    api.createVisualSession(url).then(
      (s) => {
        if (!cancelled) setSession(s);
      },
      () => {
        if (!cancelled) setMode("fallback");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!session || mode !== "connecting") return;
    const t = setTimeout(() => setMode("fallback"), OVERLAY_READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [session, mode]);

  // The proxy serves the target's origin; the dashboard host reaches it by
  // its own hostname so LAN access keeps working.
  const proxySrc = useMemo(() => {
    if (!session) return null;
    try {
      const target = new URL(session.targetUrl);
      return `http://${location.hostname}:${session.port}${target.pathname}${target.search}`;
    } catch {
      return null;
    }
  }, [session]);
  const frameSrc = mode === "fallback" ? url : (proxySrc ?? (session ? url : null));

  // Overlay messages carry the proxy origin; anchors store the target's.
  const toTargetUrl = useCallback(
    (overlayUrl: string) => {
      try {
        const u = new URL(overlayUrl);
        const t = new URL(url);
        return `${t.origin}${u.pathname}${u.search}${u.hash}`;
      } catch {
        return url;
      }
    },
    [url],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const msg = e.data as VisualOverlayMessage | null;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "rev-overlay-ready":
          setMode("overlay");
          setReadySeq((n) => n + 1);
          setPageUrl(toTargetUrl(msg.url));
          break;
        case "rev-pick":
          setOpenPin(null);
          setDraft({
            x: msg.x,
            y: msg.y,
            selector: msg.selector,
            ex: msg.ex,
            ey: msg.ey,
            outerHtml: msg.outerHtml,
          });
          break;
        case "rev-pin-click":
          setDraft(null);
          setOpenPin((cur) => (cur === msg.id ? null : msg.id));
          break;
        case "rev-route":
          setPageUrl(toTargetUrl(msg.url));
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [toTargetUrl]);

  const threads = buildThreads(commentsQ.data?.comments ?? []).filter(
    (t) => t.root.anchor?.visual?.url === pageUrl,
  );

  // Overlay renders the pins in-page; push the set whenever it changes.
  const pinsKey = JSON.stringify(
    threads.map((t, i) => ({
      id: t.root.id,
      n: i + 1,
      resolved: t.root.resolvedAt != null,
      anchor: t.root.anchor!.visual!,
    })),
  );
  useEffect(() => {
    if (mode !== "overlay") return;
    postToFrame({ type: "rev-pins", pins: JSON.parse(pinsKey) });
  }, [mode, readySeq, pinsKey, postToFrame]);

  useEffect(() => {
    if (mode !== "overlay") return;
    postToFrame({ type: "rev-mode", pick: commentMode });
  }, [mode, readySeq, commentMode, postToFrame]);

  const submitDraft = (body: string) => {
    if (!draft) return;
    const anchor: CommentAnchor = {
      file: pageUrl,
      side: "new",
      line: 0,
      snippet: "",
      visual: {
        url: pageUrl,
        x: draft.x,
        y: draft.y,
        ...(draft.selector !== undefined && {
          selector: draft.selector,
          ex: draft.ex,
          ey: draft.ey,
          outerHtml: draft.outerHtml,
        }),
      },
    };
    createMut.mutate({ dir, base, anchor, author: "user", body, pending: true });
    setDraft(null);
    setCommentMode(false);
  };

  const reply = (root: Comment, body: string) =>
    createMut.mutate({ dir, base: root.base, parentId: root.id, author: "user", body, pending: true });
  const resolve = (root: Comment, resolved: boolean) =>
    patchMut.mutate({ id: root.id, patch: { resolved } });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") {
        e.preventDefault();
        setDraft(null);
        setCommentMode((v) => !v);
      } else if (e.key === "Escape") {
        setDraft(null);
        setOpenPin(null);
        setCommentMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setOpenPin(null);
    setDraft({
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
  };

  // Pin popovers open toward the free side so edge pins stay on screen.
  const popSide = (x: number) => (x > 0.6 ? "right" : "left");

  if (!dir || !url) {
    return (
      <div className="min-h-screen">
        <AppHeader />
        <div className="mx-auto mt-24 w-full max-w-md rounded-md border border-edge bg-panel px-6 py-6 text-center">
          <p className="text-[13px] text-del">Missing {!dir ? "dir" : "url"} parameter.</p>
          <p className="mt-1 text-[12px] text-mute">
            Expected /visual?dir=&lt;abs path&gt;&amp;url=&lt;page to review&gt;.
          </p>
        </div>
      </div>
    );
  }

  const openThread = openPin ? threads.find((t) => t.root.id === openPin) : undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader>
        <span className="min-w-0 items-center truncate font-mono text-[12px] text-mute">
          visual · <span className="text-fg">{pageUrl}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="font-mono text-[11px] text-faint max-sm:hidden">
            {mode === "overlay"
              ? "element anchors"
              : mode === "fallback"
                ? "coordinates only"
                : "connecting…"}
          </span>
          <span className="font-mono text-[11px] text-faint max-sm:hidden">
            {threads.filter((t) => t.root.resolvedAt == null).length} open ·{" "}
            {threads.length} pin{threads.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              setCommentMode((v) => !v);
            }}
            aria-pressed={commentMode}
            className={cx(
              "rounded-sm border px-2 py-0.5 font-mono text-[11.5px] transition-colors duration-150",
              commentMode
                ? "border-accent/50 bg-accent-soft text-accent"
                : "border-edge text-mute hover:border-accent/50 hover:text-fg",
            )}
          >
            {commentMode ? "click to pin — c to cancel" : "comment (c)"}
          </button>
        </div>
      </AppHeader>

      {dir && <PendingSubmit dir={dir} comments={commentsQ.data?.comments ?? []} />}

      <div ref={stageRef} className="relative min-h-0 flex-1">
        {frameSrc && (
          <iframe
            ref={frameRef}
            src={frameSrc}
            title={`visual review of ${url}`}
            className="size-full border-0 bg-white"
          />
        )}
        {/* Fallback comment-mode shield: swallows clicks so the frame doesn't
            get them. In overlay mode the frame itself handles pick clicks. */}
        {commentMode && mode !== "overlay" && (
          <div
            onClick={stageClick}
            className="absolute inset-0 cursor-crosshair bg-accent/5"
          />
        )}

        {/* Fallback pins: dashboard-rendered at frame coordinates. In overlay
            mode the page renders pins itself; only the popover lives here. */}
        {mode !== "overlay" &&
          threads.map((t, i) => {
            const v = t.root.anchor!.visual!;
            const resolved = t.root.resolvedAt != null;
            return (
              <div
                key={t.root.id}
                className="absolute"
                style={{ left: `${v.x * 100}%`, top: `${v.y * 100}%` }}
              >
                <button
                  type="button"
                  onClick={() => setOpenPin((cur) => (cur === t.root.id ? null : t.root.id))}
                  title={t.root.body}
                  className={cx(
                    "grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border font-mono text-[11px] font-bold shadow-pop transition-transform hover:scale-110",
                    resolved
                      ? "border-edge bg-panel text-faint opacity-70"
                      : "border-accent bg-accent text-bg",
                  )}
                >
                  {i + 1}
                </button>
                {openPin === t.root.id && (
                  <PinPopover side={popSide(v.x)} y={v.y}>
                    <CommentThread
                      thread={t}
                      onReply={(body) => reply(t.root, body)}
                      onResolve={(r) => resolve(t.root, r)}
                    />
                  </PinPopover>
                )}
              </div>
            );
          })}

        {mode === "overlay" && openThread && openThread.root.anchor?.visual && (
          <div
            className="absolute"
            style={{
              left: `${openThread.root.anchor.visual.x * 100}%`,
              top: `${openThread.root.anchor.visual.y * 100}%`,
            }}
          >
            <PinPopover
              side={popSide(openThread.root.anchor.visual.x)}
              y={openThread.root.anchor.visual.y}
            >
              <CommentThread
                thread={openThread}
                onReply={(body) => reply(openThread.root, body)}
                onResolve={(r) => resolve(openThread.root, r)}
              />
            </PinPopover>
          </div>
        )}

        {draft && (
          <div
            className="absolute"
            style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
          >
            <span className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent bg-accent-soft p-1.5 shadow-pop">
              <span className="block size-2 rounded-full bg-accent" />
            </span>
            <PinPopover side={popSide(draft.x)} y={draft.y}>
              <div className="rounded-md border border-edge bg-panel shadow-pop">
                <Composer
                  placeholder={
                    draft.selector ? "Comment on this element…" : "Comment on this spot…"
                  }
                  autoFocus
                  onSubmit={submitDraft}
                  onCancel={() => setDraft(null)}
                />
              </div>
            </PinPopover>
          </div>
        )}
      </div>
    </div>
  );
}

/** Thread/composer bubble beside a pin, flipped to whichever side has room. */
function PinPopover({
  side,
  y,
  children,
}: {
  side: "left" | "right";
  y: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "absolute z-10 w-80 overflow-y-auto",
        side === "left" ? "left-4" : "right-4",
        y > 0.6 ? "bottom-4" : "top-4",
      )}
      style={{ maxHeight: `calc((100vh - ${HEADER_PX}px) * 0.6)` }}
    >
      {children}
    </div>
  );
}
