/**
 * IngestMapperView — UIS-15 column-mapping editor.
 *
 * Operator workflow:
 *   1. Pick an adapter (gcss-mc/ecp, /util, /sr-header, ...)
 *   2. Drop a CSV / TSV / JSONL / XLSX
 *   3. System runs the auto-mapper + LLM mapper, surfaces a proposal
 *      with per-field confidence + reasoning
 *   4. Operator reviews, drag-edits, or types a correction
 *   5. Save as MappingProfile (per unit × source × version) — next
 *      file with the same shape auto-applies without needing this UI
 *
 * The component is mounted at /admin/ingest/mapper. Scoping comes
 * from VIEW_SCOPE on /admin/ingest (data_custodian + security_manager);
 * we share the same role gate.
 */
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type UisAdapterSummary,
  type UisMappingProposal,
  type UisProfile,
} from "../../api";
import { formatApiError } from "../../api-retry";
import { useSpireStore } from "../../state/store";
import {
  Button,
  ErrorState,
  LoadingState,
  Pressable,
} from "../../components/ui";


export function IngestMapperView() {
  const [adapters, setAdapters] = useState<UisAdapterSummary[] | null>(null);
  const [adaptersErr, setAdaptersErr] = useState<string | null>(null);
  const [adapterId, setAdapterId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    api.uis
      .listAdapters()
      .then((r) => {
        if (cancelled) return;
        setAdapters(r.adapters);
        if (!adapterId && r.adapters.length > 0) {
          setAdapterId(r.adapters[0].id);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setAdaptersErr(formatApiError(e));
      });
    return () => {
      cancelled = true;
    };
    // adapterId intentionally not in deps; we set it once on first load
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedAdapter = useMemo(
    () => adapters?.find((a) => a.id === adapterId) ?? null,
    [adapters, adapterId],
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <header>
        <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.22em] text-[var(--color-text)]">
          Column Mapping Editor
        </h1>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          drop a CSV → review the proposed mapping → save as profile
        </p>
      </header>

      {adaptersErr && <ErrorState title="Adapters unavailable" description={adaptersErr} />}
      {adapters === null && !adaptersErr && <LoadingState label="Loading adapters" />}

      {adapters && adapters.length > 0 && (
        <>
          <AdapterPicker
            adapters={adapters}
            selectedId={adapterId}
            onSelect={setAdapterId}
          />
          {selectedAdapter && <Workspace adapter={selectedAdapter} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adapter picker
// ---------------------------------------------------------------------------

function AdapterPicker({
  adapters,
  selectedId,
  onSelect,
}: {
  adapters: UisAdapterSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
        Target adapter
      </div>
      <div className="flex flex-wrap gap-2">
        {adapters.map((a) => {
          const active = a.id === selectedId;
          return (
            <Pressable
              key={a.id}
              onClick={() => onSelect(a.id)}
              block={false}
              className={
                "!min-h-0 flex flex-col items-start gap-0.5 rounded-sm border px-3 py-2 text-left transition-colors " +
                (active
                  ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))]"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-border-active)]")
              }
            >
              <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-text)]">
                {a.id}
              </span>
              <span className="font-mono text-[10px] tracking-wide text-[var(--color-text-muted)]">
                target: {a.target_entity} · {a.canonical_columns.length} cols
              </span>
            </Pressable>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Workspace — drop file → mapping proposal → editor → save profile
// ---------------------------------------------------------------------------

function Workspace({ adapter }: { adapter: UisAdapterSummary }) {
  const pushToast = useSpireStore((s) => s.pushToast);
  // Only the setter is read — current state isn't used anywhere
  // in render, the file lives on the input ref instead.
  const [, setFile] = useState<File | null>(null);
  const [proposal, setProposal] = useState<UisMappingProposal | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"idle" | "propose" | "save">("idle");
  const [err, setErr] = useState<string | null>(null);

  // Adapter-change resets the file + proposal so we don't carry over
  // a stale mapping across adapter switches.
  useEffect(() => {
    setFile(null);
    setProposal(null);
    setColumnMap({});
    setErr(null);
  }, [adapter.id]);

  async function onFile(f: File) {
    setFile(f);
    setBusy("propose");
    setErr(null);
    setProposal(null);
    setColumnMap({});
    try {
      const r = await api.uis.proposeMapping(f, adapter.id, { use_llm: true });
      setProposal(r);
      setColumnMap({ ...r.column_map });
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy("idle");
    }
  }

  function setMapping(sourceCol: string, canonicalField: string) {
    setColumnMap((prev) => {
      const next = { ...prev };
      if (!canonicalField) {
        delete next[sourceCol];
      } else {
        // If another source col already maps to this canonical, clear it
        for (const [k, v] of Object.entries(next)) {
          if (v === canonicalField && k !== sourceCol) {
            delete next[k];
          }
        }
        next[sourceCol] = canonicalField;
      }
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <FileDropzone onFile={onFile} busy={busy === "propose"} />

      {err && <ErrorState title="Mapping proposal failed" description={err} />}
      {busy === "propose" && <LoadingState label="Auto-map + LLM proposal" />}

      {proposal && (
        <>
          <ProposalSummary proposal={proposal} />
          <MappingEditor
            adapter={adapter}
            proposal={proposal}
            columnMap={columnMap}
            setMapping={setMapping}
          />
          <SaveProfileBar
            adapter={adapter}
            columnMap={columnMap}
            disabled={busy !== "idle"}
            onSaved={(p) => {
              pushToast({
                tone: "ok",
                text: `Profile saved · ${p.profile_id}`,
                ttlMs: 4500,
              });
            }}
            setBusy={(b) => setBusy(b ? "save" : "idle")}
            onError={(msg) => setErr(msg)}
          />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// File dropzone
// ---------------------------------------------------------------------------

function FileDropzone({ onFile, busy }: { onFile: (f: File) => void; busy: boolean }) {
  const [dragging, setDragging] = useState(false);
  return (
    <label
      className={
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 transition-colors " +
        (busy
          ? "cursor-wait border-[var(--color-border)] bg-[var(--color-bg)]"
          : dragging
            ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_12%,var(--color-surface))]"
            : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-primary)]")
      }
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (busy) return;
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input
        type="file"
        accept=".csv,.tsv,.jsonl,.xlsx,text/csv"
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)]">
        {busy ? "Proposing mapping…" : "Drop CSV / TSV / JSONL / XLSX here · or click to browse"}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        format auto-detected · sample rows feed the LLM mapper
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Proposal summary
// ---------------------------------------------------------------------------

function ProposalSummary({ proposal }: { proposal: UisMappingProposal }) {
  const llmTone =
    proposal.llm_failed
      ? "var(--color-warning)"
      : proposal.llm_invoked
        ? "var(--color-primary)"
        : "var(--color-text-muted)";
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
      <div className="flex flex-wrap items-center gap-3">
        <span>
          <span className="text-[var(--color-text-secondary)]">format</span>{" "}
          <span className="text-[var(--color-text)]">{proposal.detected_format}</span>
        </span>
        <span>
          <span className="text-[var(--color-text-secondary)]">encoding</span>{" "}
          <span className="text-[var(--color-text)]">{proposal.detected_encoding}</span>
        </span>
        <span>
          <span className="text-[var(--color-text-secondary)]">auto-baseline</span>{" "}
          <span className="text-[var(--color-text)]">{(proposal.auto_baseline_confidence * 100).toFixed(0)}%</span>
        </span>
        <span style={{ color: llmTone }}>
          LLM: {proposal.llm_invoked ? (proposal.llm_failed ? "FAILED" : "ASSISTED") : "skipped"}
        </span>
        {proposal.llm_failed && proposal.llm_failure_reason && (
          <span className="text-[var(--color-warning)] normal-case tracking-wide">
            {proposal.llm_failure_reason.slice(0, 80)}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mapping editor — per-canonical-column dropdown of source columns
// ---------------------------------------------------------------------------

function MappingEditor({
  adapter,
  proposal,
  columnMap,
  setMapping,
}: {
  adapter: UisAdapterSummary;
  proposal: UisMappingProposal;
  columnMap: Record<string, string>;
  setMapping: (sourceCol: string, canonicalField: string) => void;
}) {
  // Derive source col → canonical field reverse view from columnMap
  const reverseMap = useMemo(() => {
    const r: Record<string, string> = {};
    for (const [src, canon] of Object.entries(columnMap)) {
      r[canon] = src;
    }
    return r;
  }, [columnMap]);

  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text)]">
          Column mapping
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          {Object.keys(columnMap).length} of {adapter.canonical_columns.length} mapped
        </div>
      </div>
      <ul className="flex flex-col gap-1">
        {adapter.canonical_columns.map((col) => {
          const sourceCol = reverseMap[col.name] ?? "";
          const confidence = proposal.confidence_per_field[col.name] ?? 0;
          const reasoning = proposal.reasoning_per_field[col.name] ?? "";
          return (
            <li
              key={col.name}
              className="grid grid-cols-[12rem_1fr_8rem] items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
            >
              <div className="flex flex-col">
                <span className="font-mono text-xs text-[var(--color-text)]">
                  {col.name}
                  {col.required && (
                    <span className="ml-1 text-[var(--color-warning)]">*</span>
                  )}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                  {col.type}
                  {col.sensitive && " · sensitive"}
                </span>
                {col.description && (
                  <span className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-secondary)]" title={col.description}>
                    {col.description}
                  </span>
                )}
              </div>
              <div className="flex flex-col">
                <select
                  value={sourceCol}
                  onChange={(e) => setMapping(e.target.value, col.name)}
                  className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs text-[var(--color-text)]"
                >
                  <option value="">— unmapped —</option>
                  {/* If sourceCol isn't in source_columns (edge case) still
                   * include it so the dropdown reflects current state */}
                  {sourceCol && !proposal.source_columns.includes(sourceCol) && (
                    <option value={sourceCol}>{sourceCol} (manual)</option>
                  )}
                  {proposal.source_columns.map((sc) => (
                    <option key={sc} value={sc}>{sc}</option>
                  ))}
                </select>
                {reasoning && (
                  <span className="mt-1 font-mono text-[10px] tracking-wide text-[var(--color-text-muted)]">
                    LLM: {reasoning}
                  </span>
                )}
              </div>
              <div className="text-right">
                <ConfidencePill value={confidence} />
              </div>
            </li>
          );
        })}
      </ul>
      {proposal.unmapped_source.length > 0 && (
        <div className="mt-3 rounded-sm border border-dashed border-[var(--color-border)] px-3 py-2 font-mono text-[11px] tracking-wide text-[var(--color-text-muted)]">
          <div className="uppercase tracking-widest">
            Source columns not yet mapped:
          </div>
          <div className="mt-1 text-[var(--color-text-secondary)]">
            {proposal.unmapped_source.join(", ")}
          </div>
        </div>
      )}
    </section>
  );
}

function ConfidencePill({ value }: { value: number }) {
  // Treat values exactly 0 (no proposal exists) differently from
  // small positives (e.g. 0.01 from a low-confidence LLM call).
  // Earlier we showed "—" for anything that math.floor(value*100)
  // rounded to 0%, which read as "no data" when really it was
  // "very low confidence". Now: show "<1%" so the operator sees
  // the LLM had an opinion but a weak one.
  if (value === 0 || value === undefined || value === null) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        —
      </span>
    );
  }
  const color =
    value >= 0.9 ? "var(--color-success)" :
    value >= 0.7 ? "var(--color-primary)" :
    value >= 0.5 ? "var(--color-warning)" :
    "var(--color-text-muted)";
  const pctRaw = value * 100;
  const label = pctRaw < 1 ? "<1%" : `${pctRaw.toFixed(0)}%`;
  return (
    <span
      className="rounded-sm border px-1.5 py-[1px] font-mono text-[10px] uppercase tracking-widest tabular-nums"
      style={{ borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`, color }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Save-profile bar
// ---------------------------------------------------------------------------

function SaveProfileBar({
  adapter,
  columnMap,
  disabled,
  onSaved,
  setBusy,
  onError,
}: {
  adapter: UisAdapterSummary;
  columnMap: Record<string, string>;
  disabled: boolean;
  onSaved: (p: UisProfile) => void;
  setBusy: (b: boolean) => void;
  onError: (msg: string) => void;
}) {
  const currentUser = useSpireStore((s) => s.currentUser);
  const defaultUnit = currentUser?.unit ?? "";
  const [profileId, setProfileId] = useState<string>(() =>
    `${slug(defaultUnit)}/${adapter.id}/v${new Date().toISOString().slice(0, 7)}`,
  );
  const [unit, setUnit] = useState<string>(defaultUnit);
  const [notes, setNotes] = useState<string>("");
  const [collisionWarning, setCollisionWarning] = useState<string | null>(null);
  const [checkingCollision, setCheckingCollision] = useState(false);

  // Reset the proposed profile_id when adapter changes
  useEffect(() => {
    setProfileId(`${slug(unit)}/${adapter.id}/v${new Date().toISOString().slice(0, 7)}`);
    setCollisionWarning(null);
  }, [adapter.id, unit]);

  // Debounced collision pre-check: every time profile_id changes,
  // wait 400ms then GET it. If it exists, surface a warning so the
  // operator doesn't spend 10 minutes editing only to hit 409 on
  // submit.
  useEffect(() => {
    const id = profileId.trim();
    if (!id) {
      setCollisionWarning(null);
      return;
    }
    setCheckingCollision(true);
    const t = setTimeout(async () => {
      try {
        const existing = await api.uis.getProfile(id);
        if (existing) {
          setCollisionWarning(
            `Profile "${id}" already exists (created ${existing.created_at.slice(0, 10)}). ` +
            "Save will overwrite it — choose a new id, or use the PUT endpoint to update."
          );
        }
      } catch {
        // 404 = available (good); other errors swallow silently
        setCollisionWarning(null);
      } finally {
        setCheckingCollision(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      setCheckingCollision(false);
    };
  }, [profileId]);

  function reset() {
    setProfileId(`${slug(unit)}/${adapter.id}/v${new Date().toISOString().slice(0, 7)}`);
    setUnit(defaultUnit);
    setNotes("");
    setCollisionWarning(null);
  }

  async function save(confirm: boolean) {
    if (!profileId.trim()) {
      onError("profile_id is required");
      return;
    }
    if (Object.keys(columnMap).length === 0) {
      onError("column_map is empty — map at least one column before saving");
      return;
    }
    setBusy(true);
    try {
      const p = await api.uis.createProfile({
        profile_id: profileId.trim(),
        source_id: adapter.id,
        unit: unit.trim() || null,
        column_map: columnMap,
        operator_notes: notes.trim(),
        confirm,
      });
      onSaved(p);
      setCollisionWarning(null);
    } catch (e) {
      onError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 font-mono text-xs uppercase tracking-widest text-[var(--color-text)]">
        Save as profile
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="profile_id">
          <input
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            disabled={disabled}
            className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-text)]"
          />
        </Field>
        <Field label="unit (optional)">
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            disabled={disabled}
            className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-text)]"
            placeholder="3d MLR"
          />
        </Field>
        <Field label="operator notes (optional)" className="sm:col-span-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={disabled}
            rows={2}
            className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-text)]"
            placeholder="why this mapping is needed; what's quirky about this unit's export"
          />
        </Field>
      </div>
      {checkingCollision && (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          checking profile_id…
        </div>
      )}
      {collisionWarning && (
        <div className="mt-2 rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning)_12%,var(--color-surface))] px-2 py-1 font-mono text-[11px] tracking-wide text-[var(--color-warning)]">
          {collisionWarning}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="secondary"
          onClick={reset}
          disabled={disabled}
          size="sm"
        >
          Reset
        </Button>
        <Button
          variant="secondary"
          onClick={() => save(false)}
          disabled={disabled}
          size="sm"
        >
          Save as draft
        </Button>
        <Button
          variant="primary"
          onClick={() => save(true)}
          disabled={disabled}
          size="sm"
        >
          Confirm + save
        </Button>
      </div>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        Confirmed profiles auto-apply on next ingest of the same source + unit. Drafts surface in the profile list but don't fire automatically.
      </div>
    </section>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={"flex flex-col gap-1 " + className}>
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
