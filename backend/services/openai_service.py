import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from backend.engine.result import CompletionResult

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


class OpenAIService:
    DEFAULT_MODEL = "gpt-5-mini-2025-08-07"

    def __init__(self):
        self._client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    def complete(
        self,
        prompt: str,
        model: str | None = None,
        **kwargs,
    ) -> CompletionResult:
        model = model or self.DEFAULT_MODEL
        resp = self._client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )
        msg = resp.choices[0].message
        usage = None
        if resp.usage:
            usage = {
                "prompt_tokens": resp.usage.prompt_tokens,
                "completion_tokens": resp.usage.completion_tokens,
                "total_tokens": resp.usage.total_tokens,
            }
        return CompletionResult(
            content=msg.content or "",
            model=resp.model,
            provider="openai",
            usage=usage,
        )
