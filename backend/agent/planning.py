import json
import re

from backend.engine import LLMEngine
from backend.agent.schema import Plan, PlanStep, PlanSchema
from backend.agent.prompts import PLANNING_SYSTEM, planning_user_prompt


def plan(user_request: str, engine: LLMEngine, provider: str, model: str | None = None, context: dict | None = None) -> Plan:
    import sys
    full_prompt = f"{PLANNING_SYSTEM}\n\n{planning_user_prompt(user_request, context)}"
    print("[agent] LLM planning call...", flush=True)
    sys.stdout.flush()
    result = engine.complete(full_prompt, provider=provider, model=model, timeout=90)
    print("[agent] planning LLM response received", flush=True)
    sys.stdout.flush()
    raw = _extract_json(result.content)
    data = json.loads(raw)
    parsed = PlanSchema.model_validate(data)
    return Plan(
        steps=[
            PlanStep(id=s.id, description=s.description, depends_on=s.depends_on)
            for s in parsed.steps
        ]
    )


def _extract_json(text: str) -> str:
    text = text.strip()
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return match.group(0)
    return text
