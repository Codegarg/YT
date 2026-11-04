"""Pure, offline prompt-hardening helpers (no network, no LLM, no file I/O).

Internal asset identifiers (#BGD-*, @CHAR-*) and raw pipeline UUIDs must never
reach Google Flow as visual content: Flow can otherwise render them as labels,
tag cards, or text. This module is the single shared, deterministic
implementation used by both the authoritative prompt builder
(``one_minute.make_prompts``) and the parser fallbacks (``parsers``), so prompt
text stays consistent no matter which path produced it.

Nothing here invents replacement content; it only removes internal identifiers.
"""
from __future__ import annotations

import re

# Canonical internal tags from the pipeline schema.
_CHARACTER_TAG = re.compile(r"@CHAR-\d{2}-[A-Za-z][A-Za-z0-9-]*")
_BACKGROUND_TAG = re.compile(r"#BGD-\d{2}-[A-Za-z][A-Za-z0-9-]*")
# Defensive catch for residual/malformed @CHAR-/ #BGD- tokens.
_RESIDUAL_TAG = re.compile(r"[@#](?:CHAR|BGD)-[A-Za-z0-9-]+")
# Raw pipeline/Flow UUIDs are identifiers, never visual content.
_UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
# Delimiter pairs left empty once a tag inside them is removed, e.g. "[#BGD-01-X]".
_EMPTY_PAIRS = re.compile(r"([\[\(\{])\s*([\]\)\}])")
_MULTISPACE = re.compile(r"[ \t]{2,}")


def _has_internal_identifier(text: str) -> bool:
    return bool(
        _UUID.search(text)
        or _CHARACTER_TAG.search(text)
        or _BACKGROUND_TAG.search(text)
        or _RESIDUAL_TAG.search(text)
    )


def strip_internal_tags(text: str) -> str:
    """Remove internal asset tags and raw UUIDs from prompt text.

    Deterministic and idempotent: text that contains no internal identifier is
    returned unchanged (so existing clean prompts keep byte-for-byte identity).
    """
    if not text:
        return text
    value = str(text)
    if not _has_internal_identifier(value):
        return text
    value = _UUID.sub("", value)
    value = _CHARACTER_TAG.sub("", value)
    value = _BACKGROUND_TAG.sub("", value)
    value = _RESIDUAL_TAG.sub("", value)
    value = _EMPTY_PAIRS.sub("", value)
    value = _MULTISPACE.sub(" ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value


def contains_internal_tag(text: str) -> bool:
    """True when prompt text still exposes an internal asset tag or UUID (audits/tests)."""
    if not text:
        return False
    return _has_internal_identifier(str(text))
