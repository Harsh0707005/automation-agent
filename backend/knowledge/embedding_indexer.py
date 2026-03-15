import logging
import os
import sqlite3
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class ChunkRecord:
    file_path: str
    chunk_index: int
    text: str
    embedding: np.ndarray


class EmbeddingIndexer:
    """Generates embeddings and stores them in a FAISS vector index with an SQLite sidecar
    that maps vector IDs back to file paths and chunk indices."""

    def __init__(self, index_dir: str | Path, dimension: int = 384):
        import faiss

        self._index_dir = Path(index_dir)
        self._index_dir.mkdir(parents=True, exist_ok=True)
        self._dimension = dimension
        self._faiss_path = self._index_dir / "vectors.faiss"
        self._db_path = self._index_dir / "chunks.db"
        self._lock = threading.Lock()

        if self._faiss_path.exists():
            self._index = faiss.read_index(str(self._faiss_path))
        else:
            self._index = faiss.IndexFlatIP(dimension)

        # Single shared connection with WAL mode — all access goes through self._lock
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._init_db()
        self._model = None
        self._processing_files: set[str] = set()

    def _init_db(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS chunks (
                vector_id   INTEGER PRIMARY KEY,
                file_path   TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                text        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
        """)

    def _get_model(self):
        if self._model is None:
            import warnings
            os.environ["TRANSFORMERS_NO_TQDM"] = "1"
            _stderr = sys.stderr
            sys.stderr = open(os.devnull, "w")
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    from sentence_transformers import SentenceTransformer
                    self._model = SentenceTransformer("all-MiniLM-L6-v2")
            finally:
                sys.stderr.close()
                sys.stderr = _stderr
        return self._model

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        model = self._get_model()
        embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        return np.array(embeddings, dtype=np.float32)

    def add_chunks(self, file_path: str, chunks: list[tuple[int, str]]) -> None:
        if not chunks:
            return

        # Skip if this file is already being processed by another thread
        with self._lock:
            if file_path in self._processing_files:
                return
            self._processing_files.add(file_path)

        try:
            texts = [text for _, text in chunks]
            embeddings = self.embed_texts(texts)

            with self._lock:
                # Remove old chunks for this file, then add new ones — all inside the lock
                self._conn.execute("DELETE FROM chunks WHERE file_path = ?", (file_path,))
                start_id = self._index.ntotal
                self._index.add(embeddings)
                rows = [
                    (start_id + i, file_path, chunk_idx, text)
                    for i, (chunk_idx, text) in enumerate(chunks)
                ]
                self._conn.executemany(
                    "INSERT OR REPLACE INTO chunks (vector_id, file_path, chunk_index, text) VALUES (?, ?, ?, ?)",
                    rows,
                )
                self._conn.commit()
        finally:
            with self._lock:
                self._processing_files.discard(file_path)

    def remove_file(self, file_path: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM chunks WHERE file_path = ?", (file_path,))
            self._conn.commit()

    def search(self, query: str, top_k: int = 10) -> list[dict]:
        with self._lock:
            ntotal = self._index.ntotal
        if ntotal == 0:
            return []

        query_vec = self.embed_texts([query])
        with self._lock:
            k = min(top_k, self._index.ntotal)
            scores, ids = self._index.search(query_vec, k)

        results = []
        with self._lock:
            for score, vid in zip(scores[0], ids[0]):
                if vid < 0:
                    continue
                row = self._conn.execute(
                    "SELECT file_path, chunk_index, text FROM chunks WHERE vector_id = ?",
                    (int(vid),),
                ).fetchone()
                if row:
                    results.append({
                        "file_path": row["file_path"],
                        "chunk_index": row["chunk_index"],
                        "text": row["text"],
                        "score": float(score),
                    })
        return results

    def file_is_indexed(self, file_path: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM chunks WHERE file_path = ? LIMIT 1", (file_path,)
            ).fetchone()
        return row is not None

    def save(self) -> None:
        import faiss
        with self._lock:
            faiss.write_index(self._index, str(self._faiss_path))

    def rebuild_index(self, all_chunks: list[tuple[str, int, str]]) -> None:
        """Full rebuild: clears everything and re-indexes from scratch."""
        import faiss

        with self._lock:
            self._conn.execute("DELETE FROM chunks")
            self._conn.commit()
            self._index = faiss.IndexFlatIP(self._dimension)

        if not all_chunks:
            self.save()
            return

        texts = [text for _, _, text in all_chunks]
        embeddings = self.embed_texts(texts)

        with self._lock:
            self._index.add(embeddings)
            rows = [
                (i, fp, ci, text)
                for i, (fp, ci, text) in enumerate(all_chunks)
            ]
            self._conn.executemany(
                "INSERT OR REPLACE INTO chunks (vector_id, file_path, chunk_index, text) VALUES (?, ?, ?, ?)",
                rows,
            )
            self._conn.commit()
        self.save()
