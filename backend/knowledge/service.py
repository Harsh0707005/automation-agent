import logging
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from backend.knowledge.chunker import chunk_text
from backend.knowledge.content_extractor import can_extract, extract_text, is_too_large_for_embedding
from backend.knowledge.embedding_indexer import EmbeddingIndexer
from backend.knowledge.metadata_store import FileRecord, MetadataStore
from backend.knowledge.retrieval import RetrievalEngine, SearchResult
from backend.knowledge.scanner import FilesystemScanner, ScanProgress
from backend.knowledge.watcher import FilesystemWatcher

logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR = Path.home() / ".automation-agent" / "knowledge"

EMBED_BATCH_SIZE = 20
SAVE_EVERY_N_FILES = 50
PROGRESS_THROTTLE_SECS = 2.0
SCAN_YIELD_EVERY = 100
SCAN_YIELD_SECS = 0.05


class IndexingStatus:
    def __init__(self):
        self.phase: str = "idle"
        self.total_discovered: int = 0
        self.total_processed: int = 0
        self.total_skipped: int = 0
        self.files_embedded: int = 0
        self.files_to_embed: int = 0
        self.current_directory: str = ""
        self.active: bool = False

    def to_dict(self) -> dict:
        return {
            "phase": self.phase,
            "total_discovered": self.total_discovered,
            "total_processed": self.total_processed,
            "total_skipped": self.total_skipped,
            "files_embedded": self.files_embedded,
            "files_to_embed": self.files_to_embed,
            "current_directory": self.current_directory,
            "active": self.active,
        }


class KnowledgeIndexService:
    """Orchestrates scanning, indexing, watching, and retrieval."""

    def __init__(
        self,
        data_dir: str | Path | None = None,
        llm_engine=None,
        rewrite_provider: str = "openai",
        rewrite_model: str | None = None,
    ):
        self._data_dir = Path(data_dir or DEFAULT_DATA_DIR)
        self._data_dir.mkdir(parents=True, exist_ok=True)

        self._meta_store = MetadataStore(self._data_dir / "metadata.db")
        self._embedding_indexer = EmbeddingIndexer(
            self._data_dir / "embeddings", dimension=384
        )
        self._scanner = FilesystemScanner(self._meta_store)
        self._retrieval = RetrievalEngine(
            self._meta_store,
            self._embedding_indexer,
            llm_engine=llm_engine,
            rewrite_provider=rewrite_provider,
            rewrite_model=rewrite_model,
        )
        self._watcher: Optional[FilesystemWatcher] = None
        self._watched_dirs: list[str] = []
        self._scan_lock = threading.Lock()
        self._status = IndexingStatus()
        self._on_status: Optional[Callable[[dict], None]] = None
        self._last_progress_time: float = 0

    def set_status_callback(self, callback: Callable[[dict], None]) -> None:
        self._on_status = callback

    def scan_directory(self, directory: str | Path) -> int:
        directory = str(Path(directory).resolve())

        self._status.active = True
        self._status.phase = "scanning"
        self._status.current_directory = directory
        self._emit_status(force=True)

        def on_scan_progress(progress: ScanProgress):
            self._status.total_discovered = progress.total_discovered
            self._status.total_processed = progress.total_processed
            self._status.total_skipped = progress.total_skipped
            self._emit_status()

        self._scanner.set_progress_callback(on_scan_progress)

        with self._scan_lock:
            count = self._scanner.scan(directory)

        self._status.phase = "embedding"
        self._emit_status(force=True)
        self._index_embeddings_for_dir(directory)

        # Always save after a full scan completes — guarantees persistence
        self._embedding_indexer.save()
        self._meta_store.checkpoint()

        self._status.phase = "idle"
        self._status.active = False
        self._emit_status(force=True)
        return count

    def scan_directory_async(self, directory: str | Path) -> None:
        t = threading.Thread(target=self.scan_directory, args=(directory,), daemon=True)
        t.start()

    def start_watching(self, directories: list[str | Path]) -> None:
        if self._watcher and self._watcher.is_running:
            self._watcher.stop()

        self._watcher = FilesystemWatcher(
            on_created=self._handle_file_created,
            on_modified=self._handle_file_modified,
            on_deleted=self._handle_file_deleted,
        )
        self._watched_dirs.clear()
        for d in directories:
            resolved = str(Path(d).resolve())
            self._watcher.watch(resolved)
            self._watched_dirs.append(resolved)
        self._watcher.start()

        self._status.phase = "watching"
        self._emit_status(force=True)

    def stop_watching(self) -> None:
        if self._watcher:
            self._watcher.stop()
            self._watcher = None
            self._watched_dirs.clear()

    def search(
        self,
        query: str,
        *,
        mode: str = "hybrid",
        extension: Optional[str] = None,
        directory: Optional[str] = None,
        top_k: int = 10,
    ) -> list[SearchResult]:
        if mode == "metadata":
            return self._retrieval.search_metadata(
                name_pattern=query, extension=extension, directory=directory, limit=top_k
            )
        elif mode == "semantic":
            return self._retrieval.search_semantic(query, top_k=top_k)
        else:
            return self._retrieval.search_hybrid(
                query, extension=extension, directory=directory, top_k=top_k
            )

    def get_status(self) -> dict:
        return self._status.to_dict()

    def get_stats(self) -> dict:
        return {
            "indexed_files": self._meta_store.count(),
            "watched_dirs": list(self._watched_dirs),
            "watcher_active": self._watcher.is_running if self._watcher else False,
            "data_dir": str(self._data_dir),
            "indexing_status": self._status.to_dict(),
        }

    def save(self) -> None:
        self._embedding_indexer.save()
        self._meta_store.checkpoint()

    # -- Private helpers --

    def _emit_status(self, force: bool = False) -> None:
        if not self._on_status:
            return
        now = time.time()
        if not force and (now - self._last_progress_time) < PROGRESS_THROTTLE_SECS:
            return
        self._last_progress_time = now
        try:
            self._on_status(self._status.to_dict())
        except Exception:
            pass

    def _index_embeddings_for_dir(self, directory: str) -> None:
        records = self._meta_store.search(directory=directory, limit=100_000)
        embeddable = [
            r for r in records
            if can_extract(r.file_path) and not is_too_large_for_embedding(r.file_path)
        ]
        self._status.files_to_embed = len(embeddable)
        self._status.files_embedded = 0
        self._emit_status(force=True)

        indexed = 0
        batch: list[tuple[str, list[tuple[int, str]]]] = []
        batch_texts_count = 0

        for rec in embeddable:
            # Content-hash skip: avoid re-embedding if the file content is identical
            if self._embedding_indexer.file_is_indexed(rec.file_path):
                current_hash = MetadataStore.compute_content_hash(rec.file_path)
                if current_hash and rec.content_hash == current_hash:
                    self._status.files_embedded += 1
                    self._emit_status()
                    continue
                # Hash changed — update it in metadata before re-embedding
                if current_hash:
                    rec.content_hash = current_hash
                    self._meta_store.upsert(rec)

            file_chunks = self._extract_chunks(rec.file_path)
            if file_chunks:
                batch.append((rec.file_path, file_chunks))
                batch_texts_count += len(file_chunks)

            if batch_texts_count >= EMBED_BATCH_SIZE:
                indexed += self._flush_embed_batch(batch)
                batch.clear()
                batch_texts_count = 0

            self._status.files_embedded += 1
            self._emit_status()

            # Yield CPU periodically so the desktop stays responsive
            if self._status.files_embedded % SCAN_YIELD_EVERY == 0:
                time.sleep(SCAN_YIELD_SECS)

            # Periodic save so progress isn't lost on crash
            if indexed > 0 and indexed % SAVE_EVERY_N_FILES == 0:
                self._embedding_indexer.save()

        if batch:
            indexed += self._flush_embed_batch(batch)

        if indexed:
            self._embedding_indexer.save()
            logger.info("Embedded %d files in %s", indexed, directory)

    def _flush_embed_batch(self, batch: list[tuple[str, list[tuple[int, str]]]]) -> int:
        count = 0
        now = time.time()
        for file_path, chunks in batch:
            self._embedding_indexer.add_chunks(file_path, chunks)
            # Stamp content hash and indexed_at so future runs can skip unchanged files
            rec = self._meta_store.get(file_path)
            if rec:
                rec.content_hash = MetadataStore.compute_content_hash(file_path)
                rec.indexed_at = now
                self._meta_store.upsert(rec)
            count += 1
        return count

    @staticmethod
    def _build_chunk_header(file_path: str) -> str:
        """Build a metadata header to prepend to each chunk so filenames and
        file types are visible in the embedding space."""
        p = Path(file_path)
        stem = p.stem.replace("_", " ").replace("-", " ")
        ext = p.suffix.lstrip(".")
        return f"File: {stem}\nType: {ext}\n\n"

    def _extract_chunks(self, file_path: str) -> list[tuple[int, str]] | None:
        if is_too_large_for_embedding(file_path):
            return None
        if not can_extract(file_path):
            return None
        text = extract_text(file_path)
        if not text or not text.strip():
            return None
        chunks = chunk_text(text)
        if not chunks:
            return None
        header = self._build_chunk_header(file_path)
        return [(c.chunk_index, header + c.text) for c in chunks]

    def _handle_file_created(self, file_path: str) -> None:
        p = Path(file_path)
        if not p.is_file():
            return
        try:
            stat = p.stat()
            record = FileRecord(
                file_path=str(p),
                file_name=p.name,
                extension=p.suffix.lower(),
                size=stat.st_size,
                created_at=stat.st_birthtime if hasattr(stat, "st_birthtime") else stat.st_ctime,
                modified_at=stat.st_mtime,
                directory=str(p.parent),
                indexed_at=time.time(),
            )
            self._meta_store.upsert(record)
            chunks = self._extract_chunks(file_path)
            if chunks:
                self._embedding_indexer.add_chunks(file_path, chunks)
                self._embedding_indexer.save()
        except Exception as e:
            logger.warning("Error indexing created file %s: %s", file_path, e)

    def _handle_file_modified(self, file_path: str) -> None:
        self._handle_file_created(file_path)

    def _handle_file_deleted(self, file_path: str) -> None:
        self._meta_store.delete(file_path)
        self._embedding_indexer.remove_file(file_path)
        self._embedding_indexer.save()
