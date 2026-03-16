"""Layered retrieval strategy.

Applies search methods from cheapest/most-precise to most-expensive/approximate,
escalating only when the current layer produces no useful results.

Layer 1 — Fuzzy filename matching (index)
Layer 2 — File type + directory heuristics (index)
Layer 3 — Literal content grep (index)
Layer 4 — Query rewriting + vector search + cross-encoder reranking (index)
Layer 5 — Live filesystem walk + grep (no index needed, direct disk access)
"""

import logging
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from backend.knowledge.content_extractor import SUPPORTED_EXTENSIONS
from backend.knowledge.metadata_store import MetadataStore
from backend.knowledge.retrieval import RetrievalEngine, SearchResult
from backend.knowledge.scanner import DEFAULT_SKIP_DIRS, DEFAULT_SKIP_EXTENSIONS, MAX_RECURSION_DEPTH
from backend.knowledge.scope import get_default_search_dirs

logger = logging.getLogger(__name__)

MIN_FUZZY_SCORE = 0.4
MIN_RESULTS_TO_STOP = 3


# ---------------------------------------------------------------------------
#  Pre-search planner
# ---------------------------------------------------------------------------

class SearchPlanner:
    """Uses a lightweight LLM call to reason about where a file likely lives
    before any filesystem operation begins."""

    PLAN_PROMPT = (
        "You are a search planner for a desktop file search system.\n"
        "The user wants to find: \"{query}\"\n"
        "Available search directories: {dirs}\n\n"
        "Based on the query, respond with ONLY a JSON object (no markdown) with:\n"
        '  "directories": list of the most likely directories from the available list\n'
        '  "extensions": list of likely file extensions (e.g. [".pdf", ".docx"]) or []\n'
        '  "keywords": list of 2-4 literal keywords to grep for, or []\n'
        "Keep it short. No explanation."
    )

    def __init__(self, llm_engine=None, provider: str = "openai", model: str | None = None):
        self._llm = llm_engine
        self._provider = provider
        self._model = model

    def plan(self, query: str, available_dirs: list[str]) -> "SearchPlan":
        if self._llm is None or not available_dirs:
            return SearchPlan(directories=available_dirs, extensions=[], keywords=[])
        try:
            import json as _json
            prompt = self.PLAN_PROMPT.format(
                query=query, dirs=", ".join(available_dirs)
            )
            result = self._llm.complete(prompt, provider=self._provider, model=self._model)
            text = result.content.strip()
            # strip markdown fences if present
            if text.startswith("```"):
                text = re.sub(r"^```\w*\n?", "", text)
                text = re.sub(r"\n?```$", "", text)
            data = _json.loads(text)
            return SearchPlan(
                directories=data.get("directories", available_dirs),
                extensions=data.get("extensions", []),
                keywords=data.get("keywords", []),
            )
        except Exception as e:
            logger.warning("Search planning failed: %s", e)
            return SearchPlan(directories=available_dirs, extensions=[], keywords=[])


@dataclass
class SearchPlan:
    directories: list[str]
    extensions: list[str]
    keywords: list[str]


# ---------------------------------------------------------------------------
#  Layer 1 — Fuzzy filename matching
# ---------------------------------------------------------------------------

def _fuzzy_ratio(a: str, b: str) -> float:
    """Simple character-bigram similarity (Dice coefficient). No dependencies."""
    a, b = a.lower(), b.lower()
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    # Also check substring containment — very common search pattern
    if a in b or b in a:
        return 0.85

    a_bigrams = {a[i : i + 2] for i in range(len(a) - 1)}
    b_bigrams = {b[i : i + 2] for i in range(len(b) - 1)}
    if not a_bigrams or not b_bigrams:
        return 0.0
    overlap = len(a_bigrams & b_bigrams)
    return (2.0 * overlap) / (len(a_bigrams) + len(b_bigrams))


def search_fuzzy_filename(
    meta: MetadataStore,
    query: str,
    *,
    directories: list[str] | None = None,
    extensions: list[str] | None = None,
    limit: int = 20,
) -> list[SearchResult]:
    """Layer 1: match query against indexed filenames using fuzzy matching."""
    candidates = meta.search(limit=100_000)

    if directories:
        dir_set = set(directories)
        candidates = [
            r for r in candidates
            if any(r.file_path.startswith(d) for d in dir_set)
        ]
    if extensions:
        ext_set = {e if e.startswith(".") else f".{e}" for e in extensions}
        candidates = [r for r in candidates if r.extension in ext_set]

    query_clean = query.lower().replace("_", " ").replace("-", " ")
    scored: list[tuple[float, SearchResult]] = []
    for rec in candidates:
        stem = Path(rec.file_path).stem.replace("_", " ").replace("-", " ")
        score = _fuzzy_ratio(query_clean, stem.lower())
        # Also check against the full filename
        name_score = _fuzzy_ratio(query_clean, rec.file_name.lower())
        best = max(score, name_score)
        if best >= MIN_FUZZY_SCORE:
            scored.append((best, SearchResult(
                file_path=rec.file_path,
                file_name=rec.file_name,
                extension=rec.extension,
                size=rec.size,
                modified_at=rec.modified_at,
                directory=rec.directory,
                excerpt="",
                score=best,
                source="fuzzy_filename",
            )))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:limit]]


# ---------------------------------------------------------------------------
#  Layer 2 — Directory and file-type heuristics
# ---------------------------------------------------------------------------

# Common directory names that carry semantic meaning
_DIR_SIGNALS: dict[str, list[str]] = {
    "resume": ["resume", "resumes", "cv", "cvs", "career"],
    "project": ["project", "projects", "repos", "workspace", "src", "code"],
    "document": ["documents", "docs", "notes", "writing"],
    "download": ["downloads", "download"],
    "image": ["images", "photos", "pictures", "screenshots"],
    "finance": ["finance", "tax", "invoices", "receipts", "billing"],
}


def search_path_heuristics(
    meta: MetadataStore,
    query: str,
    *,
    directories: list[str] | None = None,
    extensions: list[str] | None = None,
    limit: int = 20,
) -> list[SearchResult]:
    """Layer 2: score files based on directory names, extensions, path context."""
    candidates = meta.search(limit=100_000)

    if directories:
        dir_set = set(directories)
        candidates = [
            r for r in candidates
            if any(r.file_path.startswith(d) for d in dir_set)
        ]
    if extensions:
        ext_set = {e if e.startswith(".") else f".{e}" for e in extensions}
        candidates = [r for r in candidates if r.extension in ext_set]

    query_lower = query.lower()
    query_tokens = set(re.findall(r"\w+", query_lower))

    scored: list[tuple[float, SearchResult]] = []
    for rec in candidates:
        score = 0.0
        path_lower = rec.file_path.lower()
        path_parts = set(re.findall(r"\w+", path_lower))

        # Direct token overlap between query and full path
        overlap = query_tokens & path_parts
        score += len(overlap) * 0.3

        # Directory semantic signals
        for _category, signals in _DIR_SIGNALS.items():
            if any(s in query_lower for s in signals):
                if any(s in path_lower for s in signals):
                    score += 0.4
                    break

        if score > 0.2:
            scored.append((score, SearchResult(
                file_path=rec.file_path,
                file_name=rec.file_name,
                extension=rec.extension,
                size=rec.size,
                modified_at=rec.modified_at,
                directory=rec.directory,
                excerpt="",
                score=score,
                source="path_heuristic",
            )))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:limit]]


# ---------------------------------------------------------------------------
#  Layer 3 — Literal content grep
# ---------------------------------------------------------------------------

def _extract_grep_terms(query: str) -> list[str]:
    """Pull out likely literal search terms: capitalized words, quoted phrases,
    and tokens longer than 3 chars that look like names or identifiers."""
    terms: list[str] = []

    # Quoted phrases
    for match in re.finditer(r'"([^"]+)"', query):
        terms.append(match.group(1))

    # Capitalized words (likely proper nouns / company names)
    for match in re.finditer(r"\b[A-Z][a-z]{2,}\b", query):
        terms.append(match.group())

    # Remaining long tokens
    if not terms:
        for tok in re.findall(r"\w+", query):
            if len(tok) >= 4:
                terms.append(tok)

    return list(dict.fromkeys(terms))[:5]  # dedupe, cap at 5


def search_content_grep(
    meta: MetadataStore,
    query: str,
    *,
    directories: list[str] | None = None,
    extensions: list[str] | None = None,
    limit: int = 20,
) -> list[SearchResult]:
    """Layer 3: fast literal grep across indexed files."""
    terms = _extract_grep_terms(query)
    if not terms:
        return []

    candidates = meta.search(limit=100_000)
    if directories:
        dir_set = set(directories)
        candidates = [
            r for r in candidates
            if any(r.file_path.startswith(d) for d in dir_set)
        ]
    if extensions:
        ext_set = {e if e.startswith(".") else f".{e}" for e in extensions}
        candidates = [r for r in candidates if r.extension in ext_set]

    # Only grep extractable files
    candidates = [
        r for r in candidates if r.extension in SUPPORTED_EXTENSIONS
    ]

    hits: dict[str, tuple[int, str]] = {}  # path → (match_count, first_excerpt)
    for rec in candidates:
        try:
            text = Path(rec.file_path).read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeDecodeError):
            continue

        text_lower = text.lower()
        match_count = 0
        excerpt = ""
        for term in terms:
            idx = text_lower.find(term.lower())
            if idx >= 0:
                match_count += 1
                if not excerpt:
                    start = max(0, idx - 80)
                    end = min(len(text), idx + len(term) + 80)
                    excerpt = text[start:end].replace("\n", " ").strip()

        if match_count > 0:
            hits[rec.file_path] = (match_count, excerpt)

    results: list[SearchResult] = []
    for rec in candidates:
        if rec.file_path not in hits:
            continue
        count, excerpt = hits[rec.file_path]
        results.append(SearchResult(
            file_path=rec.file_path,
            file_name=rec.file_name,
            extension=rec.extension,
            size=rec.size,
            modified_at=rec.modified_at,
            directory=rec.directory,
            excerpt=excerpt,
            score=float(count) / len(terms),
            source="content_grep",
        ))

    results.sort(key=lambda r: r.score, reverse=True)
    return results[:limit]


# ---------------------------------------------------------------------------
#  Layer 5 — Live filesystem walk (no index required)
# ---------------------------------------------------------------------------

_LIVE_MAX_FILES = 50_000  # safety cap on files walked
_LIVE_MAX_CONTENT_SIZE = 2 * 1024 * 1024  # 2 MB — skip huge files for grep


def _walk_dirs_live(
    directories: list[str],
    *,
    extensions: list[str] | None = None,
    max_depth: int = MAX_RECURSION_DEPTH,
) -> list[Path]:
    """Walk directories directly on disk, respecting skip lists and depth."""
    ext_set = None
    if extensions:
        ext_set = {e if e.startswith(".") else f".{e}" for e in extensions}

    results: list[Path] = []
    count = 0

    def _recurse(directory: Path, depth: int):
        nonlocal count
        if depth > max_depth or count >= _LIVE_MAX_FILES:
            return
        try:
            for entry in directory.iterdir():
                if count >= _LIVE_MAX_FILES:
                    return
                if entry.is_dir():
                    if entry.name in DEFAULT_SKIP_DIRS or entry.name.startswith("."):
                        continue
                    _recurse(entry, depth + 1)
                elif entry.is_file():
                    if entry.suffix.lower() in DEFAULT_SKIP_EXTENSIONS:
                        continue
                    if ext_set and entry.suffix.lower() not in ext_set:
                        continue
                    results.append(entry)
                    count += 1
        except (PermissionError, OSError):
            pass

    for d in directories:
        p = Path(d)
        if p.is_dir():
            _recurse(p, 0)

    return results


def search_live_filename(
    directories: list[str],
    query: str,
    *,
    extensions: list[str] | None = None,
    limit: int = 20,
) -> list[SearchResult]:
    """Live fuzzy filename search — walks the filesystem directly."""
    files = _walk_dirs_live(directories, extensions=extensions)
    query_clean = query.lower().replace("_", " ").replace("-", " ")

    scored: list[tuple[float, SearchResult]] = []
    for f in files:
        stem = f.stem.replace("_", " ").replace("-", " ")
        score = _fuzzy_ratio(query_clean, stem.lower())
        name_score = _fuzzy_ratio(query_clean, f.name.lower())
        best = max(score, name_score)
        if best >= MIN_FUZZY_SCORE:
            try:
                stat = f.stat()
            except OSError:
                continue
            scored.append((best, SearchResult(
                file_path=str(f),
                file_name=f.name,
                extension=f.suffix.lower(),
                size=stat.st_size,
                modified_at=stat.st_mtime,
                directory=str(f.parent),
                excerpt="",
                score=best,
                source="live_filename",
            )))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:limit]]


def search_live_content(
    directories: list[str],
    query: str,
    *,
    extensions: list[str] | None = None,
    limit: int = 20,
) -> list[SearchResult]:
    """Live content grep — reads files directly from disk, no index needed."""
    terms = _extract_grep_terms(query)
    # Also add all query tokens >= 3 chars as fallback terms
    if not terms:
        terms = [tok for tok in re.findall(r"\w+", query) if len(tok) >= 3]
    if not terms:
        return []

    # Only grep text-extractable files
    content_exts = extensions or list(SUPPORTED_EXTENSIONS)
    files = _walk_dirs_live(directories, extensions=content_exts)

    results: list[SearchResult] = []
    for f in files:
        try:
            if f.stat().st_size > _LIVE_MAX_CONTENT_SIZE:
                continue
            text = f.read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeDecodeError):
            continue

        text_lower = text.lower()
        match_count = 0
        excerpt = ""
        for term in terms:
            idx = text_lower.find(term.lower())
            if idx >= 0:
                match_count += 1
                if not excerpt:
                    start = max(0, idx - 100)
                    end = min(len(text), idx + len(term) + 100)
                    excerpt = text[start:end].replace("\n", " ").strip()

        if match_count > 0:
            try:
                stat = f.stat()
            except OSError:
                continue
            results.append(SearchResult(
                file_path=str(f),
                file_name=f.name,
                extension=f.suffix.lower(),
                size=stat.st_size,
                modified_at=stat.st_mtime,
                directory=str(f.parent),
                excerpt=excerpt,
                score=float(match_count) / len(terms),
                source="live_content",
            ))

    results.sort(key=lambda r: r.score, reverse=True)
    return results[:limit]


# ---------------------------------------------------------------------------
#  Layered orchestrator
# ---------------------------------------------------------------------------

class LayeredRetrieval:
    """Applies search layers in order, escalating only when needed."""

    def __init__(
        self,
        metadata_store: MetadataStore,
        retrieval_engine: RetrievalEngine,
        llm_engine=None,
        rewrite_provider: str = "openai",
        rewrite_model: str | None = None,
    ):
        self._meta = metadata_store
        self._retrieval = retrieval_engine
        self._planner = SearchPlanner(llm_engine, rewrite_provider, rewrite_model)

    def search(
        self,
        query: str,
        *,
        directories: list[str] | None = None,
        extensions: list[str] | None = None,
        recency_days: float | None = None,
        top_k: int = 10,
        on_progress: Optional[callable] = None,
    ) -> list[SearchResult]:
        """Run the layered search: index layers first, then live filesystem fallback.

        on_progress(message: str) is called with a short status string whenever
        the search moves to a new layer or phase, so callers can stream
        real-time feedback to the user.
        """
        def _progress(msg: str):
            if on_progress:
                try:
                    on_progress(msg)
                except Exception:
                    pass

        # Always give the planner real directories to choose from
        available_dirs = directories or get_default_search_dirs()
        dir_names = [Path(d).name for d in available_dirs]
        _progress(f"Planning search scope across {', '.join(dir_names[:5])}{'…' if len(dir_names) > 5 else ''}")

        plan = self._planner.plan(query, available_dirs)
        effective_dirs = plan.directories if plan.directories else available_dirs
        effective_exts = extensions or plan.extensions or None

        scoped_names = [Path(d).name for d in effective_dirs]
        ext_hint = f" (filtering: {', '.join(effective_exts)})" if effective_exts else ""
        _progress(f"Searching in: {', '.join(scoped_names[:5])}{ext_hint}")

        # ── Index-based layers (fast, only work if files have been scanned) ──

        # Layer 1: fuzzy filename matching (index)
        _progress("Layer 1/5 — Fuzzy filename matching…")
        results = search_fuzzy_filename(
            self._meta, query,
            directories=effective_dirs, extensions=effective_exts, limit=top_k,
        )
        if len(results) >= MIN_RESULTS_TO_STOP and results[0].score >= 0.7:
            _progress(f"Found {len(results)} matches via filename matching")
            return results[:top_k]

        # Layer 2: path + directory heuristics (index)
        _progress("Layer 2/5 — Directory and path heuristics…")
        layer2 = search_path_heuristics(
            self._meta, query,
            directories=effective_dirs, extensions=effective_exts, limit=top_k,
        )
        results = _merge_results(results, layer2)
        if len(results) >= MIN_RESULTS_TO_STOP and results[0].score >= 0.5:
            _progress(f"Found {len(results)} matches via path heuristics")
            return results[:top_k]

        # Layer 3: literal content grep (index)
        _progress("Layer 3/5 — Searching file contents (indexed)…")
        layer3 = search_content_grep(
            self._meta, query,
            directories=effective_dirs, extensions=effective_exts, limit=top_k,
        )
        results = _merge_results(results, layer3)
        if len(results) >= MIN_RESULTS_TO_STOP:
            _progress(f"Found {len(results)} matches via content search")
            return results[:top_k]

        # Layer 4: semantic vector search (index)
        _progress("Layer 4/5 — Semantic vector search…")
        try:
            layer4 = self._retrieval.search_hybrid(
                query,
                extension=effective_exts[0] if effective_exts and len(effective_exts) == 1 else None,
                directory=effective_dirs[0] if effective_dirs and len(effective_dirs) == 1 else None,
                top_k=top_k,
            )
            results = _merge_results(results, layer4)
        except Exception as e:
            logger.debug("Layer 4 (semantic) failed: %s", e)

        if results:
            _progress(f"Found {len(results)} matches via semantic search")
            return results[:top_k]

        # ── Layer 5: Live filesystem fallback (no index needed) ──────────────
        live_dirs = effective_dirs
        if not live_dirs:
            _progress("No directories to search")
            return results[:top_k]

        live_names = [Path(d).name for d in live_dirs]
        _progress(f"Layer 5/5 — Scanning filesystem live: {', '.join(live_names[:5])}…")

        # 5a: live fuzzy filename match
        _progress("Scanning filenames on disk…")
        live_filename_hits = search_live_filename(
            live_dirs, query, extensions=effective_exts, limit=top_k,
        )
        results = _merge_results(results, live_filename_hits)
        if len(results) >= MIN_RESULTS_TO_STOP and results[0].score >= 0.7:
            _progress(f"Found {len(results)} matches via live filename scan")
            return results[:top_k]

        # 5b: live content grep
        _progress("Reading file contents from disk…")
        live_content_hits = search_live_content(
            live_dirs, query, extensions=effective_exts, limit=top_k,
        )
        results = _merge_results(results, live_content_hits)
        if results:
            _progress(f"Found {len(results)} matches via live content scan")
        else:
            _progress("No matches found across all search layers")
        return results[:top_k]


def _merge_results(
    existing: list[SearchResult], new: list[SearchResult]
) -> list[SearchResult]:
    """Merge two result lists, deduplicating by file_path and keeping the
    higher-scored entry."""
    by_path: dict[str, SearchResult] = {}
    for r in existing:
        if r.file_path not in by_path or r.score > by_path[r.file_path].score:
            by_path[r.file_path] = r
    for r in new:
        if r.file_path not in by_path or r.score > by_path[r.file_path].score:
            by_path[r.file_path] = r
    merged = sorted(by_path.values(), key=lambda r: r.score, reverse=True)
    return merged
