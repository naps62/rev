import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Comment } from "#shared/types";
import { TUNING } from "#shared/tuning";
import * as api from "../api";

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

/**
 * Auto-submit for pending comments, plus the floating pill that surfaces it.
 * The batch ships on whichever comes first: the Send button, an idle window
 * with no new comments (typing in a composer counts as activity), or a
 * shorter fuse after the page is hidden — so an active review pass lands as
 * one batch without the user having to remember to send it.
 */
export function PendingSubmit({ dir, comments }: { dir: string; comments: Comment[] }) {
  const qc = useQueryClient();
  const pending = comments.filter((c) => c.status === "pending");
  const count = pending.length;
  const maxSeq = pending.reduce((m, c) => Math.max(m, c.seq), 0);

  const submitMut = useMutation({
    mutationFn: () => api.submitComments(dir),
    onSettled: () => qc.invalidateQueries({ queryKey: ["comments", dir] }),
  });

  const [deadline, setDeadline] = useState<number | null>(null);
  const armed = count > 0;

  // Whether an agent session is listening — when not and spawning is
  // configured, Send will start one first (the server holds the batch).
  const agentQ = useQuery({
    queryKey: ["agent", dir],
    queryFn: () => api.getAgentStatus(dir),
    enabled: armed,
    refetchInterval: 15_000,
  });
  const willSpawn =
    agentQ.data != null && !agentQ.data.listening && agentQ.data.spawnConfigured;

  // A new pending comment (maxSeq moves) restarts the idle window.
  useEffect(() => {
    setDeadline(armed ? Date.now() + TUNING.PENDING_IDLE_SUBMIT_MS : null);
  }, [armed, maxSeq]);

  // Typing in any composer is activity — don't ship the batch mid-thought.
  useEffect(() => {
    if (!armed) return;
    const onInput = (e: Event) => {
      if ((e.target as HTMLElement | null)?.tagName === "TEXTAREA") {
        setDeadline(Date.now() + TUNING.PENDING_IDLE_SUBMIT_MS);
      }
    };
    window.addEventListener("input", onInput, true);
    return () => window.removeEventListener("input", onInput, true);
  }, [armed]);

  // Hiding the page lights a shorter fuse; coming back restores the idle
  // window, so a quick alt-tab doesn't ship a half-finished review.
  useEffect(() => {
    if (!armed) return;
    const onVisibility = () =>
      setDeadline(
        Date.now() +
          (document.visibilityState === "hidden"
            ? TUNING.PENDING_BLUR_SUBMIT_MS
            : TUNING.PENDING_IDLE_SUBMIT_MS),
      );
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [armed]);

  const fireRef = useRef<() => void>(() => {});
  fireRef.current = () => {
    if (count > 0 && !submitMut.isPending) submitMut.mutate();
    setDeadline(null);
  };
  useEffect(() => {
    if (deadline == null) return;
    const t = setTimeout(() => fireRef.current(), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(t);
  }, [deadline]);

  // `a` ships the batch immediately, same as the Send now button.
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "a" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
      e.preventDefault();
      fireRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  // 1s tick for the countdown text only; firing is the timeout above.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);

  if (count === 0 && !submitMut.isPending) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2.5 rounded-md border border-edge bg-panel py-1.5 pl-3 pr-1.5 shadow-pop">
      <span className="inline-block size-[7px] rounded-[1px] bg-accent" aria-hidden />
      <span className="text-[12px] text-fg">
        {count} pending comment{count === 1 ? "" : "s"}
      </span>
      {deadline != null && count > 0 && (
        <span className="font-mono text-[11px] tabular-nums text-faint" title="Auto-sends to the agent when you go idle or leave the page">
          sends in {countdown(deadline - now)}
        </span>
      )}
      {submitMut.isError && (
        <span
          className="max-w-56 truncate text-[11px] text-del"
          title={(submitMut.error as Error).message}
        >
          {(submitMut.error as Error).message}
        </span>
      )}
      {willSpawn && !submitMut.isPending && (
        <span
          className="text-[11px] text-faint"
          title="No agent session is listening on this checkout — sending starts one first"
        >
          no session — send starts one
        </span>
      )}
      <button
        type="button"
        disabled={submitMut.isPending}
        title={
          willSpawn
            ? "Start an agent session and send the batch to it (a)"
            : "Send the batch to the agent now (a)"
        }
        onClick={() => fireRef.current()}
        className="rounded-sm border border-accent/40 px-2 py-0.5 text-[12px] text-accent transition-colors duration-150 hover:bg-accent hover:text-bg disabled:cursor-default disabled:border-edge disabled:text-faint"
      >
        {submitMut.isPending ? (willSpawn ? "starting session…" : "sending…") : "Send now"}
      </button>
    </div>
  );
}
