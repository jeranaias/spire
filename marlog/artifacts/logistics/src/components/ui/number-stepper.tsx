import * as React from "react";
import { cn } from "@/lib/utils";

interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  secondaryStep?: number;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

export function NumberStepper({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  secondaryStep,
  className,
  disabled = false,
  "aria-label": ariaLabel,
}: NumberStepperProps) {
  const clamp = (n: number) => {
    let v = Math.max(min, n);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  const adjust = (delta: number) => {
    onChange(clamp(value + delta));
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseInt(e.target.value, 10);
    if (!isNaN(raw)) onChange(clamp(raw));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") { e.preventDefault(); adjust(step); }
    if (e.key === "ArrowDown") { e.preventDefault(); adjust(-step); }
  };

  const btn =
    "inline-flex items-center justify-center h-8 w-8 rounded border border-input bg-muted text-foreground font-mono text-sm font-bold leading-none select-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed";

  const secondaryBtn =
    "inline-flex items-center justify-center h-8 w-9 rounded border border-input bg-muted text-foreground font-mono text-xs font-bold leading-none select-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div
      className={cn("inline-flex items-center gap-1", className)}
      role="group"
      aria-label={ariaLabel}
    >
      {secondaryStep !== undefined && (
        <button
          type="button"
          className={secondaryBtn}
          onClick={() => adjust(-secondaryStep)}
          disabled={disabled || value <= min}
          aria-label={`Decrease by ${secondaryStep}`}
          tabIndex={0}
        >
          <span className="leading-none">−{secondaryStep}</span>
        </button>
      )}
      <button
        type="button"
        className={btn}
        onClick={() => adjust(-step)}
        disabled={disabled || value <= min}
        aria-label={`Decrease by ${step}`}
        tabIndex={0}
      >
        <span className="leading-none">−</span>
      </button>
      <input
        type="number"
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        min={min}
        max={max}
        className="h-8 w-16 rounded-md border border-input bg-transparent px-2 text-center font-mono text-sm leading-none shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
        aria-label={ariaLabel ? `${ariaLabel} value` : "value"}
      />
      <button
        type="button"
        className={btn}
        onClick={() => adjust(step)}
        disabled={disabled || (max !== undefined && value >= max)}
        aria-label={`Increase by ${step}`}
        tabIndex={0}
      >
        <span className="leading-none">+</span>
      </button>
      {secondaryStep !== undefined && (
        <button
          type="button"
          className={secondaryBtn}
          onClick={() => adjust(secondaryStep)}
          disabled={disabled || (max !== undefined && value >= max)}
          aria-label={`Increase by ${secondaryStep}`}
          tabIndex={0}
        >
          <span className="leading-none">+{secondaryStep}</span>
        </button>
      )}
    </div>
  );
}
