const KEYS: Array<[string, string]> = [
  ["j / k", "next / previous file"],
  ["J / K", "next / previous unseen or stale file"],
  ["n / p", "next / previous hunk"],
  ["s, v or .", "toggle seen on current file"],
  ["x", "toggle pointer crosshair (line/column/word/char)"],
  ["click id", "semantic view: open symbol panel"],
  ["?", "toggle this help"],
  ["Esc", "close help / symbol panel"],
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="overlay-in w-72 rounded-md border border-edge bg-panel p-4 shadow-[0_8px_28px_rgb(0_0_0/0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[13px] font-semibold text-fg">Keyboard</h2>
        <dl className="mt-3 space-y-2">
          {KEYS.map(([key, desc]) => (
            <div key={key} className="flex items-baseline gap-3">
              <dt className="w-14 shrink-0 rounded-sm bg-raise px-1.5 py-0.5 text-center font-mono text-[11px] text-fg">
                {key}
              </dt>
              <dd className="text-[12.5px] text-mute">{desc}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
