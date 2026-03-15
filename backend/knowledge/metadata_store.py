import hashlib
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class FileRecord:
    file_path: str
    file_name: str
    extension: str
    size: int
    created_at: float
    modified_at: float
    directory: str
    content_hash: Optional[str] = None
    indexed_at: Optional[float] = None


class MetadataStore:
    """SQLite-backed metadata index for filesystem files."""

    def __init__(self, db_path: str | Path):
        self._db_path = str(db_path)
        self._local = threading.local()
        self._init_schema()

    @property
    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS files (
                file_path   TEXT PRIMARY KEY,
                file_name   TEXT NOT NULL,
                extension   TEXT NOT NULL DEFAULT '',
                size        INTEGER NOT NULL DEFAULT 0,
                created_at  REAL NOT NULL DEFAULT 0,
                modified_at REAL NOT NULL DEFAULT 0,
                directory   TEXT NOT NULL DEFAULT '',
                content_hash TEXT,
                indexed_at  REAL
            );
            CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension);
            CREATE INDEX IF NOT EXISTS idx_files_dir ON files(directory);
            CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at);
            CREATE INDEX IF NOT EXISTS idx_files_name ON files(file_name);
        """)

    def upsert(self, record: FileRecord) -> None:
        self._conn.execute(
            """INSERT INTO files (file_path, file_name, extension, size, created_at,
                                  modified_at, directory, content_hash, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(file_path) DO UPDATE SET
                   file_name=excluded.file_name, extension=excluded.extension,
                   size=excluded.size, created_at=excluded.created_at,
                   modified_at=excluded.modified_at, directory=excluded.directory,
                   content_hash=excluded.content_hash, indexed_at=excluded.indexed_at""",
            (record.file_path, record.file_name, record.extension, record.size,
             record.created_at, record.modified_at, record.directory,
             record.content_hash, record.indexed_at),
        )
        self._conn.commit()

    def upsert_batch(self, records: list[FileRecord]) -> None:
        self._conn.executemany(
            """INSERT INTO files (file_path, file_name, extension, size, created_at,
                                  modified_at, directory, content_hash, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(file_path) DO UPDATE SET
                   file_name=excluded.file_name, extension=excluded.extension,
                   size=excluded.size, created_at=excluded.created_at,
                   modified_at=excluded.modified_at, directory=excluded.directory,
                   content_hash=excluded.content_hash, indexed_at=excluded.indexed_at""",
            [(r.file_path, r.file_name, r.extension, r.size, r.created_at,
              r.modified_at, r.directory, r.content_hash, r.indexed_at) for r in records],
        )
        self._conn.commit()

    def get(self, file_path: str) -> Optional[FileRecord]:
        row = self._conn.execute(
            "SELECT * FROM files WHERE file_path = ?", (file_path,)
        ).fetchone()
        if row is None:
            return None
        return self._row_to_record(row)

    def delete(self, file_path: str) -> None:
        self._conn.execute("DELETE FROM files WHERE file_path = ?", (file_path,))
        self._conn.commit()

    def search(
        self,
        *,
        name_pattern: Optional[str] = None,
        extension: Optional[str] = None,
        directory: Optional[str] = None,
        min_modified: Optional[float] = None,
        max_size: Optional[int] = None,
        limit: int = 50,
    ) -> list[FileRecord]:
        clauses: list[str] = []
        params: list = []

        if name_pattern:
            clauses.append("file_name LIKE ?")
            params.append(f"%{name_pattern}%")
        if extension:
            ext = extension if extension.startswith(".") else f".{extension}"
            clauses.append("extension = ?")
            params.append(ext)
        if directory:
            clauses.append("directory LIKE ?")
            params.append(f"{directory}%")
        if min_modified is not None:
            clauses.append("modified_at >= ?")
            params.append(min_modified)
        if max_size is not None:
            clauses.append("size <= ?")
            params.append(max_size)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"SELECT * FROM files {where} ORDER BY modified_at DESC LIMIT ?",
            params + [limit],
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def all_paths(self) -> set[str]:
        rows = self._conn.execute("SELECT file_path FROM files").fetchall()
        return {r["file_path"] for r in rows}

    def all_paths_under(self, directory: str) -> set[str]:
        rows = self._conn.execute(
            "SELECT file_path FROM files WHERE file_path LIKE ?",
            (f"{directory}%",),
        ).fetchall()
        return {r["file_path"] for r in rows}

    def all_records_under(self, directory: str) -> list[FileRecord]:
        rows = self._conn.execute(
            "SELECT * FROM files WHERE file_path LIKE ?",
            (f"{directory}%",),
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]

    def checkpoint(self) -> None:
        try:
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass

    @staticmethod
    def compute_content_hash(file_path: str | Path, chunk_size: int = 8192) -> Optional[str]:
        try:
            h = hashlib.sha256()
            with open(file_path, "rb") as f:
                while True:
                    data = f.read(chunk_size)
                    if not data:
                        break
                    h.update(data)
            return h.hexdigest()
        except OSError:
            return None

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> FileRecord:
        return FileRecord(
            file_path=row["file_path"],
            file_name=row["file_name"],
            extension=row["extension"],
            size=row["size"],
            created_at=row["created_at"],
            modified_at=row["modified_at"],
            directory=row["directory"],
            content_hash=row["content_hash"],
            indexed_at=row["indexed_at"],
        )
