/**
 * useClearance() — single shared hook every gated UI primitive consumes.
 *
 * Reads the current authenticated user from the global SPIRE store, exposes
 * the operator's clearance string + numeric rank, and a `can(classification)`
 * predicate. Co-located with the rest of the classification primitives so the
 * gate logic is in one file family and easy to audit during read-throughs.
 */
import { useSpireStore } from "../../state/store";
import type { User } from "../../state/store";
import {
  classificationRank,
  clearanceRank,
  meetsClearance,
  normalizeClassification,
  type Classification,
} from "./levels";

export interface ClearanceCtx {
  user: User | null;
  clearance: string;
  rank: number;
  can: (c: Classification | string) => boolean;
  shortfallFor: (c: Classification | string) => number;
}

export function useClearance(): ClearanceCtx {
  // The store key is `currentUser` (not `user`) — populated by AuthView via
  // `signIn()` after the CAC mock login. Falling back to null lets the gate
  // render the BLOCKED state instead of crashing on the unauthenticated
  // pre-login render path.
  const user = useSpireStore((s) => s.currentUser);
  const clearance = user?.clearance ?? "UNCLASSIFIED";
  const rank = clearanceRank(clearance);
  return {
    user,
    clearance,
    rank,
    can: (c) => meetsClearance(user, normalizeClassification(c)),
    shortfallFor: (c) => Math.max(0, classificationRank(c) - rank),
  };
}
