import type { ReactNode } from "react";
import { Link } from "wouter";
import * as api from "../api";

/** Header height in px. Review's scroll-anchor math offsets against this. */
export const HEADER_PX = 48;

/** Sticky top bar shared by every page: wordmark, then page-specific children. */
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-edge bg-panel px-3"
      style={{ height: HEADER_PX }}
    >
      <Link
        href={api.href("/")}
        className="shrink-0 font-mono text-[13px] font-bold text-fg hover:text-accent"
      >
        rev<span className="text-accent">_</span>
      </Link>
      {children}
    </header>
  );
}
