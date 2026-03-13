import subprocess


def run_command(command: str, timeout_seconds: int = 120) -> dict:
    """
    Run a shell command in an isolated, non-interactive subprocess.

    - stdin is disconnected from the backend terminal so that interactive prompts
      (e.g. sudo password, y/N confirmations) cannot read from or write to the
      backend's TTY.
    - stdout / stderr are always captured and returned so they can be surfaced
      to the Electron UI.
    - A new session is started so the child process is not attached to the
      main process group / terminal.
    """
    try:
        r = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            stdin=subprocess.DEVNULL,  # ensure no interaction with backend terminal
            start_new_session=True,  # detach from the server's controlling terminal
        )
        return {
            "stdout": r.stdout or "",
            "stderr": r.stderr or "",
            "returncode": r.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": "Command timed out.", "returncode": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "returncode": -1}
