/**
 * ClassifiedExport — the shared export-button primitive every download in
 * SPIRE wraps. Inherits classification from the artifact itself; the gate
 * decides whether to allow the export or to surface a spillage block.
 *
 * Two states:
 *   1. Cleared — renders a normal button with a classification badge inline,
 *      stamps the artifact at click time, calls `onExport`.
 *   2. Blocked — renders a disabled-looking button that says "BLOCKED ·
 *      REQUIRES <CLASS>"; clicking fires the spillage_prevented toast +
 *      writes an audit entry server-side. The actual export never runs.
 *
 * The component refuses to silently fall back to "no badge" — every export
 * carries a visible classification mark whether or not the call succeeds.
 */
import React, { useCallback, useState } from "react";

import { useSpireStore } from "../../state/store";
import { api } from "../../api";
import {
  classificationLabel,
  normalizeClassification,
  type Classification,
} from "./levels";
import { useClearance } from "./useClearance";
import { ClassificationBadge } from "./ClassificationBadge";

interface Props {
  classification: Classification | string;
  caveats?: string[];
  /**
   * Action label written into the audit entry on a block. Helps an
   * investigator localize which surface fired the spillage event.
   */
  action: string;
  /** Cleared-state click handler. Receives the normalized classification. */
  onExport: (classification: Classification) => void | Promise<void>;
  /** Cleared-state visible label. Defaults to "Export". */
  label?: string;
  /** While `loading` is true, label becomes `pendingLabel`. */
  pendingLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  /** Caller-supplied disabled-tooltip string (independent of clearance gate). */
  disabledReason?: string;
  /** Optional inline help text displayed under the button (cleared state). */
  hint?: string;
  /** Pass-through to outer button styling. */
  className?: string;
  style?: React.CSSProperties;
}

const buttonBase: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 4,
  border: "1px solid",
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.4,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  transition: "background 0.12s ease",
};

export function ClassifiedExport({
  classification,
  caveats,
  action,
  onExport,
  label = "Export",
  pendingLabel,
  loading = false,
  disabled = false,
  disabledReason,
  hint,
  className,
  style,
}: Props) {
  const { user, clearance, can } = useClearance();
  const pushToast = useSpireStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const canonical = normalizeClassification(classification);
  const cleared = can(canonical);
  const required = classificationLabel(canonical);

  const handleBlocked = useCallback(async () => {
    pushToast({
      tone: "error",
      text: `Spillage prevented · ${required} requires clearance ≥ ${required}`,
      ttlMs: 6000,
    });
    try {
      await api.system.spillagePrevented({
        action,
        required_classification: canonical,
        user_clearance: clearance,
        surface: "frontend",
      });
    } catch (e) {
      // Swallow — the toast already informed the operator; the backend's
      // own gate will fire its own audit entry on the next attempted call.
    }
  }, [action, canonical, clearance, pushToast, required]);

  const handleClick = useCallback(async () => {
    if (busy || loading) return;
    if (!cleared) {
      await handleBlocked();
      return;
    }
    if (disabled) return;
    try {
      setBusy(true);
      await onExport(canonical);
    } finally {
      setBusy(false);
    }
  }, [busy, loading, cleared, disabled, handleBlocked, onExport, canonical]);

  // Cleared, fully usable.
  if (cleared && !disabled) {
    const isLoading = busy || loading;
    const display = isLoading && pendingLabel ? pendingLabel : label;
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, ...style }}>
        <button
          type="button"
          className={className}
          onClick={handleClick}
          disabled={isLoading}
          style={{
            ...buttonBase,
            background: isLoading ? "#1c2129" : "#0033A0",
            color: "#FFFFFF",
            borderColor: isLoading ? "#2a313c" : "#0033A0",
            opacity: isLoading ? 0.7 : 1,
            cursor: isLoading ? "wait" : "pointer",
          }}
          title={`${display} · stamped ${required}${
            caveats?.length ? " // " + caveats.join(" // ") : ""
          }`}
        >
          <ClassificationBadge classification={canonical} caveats={caveats} size="sm" />
          <span>{display}</span>
        </button>
        {hint && (
          <span style={{ fontSize: 10, color: "#9aa4b2", letterSpacing: 0.3 }}>{hint}</span>
        )}
      </span>
    );
  }

  // Cleared but caller-disabled (e.g. nothing selected to export).
  if (cleared && disabled) {
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, ...style }}>
        <button
          type="button"
          className={className}
          onClick={() => {}}
          disabled
          style={{
            ...buttonBase,
            background: "#1c2129",
            color: "#5b6573",
            borderColor: "#2a313c",
            cursor: "not-allowed",
          }}
          title={disabledReason || "Unavailable"}
        >
          <ClassificationBadge classification={canonical} caveats={caveats} size="sm" />
          <span>{label}</span>
        </button>
        {(hint || disabledReason) && (
          <span style={{ fontSize: 10, color: "#9aa4b2", letterSpacing: 0.3 }}>
            {disabledReason || hint}
          </span>
        )}
      </span>
    );
  }

  // BLOCKED — clearance shortfall.
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, ...style }}>
      <button
        type="button"
        className={className}
        onClick={handleClick}
        style={{
          ...buttonBase,
          background: "#3a0d12",
          color: "#ffb3bb",
          borderColor: "#7a1f29",
          cursor: "not-allowed",
        }}
        title={`Spillage block · your clearance (${clearance || "UNCLASSIFIED"}) is below ${required}`}
      >
        <ClassificationBadge classification={canonical} caveats={caveats} size="sm" />
        <span>BLOCKED · REQUIRES {required}</span>
      </button>
      <span style={{ fontSize: 10, color: "#ffb3bb", letterSpacing: 0.3 }}>
        Your clearance: {clearance || "UNCLASSIFIED"} · {user?.role || "no role"}
      </span>
    </span>
  );
}
