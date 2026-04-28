import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

// ---------------------------------------------------------------------------
// Task #185 — SentrySplitPane (shared)
//
// Originally lived inside ProcessingTab.tsx. Hoisted to a shared component
// because the reviewer asked the operator-resizable split to land on the
// REVIEW screen (queue columns ↔ inspector pane), and Processing keeps its
// own raw/sanitized splitter under a per-tab storage key. Each call site
// supplies its own `storageKey` so the two splitters don't fight over the
// same px width.
//
// Below `lg` (1024px) the pane stacks vertically: top = `left`, bottom =
// `right`. The drag handle is a desktop affordance — at 1023-or-narrower
// it's hidden and the operator gets a clean stacked layout, which is the
// 1024×768 minimum-resolution requirement for SPIRE.
// ---------------------------------------------------------------------------
interface Props {
  left: ReactNode;
  right: ReactNode;
  storageKey: string;
  defaultLeftRatio?: number; // 0..1, default 0.55
  testId?: string;
}

export function SentrySplitPane({
  left,
  right,
  storageKey,
  defaultLeftRatio = 0.55,
  testId,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [leftPx, setLeftPx] = useState<number | null>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  const [dragging, setDragging] = useState(false);
  const [stacked, setStacked] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return !window.matchMedia("(min-width: 1024px)").matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setStacked(!mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const host = containerRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const min = Math.max(180, rect.width * 0.25);
      const max = Math.min(rect.width - 180, rect.width * 0.75);
      const x = Math.min(max, Math.max(min, e.clientX - rect.left));
      setLeftPx(x);
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // Persist the left-pane width on every settle (i.e. when not dragging).
  useEffect(() => {
    if (dragging || leftPx == null) return;
    try {
      window.localStorage.setItem(storageKey, String(Math.round(leftPx)));
    } catch {
      /* tolerant — quota / private mode shouldn't break the screen */
    }
  }, [dragging, leftPx, storageKey]);

  if (stacked) {
    return (
      <div
        className="flex flex-1 flex-col overflow-hidden"
        data-testid={testId}
        data-stacked="true"
      >
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden border-b border-[var(--color-border)]">
          {left}
        </div>
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          {right}
        </div>
      </div>
    );
  }

  const leftStyle =
    leftPx == null
      ? { width: `${Math.round(defaultLeftRatio * 100)}%` }
      : { width: `${leftPx}px` };

  return (
    <div
      ref={containerRef}
      className="flex flex-1 overflow-hidden"
      data-testid={testId}
      data-stacked="false"
    >
      <div
        className="flex flex-col overflow-hidden border-r border-[var(--color-border)]"
        style={leftStyle}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize split"
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setLeftPx(null)}
        onKeyDown={(e) => {
          const host = containerRef.current;
          if (!host) return;
          const rect = host.getBoundingClientRect();
          const cur = leftPx ?? rect.width * defaultLeftRatio;
          if (e.key === "ArrowLeft") {
            setLeftPx(Math.max(180, cur - 24));
            e.preventDefault();
          } else if (e.key === "ArrowRight") {
            setLeftPx(Math.min(rect.width - 180, cur + 24));
            e.preventDefault();
          } else if (e.key === "Home") {
            setLeftPx(null);
            e.preventDefault();
          }
        }}
        className={clsx(
          "group relative w-1 shrink-0 cursor-col-resize bg-[var(--color-border)] outline-none transition-colors",
          "hover:bg-[var(--color-primary)] focus-visible:bg-[var(--color-primary)]",
          dragging && "bg-[var(--color-primary)]",
        )}
        title="Drag to resize · double-click to reset"
      >
        <span className="absolute inset-y-0 -left-1 right-[-4px]" aria-hidden />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        {right}
      </div>
    </div>
  );
}
