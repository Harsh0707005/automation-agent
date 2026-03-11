from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.engine import LLMEngine

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


@app.post("/message")
def post_message(req: MessageRequest):
    prompt = req.message.strip()
    if not prompt:
        return {"ok": False, "error": "Empty message"}
    responses = []
    for provider in engine.get_providers():
        try:
            result = engine.complete(prompt, provider=provider)
            responses.append({
                "provider": result.provider,
                "model": result.model,
                "content": result.content,
                "usage": result.usage,
            })
            print(f"[{result.provider}] {result.model}: {result.content[:200]}{'...' if len(result.content) > 200 else ''}")
        except Exception as e:
            responses.append({"provider": provider, "error": str(e)})
            print(f"[{provider}] error: {e}")
    return {"ok": True, "responses": responses}
