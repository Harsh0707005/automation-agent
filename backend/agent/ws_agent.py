import asyncio
from dataclasses import dataclass, field

from backend.engine import LLMEngine
from backend.agent.step_executor import get_instructions, get_instructions_fallback
from backend.agent.command_runner import run_command
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
                session.instructions = await run_sync(lambda: get_instructions(
                    step.description,
                    session.objective,
                    session.completed_results,
                    remaining,
                    engine,
                    session.provider,
                    session.model,
                ))
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
                await send_fn({"type": "run_command_start", "command": cmd})
                result = await run_sync(lambda: run_command(cmd))
                await send_fn({
                    "type": "command_result",
                    "stdout": result["stdout"],
                    "stderr": result["stderr"],
                    "returncode": result["returncode"],
                })
                # Store enough stdout for summary (8K chars) so the final summary can describe results accurately
                stdout_snap = (result["stdout"] or "")[:8000]
                session.completed_results.append((step.id, f"Ran: {cmd}\ncode={result['returncode']}\nstdout: {stdout_snap}"))

                run_failed = result["returncode"] != 0
                if not run_failed:
                    step_complete = await run_sync(lambda: verify_step_complete(
                        step.description, cmd, result["stdout"], result["stderr"], result["returncode"],
                        engine, session.provider, session.model,
                    ))
                    if step_complete:
                        session.step_index += 1
                        session.instruction_index = 0
                        session.instructions = []
                        await send_fn({"type": "step_complete", "step_id": step.id})
                        break
                    run_failed = True  # verify said not complete (e.g. stderr had usage/error)
                if run_failed:
                    recovery = await run_sync(lambda: get_recovery_instructions(
                        step.description, session.objective, cmd,
                        result["stdout"], result["stderr"], result["returncode"],
                        session.completed_results, engine, session.provider, session.model,
                    ))
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

            if inst.tool == "request_confirmation" or inst.tool == "message":
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
    summary = await run_sync(lambda: generate_workflow_summary(
        session.objective, session.completed_results, engine, session.provider, session.model,
    ))
    await send_fn({"type": "workflow_done", "summary": summary})
