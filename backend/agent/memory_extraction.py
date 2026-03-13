import json
import re

from backend.engine import LLMEngine
from backend.agent.prompts import (
    MEMORY_EXTRACTION_SYSTEM,
    memory_extraction_user_prompt,
    memory_filter_duplicates_prompt,
)


def extract_memory_chunks(
    user_message: str,
    assistant_response: str,
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
) -> list[str]:
    """Extract 0-3 stable memory chunks from a user-assistant exchange."""
    prompt = MEMORY_EXTRACTION_SYSTEM + "\n\n" + memory_extraction_user_prompt(
        user_message, assistant_response
    )
    try:
        result = engine.complete(prompt, provider=provider, model=model, timeout=30)
        raw = result.content.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        data = json.loads(raw)
        chunks = data.get("chunks", [])
        return [str(c).strip() for c in chunks if c and str(c).strip()][:3]
    except Exception:
        return []


def filter_duplicate_memory(
    existing: list[str],
    new: list[str],
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
) -> list[int]:
    """Return 0-based indices of `new` chunks that are NOT semantically redundant with any `existing` chunk."""
    if not new:
        return []
    existing = [s.strip() for s in existing if s and s.strip()]
    new = [s.strip() for s in new if s and s.strip()]
    if not new:
        return []
    if not existing:
        return list(range(len(new)))

    prompt = memory_filter_duplicates_prompt(existing, new)
    try:
        result = engine.complete(prompt, provider=provider, model=model, timeout=25)
        raw = result.content.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        data = json.loads(raw)
        keep = data.get("keep_indices", [])
        if not isinstance(keep, list):
            return list(range(len(new)))
        valid = [i for i in keep if isinstance(i, int) and 0 <= i < len(new)]
        return sorted(set(valid))
    except Exception:
        return list(range(len(new)))
