/**
 * AwaitingIngestEmpty — Task #183 stage live-ingest mode.
 *
 * Reusable placeholder rendered by every top-level view (BASTION,
 * PULSE, SENTRY) while the dataset singleton is empty. The single
 * action returns the operator to DECISION BRIDGE where the
 * StageIngestHero accepts the three GCSS-MC CSVs.
 *
 * DECISION BRIDGE itself does *not* render this placeholder — it
 * mounts ``StageIngestHero`` directly above its tile grid so the
 * drop-zone is in front of the operator without a routing hop.
 */
import { useNavigate } from "react-router-dom";

import { Button, EmptyState } from "./ui";

interface AwaitingIngestEmptyProps {
  /** View name shown in the headline ("BASTION", "PULSE", "SENTRY"). */
  surface: string;
  /** Optional explanatory line under the headline. */
  description?: string;
}

export function AwaitingIngestEmpty({ surface, description }: AwaitingIngestEmptyProps) {
  const nav = useNavigate();
  return (
    <div
      data-testid={`awaiting-ingest-${surface.toLowerCase()}`}
      className="flex h-full items-center justify-center p-8"
    >
      <EmptyState
        title={`${surface} · Awaiting GCSS-MC ingest`}
        description={
          description ??
          `${surface} surfaces hydrate from the live GCSS-MC export. Drop the three sanitized CSVs into DECISION BRIDGE to populate this view.`
        }
        action={
          <Button variant="primary" size="sm" onClick={() => nav("/")}>
            Open DECISION BRIDGE
          </Button>
        }
      />
    </div>
  );
}
