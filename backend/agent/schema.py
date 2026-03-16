from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ToolType(str, Enum):
    RUN_COMMAND = "run_command"
    READ_FILE = "read_file"
    WRITE_FILE = "write_file"
    REQUEST_CONFIRMATION = "request_confirmation"
    MESSAGE = "message"
    RESPOND = "respond"
    ASK_USER = "ask_user"
    SEARCH_FILES = "search_files"


class PlanStepSchema(BaseModel):
    id: str = Field(..., description="Unique step id, e.g. '1', '2'")
    description: str = Field(..., description="High-level goal for this step")
    depends_on: list[str] = Field(default_factory=list, description="Ids of steps that must complete before this one")


class PlanSchema(BaseModel):
    steps: list[PlanStepSchema] = Field(..., description="Ordered high-level steps to achieve the objective")


class InstructionArgs(BaseModel):
    command: str | None = None
    path: str | None = None
    content: str | None = None
    message: str | None = None
    prompt: str | None = None
    context: str | None = None
    question: str | None = None
    options: list[str] | None = None
    # search_files args
    query: str | None = None
    directories: list[str] | None = None
    extensions: list[str] | None = None
    recency_days: float | None = None
    top_k: int | None = None


class InstructionSchema(BaseModel):
    tool: ToolType
    args: InstructionArgs = Field(default_factory=InstructionArgs)
    reason: str | None = None


class StepOutputSchema(BaseModel):
    instructions: list[InstructionSchema] = Field(..., description="Ordered list of tool invocations for this step only")


class PlanStep(BaseModel):
    id: str
    description: str
    depends_on: list[str] = Field(default_factory=list)


class Plan(BaseModel):
    steps: list[PlanStep]


class Instruction(BaseModel):
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = None


class StepResult(BaseModel):
    step_id: str
    description: str
    instructions: list[Instruction] = Field(default_factory=list)
    display_result: str = ""


class AgentResult(BaseModel):
    plan: Plan
    step_results: list[StepResult] = Field(default_factory=list)
