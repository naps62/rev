export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="0.5"
        y="0.5"
        width="23"
        height="23"
        rx="5.5"
        fill="var(--color-raise)"
        stroke="var(--color-edge)"
      />
      <path d="M5 4.5h6.5v3H8v9h3.5v3H5v-15Z" fill="currentColor" />
      <path d="M19 4.5h-6.5v3H16v9h-3.5v3H19v-15Z" fill="currentColor" />
      <rect
        x="10.25"
        y="10.25"
        width="3.5"
        height="3.5"
        rx="0.75"
        fill="var(--color-accent)"
      />
    </svg>
  );
}
