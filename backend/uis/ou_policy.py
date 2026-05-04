"""Hierarchical RBAC — OU-mapped permissions (UIS-P6.5).

DoD logistics is hierarchical: MARFOR → MEF → MLG → CLR → CLB →
company-level units. A G-4 at a CLR has read access to every
CLB beneath it; an SSgt at one CLB doesn't see another CLB's
data, even within the same CLR. Permissions inherit DOWN the
tree.

This module defines the OU tree + visibility helpers. Existing
endpoints adopt incrementally — the helpers are pure functions
that take ``(user, resource_unit_uic)`` and return bool, so
plugging them into a route is one-line.

Data shape
----------
::

    OuNode(
        unit_uic="OWNER_UIC_3D_MEF",
        unit_name="3d Marine Expeditionary Force",
        echelon="MEF",
        parent="OWNER_UIC_MARFORPAC",
        children=["OWNER_UIC_3D_MLG", "OWNER_UIC_3D_MARDIV", ...],
    )

Loaded from a YAML/JSON config at startup; pinned via the
state-root pattern so production deployments configure their
own tree.

Permission semantics
--------------------
* **read**: user can read records owned by any unit at-or-below
  their OU's level. (G-4 at CLR sees CLR + every CLB in CLR.)
* **write**: stricter — write only at-or-below + matching role
  permissions (data_custodian / security_manager required for
  ingest writes, etc.).
* **upward visibility**: by default NO. A CLB-scoped operator
  doesn't see CLR-aggregate data. Explicit ``upward_view``
  permission grants per-role override (e.g. all G-4s have
  upward read for situational awareness).

Trust assumptions
-----------------
The OU tree is operator-supplied configuration; SPIRE doesn't
authoritatively know the chain of command. A misconfigured tree
yields misconfigured permissions — that's an integrity-of-config
problem, not an integrity-of-permission-engine problem. The
config should sit in version control alongside other ATO
artifacts and be reviewed at each deployment.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Optional, Set


log = logging.getLogger(__name__)


@dataclass(frozen=True)
class OuNode:
    unit_uic: str
    unit_name: str
    echelon: str                          # MARFOR / MEF / MLG / CLR / CLB / etc
    parent: Optional[str] = None
    children: tuple = ()                  # tuple to keep frozen


@dataclass
class OuTree:
    """In-memory hierarchy. ``by_uic`` is the primary lookup
    (constant time); ``descendants`` and ``ancestors`` are
    pre-computed at load time so per-request scoping is also
    constant time per check.
    """
    by_uic: Dict[str, OuNode] = field(default_factory=dict)
    _descendants: Dict[str, FrozenSet[str]] = field(default_factory=dict, init=False)
    _ancestors: Dict[str, FrozenSet[str]] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        self._compute_closures()

    def _compute_closures(self) -> None:
        # descendants[uic] = uic + every transitive child
        for uic in self.by_uic:
            seen: Set[str] = set()
            stack = [uic]
            while stack:
                cur = stack.pop()
                if cur in seen:
                    continue
                seen.add(cur)
                node = self.by_uic.get(cur)
                if node:
                    stack.extend(node.children)
            self._descendants[uic] = frozenset(seen)

        for uic in self.by_uic:
            seen = set()
            cur = uic
            while cur:
                seen.add(cur)
                node = self.by_uic.get(cur)
                cur = node.parent if node else None
            self._ancestors[uic] = frozenset(seen)

    def descendants(self, uic: str) -> FrozenSet[str]:
        """All UICs at-or-below ``uic`` in the tree."""
        return self._descendants.get(uic, frozenset())

    def ancestors(self, uic: str) -> FrozenSet[str]:
        """All UICs at-or-above ``uic`` in the tree."""
        return self._ancestors.get(uic, frozenset())

    def is_descendant(self, candidate: str, ancestor: str) -> bool:
        """True iff ``candidate`` is at-or-below ``ancestor``."""
        return candidate in self.descendants(ancestor)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


_TREE_LOCK = threading.Lock()
_TREE: Optional[OuTree] = None


def load_tree(path: Optional[str] = None) -> OuTree:
    """Load the OU hierarchy from a JSON config. Cached on first
    load; ``reload_tree`` forces re-read.

    Config shape: a list of node objects::

        [
            {"unit_uic": "OWNER_UIC_MARFORPAC", "unit_name": "MARFORPAC",
             "echelon": "MARFOR", "parent": null,
             "children": ["OWNER_UIC_3D_MEF"]},
            ...
        ]
    """
    global _TREE
    with _TREE_LOCK:
        if _TREE is not None and path is None:
            return _TREE
        config_path = path or os.environ.get("SPIRE_OU_TREE_PATH", "")
        if not config_path:
            # Empty-tree fallback — every check returns False
            # (closed-by-default). Production must populate.
            log.warning(
                "SPIRE_OU_TREE_PATH not set — OU hierarchy is empty. "
                "Permission checks will deny by default."
            )
            _TREE = OuTree()
            return _TREE
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            log.error("OU tree load failed from %s: %s", config_path, e)
            _TREE = OuTree()
            return _TREE
        nodes: Dict[str, OuNode] = {}
        for entry in raw:
            n = OuNode(
                unit_uic=entry["unit_uic"],
                unit_name=entry.get("unit_name", entry["unit_uic"]),
                echelon=entry.get("echelon", ""),
                parent=entry.get("parent") or None,
                children=tuple(entry.get("children", []) or []),
            )
            nodes[n.unit_uic] = n
        _TREE = OuTree(by_uic=nodes)
        return _TREE


def reload_tree(path: Optional[str] = None) -> OuTree:
    """Force re-read from disk. Used by tests + by an admin
    reload endpoint."""
    global _TREE
    with _TREE_LOCK:
        _TREE = None
    return load_tree(path)


def set_tree(tree: OuTree) -> None:
    """Inject a tree directly — for tests + standalone-extraction
    use."""
    global _TREE
    with _TREE_LOCK:
        _TREE = tree


# ---------------------------------------------------------------------------
# Permission checks
# ---------------------------------------------------------------------------


# Roles that get upward-view privilege (see at-or-above their
# OU's level for situational awareness). Operator-configurable
# via SPIRE_OU_UPWARD_VIEW_ROLES env (comma-separated).
def _upward_view_roles() -> FrozenSet[str]:
    raw = os.environ.get("SPIRE_OU_UPWARD_VIEW_ROLES", "")
    return frozenset(r.strip() for r in raw.split(",") if r.strip())


def units_visible_to(user: Dict[str, Any]) -> FrozenSet[str]:
    """Return the set of unit_uics this user can READ.

    The operator's OU + every descendant. Plus, if the operator
    has a role in the upward-view list, every ancestor too.
    Empty tree or unrecognized OU = empty set (closed-by-default).
    """
    if not user:
        return frozenset()
    user_uic = (user.get("unit_uic") or user.get("unit") or "").strip()
    if not user_uic:
        return frozenset()
    tree = load_tree()
    visible: Set[str] = set(tree.descendants(user_uic))
    role = user.get("role", "")
    if role in _upward_view_roles():
        visible |= set(tree.ancestors(user_uic))
    return frozenset(visible)


def can_read(user: Dict[str, Any], resource_unit_uic: str) -> bool:
    """True iff the user can read records owned by
    ``resource_unit_uic``. Unrecognized resource UICs
    deny-by-default."""
    if not resource_unit_uic:
        return False
    return resource_unit_uic in units_visible_to(user)


def can_write(user: Dict[str, Any], resource_unit_uic: str) -> bool:
    """True iff the user can WRITE to records owned by
    ``resource_unit_uic``. Stricter than read:

      - resource must be at-or-below the user's OU (no upward
        write — a CLR G-4 doesn't write into MEF-aggregate
        records)
      - role must be in WRITE_ROLES set

    Upward-view-grant does NOT extend to write.
    """
    if not resource_unit_uic:
        return False
    user_uic = (user.get("unit_uic") or user.get("unit") or "").strip()
    if not user_uic:
        return False
    tree = load_tree()
    if not tree.is_descendant(resource_unit_uic, user_uic):
        return False
    role = user.get("role", "")
    return role in _write_roles()


def _write_roles() -> FrozenSet[str]:
    raw = os.environ.get(
        "SPIRE_OU_WRITE_ROLES",
        "data_custodian,security_manager,maintenance_chief,g4_operations",
    )
    return frozenset(r.strip() for r in raw.split(",") if r.strip())


def filter_by_visibility(
    records: list,
    user: Dict[str, Any],
    *,
    uic_field: str = "unit_uic",
) -> list:
    """Filter a list of dict-or-attr records down to ones whose
    ``uic_field`` is visible to the user. Cheap helper for
    routes that want to apply scoping in one line."""
    visible = units_visible_to(user)
    if not visible:
        return []
    out = []
    for r in records:
        if isinstance(r, dict):
            uic = r.get(uic_field, "") or ""
        else:
            uic = getattr(r, uic_field, "") or ""
        if uic in visible:
            out.append(r)
    return out
