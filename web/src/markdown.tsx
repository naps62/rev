/**
 * Markdown-lite renderer for comment bodies. Hand-rolled safe subset: fenced
 * code blocks, `inline code`, **bold**, *italic*, autolinked http(s) URLs.
 * Builds React nodes — no HTML strings, so nothing needs sanitizing.
 */

import type { ReactNode } from "react";

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(https?:\/\/[^\s<>"'`]+)/g;

/** Trailing punctuation that reads as prose, not part of the URL. */
const URL_TRAIL_RE = /[.,;:!?)\]]+$/;

function inlineNodes(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m; m = INLINE_RE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}.${n++}`;
    const [, code, bold, italic, url] = m;
    if (code) {
      out.push(
        <code
          key={key}
          className="rounded-[2px] bg-raise px-1 py-px font-mono text-[12px]"
        >
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold) {
      out.push(
        <strong key={key} className="font-semibold">
          {bold.slice(2, -2)}
        </strong>,
      );
    } else if (italic) {
      out.push(<em key={key}>{italic.slice(1, -1)}</em>);
    } else if (url) {
      const trail = URL_TRAIL_RE.exec(url)?.[0] ?? "";
      const href = trail ? url.slice(0, -trail.length) : url;
      out.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="break-all text-agent hover:underline"
        >
          {href}
        </a>,
      );
      if (trail) out.push(trail);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let code: string[] | null = null;
  let n = 0;

  const flushText = () => {
    if (buf.length === 0) return;
    nodes.push(...inlineNodes(buf.join("\n"), `t${n++}`));
    buf = [];
  };

  for (const line of lines) {
    if (code == null && /^```/.test(line.trim())) {
      flushText();
      // Swallow the newline the fence sat on so blocks don't add blank lines.
      code = [];
    } else if (code != null && line.trim() === "```") {
      nodes.push(
        <pre
          key={`c${n++}`}
          className="my-1.5 overflow-x-auto whitespace-pre rounded-sm border border-edge-soft bg-bg px-2.5 py-2 font-mono text-[12px] leading-normal text-fg"
        >
          {code.join("\n")}
        </pre>,
      );
      code = null;
    } else if (code != null) {
      code.push(line);
    } else {
      buf.push(line);
    }
  }
  if (code != null) buf.push("```", ...code); // unterminated fence: literal
  flushText();

  return <>{nodes}</>;
}
