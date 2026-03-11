import os
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

from backend.engine.result import CompletionResult

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


class AnthropicService:
    DEFAULT_MODEL = "claude-haiku-4-5"

    def __init__(self):
        self._client = Anthropic(api_key=os.getenv("CLAUDE_API_KEY"))

    def complete(
        self,
        prompt: str,
        model: str | None = None,
        **kwargs,
    ) -> CompletionResult:
        model = model or self.DEFAULT_MODEL
        resp = self._client.messages.create(
            model=model,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )
        content = resp.content[0].text if resp.content else ""
        usage = None
        if resp.usage:
            usage = {
                "prompt_tokens": resp.usage.input_tokens,
                "completion_tokens": resp.usage.output_tokens,
                "total_tokens": resp.usage.input_tokens + resp.usage.output_tokens,
            }
        return CompletionResult(
            content=content,
            model=resp.model,
            provider="anthropic",
            usage=usage,
        )
