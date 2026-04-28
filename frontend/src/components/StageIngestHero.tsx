/**
 * StageIngestHero — Task #183 stage live-ingest mode.
 *
 * The drag-drop hero card that occupies the top of DECISION BRIDGE
 * while ``_DATASET`` is empty. Three named slots (header / sr_parts /
 * due_in), per-slot validation, a single primary "Hydrate SPIRE"
 * button, a live progress chip, and post-ingest counts.
 *
 * The component is intentionally self-contained — it owns the slot
 * state, the POST, and the post-success refetch trigger. The parent
 * passes a single ``onIngested`` callback so it can re-poll
 * dataset-status after the swap.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import { api, type StageIngestResult } from "../api";
import { Button } from "./ui";

type SlotKey = "header" | "sr_parts" | "due_in";

interface SlotMeta {
  /** Canonical filename pattern shown in the slot header. */
  expected: string;
  /** Plain-language label. */
  label: string;
  /** One-liner describing the file's contents. */
  description: string;
}

const SLOT_META: Record<SlotKey, SlotMeta> = {
  header: {
    expected: "hashed_header.csv",
    label: "SR Header",
    description: "12-column sanitized GCSS-MC SR header export.",
  },
  sr_parts: {
    expected: "hashed_sr_parts.csv",
    label: "SR Parts",
    description: "6-column repair-parts requisition export.",
  },
  due_in: {
    expected: "hashed_due_in.csv",
    label: "Due-In",
    description: "82-column due-in / supply pipeline export.",
  },
};

const SLOT_ORDER: SlotKey[] = ["header", "sr_parts", "due_in"];

type SlotState =
  | { status: "empty" }
  | { status: "valid"; file: File }
  | { status: "error"; reason: string };

type IngestStatus =
  | { phase: "idle" }
  | { phase: "parsing" }
  | { phase: "validating" }
  | { phase: "hydrating" }
  | { phase: "ready"; result: StageIngestResult }
  | { phase: "error"; message: string };

interface StageIngestHeroProps {
  /** Called after a successful ingest so the parent can re-poll
   *  dataset-status and the dashboards can light up. */
  onIngested?: (result: StageIngestResult) => void;
  /** Optional caption shown above the hero — e.g. "GCSS-MC INGEST". */
  caption?: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function classifyFile(slot: SlotKey, file: File): SlotState {
  // Permissive validation — accept any .csv. The backend re-validates the
  // header schema; here we only block obviously-wrong drops (e.g. .png).
  const name = file.name.toLowerCase();
  if (!name.endsWith(".csv") && !name.endsWith(".txt")) {
    return { status: "error", reason: `${file.name} is not a CSV.` };
  }
  if (file.size === 0) {
    return { status: "error", reason: `${file.name} is empty.` };
  }
  // Soft hint when the filename clearly belongs to a different slot.
  const expected = SLOT_META[slot].expected;
  if (
    !name.includes(expected.replace(".csv", "")) &&
    !name.includes(slot.replace("_", ""))
  ) {
    // Don't reject — the operator may have renamed the export. Just
    // accept and let the backend's schema sniffer catch real mismatches.
  }
  return { status: "valid", file };
}

export function StageIngestHero({ onIngested, caption = "GCSS-MC INGEST" }: StageIngestHeroProps) {
  const [slots, setSlots] = useState<Record<SlotKey, SlotState>>({
    header: { status: "empty" },
    sr_parts: { status: "empty" },
    due_in: { status: "empty" },
  });
  const [ingest, setIngest] = useState<IngestStatus>({ phase: "idle" });
  const inputsRef = useRef<Record<SlotKey, HTMLInputElement | null>>({
    header: null,
    sr_parts: null,
    due_in: null,
  });

  const allValid = useMemo(
    () => SLOT_ORDER.every((k) => slots[k].status === "valid"),
    [slots],
  );
  const anyError = useMemo(
    () => SLOT_ORDER.some((k) => slots[k].status === "error"),
    [slots],
  );
  const isIngesting =
    ingest.phase === "parsing" ||
    ingest.phase === "validating" ||
    ingest.phase === "hydrating";

  const setSlot = useCallback((key: SlotKey, state: SlotState) => {
    setSlots((prev) => ({ ...prev, [key]: state }));
  }, []);

  const onFile = useCallback(
    (key: SlotKey, file: File | null | undefined) => {
      if (!file) {
        setSlot(key, { status: "empty" });
        return;
      }
      setSlot(key, classifyFile(key, file));
    },
    [setSlot],
  );

  const onDrop = useCallback(
    (key: SlotKey, ev: React.DragEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const file = ev.dataTransfer?.files?.[0];
      onFile(key, file);
    },
    [onFile],
  );

  const onDragOver = useCallback((ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
  }, []);

  const reset = useCallback(() => {
    setSlots({
      header: { status: "empty" },
      sr_parts: { status: "empty" },
      due_in: { status: "empty" },
    });
    setIngest({ phase: "idle" });
    SLOT_ORDER.forEach((k) => {
      const input = inputsRef.current[k];
      if (input) input.value = "";
    });
  }, []);

  const submit = useCallback(async () => {
    if (!allValid) return;
    const header = (slots.header as { status: "valid"; file: File }).file;
    const sr_parts = (slots.sr_parts as { status: "valid"; file: File }).file;
    const due_in = (slots.due_in as { status: "valid"; file: File }).file;

    setIngest({ phase: "parsing" });
    // Stage labels are deterministic (parsing → validating → hydrating)
    // so the operator sees movement even on a fast ingest. We tick
    // through them with a short delay; the actual POST runs in parallel.
    const tickValidating = window.setTimeout(
      () => setIngest((s) => (s.phase === "parsing" ? { phase: "validating" } : s)),
      350,
    );
    const tickHydrating = window.setTimeout(
      () => setIngest((s) => (s.phase === "validating" ? { phase: "hydrating" } : s)),
      750,
    );
    try {
      const result = await api.system.stageIngest({ header, sr_parts, due_in });
      setIngest({ phase: "ready", result });
      onIngested?.(result);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err ?? "stage-ingest failed");
      setIngest({ phase: "error", message });
    } finally {
      window.clearTimeout(tickValidating);
      window.clearTimeout(tickHydrating);
    }
  }, [allValid, slots, onIngested]);

  return (
    <section
      data-testid="stage-ingest-hero"
      className="relative overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      style={{
        boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-warning) 35%, transparent)",
      }}
    >
      <header className="mb-3 flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--color-warning)]">
            {caption}
          </p>
          <h2 className="mt-1 font-mono text-lg font-semibold uppercase tracking-wider text-[var(--color-text)]">
            Awaiting GCSS-MC ingest
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-[var(--color-text-muted)]">
            Drop the three sanitized CSVs into the slots below, then press
            <span className="font-semibold"> Hydrate SPIRE</span>. The dataset
            singleton is empty until ingest completes — every dashboard
            renders the empty-state placeholder until then.
          </p>
        </div>
        {ingest.phase === "ready" && (
          <div className="text-right">
            <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-success)]">
              Ingest Complete
            </p>
            <p className="font-mono text-xs text-[var(--color-text-muted)]">
              hash {ingest.result.ingest_hash} · {ingest.result.elapsed_ms}ms
            </p>
          </div>
        )}
      </header>

      <div
        data-testid="stage-ingest-slots"
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
      >
        {SLOT_ORDER.map((key) => {
          const meta = SLOT_META[key];
          const slot = slots[key];
          const valid = slot.status === "valid";
          const errored = slot.status === "error";
          return (
            <div
              key={key}
              data-testid={`stage-ingest-slot-${key}`}
              data-state={slot.status}
              onDrop={(e) => onDrop(key, e)}
              onDragOver={onDragOver}
              className="flex flex-col gap-2 rounded-sm border border-dashed border-[var(--color-border)] p-3"
              style={{
                background: valid
                  ? "color-mix(in oklab, var(--color-success-muted) 30%, transparent)"
                  : errored
                  ? "color-mix(in oklab, var(--color-danger-muted) 25%, transparent)"
                  : "transparent",
                borderColor: valid
                  ? "var(--color-success)"
                  : errored
                  ? "var(--color-danger)"
                  : undefined,
              }}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-muted)]">
                  {meta.label}
                </span>
                <code className="font-mono text-[10px] text-[var(--color-text-muted)]">
                  {meta.expected}
                </code>
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">
                {meta.description}
              </p>
              <label
                className="flex cursor-pointer items-center gap-2 rounded-sm border border-[var(--color-border)] px-2 py-1.5 text-xs font-mono uppercase tracking-wider hover:bg-[var(--color-surface-alt,transparent)]"
              >
                <input
                  ref={(el) => {
                    inputsRef.current[key] = el;
                  }}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="hidden"
                  data-testid={`stage-ingest-input-${key}`}
                  onChange={(e) => onFile(key, e.target.files?.[0])}
                />
                <span>{slot.status === "valid" ? "Replace" : "Choose file"}</span>
              </label>
              <div className="min-h-[28px] text-xs">
                {slot.status === "valid" && (
                  <span className="font-mono text-[var(--color-success)]">
                    ✓ {slot.file.name} · {fmtBytes(slot.file.size)}
                    {ingest.phase === "ready" &&
                      ingest.result.source_files[key]?.rows_parsed != null && (
                        <span
                          data-testid={`stage-ingest-rows-${key}`}
                          className="ml-2 rounded-sm border border-[var(--color-success-muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[var(--color-success)]"
                        >
                          {ingest.result.source_files[
                            key
                          ].rows_parsed.toLocaleString()}{" "}
                          rows parsed
                        </span>
                      )}
                  </span>
                )}
                {slot.status === "error" && (
                  <span className="font-mono text-[var(--color-danger)]">
                    ✗ {slot.reason}
                  </span>
                )}
                {slot.status === "empty" && (
                  <span className="font-mono text-[var(--color-text-muted)]">
                    Drop a CSV here or click "Choose file".
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs">
          {ingest.phase === "idle" && (
            <span className="font-mono text-[var(--color-text-muted)]">
              {allValid
                ? "Ready to hydrate."
                : anyError
                ? "Resolve the slot errors and try again."
                : "Drop or pick all three CSVs to continue."}
            </span>
          )}
          {(ingest.phase === "parsing" ||
            ingest.phase === "validating" ||
            ingest.phase === "hydrating") && (
            <div
              data-testid="stage-ingest-progress"
              data-phase={ingest.phase}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                ingest.phase === "parsing"
                  ? 33
                  : ingest.phase === "validating"
                  ? 66
                  : 90
              }
              aria-label="Stage ingest progress"
              className="flex min-w-[260px] flex-col gap-1"
            >
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-[var(--color-warning)]">
                <span>
                  {ingest.phase === "parsing" && "Parsing CSVs"}
                  {ingest.phase === "validating" && "Validating schema"}
                  {ingest.phase === "hydrating" && "Hydrating dataset"}
                </span>
                <span className="tabular-nums">
                  {ingest.phase === "parsing"
                    ? "33%"
                    : ingest.phase === "validating"
                    ? "66%"
                    : "90%"}
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-sm border border-[var(--color-border)]"
                style={{ background: "var(--color-bg)" }}
              >
                <div
                  data-testid="stage-ingest-progress-fill"
                  className="h-full transition-all duration-300 ease-out"
                  style={{
                    width:
                      ingest.phase === "parsing"
                        ? "33%"
                        : ingest.phase === "validating"
                        ? "66%"
                        : "90%",
                    background: "var(--color-warning)",
                    boxShadow: "0 0 6px var(--color-warning)",
                  }}
                />
              </div>
            </div>
          )}
          {ingest.phase === "ready" && (
            <span className="font-mono uppercase tracking-widest text-[var(--color-success)]">
              Ready · {ingest.result.counts.srs.toLocaleString()} SRs ·{" "}
              {ingest.result.counts.units.toLocaleString()} units
            </span>
          )}
          {ingest.phase === "error" && (
            <span
              data-testid="stage-ingest-error"
              className="font-mono uppercase tracking-widest text-[var(--color-danger)]"
            >
              Ingest failed: {ingest.message}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ingest.phase === "error" && (
            <Button variant="secondary" size="sm" onClick={reset}>
              Try again
            </Button>
          )}
          {ingest.phase !== "ready" && (
            <Button
              data-testid="stage-ingest-submit"
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={!allValid || isIngesting}
            >
              {isIngesting ? "Hydrating…" : "Hydrate SPIRE"}
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}
