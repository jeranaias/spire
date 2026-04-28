import clsx from "clsx";
import { Pressable } from "./ui";

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
      // Walkthrough #21 — visually a button bar, not radios. Use group
      // semantics (role="group" + aria-pressed) so SR announcements line
      // up with what operators see on screen.
      role="group"
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            block={false}
            className={clsx(
              "inline-flex min-w-[44px] items-center justify-center px-3 font-mono text-sm font-semibold uppercase transition-colors tracking-wider",
              i > 0 && "border-l border-[var(--color-border)]",
              active
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]",
            )}
          >
            {o.label}
          </Pressable>
        );
      })}
    </div>
  );
}
