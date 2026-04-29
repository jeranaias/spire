/**
 * Marker store — draggable APP-6 / MIL-STD-2525D symbology layer for
 * BASTION's COP planning surface. Decoupled from the GCSS-MC dataset so
 * it works in the empty-state map (Okinawa scenario layout) and stays
 * usable as additional context once readiness data lands.
 *
 * Persistence: localStorage. Backend round-trip + audit-chain wiring
 * comes in a follow-up — for the demo we want operators to drag, see
 * the move stick across reloads, and not block on an API.
 */
import { create } from "zustand";
import type { ScenarioMarker } from "../data/okinawa-scenario";
import { OKINAWA_SCENARIO } from "../data/okinawa-scenario";

const STORAGE_KEY = "spire.markers.v1";

// Drag history — the precursor to the audit-chain row. Each entry
// records the move so we can show "moved 3 min ago by RH" on hover.
type MoveEvent = {
  ts: number;
  from: [number, number];
  to: [number, number];
  by?: string;
};

export type Marker = ScenarioMarker & {
  // Tracked separately from coords so a planner can revert.
  origin?: [number, number];
  // Move log; newest first.
  history?: MoveEvent[];
};

interface MarkersState {
  markers: Marker[];
  // True once user has dragged at least one marker — surfaces the
  // "RESET TO SEED" button on the map header.
  dirty: boolean;
  // Locked = markers cannot be dragged. Default true so a casual
  // operator clicking around the map can't accidentally drift a
  // garrison off its real position. Toggle to false to enter
  // "planning mode" where drag is permitted.
  locked: boolean;

  // CRUD
  moveMarker: (id: string, to: [number, number], by?: string) => void;
  addMarker: (m: ScenarioMarker) => void;
  removeMarker: (id: string) => void;
  updateMarker: (id: string, patch: Partial<ScenarioMarker>) => void;

  // Lifecycle
  resetToSeed: () => void;
  loadFromStorage: () => void;
  setLocked: (locked: boolean) => void;
}

function readStorage(): { markers: Marker[]; dirty: boolean; locked: boolean } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.markers)) return null;
    return {
      markers: parsed.markers,
      dirty: !!parsed.dirty,
      // Default to locked when reading old shapes that didn't track it.
      locked: parsed.locked === undefined ? true : !!parsed.locked,
    };
  } catch {
    return null;
  }
}

function writeStorage(state: { markers: Marker[]; dirty: boolean; locked: boolean }) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        markers: state.markers,
        dirty: state.dirty,
        locked: state.locked,
      }),
    );
  } catch {
    // Quota / disabled storage — non-fatal; markers stay in-memory.
  }
}

function seed(): Marker[] {
  return OKINAWA_SCENARIO.map((m) => ({
    ...m,
    origin: m.coords,
    history: [],
  }));
}

// Read once at module init for the synchronous initial state.
const _initial = readStorage();

export const useMarkersStore = create<MarkersState>((set, get) => ({
  markers: _initial?.markers ?? seed(),
  dirty: _initial?.dirty ?? false,
  // Default LOCKED so casual clicks don't drift markers.
  locked: _initial?.locked ?? true,

  moveMarker: (id, to, by) => {
    const cur = get();
    // Defense-in-depth: even if a UI state slipped, never apply a move
    // when locked. The map layer also enforces this via
    // marker.setDraggable(false) when locked.
    if (cur.locked) return;
    const next = cur.markers.map((m) => {
      if (m.id !== id) return m;
      const move: MoveEvent = { ts: Date.now(), from: m.coords, to, by };
      return {
        ...m,
        coords: to,
        history: [move, ...(m.history ?? [])].slice(0, 25),
      };
    });
    const state = { markers: next, dirty: true, locked: cur.locked };
    writeStorage(state);
    set(state);
  },

  addMarker: (m) => {
    const cur = get();
    const next = [
      ...cur.markers,
      { ...m, origin: m.coords, history: [] },
    ];
    const state = { markers: next, dirty: true, locked: cur.locked };
    writeStorage(state);
    set(state);
  },

  removeMarker: (id) => {
    const cur = get();
    const next = cur.markers.filter((m) => m.id !== id);
    const state = { markers: next, dirty: true, locked: cur.locked };
    writeStorage(state);
    set(state);
  },

  updateMarker: (id, patch) => {
    const cur = get();
    const next = cur.markers.map((m) =>
      m.id === id ? { ...m, ...patch } : m,
    );
    const state = { markers: next, dirty: true, locked: cur.locked };
    writeStorage(state);
    set(state);
  },

  resetToSeed: () => {
    const cur = get();
    const next = seed();
    const state = { markers: next, dirty: false, locked: cur.locked };
    writeStorage(state);
    set(state);
  },

  loadFromStorage: () => {
    const fromStorage = readStorage();
    if (fromStorage) set(fromStorage);
  },

  setLocked: (locked) => {
    const cur = get();
    const state = { markers: cur.markers, dirty: cur.dirty, locked };
    writeStorage(state);
    set({ locked });
  },
}));
