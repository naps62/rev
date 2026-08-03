import { useEffect, useRef, useState, type ReactNode } from "react";

/** 0fr↔1fr grid slide, same curve as .file-body / .side-panel. Mounts closed
 * and opens a frame later; when `open` flips false the content slides shut and
 * `onExited` fires afterwards so the parent can unmount. */
export function Reveal({
  open,
  onExited,
  children,
}: {
  open: boolean;
  onExited?: () => void;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const exitRef = useRef(onExited);
  exitRef.current = onExited;

  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    // Timer, not transitionend: reduced-motion disables the transition and
    // would swallow the event, leaving the parent mounted forever.
    const t = setTimeout(() => exitRef.current?.(), 260);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <div className="reveal" data-open={shown || undefined}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
