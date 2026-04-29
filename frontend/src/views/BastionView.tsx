/**
 * BASTION — Common Operating Picture surface for the Nansei-Shoto
 * stand-in-forces scenario.
 *
 * This view is intentionally minimal post-pivot: it renders only the
 * three-island MIL-STD-2525D map layer (`OkinawaMapCanvas`). The
 * historical populated-state render (Camp Henderson alert sidebar +
 * 2D schematic + response panel) was retired because its Henderson-
 * shaped chrome rendered on top of the Okinawa map and confused
 * everyone who saw it. To restore an Okinawa-flavored populated
 * state, rebuild the alert/COP overlays against `OkinawaMapCanvas`
 * — the historical render lives in git at commit 2fac693.
 *
 * The dataset-status gate stays in place so the subtitle reflects
 * whether GCSS-MC data has been ingested yet (informational only —
 * the map renders identically in both states until the populated
 * overlays are rebuilt).
 */
import { useEffect, useState } from "react";

import { api, type BastionAlert } from "../api";
import { useSpireStore } from "../state/store";
import { OkinawaMapCanvas } from "../components/OkinawaMapCanvas";
import { UseCaseStrip } from "../components/UseCaseStrip";
import { useDatasetStatus } from "../hooks/useDatasetStatus";

export function BastionView() {
  // Mirrors PulseView: treat "still loading first status" as empty so
  // the page doesn't get stuck on a pre-data spinner. Once the first
  // poll resolves, datasetStatus.empty drives the actual decision.
  const { status: datasetStatus, loading: datasetStatusLoading } =
    useDatasetStatus();
  const datasetIsEmpty =
    datasetStatus?.empty !== false ||
    (datasetStatusLoading && !datasetStatus);

  const role = useSpireStore((s) => s.role);
  const setAlertCount = useSpireStore((s) => s.setAlertCount);
  const setAlertSeverityCounts = useSpireStore((s) => s.setAlertSeverityCounts);
  const [alerts, setAlerts] = useState<BastionAlert[]>([]);

  // Lightweight alert poll — keeps the topbar alert badge accurate even
  // though we don't render the populated alert sidebar yet. Skip while
  // the dataset is empty (route returns {empty: true} envelope).
  useEffect(() => {
    if (datasetIsEmpty) return;
    let cancelled = false;
    let stopped = false;

    async function tick() {
      if (stopped) return;
      try {
        const r = await api.bastion.alerts(40);
        if (cancelled) return;
        const list = (r as unknown as { alerts?: BastionAlert[] }).alerts ?? [];
        setAlerts(list);
        setAlertCount(list.length);
        const counts: Record<string, number> = {
          CRITICAL: 0,
          HIGH: 0,
          MODERATE: 0,
          LOW: 0,
          INFO: 0,
        };
        for (const a of list) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
        setAlertSeverityCounts(counts);
      } catch {
        // Tolerant — alerts polling is best-effort. Topbar badge will
        // reflect last known state.
      }
    }

    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      stopped = true;
      window.clearInterval(id);
    };
  }, [role, datasetIsEmpty, setAlertCount, setAlertSeverityCounts]);

  return (
    <div className="flex h-full flex-col">
      <UseCaseStrip
        number="11"
        title="BASTION"
        subtitle={
          datasetIsEmpty
            ? "COMMON OPERATING PICTURE — NANSEI SHOTO STAND-IN FORCES"
            : `COMMON OPERATING PICTURE — NANSEI SHOTO · ${alerts.length} ALERT${
                alerts.length === 1 ? "" : "S"
              }`
        }
        accent="var(--color-warning)"
      />
      <div className="relative flex-1 overflow-hidden">
        <OkinawaMapCanvas />
      </div>
    </div>
  );
}
