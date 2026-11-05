"""AI-powered YouTube SEO engine for RAAT KA KHAUF (offline-testable, publish-free).

WHAT THIS MODULE DOES
Turns a finished story project (`pipeline.json`) into a reviewable, versioned SEO package:

    <project dir>/seo/seo-package.json      machine-readable package
    <project dir>/seo/seo-package.md        human review document
    <project dir>/seo/youtube-metadata.json optional title/description/tags mapping
    <project dir>/seo/raw/attempt-*.txt     raw model output (audit trail)
    <project dir>/seo/history/*.json|md     archived packages on regeneration

WHAT IT NEVER DOES
  · no network calls of its own (the injected text client is the only transport),
  · no upload, no presign, no Zernio, no YouTube, no publishing, no scheduling,
  · no writes outside the project's `seo/` directory,
  · no modification of `pipeline.json`, approval records, or any media,
  · no invented search volume / difficulty / ranking / traffic figures,
  · no timestamp invention (the story data has no reliable timings).

DESIGN
Story facts are extracted deterministically from the pipeline and given to the writing
model as the ONLY permitted source of truth. The model returns one JSON object, which is
then normalized, filtered, and validated deterministically. Anything that cannot be
verified is either dropped (with a warning) or rejected (with a bounded repair retry).
A failed generation writes NO package, so a caller can never mistake a failure for success.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from . import prompts
from .paths import resolve_projects_root
from .seo_keywords import (
    CHANNEL_PROFILE,
    ENGINE_VERSION as KEYWORD_ENGINE_VERSION,
    PRIORITY_BASIS,
    build_keyword_plan,
    content_policy,
    fiction_claims,
    hashtag_is_relevant,
    hashtag_key,
    keywords_for_grounding,
    narrative_vocabulary,
    normalize_key,
    schedule_claims,
    unknown_tokens,
    upload_schedule,
    words_for_grounding,
)

SEO_SCHEMA_VERSION = 1
ENGINE_VERSION = "1.2.0"

SEO_DIR_NAME = "seo"
PACKAGE_JSON_NAME = "seo-package.json"
PACKAGE_MD_NAME = "seo-package.md"
METADATA_JSON_NAME = "youtube-metadata.json"
RAW_DIR_NAME = "raw"
HISTORY_DIR_NAME = "history"
EDITORIAL_FILE_NAME = "seo-editorial.json"

# Platform limits used by the deterministic validator.
TITLE_MAX_CHARS = 100
DESCRIPTION_MAX_CHARS = 5000
DESCRIPTION_MIN_CHARS = 300
TAGS_COMBINED_MAX_CHARS = 500
TAG_MAX_CHARS = 30
TAGS_MIN_COUNT = 8
HASHTAG_MIN_COUNT = 3
HASHTAG_MAX_COUNT = 8
HASHTAG_MAX_BODY_CHARS = 40  # YouTube's per-hashtag limit, excluding the leading '#'
SHORTS_COUNT = 3
THUMBNAIL_TEXT_MAX_WORDS = 8
THUMBNAIL_TEXT_MIN_WORDS = 2
THUMBNAIL_TEXT_SOFT_MAX_WORDS = 5
PINNED_COMMENT_MAX_CHARS = 600

DEFAULT_MAX_ATTEMPTS = 3
HARD_MAX_ATTEMPTS = 5
PROMPT_MAX_TOKENS = 7000

_TIMESTAMP_RE = re.compile(r"\b\d{1,2}\s*:\s*\d{2}\b")
_DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")
_HASHTAG_RE = re.compile(r"^#[\u0900-\u097FA-Za-z0-9_]{2,40}$")
_DIGIT_RE = re.compile(r"\d+")
_DEVANAGARI_DIGITS = "०१२३४५६७८९"
_ASCII_DIGITS = "0123456789"
_SUBSCRIBE_RE = re.compile(r"सब्सक्राइब|subscribe|सब्सक्राइबर|जुड़|जॉइन", re.I)
_CTA_FULL_STORY_RE = re.compile(r"पूरी\s*कहानी|पूरा\s*वीडियो|full\s*story|full\s*video", re.I)
_FICTION_DISCLOSURE_RE = re.compile(
    r"काल्पनिक|कल्पना\s+पर\s+आधारित|मनोरंजन\s+के\s+लिए|fiction|fictional|entertainment", re.I
)
_PINNED_GENERIC_FILLER = (
    "अपनी कहानी हमारे साथ साझा करें",
    "अपनी कहानी साझा करें",
    "share your story with us",
    "अपने अनुभव हमारे साथ साझा करें",
)
# Language a thumbnail image prompt may legitimately use. Anything else in a *capitalised*
# position is treated as a proper noun, i.e. a character or place the story never contains.
_THUMBNAIL_PROMPT_VOCABULARY = {
    "2d", "semi", "realistic", "realism", "cartoon", "horror", "thumbnail", "cinematic", "poster",
    "style", "bold", "clean", "outline", "outlines", "flat", "cel", "shading", "shadow",
    "vignette", "saturation", "saturated", "contrast", "lighting", "moonlight", "ambient", "glow",
    "glowing", "dramatic", "close", "portrait", "wide", "angle", "composition", "texture",
    "textured", "grain", "colour", "color", "colors", "colours", "palette", "scene", "background",
    "foreground", "subject", "focal", "mobile", "readable", "readability", "indian", "hindi",
    "village", "night", "dark", "cold", "blue", "red", "white", "black", "orange", "grey", "gray",
    "no", "without", "watermark", "logo", "text", "overlay", "aspect", "ratio", "ar", "high",
    "detailed", "intense", "moody", "atmospheric", "cinematic", "photorealistic", "stylised",
    "stylized", "horror", "haunting", "eerie", "ominous", "terrifying", "scary", "spooky",
}


# ---------------------------------------------------------------------------------------
# Errors (each carries the CLI exit code it should produce)
# ---------------------------------------------------------------------------------------
class SeoError(Exception):
    """Base class. `code` is the intended process exit code."""

    code = 1

    def __init__(self, message: str, details: list[str] | None = None):
        super().__init__(message)
        self.details = list(details or [])


class SeoInputError(SeoError):
    """The project cannot produce an SEO package (missing story/validation data)."""

    code = 1


class SeoRefusedError(SeoError):
    """A package already exists and regeneration was not explicitly requested."""

    code = 3


class SeoGenerationError(SeoError):
    """The model output could not be validated within the bounded attempt budget."""

    code = 1


# ---------------------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------------------
def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _text(value) -> str:
    return value if isinstance(value, str) else ""


def _clean(value) -> str:
    """Collapse all whitespace (single-line fields). Unicode-safe, no transliteration."""
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _clean_block(value) -> str:
    """Normalize a multi-line field while preserving its line structure."""
    raw = unicodedata.normalize("NFC", str(value or "").replace("\r\n", "\n").replace("\r", "\n"))
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw.split("\n")]
    out: list[str] = []
    for line in lines:
        if not line and out and not out[-1]:
            continue
        out.append(line)
    return "\n".join(out).strip()


def _chars(value: str) -> int:
    """Character count in Unicode code points (what YouTube counts for Hindi text)."""
    return len(str(value or ""))


def _ascii_digits(value: str) -> str:
    return str(value or "").translate(str.maketrans(_DEVANAGARI_DIGITS, _ASCII_DIGITS))


def _digit_runs(value: str) -> set[str]:
    return set(_DIGIT_RE.findall(_ascii_digits(value)))


def _dedupe(values: list[str], key=lambda item: item) -> tuple[list[str], int]:
    seen: set[str] = set()
    out: list[str] = []
    removed = 0
    for value in values:
        marker = key(value)
        if marker in seen:
            removed += 1
            continue
        seen.add(marker)
        out.append(value)
    return out, removed


def _as_str_list(value) -> list[str]:
    if isinstance(value, str):
        return [part for part in re.split(r"[,\n]", value)]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def _first_sentence(value: str, fallback: str, limit: int = 240) -> str:
    text = _clean(value)
    if not text:
        return fallback
    match = re.match(r"^(.*?[।.!?])\s", text)
    sentence = match.group(1) if match else text
    return sentence[:limit].strip()


def _write_bytes_atomic(path: Path, data: bytes) -> None:
    """Write bytes atomically, preserving the input's line endings and byte length."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, path)


def _write_text_atomic(path: Path, text: str) -> None:
    """Write UTF-8 with a fixed LF newline so recorded SHA-256 hashes are portable.

    `Path.write_text` translates every "\\n" to "\\r\\n" on Windows, which would make the
    hash recorded inside the metadata mapping differ from the hash of the file on disk.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------------------
# Story extraction (deterministic, read-only)
# ---------------------------------------------------------------------------------------
_ACT_RE = re.compile(r"(?m)^#{2,4}\s*Act\s*(\d+)\s*[–—\-:]\s*(.+?)\s*$")
_TITLE_LINE_RE = re.compile(r"(?m)^\*\*Title:\*\*\s*\n?\s*(.+)$")
_TAGLINE_LINE_RE = re.compile(r"(?m)^\*\*Tagline:\*\*\s*\n?\s*(.+)$")


def _scenes_of(project: dict) -> list[dict]:
    scenes = project.get("scenes")
    return scenes if isinstance(scenes, list) else []


def _characters_of(project: dict) -> list[dict]:
    characters = project.get("characters")
    return characters if isinstance(characters, list) else []


def _backgrounds_of(project: dict) -> list[dict]:
    backgrounds = project.get("backgrounds")
    return backgrounds if isinstance(backgrounds, list) else []


def _story_title(project: dict) -> str:
    idea = project.get("idea") or {}
    selected = idea.get("selected") if isinstance(idea, dict) else None
    if isinstance(selected, dict) and _clean(selected.get("title")):
        return _clean(selected.get("title"))
    script = project.get("script") or {}
    match = _TITLE_LINE_RE.search(_text(script.get("raw_text")))
    return _clean(match.group(1)) if match else ""


def _story_hook(project: dict) -> str:
    idea = project.get("idea") or {}
    selected = idea.get("selected") if isinstance(idea, dict) else None
    if isinstance(selected, dict) and _clean(selected.get("hook")):
        return _clean(selected.get("hook"))
    script = project.get("script") or {}
    match = _TAGLINE_LINE_RE.search(_text(script.get("raw_text")))
    return _clean(match.group(1)) if match else ""


def _act_beats(script_text: str) -> list[dict]:
    matches = list(_ACT_RE.finditer(script_text or ""))
    beats: list[dict] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(script_text)
        body = script_text[start:end].strip()
        first = next((line.strip() for line in body.split("\n") if line.strip()), "")
        beats.append({
            "act": int(match.group(1)),
            "name": _clean(match.group(2)),
            "beat": _clean(re.sub(r"\*\*", "", first))[:300],
            "source_ref": f"script.act:{match.group(1)}",
        })
    return beats


def _scene_corpus(scene: dict) -> str:
    parts = [
        _text(scene.get("title")),
        _text(scene.get("visual_action")),
        _text(scene.get("narration_text")),
        _text(scene.get("devanagari_dialogue")),
        _text(scene.get("sound_design")),
    ]
    return " ".join(part for part in parts if part)


def _story_anchors(title: str, hook: str, scenes: list[dict], characters: list[dict],
                   entity: str) -> list[str]:
    """Grounded short phrases usable as keywords. Never invents vocabulary."""
    anchors: list[str] = []

    def add(value: str) -> None:
        text = _clean(value).strip("।.,!?—-|")
        if not text or len(text) > 40:
            return
        if not _DEVANAGARI_RE.search(text):
            return
        if text not in anchors:
            anchors.append(text)

    for name in (entity,):
        add(name)
    for character in characters:
        name = _clean(character.get("name"))
        if _DEVANAGARI_RE.search(name):
            add(name)
    for piece in re.split(r"[|–—:\-]", title):
        add(piece)
    for scene in scenes:
        add(_text(scene.get("title")))
    for phrase in re.findall(r"[\u0900-\u097F]+(?:\s+[\u0900-\u097F]+){0,2}", hook or ""):
        if len(phrase) >= 6:
            add(phrase)
        if len(anchors) >= 14:
            break
    return anchors[:14]


def _story_metadata_strings(project: dict) -> list[str]:
    """Factuality-relevant metadata strings carried by the project, if any.

    The current pipeline records no genre/content policy, so this usually returns []. It exists
    so a future project can state its own policy and override the channel default without any
    engine change.
    """
    evidence: list[str] = []
    candidates = [
        project.get("content_policy"), project.get("factuality"),
        (project.get("idea") or {}).get("genre") if isinstance(project.get("idea"), dict) else None,
        (project.get("selected") or {}).get("genre") if isinstance(project.get("selected"), dict) else None,
        (project.get("script") or {}).get("genre") if isinstance(project.get("script"), dict) else None,
        (project.get("input") or {}).get("genre") if isinstance(project.get("input"), dict) else None,
    ]
    selected = (project.get("idea") or {}).get("selected") if isinstance(project.get("idea"), dict) else None
    if isinstance(selected, dict):
        candidates.append(selected.get("genre"))
    for value in candidates:
        if isinstance(value, str) and value.strip() and value.strip() not in evidence:
            evidence.append(value.strip())
        elif isinstance(value, dict):
            for nested in value.values():
                if isinstance(nested, str) and nested.strip() and nested.strip() not in evidence:
                    evidence.append(nested.strip())
    return evidence


def extract_story_facts(project: dict, project_file: str | None = None) -> dict:
    """Extract the only facts the SEO model is allowed to use. Pure and read-only."""
    if not isinstance(project, dict) or not project:
        raise SeoInputError("project is empty or unreadable")

    project_id = _clean(project.get("project_id"))
    script = project.get("script") or {}
    script_text = _text(script.get("raw_text"))
    scenes = _scenes_of(project)
    characters = _characters_of(project)
    backgrounds = _backgrounds_of(project)

    if not project_id:
        raise SeoInputError("project has no project_id")
    if not script_text.strip():
        raise SeoInputError(
            "project has no story text (script.raw_text). Generate the story before running SEO."
        )
    if len(scenes) < 1:
        raise SeoInputError(
            "project has no scenes. SEO generation runs after story generation and validation; "
            "the scene list is required for traceable Shorts references."
        )

    title = _story_title(project)
    hook = _story_hook(project)
    idea = project.get("idea") or {}
    selected = idea.get("selected") if isinstance(idea, dict) else None
    entity = _clean(script.get("monster")) or _clean((selected or {}).get("entity_archetype") if isinstance(selected, dict) else "")
    entity_archetype = _clean((selected or {}).get("entity_archetype") if isinstance(selected, dict) else "")

    # The supernatural name that actually appears in the story (e.g. "राधा देवी की आत्मा").
    # `script.monster` is only the creation-time archetype description, so it is never used as
    # the SEO entity when a real in-story name exists.
    entity_name = ""
    for character in characters:
        name = _clean(character.get("name"))
        if name and re.search(r"आत्मा|प्रेत|पिशाच|चुड़ैल|चुडैल|डायन|भूत|साया|छाया", name):
            entity_name = name
            break

    scene_records = []
    for index, scene in enumerate(scenes, 1):
        number = scene.get("scene_number") if isinstance(scene.get("scene_number"), int) else index
        scene_records.append({
            "scene_number": number,
            "title": _clean(scene.get("title")),
            "speaker": _clean(scene.get("speaker")) or "none",
            "source_ref": f"scenes[{number}]",
        })

    timing_available = bool(scenes) and all(
        isinstance(scene.get("edit_length_seconds"), (int, float)) and scene.get("edit_length_seconds") > 0
        for scene in scenes
    )

    corpus_parts = [
        title, hook, script_text,
        " ".join(_clean(character.get("name")) for character in characters),
        " ".join(_clean(background.get("location_name")) for background in backgrounds),
        " ".join(_scene_corpus(scene) for scene in scenes),
    ]
    corpus = "\n".join(part for part in corpus_parts if part)

    # Numbers that legitimately appear in the story. Act headings ("### Act 1 – HOOK") are
    # structural, not story facts, so they are removed before the digit set is built.
    narrative_text = re.sub(r"(?m)^#{2,4}\s*Act\s*\d+.*$", " ", script_text)
    digits_source = "\n".join([
        title, hook, narrative_text,
        " ".join(_scene_corpus(scene) for scene in scenes),
    ])

    settings = []
    for background in backgrounds:
        name = _clean(background.get("location_name"))
        if name and name not in settings:
            settings.append(name)

    character_records = []
    for character in characters:
        name = _clean(character.get("name"))
        if not name:
            continue
        tag = _clean(character.get("tag"))
        appears_in = []
        for record, scene in zip(scene_records, scenes):
            assets = scene.get("assets") if isinstance(scene.get("assets"), dict) else {}
            tags = assets.get("character_tags") if isinstance(assets.get("character_tags"), list) else []
            inline = scene.get("character_tags") if isinstance(scene.get("character_tags"), list) else []
            if tag and tag in list(tags) + list(inline):
                appears_in.append(record["scene_number"])
        character_records.append({
            "name": name,
            "tag": tag,
            "role": _clean(character.get("profession")) or None,
            "scenes": appears_in,
        })

    facts = {
        "project_id": project_id,
        "title": title,
        "hook": hook,
        "entity": entity_name or entity,
        "entity_name": entity_name or None,
        "entity_archetype": entity_archetype or entity or None,
        "language": _clean(script.get("language")) or "Hindi",
        "duration_minutes": script.get("duration_minutes"),
        "scene_count": len(scenes),
        "characters": character_records,
        "settings": settings,
        "scenes": scene_records,
        "acts": _act_beats(script_text),
        "story_anchors": _story_anchors(title, hook, scenes, characters, entity_name),
        "digits": sorted(_digit_runs(digits_source)),
        "timing_available": timing_available,
        "content_policy": content_policy(CHANNEL_PROFILE, _story_metadata_strings(project)),
        "upload_schedule": upload_schedule(CHANNEL_PROFILE),
        "corpus": corpus,
        "corpus_chars": len(corpus),
        "corpus_sha256": sha256_text(corpus),
        "source_index": {
            "script.raw_text": {"chars": len(script_text), "sha256": sha256_text(script_text)},
            "idea.selected.title": {"value": title},
            "idea.selected.hook": {"value": hook},
            "scenes": {"count": len(scenes), "refs": [record["source_ref"] for record in scene_records]},
            "characters": {"count": len(character_records), "names": [c["name"] for c in character_records]},
            "backgrounds": {"count": len(settings), "names": settings},
        },
    }
    if project_file:
        facts["project_file"] = str(Path(project_file).resolve())
    return facts


# ---------------------------------------------------------------------------------------
# Story summary (deterministic, so it can never invent a fact)
# ---------------------------------------------------------------------------------------
def build_story_summary(facts: dict, model_summary: dict | None = None) -> dict:
    model_summary = model_summary if isinstance(model_summary, dict) else {}
    corpus_key = normalize_key(facts.get("corpus", ""))
    vocab = keywords_for_grounding() | words_for_grounding()

    def accept(value, fallback: str) -> str:
        candidate = _clean(value)
        if not candidate:
            return fallback
        if unknown_tokens(candidate, corpus_key, vocab):
            return fallback
        return candidate

    protagonist = next((c["name"] for c in facts.get("characters", []) if c.get("name")), "")
    fallback_logline = _first_sentence(facts.get("hook", "") or facts.get("title", ""),
                                       f"{facts.get('title') or 'A Hindi folk-horror story'}.")
    acts = facts.get("acts") or []
    fallback_setting = (
        " / ".join(facts.get("settings", [])[:3])
        or (acts[0]["beat"] if acts else "unspecified in the story data")
    )

    return {
        "logline": accept(model_summary.get("logline"), fallback_logline),
        "setting": accept(model_summary.get("setting"), fallback_setting),
        "entity": accept(model_summary.get("entity"), facts.get("entity") or "unspecified"),
        "protagonist": accept(model_summary.get("protagonist"), protagonist or "unspecified"),
        "acts": acts,
        "scene_count": facts.get("scene_count"),
        "duration_minutes": facts.get("duration_minutes"),
        "language": facts.get("language"),
        "timing_available": facts.get("timing_available"),
        "source_refs": ["idea.selected.title", "idea.selected.hook", "script.raw_text", "scenes[*]"],
    }


# ---------------------------------------------------------------------------------------
# Title ranking (deterministic heuristic, explained in docs)
# ---------------------------------------------------------------------------------------
_CURIOSITY_MARKERS = ("क्या", "कौन", "क्यों", "रहस्य", "आवाज़", "आवाज", "सच", "राज़", "अंधेरा",
                      "कैसे", "कहाँ", "कहां", "अचानक", "गायब", "श्राप", "अमावस")
_EMOTION_MARKERS = ("डर", "खौफ", "ख़ौफ़", "आँसू", "माँ", "मां", "बच्चा", "बच्चे", "दर्द",
                    "तड़प", "पुकार", "रो", "फँस", "फंस", "मौत", "ज़िंदा", "जिंदा")


def _tokens_with_positions(text: str) -> list[tuple[int, str]]:
    """(character offset, normalized token) pairs, in text order.

    `seo_keywords.tokenize()` groups all Devanagari tokens before ASCII tokens, which is fine
    for grounding checks but loses the position needed by the title heuristic. This helper keeps
    the position so "is the search phrase near the start?" is measured against the real title.
    """
    pattern = re.compile(r"[\u0900-\u0963\u0966-\u097F]+|[A-Za-z][A-Za-z'-]*")
    return [(match.start(), normalize_key(match.group(0))) for match in pattern.finditer(text or "")]


def _ordered_phrase_position(text: str, phrase: str) -> int | None:
    """Character offset of the first token of `phrase` inside `text`, or None.

    The phrase is matched token by token in order, so one inserted adjective (as in
    "रात के 2 बजे श्मशान से आती वो *रहस्यमयी* आवाज़") does not hide an otherwise verbatim
    search phrase. Without this tolerance the search-phrase signal could be zeroed by a single
    word, which made the score describe the model's `primary_phrase` field rather than the title.
    """
    tokens = _tokens_with_positions(text)
    phrase_tokens = [key for _offset, key in _tokens_with_positions(phrase) if key]
    if not tokens or not phrase_tokens:
        return None
    cursor = 0
    first: int | None = None
    for token in phrase_tokens:
        found = None
        for index in range(cursor, len(tokens)):
            if tokens[index][1] == token:
                found = index
                break
        if found is None:
            return None
        if first is None:
            first = found
        cursor = found + 1
    return tokens[first][0]


def rank_title_candidates(candidates: list[dict]) -> list[dict]:
    """Score each candidate 0..100 for search legibility + honesty + mobile readability.

    This is a transparent heuristic, not a performance prediction. It is the *selection*
    rule: the highest score wins. Ties are broken by the shorter title (mobile readability),
    then by the model's original order so the result is stable.

    The model's own `recommended_title_index` is recorded for audit but never overrides the
    ranking. An explicit editorial choice is handled separately by `select_title()`, where it
    is labelled as an override and its score trade-off is written into the package.
    """
    ranked: list[dict] = []
    for candidate in candidates:
        text = candidate.get("text", "")
        phrase = _clean(candidate.get("primary_phrase", ""))
        length = _chars(text)
        score = 0
        phrase_position = _ordered_phrase_position(text, phrase)
        if phrase_position is not None and phrase_position < 40:
            score += 25
        elif phrase_position is not None:
            score += 15
        if 40 <= length <= 75:
            score += 20
        elif 76 <= length <= 90:
            score += 12
        elif length < 25:
            score += 4
        else:
            score += 2
        if any(marker in text for marker in _CURIOSITY_MARKERS):
            score += 10
        if any(marker in text for marker in _EMOTION_MARKERS):
            score += 10
        if _digit_runs(text):
            score += 10
        if text.endswith(("।", "?", "!", "…")):
            score += 3
        if _DEVANAGARI_RE.search(text):
            score += 12
        ranked.append({**candidate, "heuristic_score": min(100, score), "chars": length})
    ordered = sorted(
        enumerate(ranked),
        key=lambda pair: (-pair[1]["heuristic_score"], pair[1]["chars"], pair[0]),
    )
    ordered_candidates = [item for _index, item in ordered]
    for position, item in enumerate(ordered_candidates, 1):
        item["heuristic_rank"] = position
    by_text = {item["text"]: item for item in ordered_candidates}
    return [by_text.get(candidate["text"], candidate) for candidate in ranked]


def _find_title_index(candidates: list[dict], text: str) -> int | None:
    wanted = normalize_key(text)
    for index, candidate in enumerate(candidates):
        if normalize_key(candidate.get("text", "")) == wanted:
            return index
    return None


def _title_tie_break(selected: dict, runner_up: dict | None) -> str | None:
    if not runner_up or selected.get("heuristic_score") != runner_up.get("heuristic_score"):
        return None
    if selected.get("chars") != runner_up.get("chars"):
        return (
            f"score tie broken by shorter title (mobile readability): "
            f"{selected.get('chars')} < {runner_up.get('chars')} characters"
        )
    return "score and length tie broken by the model's candidate order"


def select_title(ranked: list[dict], model_index: int | None,
                 editorial_title: str | None = None,
                 editorial_reason: str | None = None) -> dict:
    """Choose the recommended title and return an auditable selection record.

    Default rule: the highest heuristic score (see `rank_title_candidates`). An editorial
    title is allowed only when it is one of the three validated candidates; it then becomes an
    explicit override. The override never rewrites scores or ranks, so the trade-off stays
    visible instead of being hidden behind a hardcoded winner.
    """
    if not ranked:
        return {
            "method": "none",
            "selected_index": 0,
            "selected_rank": None,
            "selected_score": None,
            "model_recommended_index": model_index,
            "model_agrees": False,
            "tie_break": None,
            "override": None,
        }
    by_rank = sorted(ranked, key=lambda item: item["heuristic_rank"])
    top = by_rank[0]
    selected = top
    method = "heuristic_top_rank"
    override = None
    editorial_confirmed = False

    if editorial_title:
        index = _find_title_index(ranked, editorial_title)
        if index is None:
            raise SeoInputError(
                f"editorial title {editorial_title!r} is not one of the validated title candidates"
            )
        selected = ranked[index]
        if normalize_key(selected.get("text", "")) == normalize_key(top.get("text", "")):
            # The editorial preference and the deterministic ranking agree: this is a genuine
            # heuristic win, not an override.
            editorial_confirmed = True
        else:
            method = "editorial_override"
            override = {
                "reason": editorial_reason or "explicit editorial choice",
                "requested_text": editorial_title,
                "selected_rank": selected.get("heuristic_rank"),
                "selected_score": selected.get("heuristic_score"),
                "top_ranked_text": top.get("text"),
                "top_ranked_score": top.get("heuristic_score"),
                "score_gap": (selected.get("heuristic_score") or 0) - (top.get("heuristic_score") or 0),
            }

    selected_index = _find_title_index(ranked, selected.get("text", "")) or 0
    runner_up = next((item for item in by_rank if item is not selected), None)
    tie_break = _title_tie_break(selected, runner_up)
    model_agrees = (
        model_index is not None
        and 0 <= model_index < len(ranked)
        and normalize_key(ranked[model_index].get("text", "")) == normalize_key(selected.get("text", ""))
    )

    if method == "editorial_override":
        gap = override["score_gap"]
        if gap == 0:
            tradeoff = "यह शीर्ष heuristic स्कोर के बराबर है।"
        else:
            tradeoff = (
                f"यह शीर्ष heuristic स्कोर ({override['top_ranked_score']}/100, "
                f"'{override['top_ranked_text']}') से {abs(gap)} अंक "
                f"{'अधिक' if gap > 0 else 'कम'} है।"
            )
        rationale = (
            f"संपादकीय चयन (editorial override): '{selected.get('text')}'। "
            f"कारण: {override['reason']} {tradeoff} "
            f"रैंक {selected.get('heuristic_rank')}/3, स्कोर {selected.get('heuristic_score')}/100, "
            f"{selected.get('chars')} अक्षर। यह स्कोरिंग का दावा नहीं, एक स्पष्ट संपादकीय निर्णय है।"
        )
    else:
        why = _clean(selected.get("why"))
        rationale = (
            f"'{selected.get('text')}' को heuristic रैंक 1 पर चुना गया "
            f"(स्कोर {selected.get('heuristic_score')}/100, {selected.get('chars')} अक्षर)।"
            + (f" {why}" if why else "")
        )
        if tie_break and tie_break.startswith("score tie"):
            rationale += (
                f" स्कोर बराबर होने पर छोटा शीर्षक आगे रखा गया "
                f"({selected.get('chars')} < {runner_up.get('chars')} अक्षर)।"
            )
        if editorial_confirmed:
            rationale += " संपादकीय पसंद भी यही शीर्षक थी और यह रैंक 1 से मेल खाती है।"

    return {
        "method": method,
        "selected_index": selected_index,
        "selected_rank": selected.get("heuristic_rank"),
        "selected_score": selected.get("heuristic_score"),
        "selected_chars": selected.get("chars"),
        "top_ranked_index": _find_title_index(ranked, top.get("text", "")),
        "top_ranked_text": top.get("text"),
        "top_ranked_score": top.get("heuristic_score"),
        "runner_up": (
            {
                "index": _find_title_index(ranked, runner_up.get("text", "")),
                "text": runner_up.get("text"),
                "score": runner_up.get("heuristic_score"),
                "rank": runner_up.get("heuristic_rank"),
                "chars": runner_up.get("chars"),
            }
            if runner_up else None
        ),
        "model_recommended_index": model_index,
        "model_agrees": model_agrees,
        "editorial_confirmed": editorial_confirmed,
        "tie_break": tie_break,
        "override": override,
        "rationale": rationale,
    }


# ---------------------------------------------------------------------------------------
# Safe JSON parsing
# ---------------------------------------------------------------------------------------
def parse_seo_json(raw: str) -> dict:
    """Parse a model response into a JSON object, tolerating fences and stray prose."""
    text = str(raw or "").strip()
    if not text:
        raise ValueError("model returned an empty response")
    text = re.sub(r"^\s*```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```\s*$", "", text)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("model output did not contain a JSON object")
        try:
            parsed = json.loads(text[start:end + 1])
        except json.JSONDecodeError as error:
            raise ValueError(f"model output was not valid JSON: {error.msg} at position {error.pos}")
    if not isinstance(parsed, dict):
        raise ValueError("model output was valid JSON but not an object")
    return parsed


# ---------------------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------------------
def _hashtag_from_phrase(phrase: str) -> str:
    """Turn a grounded story phrase into one single-token hashtag, or '' if it cannot.

    Underscores join the words because a hashtag may not contain spaces. Nothing is invented:
    the phrase must already come from the extracted story facts.
    """
    words: list[str] = []
    for word in str(phrase or "").split():
        cleaned = re.sub(r"[^\u0900-\u097FA-Za-z0-9_]", "", word)
        if cleaned:
            words.append(cleaned)
    if not words:
        return ""
    tag = "#" + "_".join(words)
    if not (3 <= _chars(tag) <= HASHTAG_MAX_BODY_CHARS + 1):
        return ""
    return tag if _HASHTAG_RE.match(tag) else ""


def _hashtag_fallback_pool(facts: dict) -> list[str]:
    """Deterministic, grounded hashtags used only when the model supplies none.

    Order matters: the branded channel tag first, then short story anchors (so a fallback set
    is story-specific, as the prompt asks), then the genre/channel tags. Only short, readable
    anchors are eligible, because a 40-character run-on tag is technically valid but useless.
    Every entry is re-checked by `hashtag_is_relevant` before it is used, so the fallback can
    never smuggle in an unrelated tag.
    """
    pool: list[str] = ["#raatkakhauf"]
    for anchor in facts.get("story_anchors", []) or []:
        words = str(anchor).split()
        if not words or len(words) > 4 or len(str(anchor)) > 24:
            continue
        tag = _hashtag_from_phrase(anchor)
        if tag:
            pool.append(tag)
    pool.extend(["#hindihorrorstory", "#भूतकीकहानी", "#डरावनीकहानी"])

    unique: list[str] = []
    seen: set[str] = set()
    for tag in pool:
        key = hashtag_key(tag)
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(tag)
    return unique


def _hashtag_pieces(raw, scope: str, warnings: list[str]) -> list[str]:
    """Split the model's hashtag field into individual single-token hashtags.

    A hashtag may not contain a space, so a multi-word hashtag is written with underscores.
    The model still sometimes emits "#अमावस की रात" or a comma-joined "#a,#b"; those are
    repaired into one token each instead of being mangled into junk tags, and every repair is
    recorded in the warnings so the rewrite is auditable.
    """
    pieces: list[str] = []
    for part in _as_str_list(raw):
        text = _clean(part)
        if not text:
            continue
        # Two or more '#' means the single string holds several hashtags.
        chunks = re.split(r"(?=#)", text) if text.count("#") > 1 else [text]
        for chunk in chunks:
            chunk = _clean(chunk).strip(" ,;।")
            if not chunk:
                continue
            repaired = chunk if chunk.startswith("#") else "#" + chunk
            repaired = re.sub(r"[\s\-]+", "_", repaired)
            if repaired != chunk:
                warnings.append(f"{scope}: rewrote {chunk!r} as {repaired!r}")
            pieces.append(repaired)
    return pieces


def _validate_hashtags(raw, corpus_key: str, errors: list[str], warnings: list[str],
                       *, min_count: int = HASHTAG_MIN_COUNT, max_count: int = HASHTAG_MAX_COUNT,
                       scope: str = "hashtags", fallback_pool: list[str] | None = None,
                       policy: dict | None = None) -> list[str]:
    """Normalise, filter and count hashtags for one scope (the video, or one Short).

    `scope` names the field in every message, so the video-level minimum and a per-Short
    minimum can never be reported as two contradictory requirements on the same field.

    The deterministic fallback runs only when the model supplied *no* hashtag value at all.
    When it supplied hashtags that were rejected (malformed or unrelated), that is a genuine
    failure and no fallback is allowed to mask it.
    """
    supplied = _hashtag_pieces(raw, scope, warnings)
    normalized: list[str] = []
    policy = policy or {}
    for candidate in supplied:
        if not _HASHTAG_RE.match(candidate):
            warnings.append(f"{scope}: dropped malformed hashtag: {candidate[:60]}")
            continue
        if policy.get("reject_truth_claims", policy.get("fiction", True)) and fiction_claims(
                candidate.replace("_", " ")):
            warnings.append(
                f"{scope}: dropped hashtag that claims the story is true: {candidate}"
            )
            continue
        if not hashtag_is_relevant(candidate, corpus_key, policy):
            warnings.append(
                f"{scope}: dropped unrelated hashtag (not grounded in the story): {candidate}"
            )
            continue
        normalized.append(candidate)
    normalized, removed = _dedupe(normalized, key=hashtag_key)
    if removed:
        warnings.append(f"{scope}: removed {removed} duplicate hashtag(s)")

    if not supplied and fallback_pool:
        # Video: a natural 4-tag set (brand + story + genre, never below the minimum).
        # Short: brand + one story tag.
        desired = max(min_count, 4) if scope == "hashtags" else max(min_count, 2)
        target = min(desired, max_count)
        added: list[str] = []
        existing = {hashtag_key(tag) for tag in normalized}
        for tag in fallback_pool:
            if len(normalized) + len(added) >= target:
                break
            if not _HASHTAG_RE.match(tag) or hashtag_key(tag) in existing:
                continue
            if not hashtag_is_relevant(tag, corpus_key, policy):
                continue
            added.append(tag)
            existing.add(hashtag_key(tag))
        if added:
            normalized.extend(added)
            warnings.append(
                f"{scope}: the model supplied no hashtags; added {len(added)} grounded "
                "fallback hashtag(s) from the channel profile and the story: " + " ".join(added)
            )

    if len(normalized) > max_count:
        warnings.append(f"{scope}: kept the first {max_count} of {len(normalized)} hashtags")
        normalized = normalized[:max_count]
    if len(normalized) < min_count:
        where = "the video" if scope == "hashtags" else "this Short"
        errors.append(
            f"{scope}: need at least {min_count} relevant hashtag(s) for {where}, "
            f"found {len(normalized)}"
        )
    return normalized


def _policy_of(facts: dict) -> dict:
    policy = facts.get("content_policy")
    return policy if isinstance(policy, dict) else content_policy(CHANNEL_PROFILE)


def _schedule_of(facts: dict) -> dict:
    schedule = facts.get("upload_schedule")
    return schedule if isinstance(schedule, dict) else upload_schedule(CHANNEL_PROFILE)


def _prose_vocabulary() -> set[str]:
    """Story facts + broad taxonomy + ordinary Hindi narrative/CTA vocabulary."""
    return keywords_for_grounding() | words_for_grounding() | narrative_vocabulary()


def _claim_errors(text: str, field: str, policy: dict, errors: list[str]) -> None:
    """Reject a factuality claim when the content policy is fictional."""
    if not policy.get("reject_truth_claims", policy.get("fiction", True)):
        return
    claims = fiction_claims(text)
    if claims:
        errors.append(
            f"{field}: claims the story is true/real ({', '.join(claims[:3])}), but the content "
            "policy is fiction; never present a fictional story as a real incident"
        )


def _schedule_errors(text: str, field: str, schedule: dict, errors: list[str]) -> None:
    """Reject an upload-cadence promise unless the channel profile confirms one."""
    if schedule.get("confirmed"):
        return
    claims = schedule_claims(text)
    if claims:
        errors.append(
            f"{field}: promises an upload schedule ({', '.join(claims[:3])}), but the channel "
            "profile confirms no schedule; remove the cadence promise"
        )


def _story_reference_present(text: str, facts: dict) -> bool:
    """True when the text names a real story character, entity, setting or anchor."""
    folded = _fold(text)
    if not folded:
        return False
    names: list[str] = []
    for character in facts.get("characters", []) or []:
        name = _clean(character.get("name"))
        if name:
            names.append(name)
    if facts.get("entity_name"):
        names.append(_clean(facts["entity_name"]))
    names.extend(facts.get("story_anchors", []) or [])
    for name in names:
        for word in str(name).split():
            token = _fold(word)
            if len(token) >= 3 and token in folded:
                return True
    for setting in facts.get("settings", []) or []:
        for word in re.split(r"[^A-Za-z0-9\u0900-\u097F]+", str(setting)):
            token = _fold(word)
            if len(token) >= 4 and token not in {"room", "wide", "house", "with", "view"} and token in folded:
                return True
    return False


def _fold(value: str) -> str:
    """Lowercase, matra-preserving comparison form used by the policy checks."""
    return unicodedata.normalize("NFC", str(value or "")).lower()


def _character_aliases(facts: dict) -> set[str]:
    """Latin aliases derived from the existing character tags, plus Devanagari names.

    ``@CHAR-03-RADHADEVI-ATMA`` yields ``radhadevi`` and ``atma``, so an English thumbnail
    prompt can be checked for the real character without any transliteration library.
    """
    aliases: set[str] = set()
    for character in facts.get("characters", []) or []:
        tag = _clean(character.get("tag"))
        if tag:
            for part in re.split(r"[^A-Za-z0-9]+", tag):
                part = part.lower()
                if len(part) >= 3 and not part.isdigit() and part not in {"char", "bgd"}:
                    aliases.add(part)
        name = _clean(character.get("name"))
        if name:
            aliases.add(_fold(name))
            aliases.update(_fold(word) for word in name.split() if len(word) >= 3)
    if facts.get("entity_name"):
        aliases.add(_fold(facts["entity_name"]))
    return {alias for alias in aliases if alias}


def _thumbnail_anchor_terms(facts: dict) -> set[str]:
    """Words a thumbnail image prompt must contain to prove it depicts THIS story."""
    anchors = set(_character_aliases(facts))
    for setting in facts.get("settings", []) or []:
        for word in re.split(r"[^A-Za-z0-9\u0900-\u097F]+", str(setting)):
            word = word.lower()
            if len(word) >= 4 and word not in {"room", "wide", "house", "with", "view"}:
                anchors.add(word)
    anchors.update({
        "spirit", "ghost", "ghostly", "soul", "saree", "sari", "cremation", "pyre",
        "shamshan", "आत्मा", "श्मशान", "चिता", "भूत",
    })
    return anchors


def _ensure_fiction_disclosure(description: str, policy: dict, warnings: list[str]) -> str:
    """Guarantee one fiction/entertainment disclosure line when the policy requires it.

    The prompt asks the model to write it naturally. If it forgets, the standard disclosure is
    inserted deterministically (as a warning, never silently) in front of the hashtag line.
    """
    if not policy.get("fiction") or not description:
        return description
    if _FICTION_DISCLOSURE_RE.search(description):
        return description
    disclosure = _clean(policy.get("disclosure_hi")) or "यह एक काल्पनिक कहानी है, केवल मनोरंजन के लिए।"
    lines = description.rstrip().split("\n")
    if lines and lines[-1].strip().startswith("#"):
        lines.insert(len(lines) - 1, "")
        lines.insert(len(lines) - 1, disclosure)
        updated = "\n".join(lines)
    else:
        updated = description.rstrip() + "\n\n" + disclosure
    warnings.append("description: added the required fiction/entertainment disclosure line")
    return updated


def _validate_tags(raw, corpus_key: str, policy: dict, errors: list[str],
                   warnings: list[str]) -> list[str]:
    values = []
    for value in _as_str_list(raw):
        tag = _clean(value).replace(",", " ").strip()
        if not tag:
            continue
        if _chars(tag) > TAG_MAX_CHARS:
            warnings.append(f"dropped tag longer than {TAG_MAX_CHARS} characters: {tag[:40]}…")
            continue
        values.append(tag)
    values, removed = _dedupe(values, key=lambda item: normalize_key(item))
    if removed:
        warnings.append(f"removed {removed} duplicate tag(s)")

    vocab = keywords_for_grounding() | words_for_grounding()
    relevant: list[str] = []
    dropped: list[str] = []
    claimed: list[str] = []
    for tag in values:
        if policy.get("reject_truth_claims", policy.get("fiction", True)) and fiction_claims(
                tag.replace("_", " ")):
            claimed.append(tag)
            continue
        leftovers = unknown_tokens(tag, corpus_key, vocab)
        if leftovers:
            dropped.append(tag)
        else:
            relevant.append(tag)
    if claimed:
        warnings.append(
            "dropped tag(s) that claim the story is true while the content policy is fiction: "
            + "; ".join(claimed[:8])
        )
    if dropped:
        warnings.append(
            "dropped unrelated or ungrounded tag(s): " + "; ".join(dropped[:8])
        )

    trimmed: list[str] = []
    budget = TAGS_COMBINED_MAX_CHARS
    used = 0
    for tag in relevant:
        cost = _chars(tag) + (1 if trimmed else 0)
        if used + cost > budget:
            continue
        trimmed.append(tag)
        used += cost
    if len(trimmed) != len(relevant):
        warnings.append(
            f"trimmed tags to fit the {TAGS_COMBINED_MAX_CHARS}-character combined limit "
            f"({len(relevant)} -> {len(trimmed)})"
        )
    if len(trimmed) < TAGS_MIN_COUNT:
        errors.append(f"tags: need at least {TAGS_MIN_COUNT} usable tags, found {len(trimmed)}")
    return trimmed


def _validate_source_refs(raw, facts: dict, warnings: list[str]) -> list[str]:
    valid_numbers = {record["scene_number"] for record in facts.get("scenes", [])}
    valid_acts = {str(beat["act"]) for beat in facts.get("acts", [])}
    kept: list[str] = []
    dropped: list[str] = []
    for ref in _as_str_list(raw):
        text = _clean(ref)
        if not text:
            continue
        match = re.fullmatch(r"scenes?\[(\d+)\]", text)
        if match:
            if int(match.group(1)) in valid_numbers:
                kept.append(f"scenes[{int(match.group(1))}]")
            else:
                dropped.append(text)
            continue
        match = re.fullmatch(r"script\.act:(\d+)", text)
        if match:
            (kept if match.group(1) in valid_acts else dropped).append(text)
            continue
        match = re.fullmatch(r"(idea\.selected\.(?:title|hook)|script\.raw_text|scenes\[\*\])", text)
        if match:
            kept.append(text)
            continue
        dropped.append(text)
    if dropped:
        warnings.append("dropped unverifiable source reference(s): " + "; ".join(sorted(set(dropped))[:6]))
    return kept


def _validate_titles(raw, facts: dict, corpus_key: str, policy: dict, schedule: dict,
                     errors: list[str], warnings: list[str]) -> list[dict]:
    vocab = keywords_for_grounding() | words_for_grounding()
    grounded_digits = set(facts.get("digits", []))

    if not isinstance(raw, list) or not raw:
        errors.append("title_candidates: expected a non-empty list")
        return []

    titles: list[dict] = []
    for index, item in enumerate(raw, 1):
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            errors.append(f"title_candidates[{index}]: expected an object")
            continue
        text = _clean(item.get("text"))
        if not text:
            errors.append(f"title_candidates[{index}]: empty title")
            continue
        if _chars(text) > TITLE_MAX_CHARS:
            errors.append(
                f"title_candidates[{index}]: {_chars(text)} characters exceeds the "
                f"{TITLE_MAX_CHARS}-character YouTube limit"
            )
        if not _DEVANAGARI_RE.search(text):
            errors.append(f"title_candidates[{index}]: not Hindi-first (no Devanagari characters)")
        _claim_errors(text, f"title_candidates[{index}]", policy, errors)
        _schedule_errors(text, f"title_candidates[{index}]", schedule, errors)
        unknown = unknown_tokens(text, corpus_key, vocab)
        if unknown:
            errors.append(
                f"title_candidates[{index}]: contains words that do not exist in the story: "
                + ", ".join(unknown[:6])
            )
        bad_digits = _digit_runs(text) - grounded_digits
        if bad_digits:
            errors.append(
                f"title_candidates[{index}]: numbers not supported by the story: "
                + ", ".join(sorted(bad_digits))
            )
        titles.append({
            "text": text,
            "hook_type": _clean(item.get("hook_type")) or "curiosity",
            "primary_phrase": _clean(item.get("primary_phrase")),
            "source_refs": _validate_source_refs(item.get("source_refs"), facts, warnings),
            "why": _clean(item.get("why")),
        })

    if len(titles) != 3:
        errors.append(f"title_candidates: expected exactly 3 usable titles, found {len(titles)}")

    unique, duplicates = _dedupe([title["text"] for title in titles], key=normalize_key)
    if duplicates:
        errors.append(f"title_candidates: {duplicates} duplicate title(s); each candidate must be distinct")

    return titles


def _validate_description(raw, policy: dict, schedule: dict,
                          errors: list[str], warnings: list[str]) -> str:
    description = _clean_block(raw)
    if not description:
        errors.append("description: empty")
        return ""
    length = _chars(description)
    if length > DESCRIPTION_MAX_CHARS:
        errors.append(
            f"description: {length} characters exceeds the {DESCRIPTION_MAX_CHARS}-character limit"
        )
    if length < DESCRIPTION_MIN_CHARS:
        errors.append(
            f"description: {length} characters is below the {DESCRIPTION_MIN_CHARS}-character minimum"
        )
    if not _SUBSCRIBE_RE.search(description):
        errors.append("description: missing an explicit subscribe call to action")
    if "?" not in description and "？" not in description:
        errors.append("description: missing an engagement question")
    _claim_errors(description, "description", policy, errors)
    _schedule_errors(description, "description", schedule, errors)
    return description


def _ensure_trailing_hashtags(description: str, hashtags: list[str],
                             warnings: list[str]) -> str:
    if not hashtags or not description:
        return description
    last_line = description.strip().split("\n")[-1]
    present = sum(1 for tag in hashtags if tag in last_line)
    if present >= min(2, len(hashtags)):
        return description
    warnings.append("appended the validated hashtags as the final description line")
    return description.rstrip() + "\n\n" + " ".join(hashtags)


def _keyword_stuffing_warnings(description: str, keyword_plan: dict,
                               warnings: list[str]) -> None:
    haystack = normalize_key(description)
    for group in ("primary", "secondary"):
        for record in keyword_plan.get(group, []):
            term = normalize_key(record.get("term", ""))
            if len(term.split()) < 2:
                continue
            count = haystack.count(term)
            if count > 4:
                warnings.append(
                    f"possible keyword stuffing: '{record['term']}' appears {count} times in the description"
                )


def _validate_pinned_comment(raw, facts: dict, corpus_key: str, policy: dict, schedule: dict,
                             grounded_digits: set[str], errors: list[str],
                             warnings: list[str]) -> str:
    comment = _clean_block(raw)
    if not comment:
        errors.append("pinned_comment: empty")
        return ""
    if _chars(comment) < 40:
        errors.append("pinned_comment: too short to invite a real discussion")
    if _chars(comment) > PINNED_COMMENT_MAX_CHARS:
        errors.append(
            f"pinned_comment: {_chars(comment)} characters is too long for a pinned comment "
            f"(limit {PINNED_COMMENT_MAX_CHARS}); keep it concise"
        )
    if "?" not in comment:
        errors.append("pinned_comment: must ask a story-specific question")
    elif comment.count("?") > 1:
        warnings.append("pinned_comment: asks more than one question; keep one story-specific question")
    if not _story_reference_present(comment, facts):
        errors.append(
            "pinned_comment: not story-specific; name a character, place or event from this story "
            "instead of a generic invitation"
        )
    lowered = _fold(comment)
    filler = [phrase for phrase in _PINNED_GENERIC_FILLER if _fold(phrase) in lowered]
    if filler:
        warnings.append("pinned_comment: generic filler that does not fit this story: " + "; ".join(filler))
    _claim_errors(comment, "pinned_comment", policy, errors)
    _schedule_errors(comment, "pinned_comment", schedule, errors)
    bad_digits = _digit_runs(comment) - grounded_digits
    if bad_digits:
        errors.append("pinned_comment: numbers not supported by the story: " + ", ".join(sorted(bad_digits)))
    unknown = unknown_tokens(comment, corpus_key, _prose_vocabulary())
    if unknown:
        warnings.append("pinned_comment: words outside the story and ordinary Hindi: " + ", ".join(unknown[:6]))
    return comment


def _validate_thumbnail(raw, facts: dict, corpus_key: str, policy: dict, errors: list[str],
                        warnings: list[str]) -> dict:
    thumbnail = raw if isinstance(raw, dict) else {}
    text = _clean(thumbnail.get("text") or thumbnail.get("thumbnail_text"))
    image_prompt = _clean(thumbnail.get("image_prompt"))

    if not text:
        errors.append("thumbnail.text: empty")
    else:
        words = [word for word in text.split() if word]
        if len(words) > THUMBNAIL_TEXT_MAX_WORDS:
            errors.append(
                f"thumbnail.text: {len(words)} words exceeds the {THUMBNAIL_TEXT_MAX_WORDS}-word limit"
            )
        if len(words) < THUMBNAIL_TEXT_MIN_WORDS:
            errors.append("thumbnail.text: needs at least 2 words")
        if len(words) > THUMBNAIL_TEXT_SOFT_MAX_WORDS:
            warnings.append(
                f"thumbnail.text: {len(words)} words is long for a mobile thumbnail; "
                f"2-{THUMBNAIL_TEXT_SOFT_MAX_WORDS} words read best"
            )
        if not _DEVANAGARI_RE.search(text):
            errors.append("thumbnail.text: must be Devanagari Hindi")
        _claim_errors(text, "thumbnail.text", policy, errors)
        unknown = unknown_tokens(text, corpus_key)
        if unknown:
            errors.append("thumbnail.text: words that do not exist in the story: " + ", ".join(unknown[:6]))
        bad_digits = _digit_runs(text) - set(facts.get("digits", []))
        if bad_digits:
            errors.append("thumbnail.text: numbers not supported by the story: " + ", ".join(sorted(bad_digits)))

    concept = {
        "main_subject": _clean(thumbnail.get("main_subject")),
        "composition": _clean(thumbnail.get("composition")),
        "background_lighting": _clean(thumbnail.get("background_lighting")),
        "color_contrast": _clean(thumbnail.get("color_contrast")),
    }
    for field, value in concept.items():
        if not value:
            errors.append(f"thumbnail.{field}: empty")
    if concept["main_subject"]:
        _claim_errors(concept["main_subject"], "thumbnail.main_subject", policy, errors)
        unknown_subject = unknown_tokens(concept["main_subject"], corpus_key, _prose_vocabulary())
        if unknown_subject:
            errors.append(
                "thumbnail.main_subject: invents a character or detail that is not in the story: "
                + ", ".join(unknown_subject[:6])
            )
        if not _story_reference_present(concept["main_subject"], facts):
            errors.append(
                "thumbnail.main_subject: must name the actual story character/entity or setting"
            )

    if not image_prompt:
        errors.append("thumbnail.image_prompt: empty")
    else:
        if unknown_tokens(image_prompt, corpus_key):
            # The image prompt legitimately contains style vocabulary; only warn.
            warnings.append("thumbnail.image_prompt: contains words not found in the story (style vocabulary)")
        folded_prompt = _fold(image_prompt)
        # Names may be written with a space ("Radha Devi") while a character tag is collapsed
        # ("RADHADEVI"); compare both forms so a correctly named character is never reported as
        # missing.
        compact_prompt = re.sub(r"[\s_\-]+", "", folded_prompt)
        anchors = _thumbnail_anchor_terms(facts)
        if not any(anchor and (anchor in folded_prompt or re.sub(r"[\s_\-]+", "", anchor) in compact_prompt)
                   for anchor in anchors):
            errors.append(
                "thumbnail.image_prompt: does not depict this story; name the actual character or "
                "setting (e.g. Radha Devi, the cremation ground)"
            )
        character_aliases = _character_aliases(facts)
        if not any(alias and (alias in folded_prompt or re.sub(r"[\s_\-]+", "", alias) in compact_prompt)
                   for alias in character_aliases):
            warnings.append(
                "thumbnail.image_prompt: does not name the story character; add the exact name so "
                "the thumbnail and the story stay consistent"
            )
        if "2d" not in folded_prompt or "semi-realistic" not in folded_prompt:
            errors.append(
                "thumbnail.image_prompt: must state the channel style (2D semi-realistic)"
            )
        # A watermark/logo is only acceptable when the prompt explicitly asks for one.
        without_negation = re.sub(r"\b(?:no|without|free of|zero)\s+(?:visible\s+)?(?:watermarks?|logos?)\b",
                                  " ", folded_prompt)
        if re.search(r"\b(?:watermarks?|logos?)\b", without_negation):
            errors.append("thumbnail.image_prompt: must not include watermarks or logos")
        # Capitalised Latin words are proper nouns in an English prompt; an unknown one is an
        # invented character or place.
        unknown_proper = sorted({
            token for token in re.findall(r"\b[A-Z][A-Za-z]{2,}\b", image_prompt)
            if token.lower() not in _THUMBNAIL_PROMPT_VOCABULARY
            and token.lower() not in character_aliases
            and not any(token.lower() in alias for alias in character_aliases)
            and not any(token.lower() in anchor for anchor in anchors)
        })
        if unknown_proper:
            errors.append(
                "thumbnail.image_prompt: names a character/place that is not in the story: "
                + ", ".join(unknown_proper[:6])
            )
        # The aspect suffix must be the LAST token (the schema and the Flow handoff both rely
        # on it), so it is normalised deterministically instead of trusted verbatim.
        match = re.search(r"--ar\s*16\s*:\s*9", image_prompt, re.I)
        if match:
            rest = (image_prompt[:match.start()] + " " + image_prompt[match.end():]).strip()
            normalized = rest.rstrip(" .,;") + " --ar 16:9"
            if normalized != image_prompt:
                warnings.append("thumbnail.image_prompt: moved the --ar 16:9 aspect suffix to the end")
                image_prompt = normalized
        else:
            image_prompt = image_prompt.rstrip(" .,;") + ". --ar 16:9"
            warnings.append("thumbnail.image_prompt: appended the required --ar 16:9 aspect suffix")

    return {"text": text, "concept": concept, "image_prompt": image_prompt}


def _validate_shorts(raw, facts: dict, corpus_key: str, errors: list[str],
                     warnings: list[str], hashtag_pool: list[str] | None = None,
                     policy: dict | None = None) -> list[dict]:
    policy = policy or {}
    if not isinstance(raw, list) or not raw:
        errors.append("shorts_concepts: expected a non-empty list")
        return []
    if len(raw) != SHORTS_COUNT:
        errors.append(f"shorts_concepts: expected exactly {SHORTS_COUNT} concepts, found {len(raw)}")

    valid_numbers = {record["scene_number"] for record in facts.get("scenes", [])}
    grounded_digits = set(facts.get("digits", []))
    concepts: list[dict] = []
    for index, item in enumerate(raw[:SHORTS_COUNT], 1):
        item = item if isinstance(item, dict) else {}
        hook = _clean(item.get("hook"))
        title = _clean(item.get("title"))
        description = _clean_block(item.get("description"))
        opening = _clean(item.get("opening_narration"))
        cta = _clean(item.get("cta"))

        for field, value in (("hook", hook), ("title", title), ("description", description),
                             ("opening_narration", opening), ("cta", cta)):
            if not value:
                errors.append(f"shorts_concepts[{index}].{field}: empty")

        if title and _chars(title) > TITLE_MAX_CHARS:
            errors.append(f"shorts_concepts[{index}].title: exceeds {TITLE_MAX_CHARS} characters")
        if description and _chars(description) > DESCRIPTION_MAX_CHARS:
            errors.append(f"shorts_concepts[{index}].description: exceeds {DESCRIPTION_MAX_CHARS} characters")
        if cta and not _CTA_FULL_STORY_RE.search(cta):
            errors.append(f"shorts_concepts[{index}].cta: must direct viewers to the full story")

        for field, value in (("hook", hook), ("title", title), ("description", description),
                             ("opening_narration", opening), ("cta", cta)):
            if _TIMESTAMP_RE.search(value or ""):
                errors.append(
                    f"shorts_concepts[{index}].{field}: contains a timestamp, but the source data "
                    "has no reliable timings"
                )
            bad_digits = _digit_runs(value or "") - grounded_digits
            if bad_digits:
                errors.append(
                    f"shorts_concepts[{index}].{field}: numbers not supported by the story: "
                    + ", ".join(sorted(bad_digits))
                )
            _claim_errors(value or "", f"shorts_concepts[{index}].{field}", policy, errors)

        scene_refs: list[int] = []
        for ref in (item.get("scene_refs") or []):
            try:
                number = int(ref)
            except (TypeError, ValueError):
                warnings.append(f"shorts_concepts[{index}].scene_refs: dropped non-numeric reference {ref!r}")
                continue
            if number not in valid_numbers:
                warnings.append(f"shorts_concepts[{index}].scene_refs: dropped unknown scene {number}")
                continue
            if number not in scene_refs:
                scene_refs.append(number)
        if not scene_refs:
            warnings.append(f"shorts_concepts[{index}].scene_refs: no verifiable scene reference")

        concepts.append({
            "hook": hook,
            "title": title,
            "description": description,
            "hashtags": _validate_hashtags(item.get("hashtags"), corpus_key, errors, warnings,
                                           min_count=1, max_count=5,
                                           scope=f"shorts_concepts[{index}].hashtags",
                                           fallback_pool=hashtag_pool, policy=policy),
            "opening_narration": opening,
            "scene_refs": scene_refs,
            "timing_note": "no timestamps: the story data contains no reliable scene durations",
            "cta": cta,
        })
    return concepts


def _validate_story_keywords(raw, facts: dict, keyword_plan: dict, warnings: list[str],
                             policy: dict | None = None) -> list[str]:
    policy = policy or {}
    corpus_key = normalize_key(facts.get("corpus", ""))
    vocab = keywords_for_grounding() | words_for_grounding()
    proposed = [_clean(item) for item in _as_str_list(raw) if _clean(item)]
    claimed: list[str] = []
    if policy.get("reject_truth_claims", policy.get("fiction", True)):
        claimed = [term for term in proposed if fiction_claims(term)]
        proposed = [term for term in proposed if term not in claimed]
    kept = [term for term in proposed if not unknown_tokens(term, corpus_key, vocab)]
    dropped = [term for term in proposed if term not in kept]
    if claimed:
        warnings.append(
            "dropped story keyword(s) that claim the story is true while the content policy "
            "is fiction: " + "; ".join(claimed[:8])
        )
    if dropped:
        warnings.append("dropped ungrounded story keyword(s): " + "; ".join(dropped[:8]))
    kept, removed = _dedupe(kept, key=lambda item: normalize_key(item))
    if removed:
        warnings.append(f"removed {removed} duplicate story keyword(s)")
    if not kept:
        kept = [record["term"] for record in keyword_plan.get("story_specific", [])][:10]
    return kept[:12]


def validate_candidate(candidate: dict, facts: dict, keyword_plan: dict,
                       editorial: dict | None = None) -> tuple[dict, list[str], list[str]]:
    """Validate one model response. Returns (validated_fields, errors, warnings).

    Errors block the package. Warnings are recorded in `validation_warnings`.
    `editorial` carries explicit editor-supplied copy; its title (when present) is selected as
    a labelled override instead of silently pretending the heuristic chose it.
    """
    errors: list[str] = []
    warnings: list[str] = []
    corpus_key = normalize_key(facts.get("corpus", ""))
    grounded_digits = set(facts.get("digits", []))
    policy = _policy_of(facts)
    schedule = _schedule_of(facts)
    editorial_title = _clean((editorial or {}).get("title"))
    editorial_reason = _clean((editorial or {}).get("title_reason"))

    titles = _validate_titles(candidate.get("title_candidates"), facts, corpus_key,
                              policy, schedule, errors, warnings)

    rationale = _clean(candidate.get("title_rationale"))
    if not rationale:
        errors.append("title_rationale: empty")
    elif _chars(rationale) < 40:
        errors.append("title_rationale: too short to explain the recommendation")

    description = _validate_description(candidate.get("description"), policy, schedule,
                                        errors, warnings)

    tags = _validate_tags(candidate.get("tags"), corpus_key, policy, errors, warnings)
    hashtag_pool = _hashtag_fallback_pool(facts)
    hashtags = _validate_hashtags(candidate.get("hashtags"), corpus_key, errors, warnings,
                                  scope="hashtags", fallback_pool=hashtag_pool,
                                  policy=policy)
    description = _ensure_trailing_hashtags(description, hashtags, warnings)
    description = _ensure_fiction_disclosure(description, policy, warnings)
    _keyword_stuffing_warnings(description, keyword_plan, warnings)

    if description and _chars(description) > DESCRIPTION_MAX_CHARS:
        errors.append(
            f"description: {_chars(description)} characters exceeds the "
            f"{DESCRIPTION_MAX_CHARS}-character limit after hashtag insertion"
        )

    pinned = _validate_pinned_comment(candidate.get("pinned_comment"), facts, corpus_key,
                                      policy, schedule, grounded_digits, errors, warnings)
    thumbnail = _validate_thumbnail(candidate.get("thumbnail"), facts, corpus_key, policy,
                                    errors, warnings)
    shorts = _validate_shorts(candidate.get("shorts_concepts"), facts, corpus_key, errors,
                              warnings, hashtag_pool, policy)
    story_keywords = _validate_story_keywords(candidate.get("story_specific_keywords"), facts,
                                              keyword_plan, warnings, policy)

    # Description-level grounding is advisory: prose may paraphrase. Titles/thumbnail/pinned
    # are strict, because those are the visible claims.
    description_unknown = unknown_tokens(description, corpus_key, _prose_vocabulary())
    if description_unknown:
        warnings.append("description: words outside the story and ordinary Hindi: "
                        + ", ".join(description_unknown[:8]))
    bad_digits = _digit_runs(description) - grounded_digits
    if bad_digits:
        errors.append("description: numbers not supported by the story: " + ", ".join(sorted(bad_digits)))

    # The model's index is audited, not obeyed. The prompt asks for a 1-based position; 0 is
    # tolerated as the 0-based "first" because models occasionally emit it.
    raw_index = candidate.get("recommended_title_index")
    model_index: int | None = None
    try:
        value = int(raw_index)
        if value == 0:
            model_index = 0
        elif 1 <= value <= len(titles):
            model_index = value - 1
        else:
            warnings.append(
                f"recommended_title_index {value} out of range; the deterministic ranking "
                "selected the recommended title"
            )
    except (TypeError, ValueError):
        if raw_index is not None:
            warnings.append(
                "recommended_title_index was not an integer; the deterministic ranking "
                "selected the recommended title"
            )

    ranked = rank_title_candidates(titles)
    try:
        selection = select_title(ranked, model_index, editorial_title, editorial_reason)
    except SeoInputError as error:
        errors.append(str(error))
        selection = select_title(ranked, model_index)
    recommended_index = selection.get("selected_index", 0) if ranked else 0
    if ranked:
        recommended_index = min(recommended_index, len(ranked) - 1)
    selected_text = ranked[recommended_index]["text"] if ranked else ""
    if (ranked and selection.get("method") == "heuristic_top_rank"
            and model_index is not None and not selection.get("model_agrees")):
        warnings.append(
            "the model's recommended_title_index disagrees with the deterministic ranking "
            f"(model rank {ranked[model_index].get('heuristic_rank')} vs selected rank "
            f"{selection.get('selected_rank')}); scores and ranks are authoritative"
        )

    fields = {
        "title_candidates": ranked,
        "recommended_title_index": recommended_index,
        "recommended_title": selected_text,
        "title_rationale": selection.get("rationale") or rationale,
        "title_selection": selection,
        "description": description,
        "tags": tags,
        "hashtags": hashtags,
        "pinned_comment": pinned,
        "thumbnail_text": thumbnail["text"],
        "thumbnail_concept": thumbnail["concept"],
        "thumbnail_image_prompt": thumbnail["image_prompt"],
        "shorts_concepts": shorts,
        "story_keywords": story_keywords,
        "model_story_summary": candidate.get("story_summary") if isinstance(candidate.get("story_summary"), dict) else None,
    }
    return fields, errors, warnings


# ---------------------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------------------
def build_prompt(facts: dict, keyword_plan: dict, repair_errors: list[str] | None = None) -> str:
    compact_facts = {
        "project_id": facts.get("project_id"),
        "title": facts.get("title"),
        "hook": facts.get("hook"),
        "entity": facts.get("entity"),
        "entity_archetype": facts.get("entity_archetype"),
        "language": facts.get("language"),
        "duration_minutes": facts.get("duration_minutes"),
        "scene_count": facts.get("scene_count"),
        "characters": facts.get("characters"),
        "settings": facts.get("settings"),
        "acts": facts.get("acts"),
        "scenes": facts.get("scenes"),
        "story_anchors": facts.get("story_anchors"),
        "numbers_present_in_story": facts.get("digits"),
        "timing_available": facts.get("timing_available"),
        "script_excerpt": (facts.get("corpus") or "")[:6000],
    }
    compact_taxonomy = {
        "branded": [record["term"] for record in keyword_plan.get("branded", [])],
        "primary": [record["term"] for record in keyword_plan.get("primary", [])],
        "secondary": [record["term"] for record in keyword_plan.get("secondary", [])],
        "story_specific": [record["term"] for record in keyword_plan.get("story_specific", [])],
        "long_tail": [record["term"] for record in keyword_plan.get("long_tail", [])],
        "rejected_for_this_story": [
            {"term": record.get("term"), "reason": record.get("reason")}
            for record in keyword_plan.get("rejected", [])
        ],
    }
    if repair_errors:
        repair = (
            "================ REPAIR REQUIRED ================\n"
            "Your previous response failed deterministic validation with these errors:\n"
            + "\n".join(f"  - {error}" for error in repair_errors[:20])
            + "\nFix every listed error and return the COMPLETE JSON object again. "
              "Do not explain, do not apologise, and do not add new facts.\n"
        )
    else:
        repair = ""
    return prompts.render("seo", {
        "CHANNEL_PROFILE_JSON": json.dumps(CHANNEL_PROFILE, ensure_ascii=False, indent=2),
        "CONTENT_POLICY_JSON": json.dumps(_policy_of(facts), ensure_ascii=False, indent=2),
        "UPLOAD_SCHEDULE_JSON": json.dumps(_schedule_of(facts), ensure_ascii=False, indent=2),
        "KEYWORD_TAXONOMY_JSON": json.dumps(compact_taxonomy, ensure_ascii=False, indent=2),
        "STORY_FACTS_JSON": json.dumps(compact_facts, ensure_ascii=False, indent=2),
        "REPAIR_INSTRUCTION": repair,
    })


# ---------------------------------------------------------------------------------------
# Package assembly / rendering
# ---------------------------------------------------------------------------------------
SEO_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schema" / "seo.schema.json"


def validate_package_schema(package: dict) -> None:
    """Validate the assembled package against `scripting/schema/seo.schema.json`.

    This is the last gate before anything is written: a package that does not satisfy the
    versioned schema is never saved, so a caller can never receive an incomplete file.
    """
    try:
        import jsonschema
    except ImportError as error:  # pragma: no cover - jsonschema is in requirements.txt
        raise SeoGenerationError(
            "the jsonschema package is required to validate SEO packages; "
            "run `pip install -r requirements.txt`"
        ) from error
    try:
        schema = json.loads(SEO_SCHEMA_PATH.read_text(encoding="utf-8"))
    except OSError as error:
        raise SeoGenerationError(f"the SEO package schema is unavailable: {error}") from None

    problems = sorted(
        jsonschema.Draft202012Validator(schema).iter_errors(package),
        key=lambda problem: [str(part) for part in problem.absolute_path],
    )
    if not problems:
        return
    details = []
    for problem in problems[:10]:
        where = "/".join(str(part) for part in problem.absolute_path) or "<root>"
        details.append(f"{where}: {problem.message}")
    raise SeoGenerationError(
        f"the generated SEO package does not satisfy schema v{SEO_SCHEMA_VERSION}; "
        "no package was written",
        details,
    )


def _keyword_slice(plan: dict, group: str, limit: int) -> list[dict]:
    return [dict(record) for record in plan.get(group, [])[:limit]]


# ---------------------------------------------------------------------------------------
# Explicit editorial input (human decisions, never silently mixed with model output)
# ---------------------------------------------------------------------------------------
def seo_editorial_file(project_file: str | Path, explicit: str | Path | None = None) -> Path | None:
    """Locate the project-level editorial file.

    The default is `<project dir>/seo-editorial.json`; `--editorial` may point elsewhere. The
    file is optional, so a project without it behaves exactly as before.
    """
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            raise SeoInputError(f"editorial file not found: {path}")
        return path
    candidate = Path(project_file).resolve().parent / EDITORIAL_FILE_NAME
    return candidate if candidate.is_file() else None


def load_editorial(path: Path) -> dict:
    """Read and type-check the editorial file. Raises SeoInputError; never guesses."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise SeoInputError(f"editorial file is unreadable: {error}") from None
    except json.JSONDecodeError as error:
        raise SeoInputError(
            f"editorial file is not valid JSON: {error.msg} at position {error.pos}"
        ) from None
    if not isinstance(data, dict):
        raise SeoInputError("editorial file must contain a JSON object")
    for key in ("title", "title_primary_phrase", "title_reason", "reason", "description",
                "pinned_comment"):
        if key in data and data[key] is not None and not isinstance(data[key], str):
            raise SeoInputError(f"editorial.{key} must be a string")
    for key in ("tags", "hashtags"):
        if key in data and data[key] is not None:
            if not isinstance(data[key], list) or not all(isinstance(item, str) for item in data[key]):
                raise SeoInputError(f"editorial.{key} must be a list of strings")
    if "thumbnail" in data and data["thumbnail"] is not None and not isinstance(data["thumbnail"], dict):
        raise SeoInputError("editorial.thumbnail must be an object")
    return data


def apply_editorial(candidate: dict, editorial: dict, facts: dict) -> tuple[dict, list[str]]:
    """Replace model fields with explicit editor-supplied copy.

    Returns the merged candidate and the list of fields that were actually overridden. The
    original model response stays in `raw/attempt-*.txt`; this function never deletes it.
    """
    merged = copy.deepcopy(candidate)
    applied: list[str] = []

    title = _clean(editorial.get("title"))
    if title:
        titles = merged.get("title_candidates")
        if not isinstance(titles, list):
            titles = []
        parsed = [item if isinstance(item, dict) else {"text": _clean(item)} for item in titles]
        parsed = [item for item in parsed if _clean(item.get("text"))]
        if _find_title_index(parsed, title) is None:
            editorial_candidate = {
                "text": title,
                "hook_type": "editorial",
                "primary_phrase": (
                    _clean(editorial.get("title_primary_phrase"))
                    or _clean(facts.get("title"))
                    or title
                ),
                "source_refs": ["script.raw_text"],
                "why": _clean(editorial.get("title_reason")) or "explicit editorial choice",
            }
            if parsed:
                # Replace the weakest candidate, so the package still carries exactly three and
                # the dropped candidate remains visible in the raw model response.
                ranked = rank_title_candidates(parsed)
                weakest = max(ranked, key=lambda item: item.get("heuristic_rank") or 0)
                index = _find_title_index(parsed, weakest.get("text", ""))
                parsed[index if index is not None else len(parsed) - 1] = editorial_candidate
            else:
                parsed.append(editorial_candidate)
        merged["title_candidates"] = parsed
        applied.append("title")

    if _clean_block(editorial.get("description")):
        merged["description"] = editorial["description"]
        applied.append("description")
    if _clean_block(editorial.get("pinned_comment")):
        merged["pinned_comment"] = editorial["pinned_comment"]
        applied.append("pinned_comment")
    if isinstance(editorial.get("tags"), list) and editorial["tags"]:
        merged["tags"] = list(editorial["tags"])
        applied.append("tags")
    if isinstance(editorial.get("hashtags"), list) and editorial["hashtags"]:
        merged["hashtags"] = list(editorial["hashtags"])
        applied.append("hashtags")

    thumbnail = editorial.get("thumbnail")
    if isinstance(thumbnail, dict):
        merged_thumbnail = merged.get("thumbnail") if isinstance(merged.get("thumbnail"), dict) else {}
        merged_thumbnail = dict(merged_thumbnail)
        for key in ("text", "main_subject", "composition", "background_lighting",
                    "color_contrast", "image_prompt"):
            if _clean(thumbnail.get(key)):
                merged_thumbnail[key] = thumbnail[key]
        merged["thumbnail"] = merged_thumbnail
        applied.append("thumbnail")

    return merged, applied


def editorial_metadata(path: Path, editorial: dict, applied: list[str]) -> dict:
    """Audit record for the package: which fields the editor replaced and why."""
    info = {
        "source": str(path),
        "sha256": sha256_file(path),
        "reason": _clean(editorial.get("reason")),
        "applied_fields": list(applied),
        "original_model_output": "preserved in seo/raw/attempt-*.txt",
        "note": (
            "These fields are explicit editor decisions. They are validated by the same story "
            "grounding, policy and platform-limit checks as model output; they are not scored "
            "by the title heuristic and are never presented as model recommendations."
        ),
    }
    if "title" in applied:
        info["title"] = {
            "text": _clean(editorial.get("title")),
            "reason": _clean(editorial.get("title_reason")),
            "primary_phrase": (
                _clean(editorial.get("title_primary_phrase"))
                or _clean(editorial.get("title"))
            ),
        }
    return info


def assemble_package(fields: dict, facts: dict, keyword_plan: dict, metadata: dict) -> dict:
    channel = dict(CHANNEL_PROFILE)
    package = {
        "schema_version": SEO_SCHEMA_VERSION,
        "engine_version": ENGINE_VERSION,
        "project_id": facts["project_id"],
        "project_file": facts.get("project_file"),
        "story_title": facts.get("title"),
        "channel_profile": channel,
        "content_policy": _policy_of(facts),
        "story_summary": build_story_summary(facts, fields.get("model_story_summary")),
        "keyword_ranking_basis": PRIORITY_BASIS,
        "branded_keywords": _keyword_slice(keyword_plan, "branded", 6),
        "primary_keywords": _keyword_slice(keyword_plan, "primary", 8),
        "secondary_keywords": _keyword_slice(keyword_plan, "secondary", 12),
        "long_tail_keywords": _keyword_slice(keyword_plan, "long_tail", 10),
        "keyword_plan_rejections": [dict(record) for record in keyword_plan.get("rejected", [])],
        "story_keywords": [
            {
                "term": term,
                "class": "story_specific",
                "intent": "story",
                "priority_basis": PRIORITY_BASIS,
                "source_refs": ["scenes[*]", "script.raw_text"],
            }
            for term in fields.get("story_keywords", [])
        ],
        "title_candidates": fields["title_candidates"],
        "recommended_title_index": fields["recommended_title_index"],
        "recommended_title": fields["recommended_title"],
        "title_rationale": fields["title_rationale"],
        "title_selection": fields.get("title_selection"),
        "editorial_overrides": metadata.get("editorial_overrides"),
        "description": fields["description"],
        "tags": fields["tags"],
        "tag_character_count": sum(_chars(tag) for tag in fields["tags"]) + max(0, len(fields["tags"]) - 1),
        "hashtags": fields["hashtags"],
        "pinned_comment": fields["pinned_comment"],
        "thumbnail_text": fields["thumbnail_text"],
        "thumbnail_concept": fields["thumbnail_concept"],
        "thumbnail_image_prompt": fields["thumbnail_image_prompt"],
        "thumbnail_style": (
            "2D semi-realistic cartoon horror, bold clean outlines, smooth flat cel shading, "
            "natural adult human proportions, dark edge vignette, high saturation, 16:9, no watermark"
        ),
        "shorts_concepts": fields["shorts_concepts"],
        "generation_metadata": metadata,
        "validation_warnings": list(metadata.get("validation_warnings", [])),
    }
    return package


def render_markdown(package: dict) -> str:
    lines: list[str] = []
    meta = package.get("generation_metadata", {})
    lines.append(f"# SEO package — {package.get('story_title') or package['project_id']}")
    lines.append("")
    lines.append(f"- project: `{package['project_id']}`")
    lines.append(f"- generation: {meta.get('generation')} ({'regenerated' if meta.get('regenerated') else 'first run'})")
    lines.append(f"- generated: {meta.get('generated_at')}")
    lines.append(f"- engine: {package.get('engine_version')}")
    lines.append(f"- model: {meta.get('provider', {}).get('provider')} / {meta.get('provider', {}).get('model')}")
    lines.append(f"- schema: v{package.get('schema_version')}")
    if meta.get("approval_required_for_publishing"):
        lines.append("- publishing metadata: **not approved** (review before use)")
    lines.append("")

    policy = package.get("content_policy") or {}
    if policy:
        lines.append("## Content policy")
        lines.append("")
        lines.append(f"- mode: **{policy.get('mode')}** (source: {policy.get('source')})")
        if policy.get("fiction"):
            lines.append("- the story is fictional entertainment; no title, tag, hashtag, description "
                         "or comment may claim it is a real/true incident")
            lines.append(f"- disclosure: {policy.get('disclosure_hi')}")
        lines.append("")

    lines.append("## Recommended title")
    lines.append("")
    lines.append(f"**{package['recommended_title']}**  ({_chars(package['recommended_title'])}/100 characters)")
    lines.append("")
    lines.append(package["title_rationale"])
    lines.append("")
    selection = package.get("title_selection") or {}
    if selection:
        lines.append(
            f"- selection: **{selection.get('method')}** | score {selection.get('selected_score')}/100 | "
            f"rank {selection.get('selected_rank')}/3 | model index "
            f"{selection.get('model_recommended_index')} | agrees: {selection.get('model_agrees')}"
        )
        if selection.get("tie_break"):
            lines.append(f"- tie-break: {selection['tie_break']}")
        if selection.get("override"):
            override = selection["override"]
            lines.append(
                f"- editorial override: {override.get('reason')} "
                f"(score gap {override.get('score_gap')} vs top-ranked "
                f"'{override.get('top_ranked_text')}')"
            )
        lines.append("")

    editorial = package.get("editorial_overrides") or {}
    if editorial.get("applied_fields"):
        lines.append("## Editorial overrides")
        lines.append("")
        lines.append(
            f"Explicit editor copy replaced: {', '.join(editorial['applied_fields'])}. "
            f"Source: `{editorial.get('source')}` (sha256 {editorial.get('sha256')})."
        )
        if editorial.get("reason"):
            lines.append("")
            lines.append(editorial["reason"])
        lines.append("")

    lines.append("## Title candidates")
    lines.append("")
    lines.append("| # | Title | Characters | Hook | Heuristic | Rank |")
    lines.append("|---|---|---:|---|---:|---:|")
    for index, candidate in enumerate(package["title_candidates"], 1):
        mark = "✅" if candidate["text"] == package["recommended_title"] else ""
        lines.append(
            f"| {index} | {candidate['text']} {mark} | {_chars(candidate['text'])} | "
            f"{candidate.get('hook_type', '')} | {candidate.get('heuristic_score', '')} | "
            f"{candidate.get('heuristic_rank', '')} |"
        )
    lines.append("")

    lines.append("## Description")
    lines.append("")
    lines.append("```text")
    lines.append(package["description"])
    lines.append("```")
    lines.append("")

    lines.append("## Tags")
    lines.append("")
    lines.append(f"{len(package['tags'])} tags, {package['tag_character_count']}/500 characters combined.")
    lines.append("")
    lines.append(", ".join(package["tags"]))
    lines.append("")

    lines.append("## Hashtags")
    lines.append("")
    lines.append(" ".join(package["hashtags"]))
    lines.append("")

    lines.append("## Pinned comment")
    lines.append("")
    lines.append("```text")
    lines.append(package["pinned_comment"])
    lines.append("```")
    lines.append("")

    lines.append("## Thumbnail")
    lines.append("")
    lines.append(f"**Text:** {package['thumbnail_text']}")
    lines.append("")
    concept = package["thumbnail_concept"]
    for label, key in (("Main subject", "main_subject"), ("Composition", "composition"),
                       ("Background & lighting", "background_lighting"),
                       ("Colour & contrast", "color_contrast")):
        lines.append(f"- **{label}:** {concept.get(key, '')}")
    lines.append("")
    lines.append("**Image prompt**")
    lines.append("")
    lines.append("```text")
    lines.append(package["thumbnail_image_prompt"])
    lines.append("```")
    lines.append("")

    lines.append("## Shorts concepts")
    lines.append("")
    for index, concept in enumerate(package["shorts_concepts"], 1):
        lines.append(f"### Short {index}")
        lines.append("")
        lines.append(f"- **Hook:** {concept['hook']}")
        lines.append(f"- **Title:** {concept['title']}")
        lines.append(f"- **Opening narration:** {concept['opening_narration']}")
        lines.append(f"- **Scenes:** {', '.join(str(n) for n in concept['scene_refs']) or 'none verifiable'}")
        lines.append(f"- **CTA:** {concept['cta']}")
        lines.append(f"- **Hashtags:** {' '.join(concept['hashtags'])}")
        lines.append(f"- **Timing:** {concept['timing_note']}")
        lines.append("")
        lines.append("```text")
        lines.append(concept["description"])
        lines.append("```")
        lines.append("")

    lines.append("## Keywords")
    lines.append("")
    for group, label in (("primary_keywords", "Primary"), ("secondary_keywords", "Secondary"),
                         ("long_tail_keywords", "Long tail"), ("story_keywords", "Story-specific"),
                         ("branded_keywords", "Branded")):
        entries = package.get(group, [])
        if not entries:
            continue
        lines.append(f"### {label}")
        lines.append("")
        lines.append("| Term | Intent | Priority | Heuristic |")
        lines.append("|---|---|---|---:|")
        for entry in entries:
            lines.append(
                f"| {entry['term']} | {entry.get('intent', '')} | {entry.get('priority', '')} | "
                f"{entry.get('heuristic_score', '')} |"
            )
        lines.append("")
    lines.append(f"_Priority basis: {package['keyword_ranking_basis']}_")
    lines.append("")

    rejections = package.get("keyword_plan_rejections") or []
    if rejections:
        lines.append("### Rejected for this story")
        lines.append("")
        lines.append("Catalogue terms that were deliberately not used, with the reason:")
        lines.append("")
        lines.append("| Term | Class | Reason |")
        lines.append("|---|---|---|")
        for record in rejections:
            lines.append(f"| {record.get('term', '')} | {record.get('class', '')} | {record.get('reason', '')} |")
        lines.append("")

    warnings = package.get("validation_warnings") or []
    lines.append("## Validation warnings")
    lines.append("")
    if warnings:
        for warning in warnings:
            lines.append(f"- {warning}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Review checklist")
    lines.append("")
    lines.append("1. Read the recommended title and confirm it matches the story.")
    lines.append("2. Read the description top-to-bottom; check the hook, teaser, CTA and final hashtag line.")
    lines.append("3. Confirm the thumbnail text fits the story and the image prompt matches the channel style.")
    lines.append("4. Approve the metadata mapping explicitly before using it:")
    lines.append("")
    lines.append("```powershell")
    lines.append(f"npm run video -- seo --project \"<path to pipeline.json>\" --approve-metadata --yes --by \"<your name>\"")
    lines.append("```")
    lines.append("")
    lines.append("Nothing here is uploaded or published automatically.")
    lines.append("")
    return "\n".join(lines)


def build_metadata_mapping(package: dict, package_sha256: str) -> dict:
    return {
        "schema_version": 1,
        "project_id": package["project_id"],
        "status": "pending_review",
        "youtube": {
            "title": package["recommended_title"],
            "description": package["description"],
            "tags": package["tags"],
            "hashtags": package["hashtags"],
            "visibility_recommendation": "private",
        },
        "source_package": {
            "file": PACKAGE_JSON_NAME,
            "sha256": package_sha256,
            "generation": package["generation_metadata"]["generation"],
        },
        "approval": {
            "required": True,
            "approved": False,
            "approved_at": None,
            "approved_by": None,
        },
        "publisher_integration": {
            "automatic": False,
            "note": (
                "This mapping is documentation only. The publisher (src/zernio.ts) never reads it; "
                "a human must copy approved metadata into the publishing command or YouTube Studio."
            ),
        },
        "created_at": utc_now(),
    }


# ---------------------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------------------
def resolve_project_file(project: str | None, project_id: str | None) -> Path:
    if project:
        path = Path(project).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        return path.resolve()
    if project_id:
        root = resolve_projects_root()
        return (root / project_id / "pipeline.json").resolve()
    raise SeoInputError("pass --project <pipeline.json> or --project-id <id>")


def seo_paths(project_file: str | Path, seo_root: str | Path | None = None) -> dict:
    project_path = Path(project_file).resolve()
    root = Path(seo_root).resolve() if seo_root else project_path.parent / SEO_DIR_NAME
    return {
        "root": root,
        "package": root / PACKAGE_JSON_NAME,
        "markdown": root / PACKAGE_MD_NAME,
        "metadata": root / METADATA_JSON_NAME,
        "editorial": root / EDITORIAL_FILE_NAME,
        "raw": root / RAW_DIR_NAME,
        "history": root / HISTORY_DIR_NAME,
    }


# ---------------------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------------------
def _effective_max_attempts(value: int | None) -> int:
    if value is not None:
        return max(1, min(HARD_MAX_ATTEMPTS, int(value)))
    env = os.environ.get("SEO_MAX_ATTEMPTS")
    if env and env.strip().isdigit():
        return max(1, min(HARD_MAX_ATTEMPTS, int(env)))
    return DEFAULT_MAX_ATTEMPTS


def _previous_generation(paths: dict) -> int:
    try:
        prior = json.loads(paths["package"].read_text(encoding="utf-8"))
        value = prior.get("generation_metadata", {}).get("generation")
        return int(value) if isinstance(value, int) and value >= 1 else 0
    except (OSError, ValueError, TypeError):
        return 0


def _existing_package_error(paths: dict) -> SeoRefusedError:
    return SeoRefusedError(
        f"an SEO package already exists at {paths['package']}; pass --regenerate to replace it "
        "(the previous package is archived under seo/history/)"
    )


def _generation_payload(paths: dict) -> dict[str, bytes]:
    """Byte-for-byte snapshot of the files the *current* generation owns.

    Captured BEFORE a new run writes anything, because the attempt loop overwrites
    `raw/attempt-NN.txt`; reading it afterwards would archive the new generation's bytes under
    the old generation's name.
    """
    payload: dict[str, bytes] = {}
    for source, relative in ((paths["package"], PACKAGE_JSON_NAME),
                             (paths["markdown"], PACKAGE_MD_NAME),
                             (paths["metadata"], METADATA_JSON_NAME),
                             (paths.get("editorial"), EDITORIAL_FILE_NAME)):
        if source is not None and source.is_file():
            payload[relative] = source.read_bytes()
    if paths["raw"].is_dir():
        for attempt in sorted(paths["raw"].glob("attempt-*.txt")):
            if attempt.is_file():
                payload[f"{RAW_DIR_NAME}/{attempt.name}"] = attempt.read_bytes()
    return payload


def _snapshot_generation(paths: dict, generation: int, payload: dict[str, bytes]) -> dict:
    """Write (or verify) `seo/history/generation-NNN-<stamp>/` plus a sha256 manifest.

    A generation is snapshotted once, at creation. A later regeneration presents the same
    bytes again for the outgoing generation; those bytes are *verified* against the existing
    manifest instead of being overwritten, so history stays immutable and a mismatch is a hard
    error rather than silent data loss.
    """
    existing = sorted(paths["history"].glob(f"generation-{generation:03d}-*")) if paths["history"].is_dir() else []
    for target in existing:
        manifest_path = target / "manifest.json"
        if not manifest_path.is_file():
            raise SeoGenerationError(
                f"generation {generation} already has a directory without a manifest: {target}"
            )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        recorded = {record["path"]: record for record in manifest.get("files", [])}
        if set(recorded) != set(payload.keys()):
            continue
        mismatched = [
            relative for relative, data in payload.items()
            if recorded[relative].get("sha256") != hashlib.sha256(data).hexdigest().upper()
            or recorded[relative].get("bytes") != len(data)
            or (target / relative).read_bytes() != data
        ]
        if not mismatched:
            return manifest
    # No byte-identical snapshot exists. A new snapshot is written rather than overwriting an
    # older one: metadata can legitimately change after approval, and history must stay intact.
    relative_dir = f"generation-{generation:03d}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    target = paths["history"] / relative_dir
    target.mkdir(parents=True, exist_ok=True)

    files: list[dict] = []

    for relative, data in payload.items():
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        files.append({
            "path": relative.replace("\\", "/"),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest().upper(),
        })

    manifest = {
        "generation": generation,
        "archived_at": utc_now(),
        "directory": relative_dir,
        "files": files,
    }
    _write_text_atomic(target / "manifest.json",
                       json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def generate_seo(project: dict, client, *, project_file: str | Path, regenerate: bool = False,
                 seo_root: str | Path | None = None, max_attempts: int | None = None,
                 provider_info: dict | None = None,
                 editorial_path: str | Path | None = None) -> dict:
    """Generate and validate one SEO package.

    Raises SeoInputError / SeoRefusedError / SeoGenerationError. Never writes a package on
    failure, so a caller can never mistake a failure for success.

    An optional project-level `seo-editorial.json` (or `editorial_path`) supplies explicit
    editor copy. Overridden fields are still validated and are recorded in the package; the
    model's original response remains in `raw/attempt-*.txt`.
    """
    paths = seo_paths(project_file, seo_root)
    facts = extract_story_facts(project, str(project_file))
    keyword_plan = build_keyword_plan(facts)
    editorial_file = seo_editorial_file(project_file, editorial_path)
    editorial = load_editorial(editorial_file) if editorial_file else None

    if paths["package"].exists() and not regenerate:
        raise _existing_package_error(paths)

    # Capture the outgoing generation BEFORE any write: the attempt loop rewrites
    # raw/attempt-NN.txt, so a late read would archive the new bytes under the old generation.
    previous_generation = _previous_generation(paths) if paths["package"].exists() else 0
    generation = previous_generation + 1 if (paths["package"].exists() and regenerate) else 1
    prior_payload = (
        _generation_payload(paths)
        if (paths["package"].exists() and regenerate) else {}
    )
    previous_sha = sha256_file(paths["package"]) if paths["package"].exists() else None

    attempts_allowed = _effective_max_attempts(max_attempts)
    paths["raw"].mkdir(parents=True, exist_ok=True)

    last_errors: list[str] = []
    warnings: list[str] = []
    prompt_hashes: list[str] = []
    used_attempts = 0
    editorial_applied: list[str] = []
    editorial_info: dict | None = None

    for record in keyword_plan.get("rejected", []):
        warnings.append(
            f"keyword rejected for this story: {record.get('term')} — {record.get('reason')}"
        )

    for attempt in range(1, attempts_allowed + 1):
        used_attempts = attempt
        prompt = build_prompt(facts, keyword_plan, last_errors if attempt > 1 else None)
        prompt_hashes.append(sha256_text(prompt))
        raw = client.complete(prompt, max_tokens=PROMPT_MAX_TOKENS, temperature=0)
        _write_text_atomic(paths["raw"] / f"attempt-{attempt:02d}.txt", raw)

        try:
            candidate = parse_seo_json(raw)
        except ValueError as error:
            last_errors = [f"JSON: {error}"]
            warnings.append(f"attempt {attempt}: {error}")
            continue

        attempt_editorial: list[str] = []
        if editorial:
            candidate, attempt_editorial = apply_editorial(candidate, editorial, facts)

        fields, errors, attempt_warnings = validate_candidate(candidate, facts, keyword_plan,
                                                              editorial=editorial)
        if errors:
            last_errors = errors
            warnings.append(
                f"attempt {attempt}: {len(errors)} validation error(s): " + "; ".join(errors[:6])
            )
            continue

        editorial_applied = attempt_editorial
        if editorial:
            editorial_info = editorial_metadata(editorial_file, editorial, editorial_applied)
            editorial_info["archived_as"] = f"{SEO_DIR_NAME}/{EDITORIAL_FILE_NAME}"
            if editorial_applied:
                warnings.append(
                    "explicit editorial overrides applied (recorded in generation_metadata): "
                    + ", ".join(editorial_applied)
                )
        warnings.extend(attempt_warnings)
        break
    else:
        raise SeoGenerationError(
            f"SEO generation failed after {used_attempts} attempt(s); no package was written",
            last_errors or ["unknown validation failure"],
        )

    snapshot = (
        _snapshot_generation(paths, previous_generation, prior_payload)
        if prior_payload else None
    )

    # The raw directory is an audit trail, not a pile: keep only the attempts of THIS run so a
    # later reader cannot mistake an older generation's response for the current one.
    for attempt in sorted(paths["raw"].glob("attempt-*.txt")):
        match = re.fullmatch(r"attempt-(\d+)\.txt", attempt.name)
        if not match or int(match.group(1)) > used_attempts:
            attempt.unlink()

    metadata = {
        "generated_at": utc_now(),
        "generation": generation,
        "regenerated": bool(paths["package"].exists() and regenerate),
        "previous_generation_snapshot": (
            {"generation": snapshot["generation"], "directory": snapshot["directory"],
             "files": snapshot["files"]}
            if snapshot else None
        ),
        "engine_version": ENGINE_VERSION,
        "keyword_taxonomy_version": KEYWORD_ENGINE_VERSION,
        "provider": provider_info or {"provider": "unknown", "model": "unknown"},
        "attempts": used_attempts,
        "repair_attempts": max(0, used_attempts - 1),
        "max_attempts": attempts_allowed,
        "prompt_template": "scripting/prompts/8- SEO.txt",
        "prompt_sha256": prompt_hashes[-1],
        "previous_package_sha256": previous_sha,
        "editorial_overrides": editorial_info,
        "deterministic_postprocessing": [
            "unicode_normalization",
            "title_limit_enforcement",
            "title_ranking_and_selection",
            "tag_dedupe_and_character_budget",
            "hashtag_validation_and_relevance_filter",
            "fiction_claim_filter",
            "story_topic_relevance_filter",
            "description_hashtag_append",
            "fiction_disclosure_enforcement",
            "keyword_stuffing_detection",
            "story_grounding_check",
            "source_reference_verification",
        ] + (["explicit_editorial_overrides"] if editorial_applied else []),
        "keyword_data_basis": PRIORITY_BASIS,
        "approval_required_for_publishing": True,
        "source_index": facts.get("source_index"),
        "validation_warnings": warnings,
    }

    package = assemble_package(fields, facts, keyword_plan, metadata)
    validate_package_schema(package)
    package_text = json.dumps(package, ensure_ascii=False, indent=2, sort_keys=False)
    # Round-trip guarantee: never write a file that Python cannot read back.
    if json.loads(package_text) != package:
        raise SeoGenerationError("internal JSON round-trip check failed; no package was written")

    package_sha = sha256_text(package_text)
    markdown_text = render_markdown(package)
    metadata_mapping = build_metadata_mapping(package, package_sha)

    if regenerate and paths["package"].exists():
        prior_json = paths["package"].read_text(encoding="utf-8")
        prior_markdown = paths["markdown"].read_text(encoding="utf-8") if paths["markdown"].exists() else ""
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        paths["history"].mkdir(parents=True, exist_ok=True)
        _write_text_atomic(paths["history"] / f"seo-package-gen{generation - 1:03d}-{stamp}.json", prior_json)
        if prior_markdown:
            _write_text_atomic(paths["history"] / f"seo-package-gen{generation - 1:03d}-{stamp}.md", prior_markdown)

    _write_text_atomic(paths["package"], package_text)
    _write_text_atomic(paths["markdown"], markdown_text)
    _write_text_atomic(paths["metadata"], json.dumps(metadata_mapping, ensure_ascii=False, indent=2))
    if editorial:
        _write_bytes_atomic(paths["editorial"], editorial_file.read_bytes())

    # Every generation is immutable at creation, not only when a later run archives it. The
    # snapshot is verified against the bytes just written, so a future regeneration cannot
    # silently replace it.
    current_snapshot = _snapshot_generation(paths, generation, _generation_payload(paths))

    return {
        "ok": True,
        "status": "REGENERATED" if metadata["regenerated"] else "CREATED",
        "project_id": facts["project_id"],
        "package_path": str(paths["package"]),
        "markdown_path": str(paths["markdown"]),
        "metadata_path": str(paths["metadata"]),
        "generation": generation,
        "generation_status": metadata_mapping["status"],
        "generation_snapshot": {
            "generation": current_snapshot["generation"],
            "directory": current_snapshot["directory"],
            "files": current_snapshot["files"],
        },
        "recommended_title": package["recommended_title"],
        "title_selection": package.get("title_selection"),
        "editorial_overrides": package.get("editorial_overrides"),
        "title_candidates": [candidate["text"] for candidate in package["title_candidates"]],
        "shorts": len(package["shorts_concepts"]),
        "tags": len(package["tags"]),
        "hashtags": package["hashtags"],
        "scenes": facts["scene_count"],
        "attempts": used_attempts,
        "warnings": warnings,
        "errors": [],
        "package_sha256": package_sha,
        "publisher_invoked": False,
        "network_used": False,
    }


def approve_metadata(project_file: str | Path, *, approved_by: str,
                     seo_root: str | Path | None = None) -> dict:
    """Explicitly approve the metadata mapping. Touches only seo/youtube-metadata.json."""
    paths = seo_paths(project_file, seo_root)
    if not paths["metadata"].exists():
        raise SeoInputError(
            f"no metadata mapping at {paths['metadata']}; run SEO generation first"
        )
    mapping = json.loads(paths["metadata"].read_text(encoding="utf-8"))
    if paths["package"].exists():
        current_sha = sha256_file(paths["package"])
        recorded = mapping.get("source_package", {}).get("sha256")
        if recorded and recorded != current_sha:
            raise SeoInputError(
                "the SEO package changed after this mapping was generated; regenerate the mapping "
                "before approving it"
            )
    by = _clean(approved_by)
    if not by:
        raise SeoInputError("--by <name> is required to record who approved the metadata")
    mapping["status"] = "approved"
    mapping["approval"] = {
        "required": True,
        "approved": True,
        "approved_at": utc_now(),
        "approved_by": by,
    }
    _write_text_atomic(paths["metadata"], json.dumps(mapping, ensure_ascii=False, indent=2))
    return {
        "ok": True,
        "status": "METADATA_APPROVED",
        "project_id": mapping.get("project_id"),
        "metadata_path": str(paths["metadata"]),
        "approved_by": by,
        "publisher_invoked": False,
        "network_used": False,
    }


# ---------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------
def _load_project(project_file: Path) -> dict:
    try:
        return json.loads(project_file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SeoInputError(f"project file not found: {project_file}") from None
    except json.JSONDecodeError as error:
        raise SeoInputError(f"project file is not valid JSON: {error.msg} at position {error.pos}") from None


def _print_report(report: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    if not report.get("ok"):
        print(f"status: {report.get('status', 'FAILED')}", file=sys.stderr)
        for detail in report.get("errors", [])[:20]:
            print(f"  - {detail}", file=sys.stderr)
        return
    if report.get("status") == "METADATA_APPROVED":
        print(f"Metadata:   {report['metadata_path']}")
        print(f"Approved by: {report.get('approved_by')}")
        print("")
        print("Local approval recorded. Nothing was uploaded or published, and the publisher")
        print("never reads this file; applying the metadata stays a manual step.")
        return
    print(f"SEO package: {report['package_path']}")
    print(f"Review doc:  {report['markdown_path']}")
    print(f"Metadata:    {report['metadata_path']} ({report.get('generation_status')})")
    print("")
    print(f"Recommended title: {report['recommended_title']}")
    selection = report.get("title_selection") or {}
    if selection:
        print(f"  selection: {selection.get('method')} | score {selection.get('selected_score')}/100 | "
              f"rank {selection.get('selected_rank')}/3 | model index {selection.get('model_recommended_index')}")
    for candidate in report.get("title_candidates", []):
        print(f"  - {candidate}")
    print("")
    print(f"tags: {report.get('tags')}  hashtags: {' '.join(report.get('hashtags', []))}")
    print(f"shorts: {report.get('shorts')}  scenes: {report.get('scenes')}  attempts: {report.get('attempts')}")
    if report.get("warnings"):
        print("")
        print("validation warnings:")
        for warning in report["warnings"]:
            print(f"  - {warning}")
    print("")
    print("Nothing was uploaded or published. Review the package, then approve the metadata explicitly.")


def run_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.seo",
        description="Generate a reviewable YouTube SEO package for a finished story project (no publishing).",
    )
    parser.add_argument("--project", default=None, help="Path to the project pipeline.json.")
    parser.add_argument("--project-id", default=None, help="Project id under the projects root.")
    parser.add_argument("--seo-root", default=None, help="Override the output directory (default: <project>/seo).")
    parser.add_argument("--regenerate", action="store_true",
                        help="Replace an existing package (the previous one is archived in seo/history/).")
    parser.add_argument("--extract-only", action="store_true",
                        help="Print the extracted story facts and keyword plan without calling the model.")
    parser.add_argument("--approve-metadata", action="store_true",
                        help="Approve seo/youtube-metadata.json for future use (requires --yes and --by).")
    parser.add_argument("--yes", action="store_true", help="Explicit confirmation for --approve-metadata.")
    parser.add_argument("--by", default=None, help="Name of the human approving the metadata.")
    parser.add_argument("--max-attempts", type=int, default=None,
                        help=f"Bounded generation attempts (1..{HARD_MAX_ATTEMPTS}, default {DEFAULT_MAX_ATTEMPTS}).")
    parser.add_argument("--model", default=None, help="Optional writing-model override.")
    parser.add_argument("--editorial", default=None,
                        help="Path to an explicit editorial JSON file (default: <project>/seo-editorial.json).")
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable JSON report.")
    args = parser.parse_args(argv)

    try:
        project_file = resolve_project_file(args.project, args.project_id)
    except SeoInputError as error:
        print(str(error), file=sys.stderr)
        return 2

    try:
        project = _load_project(project_file)

        if args.approve_metadata:
            if not args.yes or not args.by:
                print("--approve-metadata requires --yes and --by <name>.", file=sys.stderr)
                return 2
            report = approve_metadata(project_file, approved_by=args.by, seo_root=args.seo_root)
            _print_report(report, args.json)
            return 0

        facts = extract_story_facts(project, str(project_file))
        if args.extract_only:
            report = {
                "ok": True,
                "status": "EXTRACT_ONLY",
                "project_id": facts["project_id"],
                "facts": facts,
                "keyword_plan": build_keyword_plan(facts),
                "publisher_invoked": False,
                "network_used": False,
            }
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0

        from .anthropic_client import ScriptClient  # lazy: keeps tests dependency-free

        # Refuse BEFORE a provider client is constructed, so an existing package is reported as
        # "exists" (exit 3) even when no writing-model key is configured.
        existing = seo_paths(project_file, args.seo_root)
        if existing["package"].exists() and not args.regenerate:
            raise _existing_package_error(existing)

        client = ScriptClient(model=args.model)
        report = generate_seo(
            project,
            client,
            project_file=project_file,
            regenerate=args.regenerate,
            seo_root=args.seo_root,
            max_attempts=args.max_attempts,
            provider_info={"provider": client.provider, "model": client.model},
            editorial_path=args.editorial,
        )
        _print_report(report, args.json)
        return 0
    except SeoRefusedError as error:
        report = {"ok": False, "status": "EXISTS", "reason": str(error), "errors": [],
                  "publisher_invoked": False, "network_used": False}
        print(str(error), file=sys.stderr)
        _print_report(report, args.json)
        return error.code
    except SeoError as error:
        report = {"ok": False, "status": "FAILED", "reason": str(error),
                  "errors": error.details, "publisher_invoked": False, "network_used": False}
        print(str(error), file=sys.stderr)
        _print_report(report, args.json)
        return error.code
    except Exception as error:  # provider/network failure from the text client
        report = {"ok": False, "status": "FAILED",
                  "reason": f"{type(error).__name__}: {error}", "errors": [],
                  "publisher_invoked": False, "network_used": False}
        print(f"SEO generation failed: {type(error).__name__}: {error}", file=sys.stderr)
        _print_report(report, args.json)
        return 1


if __name__ == "__main__":
    raise SystemExit(run_cli())
