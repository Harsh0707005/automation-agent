The goal of the project is to build a completely autonomous desktop automation agent that allows a user to perform tasks simply by asking the agent, without any manual intervention. For example, a user could ask the agent to install Docker, and the agent would determine the operating system, understand the current system context, and communicate with LLMs in an agentic manner to complete the task. The agent achieves the end goal by breaking the user’s request into multiple smaller steps.

The first stage of the system is the planning layer. In this stage, the agent converts the user’s request into several high level steps without rigidly defining the exact implementation for each step. These steps represent intermediate goals required to reach the final objective.

After the planning layer, each high level step, which can be treated as a short term goal, is processed individually. The agent sends the short term goal to the LLM along with relevant context such as system state, previously completed steps within the current task window, remaining tasks, and the overall objective. The LLM then returns detailed instructions required to achieve that specific short term goal. These instructions must follow a predefined schema so the agent can execute them deterministically. The LLM is not given unrestricted free form control over execution.

To maximize the capabilities of modern LLMs, the system relies on structured outputs and tool use. These features are supported by most modern models and allow the agent to interpret responses reliably and invoke tools in a controlled way.

Each completed short term goal contributes to the completion of the larger objective. After executing every subtask, the agent returns the result back to the LLM together with updated context about the task, the goal state, and the progress so far. This creates a true agentic workflow where the system only proceeds to the next step once the current task has been verified as completed.

Efficiency is also considered in the architecture. When multiple tasks are independent and do not rely on each other’s outputs, they should be executed in parallel. Parallel execution reduces total completion time and improves overall efficiency.

Before performing destructive actions such as deleting files or modifying critical system state, the agent must explicitly request confirmation from the user before proceeding.

The system architecture consists of two main components, a backend and a frontend. The backend contains the entire business logic and agent orchestration logic. The frontend is the interface through which the user interacts with the system. The frontend will be implemented as an Electron desktop application, while the backend will be implemented in Python.

For reasoning, the system uses LLMs such as OpenAI GPT, Anthropic Claude, and Google Gemini. However, the architecture should not be tightly coupled to any specific provider. Instead, the backend should include an LLM agnostic engine responsible for managing all communication with language models. This engine routes requests to different LLM providers and standardizes their responses.

Each LLM provider is implemented as an independent service module. These modules receive requests from the LLM agnostic engine, communicate with the respective model API, and return structured results back to the engine. This design ensures flexibility and allows new LLM providers to be integrated without modifying the core agent architecture.

Code Comment Guidelines

Avoid excessive comments that make the code messy or over explanatory. Comments should only be added when the logic is complex or not immediately obvious. Do not add comments for simple or self explanatory code. Keep comments minimal while ensuring the code remains readable and easy to understand.

File Structure Guidelines

Avoid creating large files that are difficult to maintain. Break functionality into smaller, well organized modules. Maintain a clear and production ready file structure that is self explanatory and easy to navigate. This improves long term maintainability and scalability of the codebase.

Conversation Context Maintenance

Since the system follows an agentic workflow, maintaining conversation context is critical for consistent reasoning and task continuity. The agent must remain aware of the full conversational history so that decisions remain aligned with the user’s intent and previously executed actions.

For every interaction with the agent, the backend maintains the conversation history in memory. This history contains all previous messages exchanged between the user and the system during the session. Whenever the agent sends a request to the LLM, the conversation history is appended as context so the model understands what has already happened in the task lifecycle.

However, LLM context windows are limited. If the conversation becomes large, sending the full history becomes inefficient and may exceed model limits. To address this, the system implements a context compression strategy.

When the total token size of the conversation exceeds a predefined threshold, the system performs a summarization step. In this step, the agent sends the entire conversation history to the LLM with instructions to produce a concise summary that preserves the important task details, decisions, actions taken, and the current progress state.

Once the summary is generated, the context sent to future LLM calls is structured in the following way.

1. The summarized representation of the earlier conversation history.
2. The most recent two messages from the conversation included exactly as they were written.

The last two messages are preserved without summarization because they often contain immediate instructions, clarifications, or context that is critical for the next reasoning step. Summarizing them could remove important short term information.

This approach allows the agent to maintain awareness of the full conversation while remaining within LLM context limits and keeping token usage efficient. The summarization process happens internally as part of the system’s context management and is not visible to the user.
