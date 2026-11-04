"""READ-ONLY project validation and story-quality audit.

`python -m pipeline.one_minute --project-id <id> --check` delegates here.

CONTRACT
  · It NEVER writes: no `save()`, no stage mutation, no file creation. The project is
    deep-copied before the canonical `validate()` runs, because `validate()` legitimately
    normalises prompts/timestamps as a side effect.
  · It NEVER calls a model, the network, or the publishing path.
  · Structural problems are ERRORS (`ok: false`, exit 1). Story-quality observations are
    WARNINGS (`ok: true`): generation is deterministic and the human makes the final call.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from .one_minute import MAX_SCENES, MIN_SCENES, validate

# A spoken/narrated beat shorter than this is treated as a thin hook, not a line.
MIN_HOOK_CHARS = 40
# Duplicate-line detection ignores very short interjections ("हाँ", "क्या?").
MIN_REPEAT_CHARS = 12
# Story length is generated as target ±15 words; flag only a real drift.
WORD_COUNT_LOW_RATIO = 0.60
WORD_COUNT_HIGH_RATIO = 1.40


def _normalise(text: Any) -> str:
    value = re.sub(r"\s+", " ", str(text or "").strip().lower())
    return value.strip(" .,!?;:-—…।")


def _scene_text(scene: dict) -> str:
    return " ".join(
        part
        for part in (
            str(scene.get("devanagari_dialogue") or "").strip(),
            str(scene.get("narration_text") or "").strip(),
        )
        if part
    ).strip()


def _finding(code: str, message: str, **extra: Any) -> dict:
    return {"code": code, "message": message, **extra}


def check_project(project: dict, scene_count: int | None = None) -> dict:
    """Pure audit of an in-memory project. Returns a JSON-serialisable report."""
    errors: list[dict] = []
    warnings: list[dict] = []

    scenes = project.get("scenes") if isinstance(project.get("scenes"), list) else []
    characters = project.get("characters") if isinstance(project.get("characters"), list) else []
    backgrounds = project.get("backgrounds") if isinstance(project.get("backgrounds"), list) else []
    script = project.get("script") if isinstance(project.get("script"), dict) else {}

    # ---- 1. canonical structural validation (on a copy: validate() normalises in place) ----
    try:
        validate(copy.deepcopy(project), scene_count)
    except Exception as error:  # noqa: BLE001 - every structural failure is reported, never raised
        errors.append(_finding("STRUCTURE_INVALID", str(error)))

    total = len(scenes)
    if not (MIN_SCENES <= total <= MAX_SCENES):
        errors.append(_finding("SCENE_COUNT_OUT_OF_RANGE", f"Expected {MIN_SCENES}-{MAX_SCENES} scenes, got {total}."))

    # ---- 2. narration coverage (the production gate that follows generation) ----
    silent = [
        str(scene.get("scene_number"))
        for scene in scenes
        if str(scene.get("speaker") or "") in {"NARRATOR", "none", ""}
        and not str(scene.get("narration_text") or "").strip()
    ]
    if silent:
        errors.append(_finding("NARRATION_MISSING", "Non-character scenes require narration_text.", scenes=silent))

    # ---- 3. spoken-beat repetition (user priority: no unnecessary repetition) ----
    seen: dict[str, list[int]] = {}
    for index, scene in enumerate(scenes, 1):
        for key in ("devanagari_dialogue", "narration_text"):
            line = _normalise(scene.get(key))
            if len(line) >= MIN_REPEAT_CHARS:
                seen.setdefault(line, []).append(index)
    for line, scene_numbers in seen.items():
        unique = sorted(set(scene_numbers))
        if len(unique) > 1:
            warnings.append(_finding(
                "REPEATED_LINE",
                f"The same spoken line appears in scenes {', '.join(map(str, unique))}: {line[:80]}",
                scenes=unique,
            ))

    # ---- 4. opening / ending strength ----
    if scenes:
        opening = _scene_text(scenes[0])
        if len(opening) < MIN_HOOK_CHARS:
            warnings.append(_finding(
                "WEAK_OPENING",
                f"Scene 1 has only {len(opening)} characters of spoken/narrated text; the first 15-30 seconds are the retention hook.",
                chars=len(opening),
            ))
        if not _scene_text(scenes[-1]):
            warnings.append(_finding("ENDING_UNCLEAR", "The final scene has no narration or dialogue; confirm the story resolves on screen."))

    # ---- 5. story length vs the duration contract ----
    raw_text = str(script.get("raw_text") or "")
    words = len(re.findall(r"\S+", raw_text))
    duration = script.get("duration_minutes")
    target = script.get("word_count")
    if not isinstance(target, int) and isinstance(duration, int):
        target = duration * 150
    if isinstance(target, int) and target > 0 and words > 0:
        if words < target * WORD_COUNT_LOW_RATIO or words > target * WORD_COUNT_HIGH_RATIO:
            warnings.append(_finding(
                "WORD_COUNT_OFF_TARGET",
                f"Story is {words} words against a {target}-word target ({WORD_COUNT_LOW_RATIO:.0%}-{WORD_COUNT_HIGH_RATIO:.0%} accepted).",
                words=words, target=target,
            ))

    # ---- 6. character-reference consistency ----
    names: dict[str, list[str]] = {}
    for character in characters:
        tag = str(character.get("tag") or "")
        name = _normalise(character.get("name"))
        if name:
            names.setdefault(name, []).append(tag)
        if character.get("age") is None or str(character.get("gender") or "") == "unknown" or str(character.get("profession") or "") == "unspecified":
            warnings.append(_finding(
                "CHARACTER_ATTRIBUTE_UNSPECIFIED",
                f"{tag or '(untagged)'} has an unspecified age/gender/profession; confirm the script truly omits it.",
                tag=tag,
            ))
    for name, tags in names.items():
        if len(set(tags)) > 1:
            warnings.append(_finding(
                "DUPLICATE_CHARACTER_NAME",
                f"Several character tags share the display name '{name}': {', '.join(sorted(set(tags)))}.",
                tags=sorted(set(tags)),
            ))

    # ---- 7. asset usage ----
    used_backgrounds = {str(scene.get("background_tag") or "") for scene in scenes}
    unused = [str(bg.get("tag") or "") for bg in backgrounds if str(bg.get("tag") or "") not in used_backgrounds]
    if unused:
        warnings.append(_finding("UNUSED_BACKGROUND", "Backgrounds are generated but never used by a scene.", tags=unused))

    used_characters = {str(tag) for scene in scenes for tag in (scene.get("character_tags") or [])}
    unused_characters = [str(ch.get("tag") or "") for ch in characters if str(ch.get("tag") or "") not in used_characters]
    if unused_characters:
        warnings.append(_finding("UNUSED_CHARACTER", "Characters are generated but never used by a scene.", tags=unused_characters))

    dialogue_scenes = sum(1 for scene in scenes if str(scene.get("devanagari_dialogue") or "").strip())
    narration_scenes = sum(1 for scene in scenes if str(scene.get("narration_text") or "").strip())

    return {
        "ok": not errors,
        "read_only": True,
        "project_id": str(project.get("project_id") or ""),
        "scenes": total,
        "characters": len(characters),
        "backgrounds": len(backgrounds),
        "stats": {
            "words": words,
            "word_target": target if isinstance(target, int) else None,
            "dialogue_scenes": dialogue_scenes,
            "narration_scenes": narration_scenes,
        },
        "errors": errors,
        "warnings": warnings,
    }


def _empty_report(project_file: str, code: str, message: str) -> dict:
    """Stable report shape for a project that could not even be read."""
    return {
        "ok": False,
        "read_only": True,
        "project_id": "",
        "scenes": 0,
        "characters": 0,
        "backgrounds": 0,
        "stats": {"words": 0, "word_target": None, "dialogue_scenes": 0, "narration_scenes": 0},
        "errors": [_finding(code, message)],
        "warnings": [],
        "project_file": project_file,
    }


def run_check(project_file: str | Path) -> dict:
    """Read one project file and audit it. Never writes, never normalises the file on disk."""
    path = Path(project_file)
    try:
        # utf-8-sig tolerates a BOM written by some editors/tools; a BOM otherwise breaks json.loads.
        project = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return _empty_report(str(path), "PROJECT_NOT_FOUND", f"No project file at {path}.")
    except json.JSONDecodeError as error:
        return _empty_report(str(path), "PROJECT_UNREADABLE", f"Project file is not valid JSON: {error}")
    except OSError as error:
        return _empty_report(str(path), "PROJECT_UNREADABLE", f"Project file could not be read: {error}")
    if not isinstance(project, dict):
        return _empty_report(str(path), "PROJECT_UNREADABLE", "Project file must contain a JSON object.")
    report = check_project(project)
    report["project_file"] = str(path)
    return report
