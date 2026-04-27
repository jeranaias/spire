import "./_group.css";
import "./BridgeConsole.css";

/**
 * Variant B — "Bridge Console"
 *
 * Design opinion: SPIRE as a fly-by-wire bridge console.
 * Pure monochrome steel, hairline rules, no chroma, no flourish.
 * Density is the virtue; the operator's eye supplies the hierarchy.
 *
 * Aesthetic axes:
 *   warmth: COOL    density: DENSE    formality: FORMAL
 *   playfulness: ZERO    visual quietness: SILENT
 *
 * Layout / structure / copy are identical to the production Onboarding modal.
 */
export function BridgeConsole() {
  const step = 0;

  return (
    <div className="spire-onb-host bc-shell">
      {/* Hairline grid backdrop */}
      <div className="bc-grid" aria-hidden="true" />
      <div className="bc-card spire-onb-card" role="dialog" aria-modal="true">
        {/* Step indicator */}
        <div className="bc-row">
          <div className="bc-row bc-gap">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`bc-tick ${i <= step ? "bc-tick-on" : ""}`} />
            ))}
            <span className="bc-label bc-step-label">STEP {String(step + 1).padStart(2, "0")} / 03</span>
          </div>
          <button className="bc-link" aria-label="Skip onboarding">SKIP ›</button>
        </div>

        <div>
          <div className="bc-label">› WELCOME TO SPIRE</div>
          <h2 className="bc-title">Contested Logistics Operating System</h2>
        </div>

        <p className="bc-body">
          SPIRE is a single screen for the things that take a Marine a dozen tabs and three phone
          calls today. See unit readiness, find a cannib donor, draft a TMR, mark CUI, watch the
          gate cameras. One laptop. Works without internet. Built by Marines, on duty time.
        </p>

        <div className="bc-panel">
          <div className="bc-panel-head">
            <span className="bc-label">WHAT YOU CAN DO HERE</span>
          </div>
          <ol className="bc-list">
            <li><span className="bc-li-num">01</span><span>See your unit's readiness, by asset, in real time</span></li>
            <li><span className="bc-li-num">02</span><span>Forecast where readiness is heading 7-30 days out</span></li>
            <li><span className="bc-li-num">03</span><span>Find a cannibalization donor, draft the TMR, send it</span></li>
            <li><span className="bc-li-num">04</span><span>Mark a record CUI / NOFORN / coalition-releasable</span></li>
            <li><span className="bc-li-num">05</span><span>Watch base sensors (gate, perimeter, drone) on one map</span></li>
          </ol>
        </div>

        <div className="bc-footer">
          <button className="bc-btn bc-btn-ghost" disabled>‹ BACK</button>
          <button className="bc-btn bc-btn-primary">NEXT ›</button>
        </div>
      </div>
    </div>
  );
}
