import time
from dataclasses import dataclass
from typing import Optional

from backend.knowledge.embedding_indexer import EmbeddingIndexer
from backend.knowledge.metadata_store import MetadataStore


@dataclass
class SearchResult:
    file_path: str
    file_name: str
    extension: str
    size: int
    modified_at: float
    directory: str
    excerpt: str
    score: float
    source: str  # "metadata", "semantic", or "hybrid"


class RetrievalEngine:
    """Hybrid search combining metadata filtering and semantic vector search."""

    def __init__(self, metadata_store: MetadataStore, embedding_indexer: EmbeddingIndexer):
        self._meta = metadata_store
        self._embedder = embedding_indexer

    def search_metadata(
        self,
        *,
        name_pattern: Optional[str] = None,
        extension: Optional[str] = None,
        directory: Optional[str] = None,
        min_modified: Optional[float] = None,
        max_size: Optional[int] = None,
        limit: int = 20,
    ) -> list[SearchResult]:
        records = self._meta.search(
            name_pattern=name_pattern,
            extension=extension,
            directory=directory,
            min_modified=min_modified,
            max_size=max_size,
            limit=limit,
        )
        return [
            SearchResult(
                file_path=r.file_path,
                file_name=r.file_name,
                extension=r.extension,
                size=r.size,
                modified_at=r.modified_at,
                directory=r.directory,
                excerpt="",
                score=1.0,
                source="metadata",
            )
            for r in records
        ]

    def search_semantic(self, query: str, top_k: int = 10) -> list[SearchResult]:
        hits = self._embedder.search(query, top_k=top_k)
        results = []
        for hit in hits:
            rec = self._meta.get(hit["file_path"])
            results.append(SearchResult(
                file_path=hit["file_path"],
                file_name=rec.file_name if rec else hit["file_path"].rsplit("/", 1)[-1],
                extension=rec.extension if rec else "",
                size=rec.size if rec else 0,
                modified_at=rec.modified_at if rec else 0,
                directory=rec.directory if rec else "",
                excerpt=hit["text"][:500],
                score=hit["score"],
                source="semantic",
            ))
        return results

    def search_hybrid(
        self,
        query: str,
        *,
        extension: Optional[str] = None,
        directory: Optional[str] = None,
        top_k: int = 10,
        recency_weight: float = 0.1,
    ) -> list[SearchResult]:
        semantic_hits = self.search_semantic(query, top_k=top_k * 2)

        if extension or directory:
            meta_paths = {
                r.file_path
                for r in self._meta.search(
                    extension=extension, directory=directory, limit=1000
                )
            }
            semantic_hits = [h for h in semantic_hits if h.file_path in meta_paths]

        now = time.time()
        scored: list[tuple[float, SearchResult]] = []
        for hit in semantic_hits:
            age_days = max((now - hit.modified_at) / 86400, 0.01)
            recency_boost = recency_weight / age_days
            combined = hit.score + recency_boost
            scored.append((combined, hit))

        scored.sort(key=lambda x: x[0], reverse=True)

        results = []
        seen: set[str] = set()
        for combined_score, hit in scored[:top_k]:
            if hit.file_path in seen:
                continue
            seen.add(hit.file_path)
            hit.score = combined_score
            hit.source = "hybrid"
            results.append(hit)
        return results
