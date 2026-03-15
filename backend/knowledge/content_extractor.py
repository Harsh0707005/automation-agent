import csv
import io
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".pdf", ".docx"}

MAX_EMBED_SIZE = 10 * 1024 * 1024  # 10 MB


def can_extract(file_path: str | Path) -> bool:
    return Path(file_path).suffix.lower() in SUPPORTED_EXTENSIONS


def is_too_large_for_embedding(file_path: str | Path) -> bool:
    try:
        return Path(file_path).stat().st_size > MAX_EMBED_SIZE
    except OSError:
        return True


def extract_text(file_path: str | Path) -> str | None:
    path = Path(file_path)
    ext = path.suffix.lower()

    if not path.is_file():
        return None

    try:
        if ext in (".txt", ".md"):
            return _read_plain(path)
        elif ext == ".json":
            return _read_json(path)
        elif ext in (".yaml", ".yml"):
            return _read_yaml(path)
        elif ext == ".csv":
            return _read_csv(path)
        elif ext == ".pdf":
            return _read_pdf(path)
        elif ext == ".docx":
            return _read_docx(path)
    except Exception as e:
        logger.warning("Failed to extract text from %s: %s", file_path, e)
    return None


def _read_plain(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _read_json(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    return json.dumps(data, indent=2, ensure_ascii=False)


def _read_yaml(path: Path) -> str:
    try:
        import yaml
    except ImportError:
        return path.read_text(encoding="utf-8", errors="replace")
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        data = yaml.safe_load(f)
    return yaml.dump(data, default_flow_style=False, allow_unicode=True)


def _read_csv(path: Path) -> str:
    lines: list[str] = []
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            lines.append(", ".join(row))
            if i >= 5000:
                break
    return "\n".join(lines)


def _read_pdf(path: Path) -> str | None:
    try:
        import pypdf
    except ImportError:
        logger.debug("pypdf not installed, skipping PDF extraction for %s", path)
        return None
    reader = pypdf.PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n\n".join(pages).strip()
    return text if text else None


def _read_docx(path: Path) -> str | None:
    try:
        import docx
    except ImportError:
        logger.debug("python-docx not installed, skipping DOCX extraction for %s", path)
        return None
    doc = docx.Document(str(path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    text = "\n".join(paragraphs).strip()
    return text if text else None
