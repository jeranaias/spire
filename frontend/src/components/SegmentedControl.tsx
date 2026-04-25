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
              "px-3 py-1 font-mono text-sm font-semibold uppercase transition-colors",
              i > 0 && "border-l border-[var(--color-border)]",
              active
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
            )}
            style={{ letterSpacing: "0.16em" }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
