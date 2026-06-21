"""SPIRE DR / backup CLI (UIS-P6.6).

Usage::

    python -m scripts.spire_dr backup [--label LABEL] [--out PATH]
    python -m scripts.spire_dr verify  ARCHIVE
    python -m scripts.spire_dr restore ARCHIVE [--dry-run]
    python -m scripts.spire_dr list   [--dir DIR]

Designed to run without uvicorn — the DR module operates on the
SQLite file directly so an operator can take a backup from a
shell on the box (or a recovery host) without standing up the
full SPIRE stack. Same paths as the live process: the DR module
reads ``runtime/spire.db`` (or ``spire.db.enc``) by default, or
honors ``SPIRE_RUNTIME_DIR`` if set.

Exit codes:
    0  success
    1  validation failure (verify/restore reported issues)
    2  CLI / argument / IO error
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _ensure_repo_on_path() -> None:
    root = str(_repo_root())
    if root not in sys.path:
        sys.path.insert(0, root)


def cmd_backup(args: argparse.Namespace) -> int:
    _ensure_repo_on_path()
    from backend.uis.dr import create_backup

    out_path: Path
    if args.out:
        out_path = Path(args.out)
    else:
        backup_dir = _repo_root() / "runtime" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out_path = backup_dir / f"backup_{ts}.tar.gz"

    try:
        manifest = create_backup(out_path, label=args.label or "")
    except Exception as e:  # noqa: BLE001
        print(f"backup failed: {e}", file=sys.stderr)
        return 2

    summary = {
        "archive_path": str(out_path),
        "byte_count": out_path.stat().st_size,
        "manifest": manifest.to_dict(),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    _ensure_repo_on_path()
    from backend.uis.dr import verify_backup

    archive_path = Path(args.archive)
    if not archive_path.exists():
        print(f"archive not found: {archive_path}", file=sys.stderr)
        return 2

    result = verify_backup(archive_path)
    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    return 0 if result.ok else 1


def cmd_restore(args: argparse.Namespace) -> int:
    _ensure_repo_on_path()
    from backend.uis.dr import restore_backup

    archive_path = Path(args.archive)
    if not archive_path.exists():
        print(f"archive not found: {archive_path}", file=sys.stderr)
        return 2

    if not args.dry_run and not args.yes:
        # Two-step confirmation when running interactively. The
        # `--yes` switch lets non-interactive ops scripts skip
        # the prompt.
        print(
            f"About to restore {archive_path} into the live runtime.\n"
            "This OVERWRITES the live SQLite. A pre-restore snapshot "
            "is captured automatically.\nType RESTORE to continue: ",
            end="", flush=True,
        )
        try:
            answer = input().strip()
        except EOFError:
            answer = ""
        if answer != "RESTORE":
            print("aborted", file=sys.stderr)
            return 2

    result = restore_backup(archive_path, dry_run=args.dry_run)
    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    return 0 if result.ok else 1


def cmd_prune(args: argparse.Namespace) -> int:
    _ensure_repo_on_path()
    from backend.uis.dr import prune_backups

    if args.keep_count is None and args.keep_days is None:
        print("error: provide --keep-count and/or --keep-days", file=sys.stderr)
        return 2

    backup_dir = Path(args.dir) if args.dir else (_repo_root() / "runtime" / "backups")
    try:
        result = prune_backups(
            backup_dir,
            keep_count=args.keep_count,
            keep_days=args.keep_days,
            dry_run=args.dry_run,
        )
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    _ensure_repo_on_path()
    from backend.uis.dr import list_backups

    backup_dir = Path(args.dir) if args.dir else (_repo_root() / "runtime" / "backups")
    summaries = list_backups(backup_dir)
    payload = {
        "directory": str(backup_dir),
        "archives": [s.to_dict() for s in summaries],
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="spire-dr",
        description="SPIRE DR / backup CLI (UIS-P6.6)",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_backup = sub.add_parser("backup", help="Create a backup archive")
    p_backup.add_argument("--label", default="", help="Free-text annotation")
    p_backup.add_argument("--out", default="", help="Output archive path")
    p_backup.set_defaults(func=cmd_backup)

    p_verify = sub.add_parser("verify", help="Verify an archive without restoring")
    p_verify.add_argument("archive", help="Path to .tar.gz archive")
    p_verify.set_defaults(func=cmd_verify)

    p_restore = sub.add_parser("restore", help="Restore an archive into the live runtime")
    p_restore.add_argument("archive", help="Path to .tar.gz archive")
    p_restore.add_argument("--dry-run", action="store_true", help="Validate + extract, do not move into place")
    p_restore.add_argument("--yes", action="store_true", help="Skip the interactive RESTORE prompt")
    p_restore.set_defaults(func=cmd_restore)

    p_list = sub.add_parser("list", help="Inventory archives in a directory")
    p_list.add_argument("--dir", default="", help="Backup directory (defaults to runtime/backups)")
    p_list.set_defaults(func=cmd_list)

    p_prune = sub.add_parser("prune", help="Apply a retention policy to a backup directory")
    p_prune.add_argument("--dir", default="", help="Backup directory (defaults to runtime/backups)")
    p_prune.add_argument("--keep-count", type=int, default=None, help="Keep the N most recent archives")
    p_prune.add_argument("--keep-days", type=int, default=None, help="Keep archives within N days")
    p_prune.add_argument("--dry-run", action="store_true", help="Report what would be pruned, do not delete")
    p_prune.set_defaults(func=cmd_prune)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
