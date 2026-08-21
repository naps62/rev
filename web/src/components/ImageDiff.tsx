import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useState,
} from "react";
import type { FileStatus } from "#shared/types";

interface ImageDiffProps {
  oldSrc?: string;
  newSrc?: string;
  status: FileStatus;
}

type LoadState = "loading" | "loaded" | "error";
type ImageSize = { width: number; height: number };

export function ImageDiff({ oldSrc, newSrc, status }: ImageDiffProps) {
  const [split, setSplit] = useState(50);
  const [oldState, setOldState] = useState<LoadState>(
    oldSrc ? "loading" : "loaded",
  );
  const [newState, setNewState] = useState<LoadState>(
    newSrc ? "loading" : "loaded",
  );
  const [oldSize, setOldSize] = useState<ImageSize>();
  const [newSize, setNewSize] = useState<ImageSize>();

  useEffect(() => {
    setOldState(oldSrc ? "loading" : "loaded");
    setOldSize(undefined);
  }, [oldSrc]);
  useEffect(() => {
    setNewState(newSrc ? "loading" : "loaded");
    setNewSize(undefined);
  }, [newSrc]);

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setSplit(
      Math.max(
        0,
        Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100),
      ),
    );
  };

  const adjustWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = split;
    if (event.key === "ArrowLeft") next -= event.shiftKey ? 10 : 2;
    else if (event.key === "ArrowRight") next += event.shiftKey ? 10 : 2;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 100;
    else return;
    event.preventDefault();
    setSplit(Math.max(0, Math.min(100, next)));
  };

  const roundedSplit = Math.round(split);
  const dimensionsKnown = oldSize != null || newSize != null;
  const frameWidth = dimensionsKnown
    ? Math.max(oldSize?.width ?? 0, newSize?.width ?? 0, 1)
    : 320;
  const frameHeight = dimensionsKnown
    ? Math.max(oldSize?.height ?? 0, newSize?.height ?? 0, 1)
    : 320;
  return (
    <div className="bg-bg/40 p-3 max-sm:p-2">
      <div
        className="image-diff-stage"
        style={{
          width: `min(100%, ${frameWidth}px, ${((72 * frameWidth) / frameHeight).toFixed(4)}vh)`,
          aspectRatio: `${frameWidth} / ${frameHeight}`,
        }}
        role="slider"
        tabIndex={0}
        aria-label="Old and new image comparison"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedSplit}
        aria-valuetext={`${roundedSplit}% old image, ${100 - roundedSplit}% new image`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event);
        }}
        onPointerMove={updateFromPointer}
        onKeyDown={adjustWithKeyboard}
      >
        <ImageSide
          side="new"
          src={newSrc}
          state={newState}
          absentLabel={status === "deleted" ? "Image deleted" : "No new image"}
          onLoad={(size) => {
            setNewSize(size);
            setNewState("loaded");
          }}
          onError={() => setNewState("error")}
        />
        <div
          className="absolute inset-0 bg-panel"
          style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
          aria-hidden
        >
          <ImageSide
            side="old"
            src={oldSrc}
            state={oldState}
            absentLabel={
              status === "added" || status === "untracked"
                ? "Image added"
                : "No old image"
            }
            onLoad={(size) => {
              setOldSize(size);
              setOldState("loaded");
            }}
            onError={() => setOldState("error")}
          />
        </div>

        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent shadow-[0_0_0_1px_rgb(14_17_21/.65)]"
          style={{ left: `${split}%` }}
        >
          <span className="image-diff-handle absolute left-1/2 top-1/2 grid h-9 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-accent/60 bg-raise shadow-pop">
            <svg
              width="12"
              height="14"
              viewBox="0 0 12 14"
              fill="none"
              aria-hidden
            >
              <path
                d="M4.5 3 1.5 7l3 4M7.5 3l3 4-3 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>

        <span className="image-diff-label pointer-events-none absolute left-2 top-2 z-30 border border-edge bg-bg/90 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-mute">
          old
        </span>
        <span className="image-diff-label pointer-events-none absolute right-2 top-2 z-30 border border-edge bg-bg/90 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-mute">
          new
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10.5px] text-faint">
        <span>Move across the image · Arrow keys adjust</span>
        <span className="shrink-0 tabular-nums">
          old {roundedSplit}% · new {100 - roundedSplit}%
        </span>
      </div>
    </div>
  );
}

function ImageSide({
  side,
  src,
  state,
  absentLabel,
  onLoad,
  onError,
}: {
  side: "old" | "new";
  src?: string;
  state: LoadState;
  absentLabel: string;
  onLoad: (size: ImageSize) => void;
  onError: () => void;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center">
      {src && state !== "error" && (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(event) =>
            onLoad({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={onError}
          className={`max-h-full max-w-full select-none object-contain transition-opacity duration-150 ${state === "loaded" ? "opacity-100" : "opacity-0"}`}
        />
      )}
      {state !== "loaded" && (
        <span className="absolute font-mono text-[11px] text-faint">
          {state === "loading"
            ? `Loading ${side} image…`
            : `${side === "old" ? "Old" : "New"} image couldn't load`}
        </span>
      )}
      {!src && (
        <span className="font-mono text-[11px] text-faint">{absentLabel}</span>
      )}
    </div>
  );
}
