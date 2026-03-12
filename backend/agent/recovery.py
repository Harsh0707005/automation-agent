import json
import re

from backend.engine import LLMEngine
from backend.agent.schema import Instruction
from backend.agent.prompts import RECOVERY_SYSTEM, recovery_user_prompt


def get_recovery_instructions(
    goal: str,
    objective: str,
    command: str,
    stdout: str,
    stderr: str,
    returncode: int,
    completed_results: list[tuple[str, str]],
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
) -> list[Instruction] | None:
    """Returns list of instructions to try next, or None to abort."""
    prompt = f"{RECOVERY_SYSTEM}\n\n{recovery_user_prompt(goal, objective, command, stdout, stderr, returncode, completed_results)}"
    result = engine.complete(prompt, provider=provider, model=model, timeout=60)
    raw = _extract_json(result.content)
    data = json.loads(raw)
    if data.get("abort") is True:
        return None
    instructions = data.get("recovery_instructions") or []
    out = []
    for i in instructions:
        if not isinstance(i, dict):
            continue
        tool = i.get("tool", "run_command")
        args = i.get("args") or {}
        if isinstance(args, dict):
            pass
        else:
            args = {}
        reason = i.get("reason")
        out.append(Instruction(tool=tool, args=args, reason=reason))
    return out if out else None


def _extract_json(text: str) -> str:
    text = text.strip()
    match = re.search(r"\{[\s\S]*\}", text)
    return match.group(0) if match else text
