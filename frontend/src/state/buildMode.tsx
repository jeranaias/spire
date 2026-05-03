/**
 * Build posture — `demo` vs `operational`.
 *
 * Read from `import.meta.env.VITE_SPIRE_BUILD` at module init. Default
 * `demo` for safety: a stale branch shouldn't accidentally hide chrome
 * a stakeholder is expecting to see. Pilot deployments set the env
 * explicitly to `operational` at build time.
 *
 * Why two builds:
 *
 *   demo         — judging panels, flag-officer briefings, MDM-style
 *                  show-and-tell. Mission clock, MARINE MADE chip,
 *                  build version stamp, threat rings default on,
 *                  walkthrough intros. Photographs well.
 *   operational  — sustained pilot use by a CWO + 2 SSgts. Chrome
 *                  trimmed, walkthrough copy stripped, threat rings
 *                  default off, panels collapsed per role, no demo
 *                  banners. Lower cognitive load for the work.
 *
 * Wrappers:
 *
 *   <DemoOnly>...</DemoOnly>           Renders children only in demo build.
 *   <OperationalOnly>...</OperationalOnly>   Inverse.
 *
 * Helpers:
 *
 *   isDemo() / isOperational()        For non-React code paths
 *                                     (zustand stores, API helpers).
 *   useBuildMode()                    React hook returning the live
 *                                     mode string. Today the mode is
 *                                     fixed at module init; the hook
 *                                     exists so a future runtime
 *                                     toggle (e.g. a Security Manager
 *                                     keyboard shortcut) doesn't
 *                                     require a refactor of every
 *                                     consumer.
 */
import type { ReactNode } from "react";

export type BuildMode = "demo" | "operational";

function readBuildMode(): BuildMode {
  // import.meta.env is only populated under Vite; in a non-Vite
  // context (e.g. a node test harness importing this file), fall
  // back to a process.env read so the helpers stay usable.
  //
  // Default flipped 2026-05-02 — pilot deployments are the common
  // case so the unset default is "operational". Demo nights set
  // VITE_SPIRE_BUILD=demo explicitly via build arg or Fly secret.
  const viteVal = (typeof import.meta !== "undefined" &&
    (import.meta as any).env?.VITE_SPIRE_BUILD) as string | undefined;
  const procVal =
    typeof process !== "undefined" ? (process as any).env?.SPIRE_BUILD : undefined;
  const raw = (viteVal ?? procVal ?? "operational").toString().toLowerCase();
  return raw === "demo" ? "demo" : "operational";
}

export const BUILD_MODE: BuildMode = readBuildMode();

export function isDemo(): boolean {
  return BUILD_MODE === "demo";
}

export function isOperational(): boolean {
  return BUILD_MODE === "operational";
}

export function useBuildMode(): BuildMode {
  // Fixed at module init today. The hook indirection lets us swap to
  // a Zustand store without touching every consumer.
  return BUILD_MODE;
}

export function DemoOnly({ children }: { children: ReactNode }) {
  return isDemo() ? <>{children}</> : null;
}

export function OperationalOnly({ children }: { children: ReactNode }) {
  return isOperational() ? <>{children}</> : null;
}

/**
 * Pick a value based on build mode. Useful for inline copy diffs:
 *
 *   const banner = pickByBuild({
 *     demo: "UNCLASSIFIED // DEMO DATA // NOT FOR OPERATIONAL USE",
 *     operational: "UNCLASSIFIED // FOUO",
 *   });
 */
export function pickByBuild<T>({
  demo,
  operational,
}: {
  demo: T;
  operational: T;
}): T {
  return isOperational() ? operational : demo;
}
