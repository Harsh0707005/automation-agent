from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.engine import LLMEngine
from backend.services import OpenAIService, AnthropicService, GeminiService


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


class ModelInfo(BaseModel):
    id: str
    provider: str
    model: str
    label: str


MODELS: list[ModelInfo] = [
    ModelInfo(
        id="openai:gpt-4o-mini",
        provider=LLMEngine.PROVIDER_OPENAI,
        model=OpenAIService.DEFAULT_MODEL,
        label="OpenAI – gpt-4o-mini",
    ),
    ModelInfo(
        id="anthropic:claude-3-5-haiku",
        provider=LLMEngine.PROVIDER_ANTHROPIC,
        model=AnthropicService.DEFAULT_MODEL,
        label="Claude – 3.5 Haiku",
    ),
    ModelInfo(
        id="gemini:2.0-flash",
        provider=LLMEngine.PROVIDER_GEMINI,
        model=GeminiService.DEFAULT_MODEL,
        label="Gemini – 2.0 Flash",
    ),
]


@app.get("/models")
def get_models():
    return {"ok": True, "models": [m.model_dump() for m in MODELS]}


@app.post("/message")
def post_message(req: MessageRequest):
    prompt = req.message.strip()
    if not prompt:
        return {"ok": False, "error": "Empty message"}

    # If a specific provider/model is chosen, call only that one
    if req.provider:
        try:
            result = engine.complete(prompt, provider=req.provider, model=req.model)
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
            result = engine.complete(prompt, provider=provider)
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

