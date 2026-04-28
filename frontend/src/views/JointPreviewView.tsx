/**
 * JointPreviewView — faux Navy / Joint J4 console rendering the SPIRE
 * OMS/UCI export. Lives at /joint/preview, opened in a new tab from the
 * "Push to Joint COP" topbar action so a judge can hold both windows
 * side-by-side and see SPIRE's data appearing coherently in a sister-
 * service shell.
 *
 * Design intent: this is INTENTIONALLY not the SPIRE chrome. Different
 * banner, different colors (Navy steel-blue vs SPIRE primary), different
 * type, "Joint Logistics & Tracks Console" branding. The point is to
 * show the data is portable across services, so the shell has to feel
 * unfamiliar relative to the parent app.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type JointOmsUciExport } from "../api";

interface State {
  loading: boolean;
  data: JointOmsUciExport | null;
  error: string | null;
  pulledAt: string | null;
}

const REFRESH_HINT = "Re-pull from SPIRE";

export function JointPreviewView() {
  const [s, setS] = useState<State>({ loading: true, data: null, error: null, pulledAt: null });
  const inflight = useRef(false);

  async function pull() {
    if (inflight.current) return;
    inflight.current = true;
    setS((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.joint.omsUci();
      setS({ loading: false, data, error: null, pulledAt: new Date().toISOString() });
    } catch (e) {
      const msg = e instanceof ApiError && e.body && typeof e.body === "object"
        ? (((e.body as { detail?: { error?: string; required_classification?: string } }).detail || {}).error || e.message)
        : (e as Error).message || "fetch failed";
      setS((prev) => ({ ...prev, loading: false, error: String(msg) }));
    } finally {
      inflight.current = false;
    }
  }

  useEffect(() => {
    pull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0d1620",
        color: "#cfdbe4",
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        overflow: "auto",
      }}
    >
      <JointBanner classification={s.data?.envelope.classification.marking ?? "SECRET"} releasability={s.data?.envelope.classification.releasability ?? "REL TO USA, FVEY"} />
      <JointTopBar
        published={s.data?.envelope.publishedAtUtc ?? null}
        pulledAt={s.pulledAt}
        loading={s.loading}
        onPull={pull}
      />
      <main style={{ padding: "16px 24px 64px", maxWidth: 1600, margin: "0 auto" }}>
        {s.error ? (
          <ErrorPanel message={s.error} />
        ) : s.loading && !s.data ? (
          <LoadingPanel />
        ) : s.data ? (
          <Console data={s.data} />
        ) : null}
      </main>
      <JointFooter />
    </div>
  );
}

function JointBanner({ classification, releasability }: { classification: string; releasability: string }) {
  // CAPCO-style banner. SECRET/REL is amber-on-red; SPIRE uses red but the
  // partner shell uses the slightly darker DoD CAPCO red so the banner
  // reads as "this is the partner's marking system, not SPIRE's."
  const color = classification.includes("TS") ? "#ff7a00" : classification.includes("SECRET") ? "#d11616" : "#0066cc";
  return (
    <div
      role="banner"
      style={{
        background: color,
        color: "white",
        textAlign: "center",
        padding: "4px 8px",
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: "0.18em",
      }}
    >
      {classification} // {releasability}
    </div>
  );
}

function JointTopBar({
  published,
  pulledAt,
  loading,
  onPull,
}: {
  published: string | null;
  pulledAt: string | null;
  loading: boolean;
  onPull: () => void;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 24px",
        borderBottom: "1px solid #1f2c39",
        background: "linear-gradient(180deg, #15202d 0%, #0f1822 100%)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Anchor />
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, letterSpacing: "0.18em", fontSize: 14, color: "#e6eef5" }}>
            JLTC · JOINT LOGISTICS &amp; TRACKS CONSOLE
          </div>
          <div style={{ fontSize: 11, color: "#7e94a8", letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 2 }}>
            Sister-service viewer · OMS/UCI subscriber
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>
        <Pill label="Source" value="SPIRE · USMC" />
        <Pill label="Standard" value="OMS 2.4 / UCI 5.0" />
        <Pill label="Published" value={fmtTime(published)} />
        <Pill label="Pulled" value={fmtTime(pulledAt)} />
        <button
          type="button"
          onClick={onPull}
          disabled={loading}
          aria-label={REFRESH_HINT}
          style={{
            background: loading ? "#1f3a5a" : "#1d4f8a",
            color: "white",
            border: "1px solid #2d6cb6",
            padding: "6px 12px",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: loading ? "wait" : "pointer",
            borderRadius: 2,
          }}
        >
          {loading ? "Pulling…" : REFRESH_HINT}
        </button>
      </div>
    </header>
  );
}

function Anchor() {
  // Navy fouled-anchor stand-in. Generic enough to read as "Joint" rather
  // than any specific service; we don't want to imply DoN endorsement.
  return (
    <svg width="32" height="36" viewBox="0 0 32 36" aria-hidden>
      <defs>
        <linearGradient id="anchor-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9ec3df" />
          <stop offset="100%" stopColor="#3d6a8e" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="6" r="3" fill="none" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="16" y1="9" x2="16" y2="30" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="10" y1="14" x2="22" y2="14" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <path d="M5 26 Q16 36 27 26" fill="none" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="5" y1="26" x2="3" y2="22" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="27" y1="26" x2="29" y2="22" stroke="url(#anchor-fill)" strokeWidth="1.6" />
    </svg>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        padding: "4px 10px",
        background: "#0a131c",
        border: "1px solid #1f2c39",
        color: "#cfdbe4",
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        lineHeight: 1.15,
        borderRadius: 2,
      }}
    >
      <span style={{ fontSize: 9, color: "#7e94a8" }}>{label}</span>
      <span style={{ fontSize: 11 }}>{value || "—"}</span>
    </span>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(/\..*Z$/, "Z");
  } catch {
    return iso;
  }
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      style={{
        marginTop: 20,
        background: "#3a1414",
        border: "1px solid #6e2222",
        padding: 18,
        color: "#ffd7d2",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 13,
        borderRadius: 2,
      }}
      role="alert"
    >
      <div style={{ fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 6 }}>
        Subscription failed
      </div>
      <div style={{ marginBottom: 6 }}>{message}</div>
      <div style={{ color: "#c79a96", fontSize: 11 }}>
        If this reads "InsufficientClearance," the operator currently signed in on the SPIRE tab
        cannot release a SECRET//REL bundle — sign in there as a Security Manager or MEF Commander
        and re-pull.
      </div>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div
      style={{
        marginTop: 20,
        padding: 30,
        textAlign: "center",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 12,
        letterSpacing: "0.14em",
        color: "#7e94a8",
        textTransform: "uppercase",
      }}
    >
      Subscribing to SPIRE OMS/UCI feed…
    </div>
  );
}

function Console({ data }: { data: JointOmsUciExport }) {
  const env = data.envelope;
  const counts = env.messageCounts;
  return (
    <>
      <section style={cardSection}>
        <SectionHeader title="Subscription envelope" subtitle="OMS UCIMessage header" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
          <Field label="Source system" value={`${env.sourceSystem} ${env.sourceSystemVersion}`} />
          <Field label="Source service" value={env.sourceService} />
          <Field label="Source unit" value={env.sourceUnit} />
          <Field label="Originator country" value={env.classification.originatorCountry ?? "USA"} />
          <Field label="Specification" value={env.specification} />
          <Field label="Spec version" value={env.specificationVersion} />
          <Field label="Marking" value={env.classification.marking} />
          <Field label="Releasability" value={env.classification.releasability} />
        </div>
        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {Object.entries(counts).map(([k, v]) => (
            <CountChip key={k} label={k} count={v} />
          ))}
        </div>
      </section>

      <section style={cardSection}>
        <SectionHeader title="Entity state · ground units" subtitle={`${data.messages.EntityState.length} EntityState messages`} />
        <Table
          columns={["Callsign", "UIC", "SIDC", "Lat", "Lon", "Readiness", "Operational", "As-of"]}
          rows={data.messages.EntityState.map((e: any) => [
            e.EntityIdentifier?.callsign ?? "—",
            e.EntityIdentifier?.uic ?? "—",
            e.EntityType?.sidc ?? "—",
            num(e.Position?.latitude, 4),
            num(e.Position?.longitude, 4),
            <ReadinessChip key="r" code={e.ReadinessRating} />,
            e.OperationalStatus,
            short(e.asOfTime),
          ])}
        />
      </section>

      <section style={cardSection}>
        <SectionHeader title="Track data" subtitle={`${data.messages.TrackData.length} TrackData messages`} />
        <Table
          columns={["Track #", "Origin", "Quality (0..15)", "Lat", "Lon", "Stationary", "Entity ref"]}
          rows={data.messages.TrackData.map((t: any) => [
            t.trackNumber,
            t.trackOrigin,
            t.trackQuality,
            num(t.Position?.latitude, 4),
            num(t.Position?.longitude, 4),
            t.Kinematic?.stationary ? "yes" : "no",
            t.EntityIdentifierRef,
          ])}
        />
      </section>

      <section style={cardSection}>
        <SectionHeader title="Logistics status" subtitle={`${data.messages.LogisticsStatus.length} LogisticsStatus messages`} />
        <Table
          columns={["Entity ref", "Category", "MC rate", "Items (top)", "As-of"]}
          rows={data.messages.LogisticsStatus.map((l: any) => [
            l.EntityIdentifierRef,
            l.logisticsCategory,
            <ReadinessBar key="r" rate={l.missionCapableRate ?? 0} />,
            <ItemList key="i" items={(l.items || []).slice(0, 3)} />,
            short(l.asOfTime),
          ])}
        />
      </section>

      <section style={cardSection}>
        <SectionHeader title="Alert notifications" subtitle={`${data.messages.AlertNotification.length} AlertNotification messages`} />
        {data.messages.AlertNotification.length === 0 ? (
          <Empty text="No active joint-relevant alerts in this window." />
        ) : (
          <Table
            columns={["Severity", "Category", "Entity ref", "Summary", "As-of"]}
            rows={data.messages.AlertNotification.map((a: any) => [
              <SeverityChip key="s" sev={a.severity} />,
              a.alertCategory,
              a.EntityIdentifierRef,
              a.summary,
              short(a.asOfTime),
            ])}
          />
        )}
      </section>
    </>
  );
}

const cardSection: React.CSSProperties = {
  background: "#101a26",
  border: "1px solid #1f2c39",
  borderRadius: 2,
  padding: "14px 18px 18px",
  marginTop: 16,
};

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, borderBottom: "1px solid #1f2c39", paddingBottom: 6 }}>
      <h2 style={{ margin: 0, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, letterSpacing: "0.18em", textTransform: "uppercase", color: "#e6eef5" }}>{title}</h2>
      {subtitle && <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: "0.12em", color: "#7e94a8", textTransform: "uppercase" }}>{subtitle}</span>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: "#0a131c", border: "1px solid #1f2c39", padding: "8px 10px", borderRadius: 2 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: "0.16em", color: "#7e94a8", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, marginTop: 3, color: "#e6eef5" }}>{value}</div>
    </div>
  );
}

function CountChip({ label, count }: { label: string; count: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 8,
        padding: "4px 10px",
        background: "#162335",
        border: "1px solid #2d6cb6",
        color: "#9ec3df",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        letterSpacing: "0.12em",
        borderRadius: 2,
      }}
    >
      <span style={{ textTransform: "uppercase" }}>{label}</span>
      <span style={{ color: "#e6eef5", fontWeight: 600 }}>{count}</span>
    </span>
  );
}

function Table({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                style={{
                  textAlign: "left",
                  padding: "6px 10px",
                  borderBottom: "1px solid #1f2c39",
                  color: "#7e94a8",
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  fontWeight: 500,
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? "#0d1620" : "transparent" }}>
              {r.map((cell, j) => (
                <td key={j} style={{ padding: "6px 10px", borderBottom: "1px solid #15212e", color: "#cfdbe4", verticalAlign: "middle" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReadinessChip({ code }: { code: string }) {
  const tone =
    code === "C1" ? { bg: "#0d3a1f", fg: "#7be39c", border: "#1c7a44" } :
    code === "C2" ? { bg: "#26350f", fg: "#cfe87a", border: "#5b7720" } :
    code === "C3" ? { bg: "#3a2810", fg: "#f0c682", border: "#825a1f" } :
                    { bg: "#3a1414", fg: "#ff9b95", border: "#7a2222" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        borderRadius: 2,
        fontWeight: 600,
        letterSpacing: "0.14em",
      }}
    >
      {code}
    </span>
  );
}

function SeverityChip({ sev }: { sev: string }) {
  // Mirrors the backend ALERT_SEVERITY_ENUM in backend/routes/joint.py:
  //   CRITICAL > HIGH > MODERATE > LOW
  // CRITICAL gets its own brighter red so it doesn't read as just another
  // HIGH; LOW gets a deliberate cool-blue tone instead of falling to the
  // neutral catch-all (P1-9 from the joint-cop critique).
  const norm = (sev || "").toUpperCase();
  const tone =
    norm === "CRITICAL" ? { bg: "#4a0a0a", fg: "#ffd5d0", border: "#c43a2f" } :
    norm === "HIGH"     ? { bg: "#3a1414", fg: "#ff9b95", border: "#7a2222" } :
    norm === "MODERATE" ? { bg: "#3a2810", fg: "#f0c682", border: "#825a1f" } :
    norm === "LOW"      ? { bg: "#0c2233", fg: "#9ec3df", border: "#2d6cb6" } :
                          { bg: "#1a232c", fg: "#9caab6", border: "#2c3a48" };
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}`, borderRadius: 2, letterSpacing: "0.12em", fontWeight: 600 }}>
      {sev}
    </span>
  );
}

function ReadinessBar({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(1, rate)) * 100;
  const color = rate >= 0.85 ? "#7be39c" : rate >= 0.70 ? "#cfe87a" : rate >= 0.55 ? "#f0c682" : "#ff9b95";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, background: "#0a131c", border: "1px solid #1f2c39", borderRadius: 1 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
      <span style={{ width: 40, textAlign: "right", color: "#cfdbe4" }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

function ItemList({ items }: { items: any[] }) {
  if (!items.length) return <span style={{ color: "#7e94a8" }}>—</span>;
  return (
    <span>
      {items.map((it: any, i: number) => (
        <span key={i} style={{ display: "inline-block", marginRight: 8 }}>
          {it.nomenclature}: {it.missionCapable}/{it.onHand}
        </span>
      ))}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: 24, textAlign: "center", color: "#7e94a8", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase" }}>
      {text}
    </div>
  );
}

function num(n: number | undefined, decimals: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return n.toFixed(decimals);
}

function short(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return iso;
  }
}

function JointFooter() {
  return (
    <footer
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: "1px solid #1f2c39",
        background: "#0a131c",
        padding: "6px 24px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
        color: "#7e94a8",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
      }}
    >
      <span>JLTC v0.1 · Sister-service viewer · Read-only OMS/UCI subscriber</span>
      <span>SPIRE → JLTC bridge: export-only (no ingest, no engagement orders)</span>
    </footer>
  );
}
