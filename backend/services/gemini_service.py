import os
from pathlib import Path

import google.generativeai as genai
from dotenv import load_dotenv

from backend.engine.result import CompletionResult

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


class GeminiService:
    DEFAULT_MODEL = "gemini-3.1-pro-preview"

    def __init__(self):
        api_key = os.getenv("GEMINI_API_KEY")
        if api_key:
            genai.configure(api_key=api_key)
        self._default_model = self.DEFAULT_MODEL

    def complete(
        self,
        prompt: str,
        model: str | None = None,
        **kwargs,
    ) -> CompletionResult:
        kwargs = dict(kwargs)
        kwargs.pop("timeout", None)  # generate_content() does not accept timeout
        model_name = model or self._default_model
        gemini = genai.GenerativeModel(model_name)
        resp = gemini.generate_content(prompt, **kwargs)
        content = resp.text if resp.text else ""
        usage = None
        if resp.usage_metadata:
            usage = {
                "prompt_tokens": getattr(resp.usage_metadata, "prompt_token_count", 0) or 0,
                "completion_tokens": getattr(resp.usage_metadata, "candidates_token_count", 0) or 0,
                "total_tokens": getattr(resp.usage_metadata, "total_token_count", 0) or 0,
            }
        return CompletionResult(
            content=content,
            model=model_name,
            provider="gemini",
            usage=usage,
        )
