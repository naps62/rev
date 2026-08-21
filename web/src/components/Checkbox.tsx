import { cx } from "../util";

interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
  className?: string;
}

// Flat seen-checkbox; visuals + oversized hit target come from .chk in CSS.
// MUST stop click propagation — every call site sits inside a larger click
// surface (row navigate, dir toggle) that would otherwise fire too.
export function Checkbox({
  checked,
  indeterminate = false,
  title,
  onChange,
  className,
}: CheckboxProps) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      title={title}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
      className={cx("chk size-4", className)}
    />
  );
}
