"""Search scope management.

Dynamically discovers user directories rather than relying on hardcoded paths.
Enforces scope restrictions and prevents scanning from the filesystem root.
"""

from pathlib import Path

from backend.knowledge.scanner import DEFAULT_SKIP_DIRS

HOME = Path.home()

# Directories that are never useful for user file search — system/app internals
_SKIP_TOP_LEVEL = DEFAULT_SKIP_DIRS | {
    "Library", "Applications", "System", "Volumes", "private",
    "opt", "usr", "bin", "sbin", "etc", "var", "tmp", "dev", "cores",
    "AppData", "ProgramData", "Program Files", "Program Files (x86)",
    "Windows", "Recovery", "$Recycle.Bin",
    "snap", "proc", "sys", "run", "boot", "lost+found",
}


def discover_home_dirs() -> list[str]:
    """Scan ~/  for real user directories (non-hidden, non-system).

    This is the ground truth — no hardcoded list of "Documents, Desktop, ..."
    because different machines have different layouts.  We return every
    top-level directory under $HOME that isn't a system/dot directory,
    letting the LLM planner pick the relevant ones per query.
    """
    dirs: list[str] = []
    try:
        for entry in sorted(HOME.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name.startswith("."):
                continue
            if entry.name in _SKIP_TOP_LEVEL:
                continue
            dirs.append(str(entry))
    except OSError:
        pass
    return dirs


def get_default_search_dirs() -> list[str]:
    """Return all discoverable user directories on this machine."""
    return discover_home_dirs()


def validate_search_dirs(directories: list[str]) -> list[str]:
    """Reject root-level paths and non-existent directories."""
    valid = []
    for d in directories:
        p = Path(d).resolve()
        if str(p) == p.root:
            continue
        if p.is_dir():
            valid.append(str(p))
    return valid
