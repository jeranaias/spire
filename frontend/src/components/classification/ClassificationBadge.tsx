/**
 * ClassificationBadge — small inline pill that stamps a classification label
 * onto any UI element (export button, file row, attestation header).
 *
 * CAPCO-aligned colors come from `levels.ts`. Two sizes: "sm" (inline next to
 * a button label) and "md" (banner-style above an artifact).
 */
import {
  classificationColors,
  classificationLabel,
  type Classification,
} from "./levels";

interface Props {
  classification: Classification | string;
  size?: "sm" | "md";
  caveats?: string[];
  title?: string;
  className?: string;
}

export function ClassificationBadge({
  classification,
  size = "sm",
  caveats,
  title,
  className = "",
}: Props) {
  const colors = classificationColors(classification);
  const label = classificationLabel(classification);
  const caveatStr = caveats && caveats.length ? ` // ${caveats.join(" // ")}` : "";
  const fullLabel = `${label}${caveatStr}`;

  const padding = size === "md" ? "4px 10px" : "2px 6px";
  const fontSize = size === "md" ? 11 : 9.5;

  return (
    <span
      className={className}
      title={title || fullLabel}
      style={{
        background: colors.bg,
        color: colors.fg,
        padding,
        borderRadius: 2,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        display: "inline-block",
        lineHeight: 1.3,
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      {fullLabel}
    </span>
  );
}
