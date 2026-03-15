import logging
import time
from pathlib import Path
from typing import Callable, Optional

YIELD_EVERY = 500
YIELD_SECS = 0.01

from backend.knowledge.metadata_store import FileRecord, MetadataStore

logger = logging.getLogger(__name__)

DEFAULT_SKIP_DIRS = {
    ".git", ".svn", ".hg", "__pycache__", "node_modules", ".venv", "venv",
    ".idea", ".vscode", ".DS_Store", "dist", "build", ".tox", ".mypy_cache",
    ".pytest_cache", "egg-info", ".Trash", ".cache", "Library", ".npm",
    ".cargo", ".rustup", ".local", ".gradle",
}

DEFAULT_SKIP_EXTENSIONS = {
    ".pyc", ".pyo", ".o", ".so", ".dylib", ".dll", ".exe", ".bin",
    ".iso", ".dmg", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
    ".jar", ".war", ".class", ".whl", ".egg",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flac", ".wav",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".ico", ".svg", ".webp",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".db", ".sqlite", ".sqlite3",
}


class ScanProgress:
    def __init__(self):
        self.total_discovered: int = 0
        self.total_processed: int = 0
        self.total_skipped: int = 0
        self.total_new: int = 0
        self.total_updated: int = 0
        self.scanning: bool = False
        self.current_directory: str = ""

    def to_dict(self) -> dict:
        return {
            "total_discovered": self.total_discovered,
            "total_processed": self.total_processed,
            "total_skipped": self.total_skipped,
            "total_new": self.total_new,
            "total_updated": self.total_updated,
            "scanning": self.scanning,
            "current_directory": self.current_directory,
        }


class FilesystemScanner:
    """Walks directories and populates the metadata store with incremental support."""

    def __init__(
        self,
        store: MetadataStore,
        skip_dirs: set[str] | None = None,
        skip_extensions: set[str] | None = None,
    ):
        self.store = store
        self.skip_dirs = skip_dirs if skip_dirs is not None else DEFAULT_SKIP_DIRS
        self.skip_extensions = skip_extensions if skip_extensions is not None else DEFAULT_SKIP_EXTENSIONS
        self.progress = ScanProgress()
        self._on_progress: Optional[Callable[[ScanProgress], None]] = None
        self._cancelled = False

    def set_progress_callback(self, callback: Callable[[ScanProgress], None]) -> None:
        self._on_progress = callback

    def cancel(self) -> None:
        self._cancelled = True

    def scan(self, root: str | Path, batch_size: int = 200) -> int:
        root = Path(root).resolve()
        if not root.is_dir():
            logger.warning("Scan target is not a directory: %s", root)
            return 0

        self._cancelled = False
        self.progress = ScanProgress()
        self.progress.scanning = True
        self.progress.current_directory = str(root)
        self._emit_progress()

        existing_records = self.store.all_records_under(str(root))
        existing_map: dict[str, float] = {
            r.file_path: r.modified_at for r in existing_records
        }

        indexed_paths: set[str] = set()
        batch: list[FileRecord] = []
        total = 0
        changed_paths: list[str] = []

        for entry in self._walk(root):
            if self._cancelled:
                logger.info("Scan cancelled at %d files", total)
                break

            self.progress.total_discovered += 1

            # Yield CPU periodically so the desktop app stays responsive
            if self.progress.total_discovered % YIELD_EVERY == 0:
                time.sleep(YIELD_SECS)

            record = self._build_record(entry)
            if record is None:
                continue

            indexed_paths.add(record.file_path)
            prev_mtime = existing_map.get(record.file_path)

            if prev_mtime is not None and abs(record.modified_at - prev_mtime) < 1.0:
                self.progress.total_skipped += 1
                continue

            if prev_mtime is None:
                self.progress.total_new += 1
            else:
                self.progress.total_updated += 1

            batch.append(record)
            changed_paths.append(record.file_path)

            if len(batch) >= batch_size:
                self.store.upsert_batch(batch)
                total += len(batch)
                self.progress.total_processed = total
                self._emit_progress()
                batch.clear()

        if batch:
            self.store.upsert_batch(batch)
            total += len(batch)

        if not self._cancelled:
            self._prune_deleted(root, indexed_paths | set(existing_map.keys()) - indexed_paths.symmetric_difference(set(existing_map.keys())))

        self.progress.total_processed = total
        self.progress.scanning = False
        self._emit_progress()
        logger.info(
            "Scan complete: %d new/updated, %d skipped (unchanged) under %s",
            total, self.progress.total_skipped, root,
        )
        return total

    def get_changed_paths(self, root: str | Path) -> list[str]:
        """Return file paths that were new or updated in the last scan."""
        root = Path(root).resolve()
        if not root.is_dir():
            return []

        existing_map: dict[str, float] = {
            r.file_path: r.modified_at
            for r in self.store.all_records_under(str(root))
        }

        changed: list[str] = []
        for entry in self._walk(root):
            try:
                stat = entry.stat()
            except OSError:
                continue
            fp = str(entry)
            prev_mtime = existing_map.get(fp)
            if prev_mtime is None or abs(stat.st_mtime - prev_mtime) >= 1.0:
                changed.append(fp)
        return changed

    def _walk(self, root: Path):
        try:
            for entry in sorted(root.iterdir()):
                if self._cancelled:
                    return
                if entry.is_dir():
                    if entry.name in self.skip_dirs or entry.name.startswith("."):
                        continue
                    yield from self._walk(entry)
                elif entry.is_file():
                    if entry.suffix.lower() in self.skip_extensions:
                        continue
                    yield entry
        except PermissionError:
            logger.debug("Permission denied: %s", root)
        except OSError:
            logger.debug("OS error scanning: %s", root)

    def _build_record(self, path: Path) -> FileRecord | None:
        try:
            stat = path.stat()
        except OSError:
            return None
        return FileRecord(
            file_path=str(path),
            file_name=path.name,
            extension=path.suffix.lower(),
            size=stat.st_size,
            created_at=stat.st_birthtime if hasattr(stat, "st_birthtime") else stat.st_ctime,
            modified_at=stat.st_mtime,
            directory=str(path.parent),
            content_hash=None,
            indexed_at=time.time(),
        )

    def _prune_deleted(self, root: Path, current_paths: set[str]) -> None:
        existing = self.store.all_paths_under(str(root))
        for path in existing:
            if path not in current_paths:
                self.store.delete(path)
                logger.debug("Pruned deleted file: %s", path)

    def _emit_progress(self) -> None:
        if self._on_progress:
            try:
                self._on_progress(self.progress)
            except Exception:
                pass
