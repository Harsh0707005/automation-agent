import asyncio
import shlex
from dataclasses import dataclass, field

from backend.engine import LLMEngine
from backend.agent.step_executor import get_instructions, get_instructions_fallback
from backend.agent.verify import verify_step_complete
from backend.agent.recovery import get_recovery_instructions
from backend.agent.file_ops import read_file as do_read_file, write_file as do_write_file
from backend.agent.respond import generate_response, generate_workflow_summary
from backend.agent.schema import Plan, Instruction


@dataclass
class AgentSession:
    plan: Plan | None = None
    objective: str = ""
    provider: str = ""
    model: str | None = None
    context: dict | None = None
    engine: LLMEngine | None = None
    step_index: int = 0
    instruction_index: int = 0
    instructions: list[Instruction] = field(default_factory=list)
    completed_results: list[tuple[str, str]] = field(default_factory=list)
    last_read_content: str = ""
    state: str = "idle"
    pending_confirmation: asyncio.Future | None = None
    # For awaiting command results coming back from the Electron client
    pending_command_result: asyncio.Future | None = None


def _is_potentially_destructive_command(command: str) -> bool:
    """Heuristic to detect obviously destructive shell commands."""
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.strip().split()
    if not parts:
        return False
    first = parts[0].lower()
    destructive_starts = {
        "rm",
        "kill",
        "pkill",
        "killall",
        "chmod",
        "chown",
        "systemctl",
        "launchctl",
        "diskutil",
    }
    if first in destructive_starts:
        return True
    # Package managers used for installs/removals
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

    while session.step_index < len(steps):
        step = steps[session.step_index]
        if session.instruction_index == 0 or not session.instructions:
            remaining = [s.description for s in steps[session.step_index + 1 :]]
            try:
                session.instructions = await run_sync(
                    lambda: get_instructions(
                        goal=step.description,
                        objective=session.objective,
                        completed_results=session.completed_results,
                        remaining_descriptions=remaining,
                        engine=engine,
                        provider=session.provider,
                        model=session.model,
                        context=session.context,
                    )
                )
            except Exception:
                session.instructions = []
            if not session.instructions:
                session.instructions = await run_sync(lambda: get_instructions_fallback(
                    step.description, engine, session.provider, session.model,
                ))
            await send_fn({"type": "step_start", "step_id": step.id, "description": step.description})

        while session.instruction_index < len(session.instructions):
            inst = session.instructions[session.instruction_index]
            args = inst.args or {}

            if inst.tool == "run_command":
                cmd = args.get("command", "")
                if not cmd:
                    session.instruction_index += 1
                    continue
                # Backend safety net: require confirmation before obviously destructive commands
                if _is_potentially_destructive_command(cmd):
                    await send_fn({
                        "type": "confirmation_required",
                        "step_id": step.id,
                        "prompt": f"You requested to run a potentially destructive command: `{cmd}`. "
                                  "Do you approve this action? It may delete data or change system state and cannot be undone.",
                    })
                    loop = asyncio.get_event_loop()
                    session.pending_confirmation = loop.create_future()
                    approved = await session.pending_confirmation
                    session.pending_confirmation = None
                    if not approved:
                        session.state = "idle"
                        await send_fn({
                            "type": "workflow_stopped",
                            "reason": "User declined the requested command.",
                        })
                        return

                # Ask the Electron client to run this command on the user's machine.
                await send_fn({"type": "run_command_start", "command": cmd})

                loop = asyncio.get_event_loop()
                session.pending_command_result = loop.create_future()
                result = await session.pending_command_result
                session.pending_command_result = None

                # Store enough stdout for summary (8K chars) so the final summary can describe results accurately
                stdout_snap = (result["stdout"] or "")[:8000]
                session.completed_results.append(
                    (step.id, f"Ran: {cmd}\ncode={result['returncode']}\nstdout: {stdout_snap}")
                )

                run_failed = result["returncode"] != 0
                if not run_failed:
                    step_complete = await run_sync(
                        lambda: verify_step_complete(
                            step.description,
                            cmd,
                            result["stdout"],
                            result["stderr"],
                            result["returncode"],
                            engine,
                            session.provider,
                            session.model,
                        )
                    )
                    if step_complete:
                        session.step_index += 1
                        session.instruction_index = 0
                        session.instructions = []
                        await send_fn({"type": "step_complete", "step_id": step.id})
                        break
                    run_failed = True  # verify said not complete (e.g. stderr had usage/error)
                if run_failed:
                    recovery = await run_sync(
                        lambda: get_recovery_instructions(
                            step.description,
                            session.objective,
                            cmd,
                            result["stdout"],
                            result["stderr"],
                            result["returncode"],
                            session.completed_results,
                            engine,
                            session.provider,
                            session.model,
                        )
                    )
                    if recovery is None:
                        await send_fn({"type": "workflow_stopped", "reason": "Recovery aborted after failure"})
                        return
                    idx = session.instruction_index + 1
                    session.instructions = session.instructions[:idx] + recovery + session.instructions[idx:]
                    await send_fn({"type": "step_message", "message": "Adding recovery steps and continuing."})
                session.instruction_index += 1
                continue

            if inst.tool == "read_file":
                path = args.get("path", "")
                if path:
                    content, err = await run_sync(lambda: do_read_file(path))
                    if err:
                        session.completed_results.append((step.id, f"read_file {path}: {err}"))
                        await send_fn({"type": "step_message", "message": f"Could not read {path}: {err}"})
                        session.last_read_content = ""
                    else:
                        session.last_read_content = content
                        session.completed_results.append((step.id, f"Read {path}: {len(content)} chars"))
                        await send_fn({"type": "step_message", "message": f"Read {path} ({len(content)} chars)."})
                session.instruction_index += 1
                continue

            if inst.tool == "respond":
                prompt_text = args.get("prompt", "") or "Respond to the user."
                context_text = args.get("context", "") or session.last_read_content
                response = await run_sync(lambda: generate_response(
                    prompt_text, context_text or None, engine, session.provider, session.model,
                ))
                await send_fn({"type": "step_message", "message": response})
                session.completed_results.append((step.id, f"Respond: {response[:200]}..."))
                session.instruction_index += 1
                continue

            if inst.tool == "write_file":
                path = args.get("path", "")
                content = args.get("content", "")
                if path:
                    err = await run_sync(lambda: do_write_file(path, content))
                    if err:
                        await send_fn({"type": "step_message", "message": f"Write failed: {err}"})
                    else:
                        await send_fn({"type": "step_message", "message": f"Wrote {path}."})
                session.instruction_index += 1
                continue

            if inst.tool == "request_confirmation":
                prompt = args.get("prompt", "") or args.get("message", "") or ""
                # Ask the frontend to show a confirmation UI and wait for user choice
                await send_fn({
                    "type": "confirmation_required",
                    "step_id": step.id,
                    "prompt": prompt or "Do you approve this potentially destructive action?",
                })
                loop = asyncio.get_event_loop()
                session.pending_confirmation = loop.create_future()
                approved = await session.pending_confirmation
                session.pending_confirmation = None
                if not approved:
                    session.state = "idle"
                    await send_fn({
                        "type": "workflow_stopped",
                        "reason": "User declined the requested action.",
                    })
                    return
                # User approved: continue to next instruction (typically a destructive run_command)
                session.instruction_index += 1
                continue

            if inst.tool == "message":
                msg = args.get("message", "") or args.get("prompt", "") or ""
                if msg:
                    await send_fn({"type": "step_message", "message": msg})
                session.instruction_index += 1
                continue

            session.instruction_index += 1

        else:
            await send_fn({"type": "step_complete", "step_id": step.id})
            session.step_index += 1
            session.instruction_index = 0
            session.instructions = []

    session.state = "idle"
    summary = await run_sync(
        lambda: generate_workflow_summary(
            session.objective,
            session.completed_results,
            engine,
            session.provider,
            session.model,
        )
    )
    await send_fn({"type": "workflow_done", "summary": summary})
