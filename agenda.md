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

Memory Creation Logic

In addition to short term conversational context, the agent maintains a structured memory layer that stores important long term information extracted from interactions with the user. The purpose of this memory is to allow the system to improve future reasoning by remembering relevant facts, preferences, and patterns observed during previous interactions.

Memory creation is executed continuously during the conversation lifecycle. Each interaction between the user and the agent forms a message pair consisting of a user message and the corresponding assistant response. After every completed pair, a memory extraction process is triggered.

During this process, the system evaluates the message pair and determines whether any information within it should be converted into long term memory. The goal is to extract information that is stable over time and likely to be useful for future interactions.

A memory chunk represents a single meaningful piece of information that the system should retain. Examples of valid memory candidates include the following.

User preferences such as communication style or tone
Explicit instructions provided by the user that should persist across tasks
Information about the user's environment such as operating system, device type, or frequently used tools
Workflows or processes explained by the user that the agent may reuse later
Behavioral patterns that influence how the agent should interact with the user
Facts that the user explicitly requests the system to remember

The system must not store the entire user and assistant message pair as raw memory. Instead, the interaction must be compressed into a concise representation that preserves the important information in a minimal and structured form. Memory entries should contain only the essential detail required for future reasoning while maintaining the correct context and meaning of the information.

This compression step ensures that memory remains efficient, structured, and free of unnecessary conversational content. The goal is to retain accurate facts and instructions without storing redundant dialogue.

Memory generation must be strictly grounded in information explicitly provided by the user. The system must never fabricate or infer new details when creating memory entries. If a piece of information was not clearly stated by the user, it must not be stored as memory. Memory should always reflect what the user actually said rather than what the system assumes.

Memory must only contain information that is relatively stable. The system must avoid storing volatile or time dependent information. For example the number of files in a directory, temporary system state, or the contents of files should not be stored because these values change frequently and would quickly become incorrect.

However structural information such as the location of an important directory or a preferred workspace path can be stored because it remains relatively stable.

Memory extraction must also respect user intent. Information should never be stored if the user explicitly requests that it should not be remembered. Trivial or irrelevant details should also be ignored to avoid polluting the memory system with low value data.

For the current implementation, memory is stored locally on the user’s device inside the desktop application rather than on the backend. The desktop application acts as the memory holder and manages storage and retrieval of memory chunks.

Whenever the user sends a request, the desktop application first analyzes the request and retrieves only the relevant memory chunks that may help the agent complete the task. These memory chunks are then appended to the request before it is sent to the backend. The backend processes the request together with the attached memory context and generates a response accordingly.

The system must avoid sending the entire memory store with every request. Instead, a relevance filtering step is performed to retrieve only the memory items that are useful for the current request. This filtering can be implemented using semantic similarity through embeddings, keyword matching, text similarity, pattern matching through regular expressions, or other retrieval mechanisms. Only the most relevant memory chunks should be included in the request context.

In some cases the backend may determine that additional memory is required to complete the task. When this happens the backend can explicitly request additional memory from the desktop application. The desktop application then retrieves the requested memory items and sends them back to the backend.

The extracted memory is structured into small independent chunks so that it can be selectively retrieved later. When the agent performs reasoning for a new task, relevant memory chunks can be attached to the context to provide additional background information to the LLM. This allows the agent to behave consistently across interactions and better align with the user’s environment, preferences, and workflows.

The memory extraction logic should remain conservative. The system should prefer storing fewer high quality memory items rather than aggressively storing large amounts of low value information. This approach reduces noise and ensures that the memory layer remains useful and reliable for future reasoning.

Filesystem Knowledge Index and Retrieval System

To enable the desktop automation agent to operate intelligently within the user’s environment, the system includes a local filesystem knowledge index. This component allows the agent to discover, search, and retrieve files across the user’s machine in a structured and scalable way. The purpose of this feature is to give the agent awareness of the user’s local files so it can locate relevant resources, reference existing documents, and use file contents when reasoning about tasks.

Unlike simple directory searches, this system builds a persistent knowledge index of the user’s filesystem using a combination of file metadata indexing and semantic embeddings. This allows the agent to perform both deterministic file discovery and semantic search across file contents.

The filesystem knowledge index runs entirely locally on the user’s machine as a background subsystem of the desktop application. All indexing, embedding generation, file scanning, and update operations occur directly on the user’s device rather than on the backend infrastructure. This design is critical for system scalability. If indexing operations were performed through backend APIs, every user’s filesystem scan and embedding generation would continuously send large volumes of data to the backend, creating severe load and preventing the system from scaling effectively. By performing indexing locally, the system avoids unnecessary backend traffic and ensures that the backend remains lightweight and focused only on reasoning tasks.

When the system is first initialized, an indexing process begins by scanning selected directories within the user’s filesystem. The goal of this scan is to discover files and record their metadata in a structured storage layer maintained locally on the device. Metadata includes attributes such as the file path, file name, extension, file size, creation timestamp, last modified timestamp, and the directory in which the file resides. A content hash may also be generated to detect when files change over time.

This metadata layer allows the agent to perform fast queries for files based on attributes such as name, file type, modification date, or directory location. For example, the system can quickly locate all PDF documents, files created recently, or files with a specific name pattern. These operations rely on structured indexing rather than semantic search, which makes them extremely efficient and reliable.

In addition to metadata indexing, the system also creates a semantic understanding of file contents. For supported file types, the system extracts textual content and converts that content into embeddings using a local embedding model. This process allows the agent to perform semantic search across documents and locate files based on meaning rather than exact keywords. Because embedding generation also occurs locally on the user’s machine, the system avoids sending file contents to the backend during the indexing process.

Before embeddings are generated, extracted file content is divided into smaller segments called chunks. Chunking ensures that large documents remain manageable and allows the system to retrieve only the relevant sections of a document during search. Each chunk is embedded independently and stored together with metadata linking it back to the original file.

The embedding vectors are stored in a local vector database designed for efficient similarity search. When the agent needs to locate information, it can query the vector index to find document segments that are semantically related to the user’s request.

The retrieval system combines both metadata filtering and semantic vector search in a hybrid approach. Metadata filters help narrow the search space by identifying relevant file types or directories, while semantic similarity search identifies document segments that closely match the meaning of the user’s query. The results from these processes are merged and ranked based on relevance before being returned to the agent.

To ensure the knowledge index remains accurate over time, the system includes a filesystem watcher that continuously monitors the user’s directories for changes. The watcher detects file creation, modification, and deletion events. When a file is created, the system indexes its metadata and, if applicable, generates embeddings for its contents. When a file is modified, the corresponding metadata and embeddings are updated. When a file is deleted, its entries are removed from the index.

This event driven update mechanism ensures that the agent’s understanding of the filesystem remains synchronized with the user’s environment without requiring frequent full rescans of the disk.

The filesystem knowledge index exposes a retrieval interface that allows the agent backend to request relevant files when reasoning about a task. When the user issues a request, the desktop application first performs the search locally using the metadata index and vector database. Only the small set of relevant results or excerpts is then passed to the backend reasoning engine. This significantly reduces data transfer and prevents unnecessary backend processing.

These excerpts are then included as context in the agent’s interaction with the language model. By providing the model with targeted information from the user’s files, the system enables more accurate reasoning while avoiding the need to load entire documents into the model context.

To maintain efficiency and avoid unnecessary resource consumption, the indexing system applies several safeguards. Extremely large files are excluded from embedding generation while still being indexed at the metadata level. Binary files or unsupported formats are also excluded from content extraction. These restrictions ensure that the indexing process remains lightweight and does not degrade system performance.

Because the filesystem knowledge index operates locally on the user’s device, it preserves user privacy and does not require uploading file contents to external servers. File content never needs to leave the user’s machine during indexing. The backend receives only minimal contextual excerpts when necessary for reasoning.

This architecture ensures that the system remains scalable even as the number of users grows. Each user maintains their own local knowledge index, which distributes the computational load across client machines rather than concentrating it on centralized backend infrastructure.

This feature allows the automation agent to operate with awareness of the user’s documents and workspace. As a result, the system can locate configuration files, retrieve documents relevant to a task, and use information contained within files to guide decision making. The filesystem knowledge index therefore serves as a foundational capability that enables the agent to reason about and interact with the user’s local environment in a meaningful and scalable way.
