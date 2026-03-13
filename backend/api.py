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

    async def send(msg: dict):
        await websocket.send_text(json.dumps(msg))

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            typ = msg.get("type")
            if typ == "start":
                message = (msg.get("payload") or {}).get("message", "").strip()
                provider = (msg.get("payload") or {}).get("provider")
                model = (msg.get("payload") or {}).get("model")
                context = (msg.get("payload") or {}).get("context")
                if not message or not provider:
                    await send({"type": "error", "error": "message and provider required"})
                    continue
                # Heuristic: decide whether this is a follow-up on the existing objective
                lower_msg = message.lower()
                is_short_ack = len(message) <= 40 and any(
                    phrase in lower_msg
                    for phrase in [
                        "yes",
                        "ok",
                        "okay",
                        "sure",
                        "continue",
                        "go ahead",
                        "yep",
                        "yeah",
                        "please do",
                    ]
                )
                # Short referential follow-up like "that 3rd process" or "the first one"
                is_referential_followup = len(message) <= 120 and any(
                    phrase in lower_msg
                    for phrase in [
                        "process",
                        "pid",
                        "first one",
                        "second one",
                        "third one",
                        "3rd",
                        "2nd",
                        "1st",
                        "that one",
                        "this one",
                        "above",
                        "from the list",
                    ]
                )
                has_prior_context = bool(session.objective and session.completed_results)

                if (is_short_ack or is_referential_followup) and has_prior_context:
                    # Follow-up on previous objective; keep objective but pass both to planner
                    combined_objective = (
                        f"Previous user objective: {session.objective}\n"
                        f"New user message: {message}"
                    )
                    planning_request = combined_objective
                else:
                    # New objective: reset agent session progress
                    session.plan = None
                    session.step_index = 0
                    session.instruction_index = 0
                    session.instructions = []
                    session.completed_results = []
                    session.last_read_content = ""
                    session.objective = message
                    planning_request = message

                session.provider = provider
                session.model = model
                session.context = context
                try:
                    # Include recent completed_results so the planner can reuse prior outputs
                    recent_results = session.completed_results or []
                    planned = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: plan(
                            planning_request,
                            engine,
                            provider,
                            model,
                            context=context,
                            recent_results=recent_results,
                        ),
                    )
                    session.plan = planned
                    await send({"type": "plan", "plan": planned.model_dump()})
                    # Start execution in background so we can still receive confirmations
                    asyncio.create_task(run_agent_ws(send, session))
                except Exception as e:
                    await send({"type": "error", "error": str(e)})
            elif typ == "confirmation_response":
                approved = bool((msg.get("payload") or {}).get("approved"))
                fut = getattr(session, "pending_confirmation", None)
                if fut is not None and not fut.done():
                    fut.set_result(approved)
            elif typ == "command_result":
                # Command finished on the user's machine; resume the awaiting agent step.
                payload = msg.get("payload") or {}
                fut = getattr(session, "pending_command_result", None)
                if fut is not None and not fut.done():
                    fut.set_result(
                        {
                            "stdout": str(payload.get("stdout") or ""),
                            "stderr": str(payload.get("stderr") or ""),
                            "returncode": int(payload.get("returncode") or 0),
                        }
                    )
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

