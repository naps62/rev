import { cx } from "../util";
import type { WsStatus } from "../ws";

const LABEL: Record<WsStatus, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  fixture: "fixture",
};

export function LiveDot({ status }: { status: WsStatus }) {
  return (
    <span
      title={
        status === "live"
          ? "Connected — diffs and comments update in realtime"
          : status === "fixture"
            ? "Fixture mode — serving canned data, no server"
            : "Not connected — retrying with backoff"
      }
      className="flex items-center gap-1.5 font-mono text-[11px] text-mute"
    >
      <span
        className={cx(
          "size-1.5 rounded-full",
          status === "live" && "bg-add",
          status === "fixture" && "bg-agent",
          status === "connecting" && "bg-mute",
          status === "reconnecting" && "bg-del",
        )}
      />
      <span className="max-sm:hidden">{LABEL[status]}</span>
    </span>
  );
}
