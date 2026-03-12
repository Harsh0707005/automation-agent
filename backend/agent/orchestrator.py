from backend.engine import LLMEngine
from backend.agent.schema import AgentResult, Plan, StepResult
from backend.agent.planning import plan
from backend.agent.step_executor import get_instructions, mock_execute


def run_agent(
    user_request: str,
    provider: str,
    model: str | None = None,
    engine: LLMEngine | None = None,
    context: dict | None = None,
) -> AgentResult:
    import sys
    if engine is None:
        engine = LLMEngine()
    print("[agent] plan()...", flush=True)
    sys.stdout.flush()
    planned = plan(user_request, engine, provider, model, context=context)
    print(f"[agent] plan done: {len(planned.steps)} steps", flush=True)
    sys.stdout.flush()
    step_results: list[StepResult] = []
    completed_results: list[tuple[str, str]] = []
    step_list = planned.steps
    for i, s in enumerate(step_list):
        print(f"[agent] step {s.id}...", flush=True)
        sys.stdout.flush()
        remaining = [x.description for x in step_list[i + 1 :]]
        instructions = get_instructions(
            goal=s.description,
            objective=user_request,
            completed_results=completed_results,
            remaining_descriptions=remaining,
            engine=engine,
            provider=provider,
            model=model,
        )
        display_result = mock_execute(instructions)
        step_results.append(
            StepResult(
                step_id=s.id,
                description=s.description,
                instructions=instructions,
                display_result=display_result,
            )
        )
        completed_results.append((s.id, display_result))
    return AgentResult(plan=planned, step_results=step_results)
