import asyncio
import json
from typing import Any, Optional

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.engine import LLMEngine
from backend.services import OpenAIService, AnthropicService, GeminiService
from backend.agent import run_agent
from backend.agent.planning import plan
from backend.agent.ws_agent import AgentSession, run_agent_ws


_MAX_HISTORY_TURNS = 20


def _append_history(history: list[dict], role: str, content: str) -> None:
    """Append a turn and keep history bounded to _MAX_HISTORY_TURNS entries."""
    history.append({"role": role, "content": content})
    if len(history) > _MAX_HISTORY_TURNS:
        del history[: len(history) - _MAX_HISTORY_TURNS]


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = LLMEngine()


class MessageRequest(BaseModel):
    message: str
    provider: Optional[str] = None
    model: Optional[str] = None
    context: Optional[dict[str, Any]] = None


class TitleResponse(BaseModel):
    ok: bool
    title: Optional[str] = None
    error: Optional[str] = None


class ModelInfo(BaseModel):
    id: str
    provider: str
    model: str
    label: str


MODELS: list[ModelInfo] = [
    ModelInfo(
        id="openai:gpt-5-mini-2025-08-07",
        provider=LLMEngine.PROVIDER_OPENAI,
        model=OpenAIService.DEFAULT_MODEL,
        label="GPT-5 Mini",
    ),
    ModelInfo(
        id="anthropic:claude-haiku-4-5",
        provider=LLMEngine.PROVIDER_ANTHROPIC,
        model=AnthropicService.DEFAULT_MODEL,
        label="Claude Haiku 4.5",
    ),
    ModelInfo(
        id="gemini:gemini-3.1-pro-preview",
        provider=LLMEngine.PROVIDER_GEMINI,
        model=GeminiService.DEFAULT_MODEL,
        label="Gemini 3.1 Pro Preview",
    ),
]


def _build_prompt_with_context(message: str, context: Optional[dict[str, Any]]) -> str:
    if not context:
        return message
    lines = ["Device context:", *[f"  {k}: {v}" for k, v in sorted(context.items())], "", message]
    return "\n".join(lines)


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    session = AgentSession(engine=engine)

    agent_task: asyncio.Task | None = None
    # Flag to indicate the current workflow has been cancelled from the client.
    session.cancelled = False  # type: ignore[attr-defined]

    async def send(msg: dict):
        # Capture workflow summary into conversation history as an assistant turn
        if msg.get("type") == "workflow_done" and session.last_summary:
            _append_history(session.conversation_history, "assistant", session.last_summary)
        await websocket.send_text(json.dumps(msg))

    async def run_workflow(message: str, provider: str, model: str | None, context: dict | None, conv_history: list) -> None:
        """Run planning + agent execution as a background task so the receive loop stays free."""
        try:
            planned = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: plan(
                    message,
                    engine,
                    provider,
                    model,
                    context=context,
                    conversation_history=conv_history,
                ),
            )
            # If the workflow was cancelled while we were still planning, bail out silently.
            if getattr(session, "cancelled", False):
                return
            session.plan = planned
            await send({"type": "plan", "plan": planned.model_dump()})
            await run_agent_ws(send, session)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            if not getattr(session, "cancelled", False):
                await send({"type": "error", "error": str(e)})

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            typ = msg.get("type")
            if typ == "start":
                payload = msg.get("payload") or {}
                message = payload.get("message", "").strip()
                provider = payload.get("provider")
                model = payload.get("model")
                context = payload.get("context")
                if not message or not provider:
                    await send({"type": "error", "error": "message and provider required"})
                    continue

                # Seed conversation history from the desktop client on the first turn of this
                # WS session (session.conversation_history is empty on a fresh connection).
                # This lets "continue conversation" work correctly after reconnecting.
                prior_history = payload.get("conversation_history") or []
                if not session.conversation_history and prior_history:
                    session.conversation_history = [
                        {"role": str(h.get("role", "")), "content": str(h.get("content", ""))}
                        for h in prior_history
                        if h.get("role") in ("user", "assistant") and h.get("content")
                    ]

                # Record this user turn into persistent history before planning
                _append_history(session.conversation_history, "user", message)

                # Reset per-workflow state for the new request
                session.cancelled = False  # type: ignore[attr-defined]
                session.plan = None
                session.step_index = 0
                session.instruction_index = 0
                session.instructions = []
                session.completed_results = []
                session.last_read_content = ""
                session.last_summary = ""
                session.objective = message

                session.provider = provider
                session.model = model
                session.context = context

                # Run planning + execution in the background so we can immediately handle
                # stop/confirmation/command_result messages while the LLM is working.
                agent_task = asyncio.create_task(
                    run_workflow(message, provider, model, context, list(session.conversation_history))
                )
            elif typ == "confirmation_response":
                approved = bool((msg.get("payload") or {}).get("approved"))
                fut = getattr(session, "pending_confirmation", None)
                if fut is not None and not fut.done():
                    fut.set_result(approved)
            elif typ == "ask_user_response":
                answer = str((msg.get("payload") or {}).get("answer") or "")
                fut = getattr(session, "pending_user_input", None)
                if fut is not None and not fut.done():
                    fut.set_result(answer)
            elif typ == "command_result":
                # Command finished on the user's machine; resume the awaiting agent step.
                payload = msg.get("payload") or {}
                cmd_id = payload.get("cmd_id")
                result_val = {
                    "stdout": str(payload.get("stdout") or ""),
                    "stderr": str(payload.get("stderr") or ""),
                    "returncode": int(payload.get("returncode") or 0),
                }
                # Route to the correct future by cmd_id (parallel execution)
                if cmd_id and cmd_id in session.pending_command_results:
                    fut = session.pending_command_results.get(cmd_id)
                    if fut is not None and not fut.done():
                        fut.set_result(result_val)
                else:
                    # Fallback: resolve any single pending future (legacy / no cmd_id)
                    for fut in list(session.pending_command_results.values()):
                        if not fut.done():
                            fut.set_result(result_val)
                            break
            elif typ == "stop":
                # User requested to stop the current workflow.
                session.cancelled = True  # type: ignore[attr-defined]

                # Best-effort cancel of any in-flight agent execution, but do NOT await it.
                if agent_task is not None and not agent_task.done():
                    agent_task.cancel()

                # Cancel all pending command futures (parallel execution may have several).
                for fut in list(session.pending_command_results.values()):
                    if not fut.done():
                        fut.cancel()
                session.pending_command_results.clear()

                # Cancel interaction futures.
                for fut_name in ("pending_confirmation", "pending_user_input"):
                    fut = getattr(session, fut_name, None)
                    if fut is not None and not fut.done():
                        fut.cancel()
                        setattr(session, fut_name, None)

                session.state = "idle"
                reason = (msg.get("payload") or {}).get("reason") or "Stopped."
                await send({"type": "workflow_stopped", "reason": reason})
    except Exception:
        pass


@app.get("/models")
def get_models():
    return {"ok": True, "models": [m.model_dump() for m in MODELS]}


@app.post("/plan")
def post_plan(req: MessageRequest):
    print("[plan] request received", flush=True)
    prompt = req.message.strip()
    if not prompt:
        return {"ok": False, "error": "Empty message"}
    if not req.provider:
        return {"ok": False, "error": "Provider required for plan"}
    try:
        planned = plan(prompt, engine, req.provider, req.model, context=req.context)
        return {"ok": True, "plan": planned.model_dump()}
    except Exception as e:
        print(f"[plan] error: {e}", flush=True)
        return {"ok": False, "error": str(e)}


@app.post("/agent")
def post_agent(req: MessageRequest):
    print("[agent] request received", flush=True)
    prompt = req.message.strip()
    if not prompt:
        return {"ok": False, "error": "Empty message"}
    if not req.provider:
        return {"ok": False, "error": "Provider required for agent"}
    try:
        result = run_agent(user_request=prompt, provider=req.provider, model=req.model, engine=engine, context=req.context)
        print("[agent] done", flush=True)
        return {"ok": True, "agent": result.model_dump()}
    except Exception as e:
        print(f"[agent] error: {e}", flush=True)
        return {"ok": False, "error": str(e)}


@app.post("/message")
def post_message(req: MessageRequest):
    print("[message] request received", flush=True)
    prompt = req.message.strip()
    if not prompt:
        return {"ok": False, "error": "Empty message"}

    prompt_with_context = _build_prompt_with_context(prompt, req.context)

    # If a specific provider/model is chosen, call only that one
    if req.provider:
        try:
            result = engine.complete(prompt_with_context, provider=req.provider, model=req.model)
            print(
                f"[{result.provider}] {result.model}: "
                f"{result.content[:200]}{'...' if len(result.content) > 200 else ''}"
            )
            return {
                "ok": True,
                "responses": [
                    {
                        "provider": result.provider,
                        "model": result.model,
                        "content": result.content,
                        "usage": result.usage,
                    }
                ],
            }
        except Exception as e:
            print(f"[{req.provider}] error: {e}")
            return {"ok": False, "error": str(e)}

    # Fallback: fan out to all providers (legacy behavior)
    responses = []
    for provider in engine.get_providers():
        try:
            result = engine.complete(prompt_with_context, provider=provider)
            responses.append(
                {
                    "provider": result.provider,
                    "model": result.model,
                    "content": result.content,
                    "usage": result.usage,
                }
            )
            print(
                f"[{result.provider}] {result.model}: "
                f"{result.content[:200]}{'...' if len(result.content) > 200 else ''}"
            )
        except Exception as e:
            responses.append({"provider": provider, "error": str(e)})
            print(f"[{provider}] error: {e}")
    return {"ok": True, "responses": responses}


@app.post("/title", response_model=TitleResponse)
def post_title(req: MessageRequest) -> TitleResponse:
    """Generate a short conversation title from the initial user message.

    This is intentionally lightweight and is used by the desktop client in the
    background so it must not block or be overly expensive.
    """
    prompt = (req.message or "").strip()
    if not prompt:
        return TitleResponse(ok=False, error="Empty message")

    # Keep the instruction small and cheap but constrained so we get a usable title.
    instruction = (
        "Generate a short, descriptive title (max 6 words) for this conversation.\n"
        "Requirements:\n"
        "- Do NOT wrap the title in quotes.\n"
        "- Use Title Case.\n"
        "- No trailing punctuation.\n\n"
        f"User's first message:\n{prompt}"
    )

    provider = req.provider
    model = req.model

    # Fallback to engine defaults if no provider/model were specified.
    if not provider:
        provider = engine.get_providers()[0]

    try:
        result = engine.complete(instruction, provider=provider, model=model)
        title = (result.content or "").strip()
        if not title:
            return TitleResponse(ok=False, error="Empty title from model")
        return TitleResponse(ok=True, title=title)
    except Exception as e:
        return TitleResponse(ok=False, error=str(e))

