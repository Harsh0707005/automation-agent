from typing import Any

from backend.engine.result import CompletionResult
from backend.services import OpenAIService, AnthropicService, GeminiService


class LLMEngine:
    PROVIDER_OPENAI = "openai"
    PROVIDER_ANTHROPIC = "anthropic"
    PROVIDER_GEMINI = "gemini"

    def __init__(self):
        self._services = {
            self.PROVIDER_OPENAI: OpenAIService(),
            self.PROVIDER_ANTHROPIC: AnthropicService(),
            self.PROVIDER_GEMINI: GeminiService(),
        }

    def get_providers(self) -> list[str]:
        return list(self._services.keys())

    def complete(
        self,
        prompt: str,
        provider: str,
        model: str | None = None,
        **kwargs: Any,
    ) -> CompletionResult:
        svc = self._services.get(provider)
        if not svc:
            raise ValueError(f"Unknown provider: {provider}. Choose from {self.get_providers()}")
        return svc.complete(prompt, model=model, **kwargs)
