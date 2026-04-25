import clsx from "clsx";

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: Props<T>) {
  return (
    <div
      className={clsx(
        "inline-flex overflow-hidden rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]",
        className,
      )}
      role="radiogroup"
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              // 44px tap target per Apple HIG / WCAG 2.5.5. Filter pills used
              // to be ~24px tall and failed mobile audits.
              "inline-flex h-11 min-w-[44px] items-center justify-center px-3 font-mono text-sm font-semibold uppercase transition-colors tracking-wider",
              i > 0 && "border-l border-[var(--color-border)]",
              active
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
