import json
import re

from backend.engine import LLMEngine
from backend.agent.schema import Instruction, StepOutputSchema
from backend.agent.prompts import STEP_SYSTEM, step_user_prompt, SINGLE_COMMAND_FALLBACK


def get_instructions(
    goal: str,
    objective: str,
    completed_results: list[tuple[str, str]],
    remaining_descriptions: list[str],
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
    context: dict | None = None,
) -> list[Instruction]:
    import sys
    full_prompt = f"{STEP_SYSTEM}\n\n{step_user_prompt(goal, objective, completed_results, remaining_descriptions, context=context)}"
    print(f"[agent] step LLM call (goal={goal[:50]}...)", flush=True)
    sys.stdout.flush()
    result = engine.complete(full_prompt, provider=provider, model=model, timeout=90)
    raw = _extract_json(result.content)
    data = json.loads(raw)
    parsed = StepOutputSchema.model_validate(data)
    out = []
    for i in parsed.instructions:
        args = {}
        if i.args.command is not None:
            args["command"] = i.args.command
        if i.args.path is not None:
            args["path"] = i.args.path
        if i.args.content is not None:
            args["content"] = i.args.content
        if i.args.message is not None:
            args["message"] = i.args.message
        if i.args.prompt is not None:
            args["prompt"] = i.args.prompt
        if i.args.context is not None:
            args["context"] = i.args.context
        out.append(Instruction(tool=i.tool.value, args=args, reason=i.reason))
    return out


def get_instructions_fallback(
    goal: str,
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
) -> list[Instruction]:
    """When get_instructions returns empty, ask for a single run_command from the goal."""
    try:
        full_prompt = f"{SINGLE_COMMAND_FALLBACK}\n\nGoal: {goal}"
        result = engine.complete(full_prompt, provider=provider, model=model, timeout=60)
        raw = _extract_json(result.content)
        data = json.loads(raw)
        parsed = StepOutputSchema.model_validate(data)
        out = []
        for i in parsed.instructions:
            if i.tool.value != "run_command":
                continue
            cmd = i.args.command if i.args else None
            if cmd:
                out.append(Instruction(tool="run_command", args={"command": cmd}, reason=i.reason))
        return out
    except Exception:
        return []


def mock_execute(instructions: list[Instruction]) -> str:
    lines = []
    for i, inst in enumerate(instructions, 1):
        part = f"{i}. {inst.tool}"
        if inst.args:
            part += " " + str(inst.args)
        if inst.reason:
            part += f" — {inst.reason}"
        lines.append(part)
    return "Would execute (display only):\n" + "\n".join(lines) if lines else "No instructions."


def _extract_json(text: str) -> str:
    text = text.strip()
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return match.group(0)
    return text
