from dataclasses import dataclass


@dataclass
class CompletionResult:
    content: str
    model: str
    provider: str
    usage: dict[str, int] | None = None
