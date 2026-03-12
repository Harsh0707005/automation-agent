import json
import re

from backend.engine import LLMEngine
from backend.agent.prompts import VERIFY_SYSTEM, verify_user_prompt


def verify_step_complete(
    goal: str,
    command: str,
    stdout: str,
    stderr: str,
    returncode: int,
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
) -> bool:
    # Command printed usage/error to stderr — treat as not complete (e.g. macOS ps with GNU-style flags)
    stderr_lower = (stderr or "").strip().lower()
    if stderr_lower and (
        "illegal option" in stderr_lower
        or "usage:" in stderr_lower
        or stderr_lower.startswith("usage\n")
        or "error:" in stderr_lower
        or "no such" in stderr_lower
    ):
        return False
    prompt = f"{VERIFY_SYSTEM}\n\n{verify_user_prompt(goal, command, stdout, stderr, returncode)}"
    result = engine.complete(prompt, provider=provider, model=model, timeout=30)
    raw = _extract_json(result.content)
    data = json.loads(raw)
    return bool(data.get("step_complete", False))


def _extract_json(text: str) -> str:
    text = text.strip()
    match = re.search(r"\{[\s\S]*\}", text)
    return match.group(0) if match else text
