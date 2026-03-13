import json
import re

from backend.engine import LLMEngine
from backend.agent.prompts import MEMORY_EXTRACTION_SYSTEM, memory_extraction_user_prompt


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
