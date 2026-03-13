from backend.engine import LLMEngine

RESPOND_SYSTEM = """You are a helpful assistant. Given the context (if any) and the user's request, produce a clear, helpful text response. Respond in plain text. No approval or confirmation steps."""

WORKFLOW_SUMMARY_SYSTEM = """You are a helpful assistant summarizing what an automation agent did for the user. Given the user's original request and a list of steps that were completed (with their output), write a natural-language summary.

<style>
- Be concise: include only what is necessary (what was asked, what was done, and the outcome).
- Assume the user can already see the raw command output in their UI. Do NOT simply repeat the full logs or tables. Instead, explain them in human-friendly terms and, if helpful, highlight just the most important lines or processes.
- Use as many or as few sentences as needed—no fixed limit.
- Address the user in second person ("you asked…", "I…").
- Output in Markdown for readability: use **bold** for emphasis, `backticks` for commands or technical terms, and short paragraphs or brief bullet lists where it helps readability.
- No JSON or raw code blocks.
</style>

Summarize based on the step results provided; do not mention truncation or that output was limited—describe the outcome as if the user is seeing the full picture."""


def generate_response(
    prompt: str,
    context: str | None,
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
) -> str:
    if context and context.strip():
        user_content = f"Context:\n{context[:12000]}\n\nRequest: {prompt}"
    else:
        user_content = prompt
    full = f"{RESPOND_SYSTEM}\n\n{user_content}"
    result = engine.complete(full, provider=provider, model=model, timeout=60)
    return (result.content or "").strip()


# Max chars per step result to send to summary LLM (enough for e.g. top-10 process list)
SUMMARY_STEP_RESULT_CHARS = 6000


def generate_workflow_summary(
    objective: str,
    completed_results: list[tuple[str, str]],
    engine: LLMEngine,
    provider: str,
    model: str | None = None,
) -> str:
    """Produce a short natural-language summary of what was done for the user."""
    if not completed_results:
        return "Workflow completed with no steps run."
    context_lines = [
        f"Step {step_id}: {result[:SUMMARY_STEP_RESULT_CHARS]}{'...' if len(result) > SUMMARY_STEP_RESULT_CHARS else ''}"
        for step_id, result in completed_results
    ]
    context = "\n".join(context_lines)
    prompt = "Summarize what was done and the result for the user in Markdown (concise, only what is necessary)."
    full = f"{WORKFLOW_SUMMARY_SYSTEM}\n\nUser request: {objective}\n\nSteps completed:\n{context}\n\n{prompt}"
    result = engine.complete(full, provider=provider, model=model, timeout=45)
    return (result.content or "Workflow complete.").strip()
