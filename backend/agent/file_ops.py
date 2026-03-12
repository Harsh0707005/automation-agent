from pathlib import Path

MAX_FILE_SIZE = 512 * 1024


def read_file(path: str) -> tuple[str, str | None]:
    """Returns (content, None) or ("", error_message)."""
    try:
        p = Path(path).expanduser().resolve()
        if not p.exists():
            return "", f"File not found: {path}"
        if not p.is_file():
            return "", f"Not a file: {path}"
        if p.stat().st_size > MAX_FILE_SIZE:
            return "", f"File too large (max {MAX_FILE_SIZE // 1024}KB): {path}"
        return p.read_text(encoding="utf-8", errors="replace"), None
    except Exception as e:
        return "", str(e)


def write_file(path: str, content: str) -> str | None:
    """Returns None on success, or error message."""
    try:
        p = Path(path).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return None
    except Exception as e:
        return str(e)
