import type { ReactNode } from "react";
import { Link } from "wouter";
import * as api from "../api";
import { BrandMark } from "./BrandMark";
import { type ReviewSettings, SettingsControl } from "./SettingsModal";

/** Header height in px. Review's scroll-anchor math offsets against this. */
export const HEADER_PX = 48;

/** Sticky top bar shared by every page: wordmark, page-specific children,
    and the settings cog. `settings` adds the review-page sections. */
export function AppHeader({
  children,
  settings,
}: {
  children?: ReactNode;
  settings?: ReviewSettings;
}) {
  return (
    <header
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-edge bg-panel px-3"
      style={{ height: HEADER_PX }}
    >
      <Link
        href={api.href("/")}
        className="group inline-flex shrink-0 items-center gap-1.5 rounded-sm font-mono text-[13px] font-bold text-fg transition-colors hover:text-accent"
      >
        <BrandMark className="size-5 shrink-0 transition-colors" />
        <span>
          rev<span className="text-accent">_</span>
        </span>
      </Link>
      {children}
      <SettingsControl review={settings} />
    </header>
  );
}
