/**
 * NotificationsChip — combined Drafts + Alerts chip for the operator
 * mode top bar. The two old chips were both small numeric badges
 * sitting side-by-side; merging them into one tabbed dropdown frees a
 * slot in the right group while preserving every action the originals
 * offered.
 *
 * Visibility:
 *   - Drafts tab is gated on the same roles as the legacy DraftsBadge
 *     (maintenance_chief, g4, mef_commander). For roles where drafts
 *     are not visible the chip simply renders the alerts segment alone
 *     (and is purely informational for those roles).
 *   - Alerts segment is always visible.
 *
 * The chip itself only mounts in operator mode (stage mode hides it
 * because the AlertBadge stage backstop renders separately for stage
 * presentations — the spec keeps that backstop intact).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type PulseDraft } from "../api";
import { formatApiError } from "../api-retry";
import { useSpireStore, type Role } from "../state/store";
import { Button, Pressable } from "./ui";

const DRAFT_ROLES: ReadonlySet<Role> = new Set<Role>([
  "maintenance_chief",
  "g4",
  "mef_commander",
]);

function formatAge(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!isFinite(t)) return iso;
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch {
    return iso;
  }
}

export function NotificationsChip() {
  const role = useSpireStore((s) => s.role);
  const stageMode = useSpireStore((s) => s.stageMode);
  const alertCount = useSpireStore((s) => s.alertCount);
  const refreshTick = useSpireStore((s) => s.draftsRefreshTick);
  const bumpDrafts = useSpireStore((s) => s.bumpDraftsRefresh);
  // Programmatic-open nonce — bumped by the inline "N held" pill on
  // Risk Board rows when the operator wants to jump straight from a
  // row indicator to the drafts queue.
  const popoverOpenTick = useSpireStore((s) => s.draftsPopoverOpenTick);
  const setSelectedAssetId = useSpireStore((s) => s.setSelectedAssetId);
  const pushToast = useSpireStore((s) => s.pushToast);
  const nav = useNavigate();

  const draftsAllowed = DRAFT_ROLES.has(role);
  const [drafts, setDrafts] = useState<PulseDraft[]>([]);
  const [expiredDrafts, setExpiredDrafts] = useState<PulseDraft[]>([]);
  const [showExpired, setShowExpired] = useState(false);
  const [draftsUnreachable, setDraftsUnreachable] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"drafts" | "alerts">(
    draftsAllowed ? "drafts" : "alerts",
  );
  // One-action-per-draft pending-state; covers approve / reject / dismiss
  // so the buttons rate-limit themselves and don't double-fire on a
  // jittery click.
  const [pending, setPending] = useState<{ id: string; kind: "approve" | "reject" | "dismiss" } | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!draftsAllowed) {
      setDrafts([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      try {
        const r = await api.pulse.drafts("held");
        if (cancelled) return;
        setDrafts(r.drafts);
        setDraftsUnreachable(false);
      } catch {
        if (cancelled) return;
        setDraftsUnreachable(true);
      } finally {
        if (!cancelled) timer = setTimeout(tick, 15_000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [draftsAllowed, refreshTick]);

  // Expired drafts are loaded on-demand the first time the operator
  // toggles "Show expired" — keeping them out of the default fetch is
  // what guarantees they don't count toward the badge.
  useEffect(() => {
    if (!draftsAllowed || !showExpired) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.pulse.drafts("expired");
        if (cancelled) return;
        setExpiredDrafts(r.drafts);
      } catch {
        if (cancelled) return;
        setExpiredDrafts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftsAllowed, showExpired, refreshTick]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current) return;
      if (!wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Open the popover when something elsewhere in the app (e.g. the
  // Risk Board "N held" pill) bumps the open nonce. Snap to the drafts
  // tab so the operator lands on the queue they came to look at,
  // assuming the role is allowed to see drafts at all.
  useEffect(() => {
    if (popoverOpenTick === 0) return;
    if (!draftsAllowed) return;
    setTab("drafts");
    setOpen(true);
  }, [popoverOpenTick, draftsAllowed]);

  // Stage presenters get the dedicated AlertBadge backstop instead.
  if (stageMode) return null;

  const draftCount = drafts.length;
  const totalCount = (draftsAllowed ? draftCount : 0) + alertCount;

  // Tone is dominated by the most urgent signal — alerts beat drafts
  // because they are operational signals, drafts are review queue items.
  const tone =
    alertCount >= 3
      ? "var(--color-danger)"
      : alertCount > 0
        ? "var(--color-warning)"
        : draftCount > 0
          ? "var(--color-primary)"
          : draftsUnreachable
            ? "var(--color-warning)"
            : "var(--color-text-muted)";

  async function dismiss(draftId: string) {
    if (pending) return;
    setPending({ id: draftId, kind: "dismiss" });
    try {
      await api.pulse.dismissDraft(draftId);
      setDrafts((prev) => prev.filter((d) => d.draft_id !== draftId));
      bumpDrafts();
      pushToast({ tone: "ok", text: `Draft ${draftId} dismissed`, ttlMs: 3000 });
    } catch (e) {
      pushToast({ tone: "error", text: `Dismiss failed: ${formatApiError(e)}` });
    } finally {
      setPending(null);
    }
  }

  async function approve(draftId: string) {
    if (pending) return;
    setPending({ id: draftId, kind: "approve" });
    try {
      const r = await api.pulse.approveDraft(draftId);
      setDrafts((prev) => prev.filter((d) => d.draft_id !== draftId));
      bumpDrafts();
      const exec = r.execution;
      const tail = exec?.proposal_id
        ? ` · cross-level proposal ${exec.proposal_id} queued`
        : exec?.status === "queued_for_execution"
          ? " · queued for execution"
          : "";
      pushToast({
        tone: "ok",
        text: `Draft ${draftId} approved${tail}`,
        ttlMs: 5000,
      });
    } catch (e) {
      pushToast({ tone: "error", text: `Approve failed: ${formatApiError(e)}` });
    } finally {
      setPending(null);
    }
  }

  async function reject(draftId: string) {
    if (pending) return;
    // Light-weight reason capture — `prompt` keeps the popover small;
    // an empty/cancelled reason is fine (the audit row records "" so
    // the rejection itself is still on-chain).
    const raw = window.prompt(
      `Reject draft ${draftId}? Optional reason (logged in the audit chain):`,
      "",
    );
    if (raw === null) return;
    const reason = raw.trim();
    setPending({ id: draftId, kind: "reject" });
    try {
      await api.pulse.rejectDraft(draftId, reason);
      setDrafts((prev) => prev.filter((d) => d.draft_id !== draftId));
      bumpDrafts();
      pushToast({
        tone: "warn",
        text: `Draft ${draftId} rejected${reason ? ` · ${reason}` : ""}`,
        ttlMs: 5000,
      });
    } catch (e) {
      pushToast({ tone: "error", text: `Reject failed: ${formatApiError(e)}` });
    } finally {
      setPending(null);
    }
  }

  function openOnAsset(d: PulseDraft) {
    setSelectedAssetId(d.asset_id);
    setOpen(false);
    nav("/pulse/risk");
  }

  const ariaLabel = `${alertCount} active alert${alertCount === 1 ? "" : "s"}${draftsAllowed ? `, ${draftCount} draft${draftCount === 1 ? "" : "s"} held` : ""}`;

  return (
    <div ref={wrap} className="relative shrink-0">
      <Pressable
        onClick={() => setOpen((v) => !v)}
        block={false}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        data-testid="notifications-chip"
        className="!min-h-0 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-sm border bg-[var(--color-bg)] px-2 font-mono text-[11px] uppercase tracking-widest"
        style={{
          borderColor:
            totalCount > 0 || draftsUnreachable
              ? `color-mix(in oklab, ${tone} 45%, var(--color-border))`
              : "var(--color-border)",
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: tone }}
          aria-hidden
        >
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {/* Numeric badge — sums alerts and drafts. Shows the urgent
         * count separately when there are alerts so the operator sees
         * the situation, not just a sum. */}
        <span className="tabular-nums" style={{ color: tone }}>
          {alertCount > 0
            ? `${alertCount}!${draftsAllowed && draftCount > 0 ? `+${draftCount}` : ""}`
            : draftsAllowed
              ? String(draftCount).padStart(2, "0")
              : "00"}
        </span>
      </Pressable>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          data-testid="notifications-panel"
          className="absolute right-0 top-[calc(100%+6px)] z-[8500] w-[28rem] max-w-[92vw] rounded-md border border-[var(--color-border-active)] bg-[var(--color-surface)] shadow-2xl"
        >
          {draftsAllowed && (
            <div
              role="tablist"
              className="flex border-b border-[var(--color-border)]"
            >
              <button
                role="tab"
                aria-selected={tab === "drafts"}
                data-testid="notifications-tab-drafts"
                onClick={() => setTab("drafts")}
                className={`flex-1 px-4 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                  tab === "drafts"
                    ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                    : "border-b-2 border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                Drafts ({draftCount})
              </button>
              <button
                role="tab"
                aria-selected={tab === "alerts"}
                data-testid="notifications-tab-alerts"
                onClick={() => setTab("alerts")}
                className={`flex-1 px-4 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                  tab === "alerts"
                    ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                    : "border-b-2 border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                Alerts ({alertCount})
              </button>
            </div>
          )}

          {(tab === "drafts" && draftsAllowed) && (
            <div>
              <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
                <span>Risk Board · held drafts · audit-tracked</span>
                {/* "Show expired" toggle — task #144. Expired rows are
                    rotated out of `held` by the backend TTL/cap sweep
                    and are hidden by default so they don't count toward
                    the badge. Operators can opt in to audit them. */}
                <label className="flex cursor-pointer items-center gap-1.5 normal-case tracking-normal">
                  <input
                    type="checkbox"
                    checked={showExpired}
                    onChange={(e) => setShowExpired(e.target.checked)}
                    data-testid="notifications-show-expired"
                    className="h-3 w-3 cursor-pointer accent-[var(--color-primary)]"
                  />
                  <span className="text-[10px] uppercase tracking-widest">
                    Show expired
                  </span>
                </label>
              </div>
              {draftsUnreachable && (
                <div className="border-b border-[var(--color-border)] px-4 py-2 font-mono text-[11px] text-[var(--color-warning)] tracking-wide">
                  Drafts service unreachable — list may be stale.
                </div>
              )}
              {draftCount === 0 && !draftsUnreachable && (
                <div className="px-4 py-6 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  No drafts held. Use the Draft Action button on the PULSE Risk Board to queue one.
                </div>
              )}
              {draftCount > 0 && (
                <ul className="max-h-[60vh] divide-y divide-[var(--color-border)] overflow-y-auto">
                  {drafts.map((d) => {
                    // Approver UI is gated on (1) the role being in the
                    // approver set and (2) the actor differing from the
                    // originator — the backend re-asserts both, but we
                    // also hide the buttons so the popover doesn't lure
                    // an originator into a guaranteed-403 click.
                    const canApprove = draftsAllowed && d.actor !== role;
                    const isOriginator = d.actor === role;
                    const rowPending = pending?.id === d.draft_id;
                    return (
                      <li key={d.draft_id} className="p-3" data-testid={`drafts-row-${d.draft_id}`}>
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-widest">
                              <span className="font-semibold text-[var(--color-primary)]">
                                {d.kind?.toUpperCase()}
                              </span>
                              <button
                                type="button"
                                onClick={() => openOnAsset(d)}
                                className="font-semibold text-[var(--color-text)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-primary)]"
                                title="Open this asset on the Risk Board"
                              >
                                {d.asset_id}
                              </button>
                              {d.unit_name && (
                                <span className="text-[var(--color-text-muted)]">· {d.unit_name}</span>
                              )}
                            </div>
                            <div className="mt-1 font-mono text-xs text-[var(--color-text)] tracking-wide">
                              {d.title}
                            </div>
                            <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                              {d.draft_id} · by {d.actor} · {formatAge(d.created_at)}
                              {d.mc_delta_pct != null && (
                                <> · MC +{(d.mc_delta_pct * 100).toFixed(0)}</>
                              )}
                              {d.cost_usd != null && (
                                <> · ${d.cost_usd.toLocaleString("en-US")}</>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-end gap-2">
                          {canApprove && (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => approve(d.draft_id)}
                                pending={rowPending && pending?.kind === "approve"}
                                disabled={!!pending}
                                data-testid={`drafts-approve-${d.draft_id}`}
                                title="Approve this draft. CANNIBALIZE drafts auto-route to a cross-level proposal."
                              >
                                Approve
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => reject(d.draft_id)}
                                pending={rowPending && pending?.kind === "reject"}
                                disabled={!!pending}
                                data-testid={`drafts-reject-${d.draft_id}`}
                                title="Reject this draft. Optional reason is logged in the audit chain."
                              >
                                Reject
                              </Button>
                            </>
                          )}
                          {isOriginator && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => dismiss(d.draft_id)}
                              pending={rowPending && pending?.kind === "dismiss"}
                              disabled={!!pending}
                              data-testid={`drafts-dismiss-${d.draft_id}`}
                              title="Withdraw this draft (writes an audit row). Originator-only."
                            >
                              Dismiss
                            </Button>
                          )}
                          {!canApprove && !isOriginator && (
                            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                              awaiting approver
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {showExpired && (
                <div
                  className="border-t border-[var(--color-border)]"
                  data-testid="notifications-expired-section"
                >
                  <div className="px-4 py-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
                    Expired ({expiredDrafts.length}) · auto-rotated, audit-tracked
                  </div>
                  {expiredDrafts.length === 0 ? (
                    <div className="px-4 py-3 text-center font-mono text-[11px] text-[var(--color-text-muted)] tracking-wide">
                      No expired drafts on record.
                    </div>
                  ) : (
                    <ul className="max-h-[40vh] divide-y divide-[var(--color-border)] overflow-y-auto opacity-75">
                      {expiredDrafts.map((d) => (
                        <li key={d.draft_id} className="p-3">
                          <div className="flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-widest">
                            <span className="text-[var(--color-text-muted)]">
                              {d.kind?.toUpperCase()}
                            </span>
                            <button
                              type="button"
                              onClick={() => openOnAsset(d)}
                              className="font-semibold text-[var(--color-text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-primary)]"
                              title="Open this asset on the Risk Board"
                            >
                              {d.asset_id}
                            </button>
                            {d.unit_name && (
                              <span className="text-[var(--color-text-muted)]">· {d.unit_name}</span>
                            )}
                          </div>
                          <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
                            {d.title}
                          </div>
                          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                            {d.draft_id} · by {d.actor} · {formatAge(d.created_at)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {(tab === "alerts" || !draftsAllowed) && (
            <div>
              <div className="border-b border-[var(--color-border)] px-4 py-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
                Active alerts · operational signals
              </div>
              {alertCount === 0 ? (
                <div className="px-4 py-6 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
                  No active alerts. Operational state nominal.
                </div>
              ) : (
                <div className="px-4 py-4 font-mono text-xs text-[var(--color-text)] tracking-wide">
                  <div className="flex items-baseline gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: tone }} aria-hidden>
                      <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
                    </svg>
                    <span style={{ color: tone }} className="font-semibold tabular-nums">
                      {alertCount} active alert{alertCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-2 text-[var(--color-text-secondary)]">
                    Alerts are surfaced on the unit feed and on the relevant module screens.
                    Resolve them in the originating module to clear this badge.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
