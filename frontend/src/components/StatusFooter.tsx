import { useEffect, useState } from "react";

export function StatusFooter() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Local wall-clock time -- judge at a TOC wants the same time as their watch,
  // not Zulu.
  const localTime = now.toLocaleTimeString([], { hour12: false });

  const segments = [
    "Local Infrastructure",
    "No Cloud",
    "No Third-Party APIs",
    "AES-256 Encrypted",
    "v0.1.0",
    localTime,
  ];

  return (
    <footer className="h-7 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[11px] text-[var(--color-text-muted)]">
      <div className="flex h-full items-center justify-center gap-3 px-4">
        {segments.map((s, i) => (
          <span key={s} className="flex items-center gap-3">
            {i > 0 && <span className="text-[var(--color-border-active)]">│</span>}
            <span className="tabular-nums">{s}</span>
          </span>
        ))}
      </div>
    </footer>
  );
}
