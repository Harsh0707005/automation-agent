import logging
import time
from pathlib import Path
from typing import Callable

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from backend.knowledge.scanner import DEFAULT_SKIP_DIRS, DEFAULT_SKIP_EXTENSIONS

logger = logging.getLogger(__name__)


class _IndexEventHandler(FileSystemEventHandler):
    """Handles filesystem events and dispatches to callback functions."""

    def __init__(
        self,
        on_created: Callable[[str], None],
        on_modified: Callable[[str], None],
        on_deleted: Callable[[str], None],
        skip_dirs: set[str],
        skip_extensions: set[str],
        debounce_seconds: float = 1.0,
    ):
        super().__init__()
        self._on_created = on_created
        self._on_modified = on_modified
        self._on_deleted = on_deleted
        self._skip_dirs = skip_dirs
        self._skip_extensions = skip_extensions
        self._debounce = debounce_seconds
        self._last_event: dict[str, float] = {}

    def _should_skip(self, path: str) -> bool:
        p = Path(path)
        if p.suffix.lower() in self._skip_extensions:
            return True
        for part in p.parts:
            if part in self._skip_dirs:
                return True
        return False

    def _is_debounced(self, path: str) -> bool:
        now = time.time()
        last = self._last_event.get(path, 0)
        if now - last < self._debounce:
            return True
        self._last_event[path] = now
        return False

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory or self._should_skip(event.src_path):
            return
        if self._is_debounced(event.src_path):
            return
        logger.debug("File created: %s", event.src_path)
        self._on_created(event.src_path)

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory or self._should_skip(event.src_path):
            return
        if self._is_debounced(event.src_path):
            return
        logger.debug("File modified: %s", event.src_path)
        self._on_modified(event.src_path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        if event.is_directory or self._should_skip(event.src_path):
            return
        logger.debug("File deleted: %s", event.src_path)
        self._on_deleted(event.src_path)


class FilesystemWatcher:
    """Monitors directories for changes and triggers index updates."""

    def __init__(
        self,
        on_created: Callable[[str], None],
        on_modified: Callable[[str], None],
        on_deleted: Callable[[str], None],
        skip_dirs: set[str] | None = None,
        skip_extensions: set[str] | None = None,
    ):
        self._handler = _IndexEventHandler(
            on_created=on_created,
            on_modified=on_modified,
            on_deleted=on_deleted,
            skip_dirs=skip_dirs or DEFAULT_SKIP_DIRS,
            skip_extensions=skip_extensions or DEFAULT_SKIP_EXTENSIONS,
        )
        self._observer = Observer()
        self._watching: set[str] = set()

    def watch(self, directory: str | Path) -> None:
        d = str(Path(directory).resolve())
        if d in self._watching:
            return
        self._observer.schedule(self._handler, d, recursive=True)
        self._watching.add(d)
        logger.info("Watching directory: %s", d)

    def start(self) -> None:
        if not self._observer.is_alive():
            self._observer.start()
            logger.info("Filesystem watcher started")

    def stop(self) -> None:
        if self._observer.is_alive():
            self._observer.stop()
            self._observer.join(timeout=5)
            logger.info("Filesystem watcher stopped")

    @property
    def is_running(self) -> bool:
        return self._observer.is_alive()
