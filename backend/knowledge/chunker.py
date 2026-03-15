from dataclasses import dataclass

TARGET_CHUNK_CHARS = 2000  # ~500 tokens
MAX_CHUNK_CHARS = 4000    # ~1000 tokens
OVERLAP_CHARS = 200


@dataclass
class TextChunk:
    text: str
    chunk_index: int
    start_char: int
    end_char: int


def chunk_text(
    text: str,
    target_size: int = TARGET_CHUNK_CHARS,
    max_size: int = MAX_CHUNK_CHARS,
    overlap: int = OVERLAP_CHARS,
) -> list[TextChunk]:
    if not text or not text.strip():
        return []

    if len(text) <= max_size:
        return [TextChunk(text=text.strip(), chunk_index=0, start_char=0, end_char=len(text))]

    chunks: list[TextChunk] = []
    start = 0
    idx = 0

    while start < len(text):
        end = min(start + target_size, len(text))

        if end < len(text):
            # Try to break at paragraph, then sentence, then word boundary
            candidate = text[start:min(start + max_size, len(text))]
            break_pos = _find_break(candidate, target_size)
            end = start + break_pos

        chunk_text_str = text[start:end].strip()
        if chunk_text_str:
            chunks.append(TextChunk(
                text=chunk_text_str,
                chunk_index=idx,
                start_char=start,
                end_char=end,
            ))
            idx += 1

        start = max(end - overlap, start + 1)

    return chunks


def _find_break(text: str, target: int) -> int:
    """Find best break position near target within text."""
    # Paragraph break
    pos = text.rfind("\n\n", 0, target + 200)
    if pos > target // 2:
        return pos + 2

    # Single newline
    pos = text.rfind("\n", 0, target + 100)
    if pos > target // 2:
        return pos + 1

    # Sentence ending
    for sep in (". ", "! ", "? "):
        pos = text.rfind(sep, 0, target + 100)
        if pos > target // 2:
            return pos + len(sep)

    # Word boundary
    pos = text.rfind(" ", 0, target + 50)
    if pos > target // 2:
        return pos + 1

    return target
