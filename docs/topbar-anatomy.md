# SPIRE TopBar Anatomy

Task #184 declutter — the TopBar carries 13 distinct affordances. This
note records how they collapse into a stable spine that survives
1024 → 2560px without wrapping or visual rebalance.

## Goals

1. **Same skeleton at every breakpoint.** The user should never see a
   chip "appear" or shift columns when they resize. Hidden detail goes
   into menus, not a different row.
2. **Roles still gate.** The PR #181 `z-[60]` MissionClock fix and the
   `restrict` role gates on Tabs / IdentityChips / PushToJointButton are
   preserved verbatim.
3. **Stage mode (`?stage=1` / `localStorage spire.stageMode=1`) keeps
   the dramatic surface.** Failsafe + Reset + Audit are clustered into
   one rounded chip so they read as a single "stage controls" affordance
   instead of three competing pills.

## Spine

```
[Mark][Tabs ………………………………………………][Mid: clock][Right: chips][Identity]
```

- **Mark** — SPIRE wordmark + classification + tagline. The tagline
  ("Contested Logistics") is `truncate max-w-[14rem] min-w-0` so it can
  shrink without pushing the tabs.
- **Tabs** — flex-wrap row, no leading numerals (`01/02/...` removed).
  Wraps onto a second line on the smallest supported width but never
  competes with the right group for horizontal real estate.
- **Mid** — `MissionClock`. Full clock at `xl+`, `compact` chip at
  `md..lg`, hidden below `md`. Compact chip dispatches a
  `spire:open-mission-clock` event; the full clock listens and reopens.
- **Right** — `SystemStatusChip` + (`StageCluster` if stage mode) +
  `NotificationsChip` + `CommsControl` + (`PushToJointButton` if
  cleared role) + `IdentityChips` (≤ 4 sibling certs) +
  `IdentityPill` (the menu).
- **IdentityPill menu** holds Operator settings (Air-gap, Density,
  Comms posture summary), Presenter shortcuts, and Sign out. This is
  where the chips that used to crowd the right group now live.

## Breakpoint diagrams

### `xl` and up (≥ 1280px)

```
┌──────────────────────────────────────────────────────────────────────┐
│ SPIRE  · UNCLASSIFIED · Contested Logistics                          │
│ SENTRY  PULSE  BASTION  ADMIN                                        │
│                                                                      │
│ [MissionClock — full]                                                │
│ [System][StageCluster?][Notif][Comms][JointCOP?][IdChips][IdPill ▾]  │
└──────────────────────────────────────────────────────────────────────┘
```

Every right-group chip shows label + value segments. SystemStatusChip
unfurls "Sync · GCSS · Mode" labels at `2xl`, badge-only otherwise.

### `md`/`lg` (768 – 1280px)

```
┌──────────────────────────────────────────────────────────────────────┐
│ SPIRE · UNCLASS · Contested Logistics                                │
│ SENTRY  PULSE  BASTION  ADMIN                                        │
│ [Clock chip] [System][Stage?][Notif][Comms][IdChips][IdPill ▾]       │
└──────────────────────────────────────────────────────────────────────┘
```

The full MissionClock is hidden; `CompactMissionClock` rides in the
right group. JointCOP button is `hidden xl:inline-flex` — the menu's
"Open demo cockpit" row is the fallback at this width.

### `sm` (≤ 768px, narrow staff laptop / portrait)

```
┌──────────────────────────────────┐
│ SPIRE · UNCLASS                  │
│ SENTRY PULSE BASTION ADMIN       │
│ [System][Notif][Comms][IdPill ▾] │
└──────────────────────────────────┘
```

MissionClock disappears entirely; the menu's mission row owns the
"open the clock" affordance via the `spire:open-mission-clock` event.
Tabs wrap. Tagline truncates.

## Rationale

| Old chip                  | New home                                          |
| ------------------------- | ------------------------------------------------- |
| NodeStatus                | `SystemStatusChip` (Sync segment + drawer)        |
| GcssMcSyncPill            | `SystemStatusChip` (GCSS segment + drawer body)   |
| ModeBadge                 | `SystemStatusChip` (Mode segment + dropdown row)  |
| AlertBadge (operator)     | `NotificationsChip` Alerts tab                    |
| AlertBadge (stage)        | Backstop kept in stage mode for the dramatic ping |
| DraftsBadge               | `NotificationsChip` Drafts tab                    |
| FailsafePill              | `StageCluster` Failsafe icon                      |
| ResetDemoButton           | `StageCluster` Reset icon                         |
| AuditPill                 | `StageCluster` Audit icon                         |
| AirGapToggle              | IdentityPill → Operator settings → Air-gap row    |
| DensityToggle             | IdentityPill → Operator settings → Density radio  |
| CommsControl              | Stays in right group (single posture chip)        |
| MissionClock              | Stays mid; `compact` variant for `md`/`lg`        |
| PushToJointButton         | Right group, `xl+` only                           |
| Tab numerals (`01/02/...`)| Removed — labels carry the meaning                |

The drawer/dropdown destinations are reachable in stage mode too — the
chip is the same component, the menu is the same menu, only the
surrounding stage cluster appears/disappears with the mode.
