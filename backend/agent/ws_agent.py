import asyncio
import shlex
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any

from backend.engine import LLMEngine
from backend.agent.step_executor import get_instructions, get_instructions_fallback
from backend.agent.verify import verify_step_complete
from backend.agent.recovery import get_recovery_instructions
from backend.agent.file_ops import read_file as do_read_file, write_file as do_write_file
from backend.agent.respond import (
    generate_response,
    generate_workflow_summary,
    is_reply_only_workflow,
    get_reply_only_preview,
)
from backend.agent.schema import Plan, Instruction


@dataclass
class AgentSession:
    plan: Plan | None = None
    objective: str = ""
    provider: str = ""
    model: str | None = None
    context: dict | None = None
    engine: LLMEngine | None = None
    knowledge_service: Any = None  # KnowledgeIndexService instance (optional)
    # Legacy sequential-executor fields (kept for compat, not used by parallel executor)
    step_index: int = 0
    instruction_index: int = 0
    instructions: list[Instruction] = field(default_factory=list)
    completed_results: list[tuple[str, str]] = field(default_factory=list)
    last_read_content: str = ""
    state: str = "idle"
    # Interaction futures (one at a time, serialized by interact_lock)
    pending_confirmation: asyncio.Future | None = None
    pending_user_input: asyncio.Future | None = None
    # Parallel command futures: cmd_id -> Future
    pending_command_results: dict = field(default_factory=dict)
    # Persistent across runs
    conversation_history: list[dict] = field(default_factory=list)
    last_summary: str = ""


def _snapshot_paths_for_command(command: str) -> list[str]:
    """
    For commands that destroy or overwrite files (rm, mv, etc.), return the
    absolute paths of files that should be snapshotted before execution.
    Only regular files are included — directories are skipped.
    """
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.strip().split()
    if not parts:
        return []

    verb = parts[0].lower()
    candidates: list[str] = []

    if verb == "rm":
        # Collect all non-flag arguments after 'rm'
        for part in parts[1:]:
            if part.startswith("-"):
                continue
            candidates.append(part)
    elif verb == "mv":
        # Source is the second-to-last argument (last is destination)
        non_flags = [p for p in parts[1:] if not p.startswith("-")]
        if len(non_flags) >= 2:
            candidates.append(non_flags[0])  # snapshot the source file

    paths = []
    for raw in candidates:
        try:
            resolved = Path(raw).expanduser().resolve()
            if resolved.is_file():
                paths.append(str(resolved))
        except Exception:
            pass
    return paths


def _is_potentially_destructive_command(command: str) -> bool:
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.strip().split()
    if not parts:
        return False
    first = parts[0].lower()
    destructive_starts = {
        "rm", "kill", "pkill", "killall", "chown",
        "systemctl", "launchctl", "diskutil",
    }
    if first in destructive_starts:
        return True
    if first in {"apt", "apt-get", "brew", "pip", "pip3", "conda"} and len(parts) > 1:
        sub = parts[1].lower()
        if any(x in sub for x in ["install", "remove", "uninstall", "purge"]):
            return True
    return False


async def run_agent_ws(send_fn, session: AgentSession):
    loop = asyncio.get_event_loop()

    def run_sync(f):
        return loop.run_in_executor(None, f)

    engine = session.engine or LLMEngine()
    steps = session.plan.steps

    # ── Shared parallel-execution state ──────────────────────────────────────
    completed_step_ids: set[str] = set()
    results_lock = asyncio.Lock()       # protects session.completed_results appends
    interact_lock = asyncio.Lock()      # serializes confirmation / ask_user dialogs
    stop_event = asyncio.Event()        # set by any step that needs to halt execution
    cmd_counter: list[int] = [0]

    def next_cmd_id(step_id: str) -> str:
        cmd_counter[0] += 1
        return f"{step_id}_{cmd_counter[0]}"

    # ── Single step executor ──────────────────────────────────────────────────

    async def run_step(step) -> bool:
        """Execute one plan step. Returns True on success, False on stop/failure."""
        try:
            if stop_event.is_set() or getattr(session, "cancelled", False):
                return False

            remaining = [
                s.description for s in steps
                if s.id not in completed_step_ids and s.id != step.id
            ]

            try:
                instructions = await run_sync(
                    lambda: get_instructions(
                        goal=step.description,
                        objective=session.objective,
                        completed_results=list(session.completed_results),
                        remaining_descriptions=remaining,
                        engine=engine,
                        provider=session.provider,
                        model=session.model,
                        context=session.context,
                        conversation_history=list(session.conversation_history),
                    )
                )
            except Exception:
                instructions = []

            if not instructions:
                instructions = await run_sync(
                    lambda: get_instructions_fallback(
                        step.description, engine, session.provider, session.model
                    )
                )

            await send_fn({"type": "step_start", "step_id": step.id, "description": step.description})

            inst_idx = 0
            while inst_idx < len(instructions):
                if stop_event.is_set() or getattr(session, "cancelled", False):
                    return False

                inst = instructions[inst_idx]
                args = inst.args or {}

                # ── run_command ───────────────────────────────────────────────
                if inst.tool == "run_command":
                    cmd = args.get("command", "")
                    if not cmd:
                        inst_idx += 1
                        continue

                    # Destructive-command confirmation (serialized so dialogs never overlap)
                    if _is_potentially_destructive_command(cmd):
                        conf_cmd_id = next_cmd_id(step.id)
                        async with interact_lock:
                            if stop_event.is_set():
                                return False
                            await send_fn({
                                "type": "confirmation_required",
                                "step_id": step.id,
                                "cmd_id": conf_cmd_id,
                                "prompt": (
                                    f"You requested to run a potentially destructive command: `{cmd}`. "
                                    "Do you approve this action? It may delete data or change system "
                                    "state and cannot be undone."
                                ),
                            })
                            conf_fut = loop.create_future()
                            session.pending_confirmation = conf_fut
                            approved = await conf_fut
                            session.pending_confirmation = None

                        if not approved:
                            stop_event.set()
                            for f in list(session.pending_command_results.values()):
                                if not f.done():
                                    f.cancel()
                            await send_fn({
                                "type": "workflow_stopped",
                                "reason": "User declined the requested command.",
                            })
                            return False

                    # Snapshot any files that this command would destroy/overwrite
                    # so the renderer can offer a revert action later.
                    snap_paths = _snapshot_paths_for_command(cmd)
                    for snap_path in snap_paths:
                        _p = snap_path  # bind loop variable for lambda capture
                        snap_content, snap_err = await run_sync(lambda: do_read_file(_p))
                        if snap_err is None:
                            await send_fn({
                                "type": "file_snapshot",
                                "path": snap_path,
                                "original_content": snap_content,
                                "existed": True,
                            })

                    # Run the command on the client machine
                    cmd_id = next_cmd_id(step.id)
                    cmd_fut = loop.create_future()
                    session.pending_command_results[cmd_id] = cmd_fut
                    await send_fn({"type": "run_command_start", "cmd_id": cmd_id, "command": cmd})

                    try:
                        result = await cmd_fut
                    except asyncio.CancelledError:
                        return False
                    finally:
                        session.pending_command_results.pop(cmd_id, None)

                    if stop_event.is_set() or getattr(session, "cancelled", False):
                        return False

                    stdout_snap = (result.get("stdout") or "")[:8000]
                    async with results_lock:
                        session.completed_results.append(
                            (step.id, f"Ran: {cmd}\ncode={result.get('returncode', 0)}\nstdout: {stdout_snap}")
                        )

                    run_failed = result.get("returncode", 0) != 0
                    if not run_failed:
                        step_complete = await run_sync(
                            lambda: verify_step_complete(
                                step.description, cmd,
                                result.get("stdout", ""), result.get("stderr", ""),
                                result.get("returncode", 0),
                                engine, session.provider, session.model,
                            )
                        )
                        if step_complete:
                            await send_fn({"type": "step_complete", "step_id": step.id})
                            return True
                        run_failed = True

                    if run_failed:
                        recovery = await run_sync(
                            lambda: get_recovery_instructions(
                                step.description, session.objective, cmd,
                                result.get("stdout", ""), result.get("stderr", ""),
                                result.get("returncode", 0),
                                session.completed_results, engine, session.provider, session.model,
                            )
                        )
                        if recovery is None:
                            # Only this step fails — do NOT touch stop_event so sibling parallel
                            # steps continue unaffected.
                            await send_fn({
                                "type": "step_failed",
                                "step_id": step.id,
                                "reason": "Could not recover from command failure.",
                            })
                            return False
                        idx = inst_idx + 1
                        instructions = instructions[:idx] + recovery + instructions[idx:]
                        await send_fn({"type": "step_message", "message": "Adding recovery steps and continuing."})

                    inst_idx += 1
                    continue

                # ── read_file ─────────────────────────────────────────────────
                if inst.tool == "read_file":
                    path_val = args.get("path", "")
                    if path_val:
                        content, err = await run_sync(lambda: do_read_file(path_val))
                        if err:
                            async with results_lock:
                                session.completed_results.append((step.id, f"read_file {path_val}: {err}"))
                            await send_fn({"type": "step_message", "message": f"Could not read {path_val}: {err}"})
                            session.last_read_content = ""
                        else:
                            session.last_read_content = content
                            async with results_lock:
                                session.completed_results.append((step.id, f"Read {path_val}: {len(content)} chars"))
                            await send_fn({"type": "step_message", "message": f"Read {path_val} ({len(content)} chars)."})
                    inst_idx += 1
                    continue

                # ── respond ───────────────────────────────────────────────────
                if inst.tool == "respond":
                    prompt_text = args.get("prompt", "") or "Respond to the user."
                    context_text = args.get("context", "") or session.last_read_content
                    memory = (session.context or {}).get("user_memory", "")
                    if memory:
                        context_text = f"{context_text}\n\nUser memory: {memory}".strip() if context_text else f"User memory: {memory}"
                    knowledge = (session.context or {}).get("knowledge_context", "")
                    if knowledge:
                        knowledge_snippet = str(knowledge)[:2000]
                        context_text = f"{context_text}\n\nRelevant files from filesystem:\n{knowledge_snippet}".strip() if context_text else f"Relevant files from filesystem:\n{knowledge_snippet}"
                    response = await run_sync(
                        lambda: generate_response(
                            prompt_text, context_text or None, engine, session.provider, session.model
                        )
                    )
                    await send_fn({"type": "step_message", "message": response})
                    async with results_lock:
                        session.completed_results.append((step.id, f"Respond: {response[:200]}..."))
                    inst_idx += 1
                    continue

                # ── write_file ────────────────────────────────────────────────
                if inst.tool == "write_file":
                    path_val = args.get("path", "")
                    content = args.get("content", "")
                    if path_val:
                        # Snapshot the current file state before overwriting so the
                        # renderer can offer a revert action.
                        snap_content, snap_err = await run_sync(lambda: do_read_file(path_val))
                        existed = snap_err is None
                        try:
                            resolved_path = str(Path(path_val).expanduser().resolve())
                        except Exception:
                            resolved_path = path_val
                        await send_fn({
                            "type": "file_snapshot",
                            "path": resolved_path,
                            "original_content": snap_content if existed else "",
                            "existed": existed,
                        })
                        err = await run_sync(lambda: do_write_file(path_val, content))
                        if err:
                            await send_fn({"type": "step_message", "message": f"Write failed: {err}"})
                        else:
                            await send_fn({"type": "step_message", "message": f"Wrote {path_val}."})
                    inst_idx += 1
                    continue

                # ── request_confirmation ──────────────────────────────────────
                if inst.tool == "request_confirmation":
                    prompt = args.get("prompt", "") or args.get("message", "") or ""
                    conf_cmd_id = next_cmd_id(step.id)
                    async with interact_lock:
                        if stop_event.is_set():
                            return False
                        await send_fn({
                            "type": "confirmation_required",
                            "step_id": step.id,
                            "cmd_id": conf_cmd_id,
                            "prompt": prompt or "Do you approve this potentially destructive action?",
                        })
                        conf_fut = loop.create_future()
                        session.pending_confirmation = conf_fut
                        approved = await conf_fut
                        session.pending_confirmation = None

                    if not approved:
                        stop_event.set()
                        for f in list(session.pending_command_results.values()):
                            if not f.done():
                                f.cancel()
                        await send_fn({
                            "type": "workflow_stopped",
                            "reason": "User declined the requested action.",
                        })
                        return False
                    inst_idx += 1
                    continue

                # ── message ───────────────────────────────────────────────────
                if inst.tool == "message":
                    msg_text = args.get("message", "") or args.get("prompt", "") or ""
                    if msg_text:
                        await send_fn({"type": "step_message", "message": msg_text})
                    inst_idx += 1
                    continue

                # ── search_files ──────────────────────────────────────────────
                if inst.tool == "search_files":
                    query = args.get("query", "")
                    if query and session.knowledge_service is not None:
                        search_kwargs = {"query": query, "top_k": args.get("top_k") or 10}
                        if args.get("directories"):
                            search_kwargs["directories"] = args["directories"]
                        elif (session.context or {}).get("allowed_search_dirs"):
                            search_kwargs["directories"] = session.context["allowed_search_dirs"]
                        if args.get("extensions"):
                            search_kwargs["extensions"] = args["extensions"]
                        if args.get("recency_days") is not None:
                            search_kwargs["recency_days"] = args["recency_days"]

                        # Stream search progress to the user in real-time
                        import queue as _queue
                        progress_q: _queue.Queue = _queue.Queue()

                        def _on_search_progress(msg: str):
                            progress_q.put(msg)

                        search_kwargs["on_progress"] = _on_search_progress

                        # Run search in thread, drain progress messages concurrently
                        search_future = loop.run_in_executor(
                            None,
                            lambda: session.knowledge_service.layered_search(**search_kwargs),
                        )

                        # Poll progress queue while search runs
                        results = None
                        while results is None:
                            done = search_future.done()
                            while not progress_q.empty():
                                try:
                                    pmsg = progress_q.get_nowait()
                                    await send_fn({"type": "step_message", "message": f"🔍 {pmsg}"})
                                except _queue.Empty:
                                    break
                            if done:
                                try:
                                    results = search_future.result()
                                except Exception as e:
                                    results = []
                                    await send_fn({"type": "step_message", "message": f"File search error: {e}"})
                                break
                            await asyncio.sleep(0.15)

                        # Drain any remaining progress messages
                        while not progress_q.empty():
                            try:
                                pmsg = progress_q.get_nowait()
                                await send_fn({"type": "step_message", "message": f"🔍 {pmsg}"})
                            except _queue.Empty:
                                break

                        if results:
                            result_lines = []
                            for r in results:
                                line = f"  {r.file_path} (score={r.score:.2f}, source={r.source})"
                                if r.excerpt:
                                    line += f"\n    excerpt: {r.excerpt[:150]}"
                                result_lines.append(line)
                            result_text = f"Search for '{query}' found {len(results)} results:\n" + "\n".join(result_lines)
                        else:
                            result_text = f"Search for '{query}' found no results."

                        async with results_lock:
                            session.completed_results.append((step.id, result_text))
                        await send_fn({"type": "step_message", "message": result_text})
                    elif not session.knowledge_service:
                        msg_text = "File search is not available (knowledge index not initialized)."
                        async with results_lock:
                            session.completed_results.append((step.id, msg_text))
                        await send_fn({"type": "step_message", "message": msg_text})
                    inst_idx += 1
                    continue

                # ── ask_user ──────────────────────────────────────────────────
                if inst.tool == "ask_user":
                    question = args.get("question", "") or "I need some information to continue."
                    options = args.get("options") or []
                    async with interact_lock:
                        if stop_event.is_set():
                            return False
                        await send_fn({
                            "type": "ask_user_required",
                            "step_id": step.id,
                            "question": question,
                            "options": options,
                        })
                        user_fut = loop.create_future()
                        session.pending_user_input = user_fut
                        answer = await user_fut
                        session.pending_user_input = None
                    async with results_lock:
                        session.completed_results.append((step.id, f"User provided: {answer}"))
                    inst_idx += 1
                    continue

                inst_idx += 1

            # All instructions completed normally
            await send_fn({"type": "step_complete", "step_id": step.id})
            return True

        except asyncio.CancelledError:
            return False
        except Exception as e:
            # Step-level exception: report as step_failed, not as a global error.
            # stop_event is not set so sibling parallel steps continue unaffected.
            if not stop_event.is_set() and not getattr(session, "cancelled", False):
                await send_fn({
                    "type": "step_failed",
                    "step_id": step.id,
                    "reason": str(e),
                })
            return False

    # ── DAG execution loop ────────────────────────────────────────────────────
    # failed_step_ids: steps whose own execution failed (unrelated to user stop).
    # Their dependents are skipped, but sibling steps in the same or future waves
    # continue running normally.
    failed_step_ids: set[str] = set()

    while True:
        if stop_event.is_set() or getattr(session, "cancelled", False):
            return

        accounted_for = completed_step_ids | failed_step_ids
        if len(accounted_for) == len(steps):
            break  # Every step has been resolved one way or another

        # Steps eligible this wave:
        #   • not yet resolved
        #   • ALL deps are in completed_step_ids (not just accounted_for — a failed dep blocks)
        #   • NO dep is in failed_step_ids (permanently blocked if any dep failed)
        ready = [
            s for s in steps
            if s.id not in accounted_for
            and all(dep in completed_step_ids for dep in s.depends_on)
            and not any(dep in failed_step_ids for dep in s.depends_on)
        ]

        if not ready:
            # Any unresolved steps left are permanently blocked by failed dependencies.
            still_unresolved = [s for s in steps if s.id not in accounted_for]
            for blocked in still_unresolved:
                await send_fn({
                    "type": "step_failed",
                    "step_id": blocked.id,
                    "reason": "Skipped: a required earlier step failed.",
                })
                failed_step_ids.add(blocked.id)
            break

        if len(ready) > 1:
            parallel_ids = ", ".join(s.id for s in ready)
            await send_fn({"type": "step_message", "message": f"Running steps {parallel_ids} in parallel."})

        # Run all ready steps concurrently; each has its own recovery cycle.
        task_results = await asyncio.gather(
            *[run_step(s) for s in ready],
            return_exceptions=True,
        )

        # If the user stopped mid-wave, bail immediately.
        if stop_event.is_set() or getattr(session, "cancelled", False):
            return

        for step, result in zip(ready, task_results):
            if result is True:
                completed_step_ids.add(step.id)
            else:
                failed_step_ids.add(step.id)
        # Loop continues — independent future steps still run.

    # ── Final summary ─────────────────────────────────────────────────────────
    session.state = "idle"
    if is_reply_only_workflow(session.completed_results):
        # No LLM summary for pure reply-from-memory; avoid redundant "Result: Responded with..."
        summary = ""
        reply_preview = get_reply_only_preview(session.completed_results)
        session.last_summary = reply_preview or ""
        await send_fn({"type": "workflow_done", "summary": summary, "reply_preview": reply_preview or None})
    else:
        summary = await run_sync(
            lambda: generate_workflow_summary(
                session.objective,
                session.completed_results,
                engine,
                session.provider,
                session.model,
            )
        )
        session.last_summary = summary
        await send_fn({"type": "workflow_done", "summary": summary})
