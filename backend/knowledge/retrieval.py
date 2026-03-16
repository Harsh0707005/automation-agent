import logging
import time
from dataclasses import dataclass
from typing import Optional

from backend.knowledge.embedding_indexer import EmbeddingIndexer
from backend.knowledge.metadata_store import MetadataStore

logger = logging.getLogger(__name__)


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

    @property
    def normalized_score(self) -> float:
        """Map raw score to a 0-1 display range.

        - Semantic (inner-product on normalized vecs): [-1, 1] → [0, 1]
        - Cross-encoder / hybrid scores can exceed 1, so we clamp.
        - Metadata results always return 1.0.
        """
        if self.source == "metadata":
            return 1.0
        mapped = (self.score + 1.0) / 2.0
        return max(0.0, min(1.0, mapped))


class QueryRewriter:
    """Rewrites natural language queries into keyword-focused variants using an
    LLM, so that vague descriptions like 'girl who worked at microsoft' produce
    search variants that actually match document text."""

    REWRITE_PROMPT = (
        "Convert this search query into 2-3 short keyword-focused variants "
        "that would match a resume, document, or filename. "
        'Query: "{query}"\n'
        "Return only the variants, one per line, no numbering or explanation."
    )

    def __init__(self, llm_engine=None, provider: str = "openai", model: str | None = None):
        self._llm = llm_engine
        self._provider = provider
        self._model = model

    def rewrite(self, query: str) -> list[str]:
        """Return the original query plus LLM-generated variants."""
        if self._llm is None:
            return [query]
        try:
            prompt = self.REWRITE_PROMPT.format(query=query)
            result = self._llm.complete(prompt, provider=self._provider, model=self._model)
            variants = [
                line.strip()
                for line in result.content.strip().splitlines()
                if line.strip()
            ]
            # Always include the original query first
            return [query] + variants[:3]
        except Exception as e:
            logger.warning("Query rewrite failed, using original query: %s", e)
            return [query]


class Reranker:
    """Cross-encoder reranker for two-stage retrieval.

    Stage 1 (FAISS) gives fast but coarse candidates.  Stage 2 (cross-encoder)
    reads query + document together for much more accurate relevance scoring.
    """

    def __init__(self):
        self._model = None

    def _get_model(self):
        if self._model is None:
            import os, sys, warnings
            os.environ["TRANSFORMERS_NO_TQDM"] = "1"
            _stderr = sys.stderr
            sys.stderr = open(os.devnull, "w")
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    from sentence_transformers import CrossEncoder
                    self._model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
            finally:
                sys.stderr.close()
                sys.stderr = _stderr
        return self._model

    def rerank(
        self, query: str, results: list["SearchResult"], top_k: int
    ) -> list["SearchResult"]:
        if not results:
            return results
        try:
            model = self._get_model()
            pairs = [(query, r.excerpt) for r in results]
            scores = model.predict(pairs)
            scored = sorted(zip(scores, results), key=lambda x: x[0], reverse=True)
            for score, result in scored:
                result.score = float(score)
            return [r for _, r in scored[:top_k]]
        except Exception as e:
            logger.warning("Reranker failed, falling back to original ranking: %s", e)
            return results[:top_k]


class RetrievalEngine:
    """Hybrid search combining metadata filtering and semantic vector search."""

    def __init__(
        self,
        metadata_store: MetadataStore,
        embedding_indexer: EmbeddingIndexer,
        llm_engine=None,
        rewrite_provider: str = "openai",
        rewrite_model: str | None = None,
    ):
        self._meta = metadata_store
        self._embedder = embedding_indexer
        self._reranker = Reranker()
        self._rewriter = QueryRewriter(llm_engine, rewrite_provider, rewrite_model)

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

    def _faiss_hits_to_results(self, hits: list[dict]) -> list[SearchResult]:
        """Convert raw FAISS hits to SearchResult objects."""
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

    def search_semantic(
        self, query: str, top_k: int = 10, *, rerank: bool = True
    ) -> list[SearchResult]:
        coarse_k = top_k * 3 if rerank else top_k

        # Multi-query: rewrite and merge results from all query variants
        variants = self._rewriter.rewrite(query)
        seen_keys: set[tuple[str, int]] = set()
        all_hits: list[dict] = []
        for variant in variants:
            hits = self._embedder.search(variant, top_k=coarse_k)
            for h in hits:
                key = (h["file_path"], h["chunk_index"])
                if key not in seen_keys:
                    seen_keys.add(key)
                    all_hits.append(h)

        # Sort merged hits by score descending
        all_hits.sort(key=lambda h: h["score"], reverse=True)
        results = self._faiss_hits_to_results(all_hits)

        # Stage 2: cross-encoder reranking for accurate relevance
        if rerank and len(results) > 1:
            results = self._reranker.rerank(query, results, top_k)
        else:
            results = results[:top_k]
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
        # Get reranked semantic results with an expanded candidate pool
        semantic_hits = self.search_semantic(query, top_k=top_k * 2, rerank=True)

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
