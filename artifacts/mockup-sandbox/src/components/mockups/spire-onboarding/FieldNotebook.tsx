import "./_group.css";
import "./FieldNotebook.css";

/**
 * Variant A — "Field Notebook"
 *
 * Design opinion: SPIRE as a Marine's analog field journal.
 * Warm parchment, oxide-red ink stamps, typewriter labels, hand-set serif body.
 * The digital console set down on a wooden field-desk — quieter, more tactile.
 *
 * Aesthetic axes:
 *   warmth: WARM    density: LOOSE    formality: INFORMAL
 *   playfulness: SLIGHT    visual quietness: QUIET
 *
 * Layout / structure / copy are identical to the production Onboarding modal.
 */
export function FieldNotebook() {
  const step = 0; // mirror the screenshot — show step 1

  return (
    <div className="spire-onb-host fn-shell">
      <div className="fn-card spire-onb-card" role="dialog" aria-modal="true">
        {/* Step indicator */}
        <div className="fn-row">
          <div className="fn-row fn-gap">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`fn-tick ${i <= step ? "fn-tick-on" : ""}`} />
            ))}
            <span className="fn-eyebrow fn-step-label">Step {step + 1} of 3</span>
          </div>
          <button className="fn-link" aria-label="Skip onboarding">Skip</button>
        </div>

        <div>
          <div className="fn-eyebrow">
            <span className="fn-stamp">Welcome to SPIRE</span>
          </div>
          <h2 className="fn-title">Contested Logistics Operating System</h2>
        </div>

        <p className="fn-body">
          SPIRE is a single screen for the things that take a Marine a dozen tabs and three phone
          calls today. See unit readiness, find a cannib donor, draft a TMR, mark CUI, watch the
          gate cameras. One laptop. Works without internet. Built by Marines, on duty time.
        </p>

        <div className="fn-panel">
          <div className="fn-eyebrow">What you can do here</div>
          <ul className="fn-list">
            <li>· See your unit's readiness, by asset, in real time</li>
            <li>· Forecast where readiness is heading 7-30 days out</li>
            <li>· Find a cannibalization donor, draft the TMR, send it</li>
            <li>· Mark a record CUI / NOFORN / coalition-releasable</li>
            <li>· Watch base sensors (gate, perimeter, drone) on one map</li>
          </ul>
        </div>

        <div className="fn-footer">
          <button className="fn-btn fn-btn-ghost" disabled>Back</button>
          <button className="fn-btn fn-btn-primary">Next</button>
        </div>

        <span className="fn-corner-fold" aria-hidden="true" />
      </div>
    </div>
  );
}
