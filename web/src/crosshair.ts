/**
 * Vim-style pointer crosshair over the diff tables: cursorline/cursorcolumn
 * washes, a box around the word and the character under the pointer, and a
 * line:col badge at the row's edge. Pure DOM — the overlay repositions on
 * rAF-throttled mousemove, so nothing re-renders in React.
 *
 * Geometry comes from the caret APIs (caretPositionFromPoint), which resolve
 * the exact character even when a long line soft-wraps.
 */

/** Text nodes that make up the line content, in order. Skips the absolutely
 *  positioned overlays inside the cell (comment button, rail) — same rule as
 *  tokenFromPoint in DiffFile. */
function textNodesOf(cell: HTMLElement): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n as Text);
      return;
    }
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.tagName === "BUTTON" || el.hasAttribute("aria-hidden")) return;
      for (const c of Array.from(n.childNodes)) walk(c);
    }
  };
  walk(cell);
  return out;
}

function rangeFor(nodes: Text[], start: number, end: number): Range | null {
  const r = document.createRange();
  let acc = 0;
  let started = false;
  for (const n of nodes) {
    if (!started && start <= acc + n.length) {
      r.setStart(n, Math.max(0, start - acc));
      started = true;
    }
    if (started && end <= acc + n.length) {
      r.setEnd(n, Math.max(0, end - acc));
      return r;
    }
    acc += n.length;
  }
  return null;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

const WORD = /[\w$]/;

export function attachCrosshair(container: HTMLElement): () => void {
  const prevPosition = container.style.position;
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  const root = document.createElement("div");
  root.className = "xh-root";
  root.setAttribute("aria-hidden", "true");
  const mk = (cls: string) => {
    const el = document.createElement("div");
    el.className = cls;
    root.appendChild(el);
    return el;
  };
  const lineEl = mk("xh-line");
  const colEl = mk("xh-col");
  const wordEl = mk("xh-word");
  const charEl = mk("xh-char");
  const badgeEl = mk("xh-badge");
  container.appendChild(root);

  const parts = [lineEl, colEl, wordEl, charEl, badgeEl];
  const hide = (...els: HTMLElement[]) => {
    for (const el of els) el.style.display = "none";
  };
  const place = (el: HTMLElement, r: DOMRect, c: DOMRect) => {
    el.style.display = "block";
    el.style.left = `${r.left - c.left}px`;
    el.style.top = `${r.top - c.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  };

  let raf = 0;
  let px = 0;
  let py = 0;
  let target: Element | null = null;

  const update = () => {
    raf = 0;
    const row = target?.closest<HTMLElement>("tr[data-lk]");
    const table = row?.closest("table");
    if (!row || !table || !container.contains(row)) {
      hide(...parts);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const tRect = table.getBoundingClientRect();

    // cursorline: the hovered row, clipped to its table's width.
    lineEl.style.display = "block";
    lineEl.style.left = `${tRect.left - cRect.left}px`;
    lineEl.style.width = `${tRect.width}px`;
    lineEl.style.top = `${rowRect.top - cRect.top}px`;
    lineEl.style.height = `${rowRect.height}px`;

    // Everything else needs a caret hit inside a code cell of this row.
    const hit = caretAt(px, py);
    const cell =
      hit?.node.nodeType === Node.TEXT_NODE
        ? hit.node.parentElement?.closest<HTMLElement>("td[data-code]")
        : null;
    if (!hit || !cell || !row.contains(cell)) {
      hide(colEl, wordEl, charEl, badgeEl);
      return;
    }
    const nodes = textNodesOf(cell);
    let off = -1;
    let acc = 0;
    for (const n of nodes) {
      if (n === hit.node) {
        off = acc + hit.offset;
        break;
      }
      acc += n.length;
    }
    const text = nodes.map((n) => n.data).join("");
    if (off < 0 || text.length === 0) {
      hide(colEl, wordEl, charEl, badgeEl);
      return;
    }
    // Past-end caret (pointer right of the text) clamps to the last char.
    off = Math.min(off, text.length - 1);

    const charRect = rangeFor(nodes, off, off + 1)?.getBoundingClientRect();
    if (!charRect || charRect.width === 0) {
      hide(colEl, wordEl, charEl, badgeEl);
      return;
    }
    place(charEl, charRect, cRect);

    // cursorcolumn: one character wide, spanning the whole table.
    colEl.style.display = "block";
    colEl.style.left = `${charRect.left - cRect.left}px`;
    colEl.style.width = `${charRect.width}px`;
    colEl.style.top = `${tRect.top - cRect.top}px`;
    colEl.style.height = `${tRect.height}px`;

    if (WORD.test(text[off]!)) {
      let ws = off;
      let we = off + 1;
      while (ws > 0 && WORD.test(text[ws - 1]!)) ws--;
      while (we < text.length && WORD.test(text[we]!)) we++;
      const wRect = rangeFor(nodes, ws, we)?.getBoundingClientRect();
      if (wRect) place(wordEl, wRect, cRect);
      else hide(wordEl);
    } else {
      hide(wordEl);
    }

    // line:col badge at the row's right edge; the line number follows the
    // hovered side (old pane vs new pane in split view).
    const side = cell.dataset.side ?? "new";
    const lk = row.getAttribute("data-lk") ?? "";
    const m = lk.match(new RegExp(`${side}:(\\d+)`)) ?? lk.match(/\d+/);
    if (m) {
      badgeEl.style.display = "block";
      badgeEl.textContent = `${m[1] ?? m[0]}:${off + 1}`;
      badgeEl.style.left = "auto";
      badgeEl.style.right = `${cRect.right - tRect.right + 6}px`;
      badgeEl.style.top = `${rowRect.top - cRect.top + 2}px`;
    } else {
      hide(badgeEl);
    }
  };

  const onMove = (e: MouseEvent) => {
    px = e.clientX;
    py = e.clientY;
    target = e.target as Element;
    if (!raf) raf = requestAnimationFrame(update);
  };
  const onLeave = () => hide(...parts);
  // Content sliding under a stationary pointer (j/k, glide) would leave the
  // marks stale; hide until the next real mouse move.
  const onScroll = () => hide(...parts);

  container.addEventListener("mousemove", onMove, { passive: true });
  container.addEventListener("mouseleave", onLeave);
  window.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    if (raf) cancelAnimationFrame(raf);
    container.removeEventListener("mousemove", onMove);
    container.removeEventListener("mouseleave", onLeave);
    window.removeEventListener("scroll", onScroll);
    root.remove();
    container.style.position = prevPosition;
  };
}
