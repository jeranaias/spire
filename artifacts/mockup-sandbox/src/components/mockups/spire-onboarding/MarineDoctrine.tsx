import "./_group.css";
import "./MarineDoctrine.css";

/**
 * Variant C — "Marine Doctrine"
 *
 * Design opinion: SPIRE as the unapologetic Marine doctrine launcher.
 * Scarlet + gold against deep navy, stencil display type, diagonal banner,
 * chunky enumerated callouts. Identity dialed up; nothing whispered.
 *
 * Aesthetic axes:
 *   warmth: WARM    density: MEDIUM    formality: FORMAL
 *   playfulness: SLIGHT (geometric)    visual quietness: LOUD
 *
 * Layout / structure / copy are identical to the production Onboarding modal.
 */
export function MarineDoctrine() {
  const step = 0;

  return (
    <div className="spire-onb-host md-shell">
      <div className="md-card spire-onb-card" role="dialog" aria-modal="true">
        {/* Doctrine banner — scarlet diagonal stripe */}
        <div className="md-banner" aria-hidden="true">
          <span className="md-banner-text">CONTESTED · LOGISTICS · INDOPACOM</span>
        </div>

        {/* Step indicator */}
        <div className="md-row">
          <div className="md-row md-gap">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`md-tick ${i <= step ? "md-tick-on" : ""}`} />
            ))}
            <span className="md-step-label">STEP {step + 1} / 3</span>
          </div>
          <button className="md-link" aria-label="Skip onboarding">Skip ›</button>
        </div>

        <div>
          <div className="md-eyebrow">
            <span className="md-eyebrow-mark" />
            Welcome to SPIRE
          </div>
          <h2 className="md-title">Contested Logistics Operating System</h2>
        </div>

        <p className="md-body">
          SPIRE is a single screen for the things that take a Marine a dozen tabs and three phone
          calls today. See unit readiness, find a cannib donor, draft a TMR, mark CUI, watch the
          gate cameras. <strong>One laptop. Works without internet. Built by Marines, on duty time.</strong>
        </p>

        <div className="md-panel">
          <div className="md-panel-head">
            <span className="md-eyebrow md-eyebrow-on-dark">What you can do here</span>
          </div>
          <ol className="md-list">
            <li><span className="md-li-num">01</span><span>See your unit's readiness, by asset, in real time</span></li>
            <li><span className="md-li-num">02</span><span>Forecast where readiness is heading 7-30 days out</span></li>
            <li><span className="md-li-num">03</span><span>Find a cannibalization donor, draft the TMR, send it</span></li>
            <li><span className="md-li-num">04</span><span>Mark a record CUI / NOFORN / coalition-releasable</span></li>
            <li><span className="md-li-num">05</span><span>Watch base sensors (gate, perimeter, drone) on one map</span></li>
          </ol>
        </div>

        <div className="md-footer">
          <button className="md-btn md-btn-ghost" disabled>BACK</button>
          <button className="md-btn md-btn-primary">
            <span>NEXT</span>
            <span className="md-btn-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}
