"""READ-ONLY project validation, story intelligence and scene intelligence.

`python -m pipeline.one_minute --project-id <id> --check` (or `--project-file <path>`)
delegates here; the TypeScript bridge (`production/src/storyValidation.ts`) shells out to
the same command, so there is exactly ONE authoritative validator.

CONTRACT
  · It NEVER writes: no `save()`, no stage mutation, no file creation. The project is
    deep-copied before the canonical `validate()` runs, because `validate()` legitimately
    normalises prompts/timestamps as a side effect.
  · It NEVER calls a model, the network, the browser, or the publishing path.
  · Findings are classified:
        BLOCKER  structural/config problem that makes production impossible or unsafe;
                 paid Flow generation must not be authorised.
        WARNING  a story/scene quality problem a human should review; it does NOT block.
        INFO     an observation that is useful context but needs no action.
  · Backward compatible: `ok` is still `not errors`, and `errors` / `warnings` still carry
    the historical codes. New machine-readable fields (`status`, `counts`, `findings`,
    `story_findings`, `scene_findings`, `info`, `recommended_actions`) are additive.

The canonical rules live in `one_minute.validate()` (structure, tags, speaker, wardrobe).
This module adds the explicit story/scene findings on top and imports the SAME helpers
(`_is_strict_project`, `_is_strict_character`, `_resolve_outfit`, `_appearance_text`,
`derive_camera_safety`) instead of duplicating them.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from .one_minute import (
    DEFAULT_SCENES_PER_MINUTE,
    MAX_SCENES,
    MIN_SCENES,
    _appearance_text,
    _is_strict_character,
    _is_strict_project,
    _resolve_outfit,
    derive_camera_safety,
    validate,
)

# ---- thresholds (all grounded in the existing generation contract, not invented) ----
# A spoken/narrated beat shorter than this is treated as a thin hook, not a line.
MIN_HOOK_CHARS = 40
# Duplicate-line detection ignores very short interjections ("हाँ", "क्या?").
MIN_REPEAT_CHARS = 12
# Story length is generated as target ±15 words; flag only a real drift.
WORD_COUNT_LOW_RATIO = 0.60
WORD_COUNT_HIGH_RATIO = 1.40
# `scripting/prompts/6- ANIMATION PROMPTS.txt` requires a describable SCENE ACTION,
# CAMERA and SOUND DESIGN for every scene. These floors mark placeholder text; the real
# committed project's shortest values are 143 / 85 / 68 characters.
MIN_VISUAL_ACTION_CHARS = 40
MIN_CAMERA_CHARS = 20
MIN_SOUND_DESIGN_CHARS = 8
# The story templates allow a natural scene count, so pacing is a drift warning only.
PACING_LOW_RATIO = 0.5
PACING_HIGH_RATIO = 1.5

__all__ = [
    "check_project",
    "run_check",
    "MIN_HOOK_CHARS",
    "MIN_REPEAT_CHARS",
    "MIN_VISUAL_ACTION_CHARS",
    "MIN_CAMERA_CHARS",
    "MIN_SOUND_DESIGN_CHARS",
]


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


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _finding(
    code: str,
    message: str,
    *,
    severity: str = "WARNING",
    scope: str | None = None,
    scene: int | None = None,
    field: str | None = None,
    recommendation: str | None = None,
    **extra: Any,
) -> dict:
    # A finding that names a scene belongs to the scene scope unless stated otherwise.
    resolved_scope = scope or ("scene" if scene is not None else "story")
    item: dict[str, Any] = {"code": code, "message": message, "severity": severity, "scope": resolved_scope}
    if scene is not None:
        item["scene"] = scene
    if field:
        item["field"] = field
    if recommendation:
        item["recommendation"] = recommendation
    item.update(extra)
    return item


def _add(findings: list[dict], severity: str, code: str, message: str, **kwargs: Any) -> None:
    findings.append(_finding(code, message, severity=severity, **kwargs))


_RECOMMENDATIONS: dict[str, str] = {
    "PROJECT_NOT_FOUND": "Check the project id/path; the pipeline file does not exist.",
    "PROJECT_UNREADABLE": "Fix the JSON file so it parses as a single UTF-8 object.",
    "PROJECT_ID_MISSING": "Set pipeline.project_id to the project directory name.",
    "CHARACTERS_INVALID": "Make pipeline.characters a JSON array.",
    "BACKGROUNDS_INVALID": "Make pipeline.backgrounds a JSON array.",
    "SCENES_INVALID": "Make pipeline.scenes a JSON array.",
    "STRUCTURE_INVALID": "Fix the structure reported by the canonical validator, then re-run validation.",
    "SCENE_COUNT_OUT_OF_RANGE": f"Use between {MIN_SCENES} and {MAX_SCENES} scenes.",
    "NARRATION_MISSING": "Add narration_text to every NARRATOR/none scene.",
    "INVALID_SCENE": "Every entry in scenes[] must be a JSON object.",
    "INVALID_SCENE_ID": "Set scene_number to a positive integer.",
    "DUPLICATE_SCENE_ID": "Give every scene a unique scene_number.",
    "SCENE_ORDER_INVALID": "Renumber scenes sequentially from 1 in story order.",
    "BACKGROUND_TAG_MISSING": "Set scene.background_tag to a tag defined in backgrounds[].",
    "UNKNOWN_BACKGROUND_REFERENCE": "Use only tags defined in backgrounds[], or add the missing background.",
    "CHARACTER_TAGS_INVALID": "Make scene.character_tags a JSON array of character tags.",
    "UNDEFINED_CHARACTER_REFERENCE": "Use only tags defined in characters[], or add the missing character.",
    "DUPLICATE_SCENE_CHARACTER": "Remove duplicate tags from scene.character_tags.",
    "SPEAKER_MISSING": "Set scene.speaker to NARRATOR, none, or a character tag.",
    "INVALID_SPEAKER": "Set scene.speaker to NARRATOR, none, or a tag defined in characters[].",
    "SPEAKER_NOT_IN_SCENE": "Add the speaker's tag to scene.character_tags, or change the speaker.",
    "DIALOGUE_MISSING": "Add the exact Devanagari line to every character-speaking scene.",
    "UNUSED_NARRATION": "Remove narration_text from character-speaking scenes; the native Flow voice is used.",
    "ORPHAN_DIALOGUE": "Remove devanagari_dialogue from NARRATOR/none scenes; it is never spoken.",
    "VISUAL_ACTION_MISSING": "Describe what happens in scene.visual_action.",
    "WEAK_VISUAL_ACTION": "Make scene.visual_action a specific, filmable beat.",
    "CAMERA_MISSING": "Describe the shot in scene.camera.",
    "CAMERA_UNDERSPECIFIED": "Give scene.camera a concrete angle/scale/movement.",
    "SOUND_DESIGN_MISSING": "Add scene.sound_design (ambience/SFX) so the clip is never silent.",
    "ANIMATION_PROMPT_MISSING": "Re-run `python -m pipeline.one_minute --check`/story generation so prompts materialise.",
    "CAMERA_UNSAFE_FOR_MULTI_CHARACTER": "Use a stable frontal/wide composition for multi-character scenes.",
    "WARDROBE_UNRESOLVED": "Give the character a valid default_outfit/outfits, or a valid scene outfit_ids override.",
    "APPEARANCE_LOCK_MISSING": "Add the strict appearance_lock fields for this character.",
    "LEGACY_APPEARANCE_CONTRACT": "Opt in with wardrobe_schema_version=1 and appearance_lock/wardrobe when ready.",
    "REPEATED_LINE": "Rewrite or remove the duplicated spoken line.",
    "REPETITIVE_SCENE": "Differentiate the repeated scene action, or merge the scenes.",
    "WEAK_OPENING": "Strengthen scene 1's hook (the first 15-30 seconds).",
    "ENDING_UNCLEAR": "Give the final scene a spoken/narrated resolution.",
    "ABRUPT_ENDING": "Resolve the story with a complete final beat, not a fragment.",
    "WORD_COUNT_OFF_TARGET": "Regenerate or trim the story to the configured duration.",
    "SCENE_PACING_OFF_TARGET": "Review scene density against the configured duration.",
    "NO_CHARACTER_DIALOGUE": "Consider one character-spoken beat; confirm a fully narrated story is intended.",
    "SUSPENSE_PROGRESSION_WEAK": "Add a character confrontation in the final third (climax).",
    "CHARACTER_ATTRIBUTE_UNSPECIFIED": "Confirm the script truly omits age/gender/profession.",
    "CHARACTER_PROMPT_MISSING": "Add the character reference prompt (or supply the character asset locally).",
    "CHARACTER_LOOK_MISSING": "Add look_summary or an appearance_lock.",
    "CHARACTER_VOICE_MISSING": "Add voice_description so the Flow voice contract is complete.",
    "DUPLICATE_CHARACTER_NAME": "Use distinct display names, or confirm they are intentionally the same person.",
    "BACKGROUND_LOCATION_MISSING": "Add location_name.",
    "BACKGROUND_PROMPT_MISSING": "Add look_summary/full_prompt (or supply the background PNG locally).",
    "UNUSED_BACKGROUND": "Remove unused backgrounds or use them in a scene.",
    "UNUSED_CHARACTER": "Remove unused characters or use them in a scene.",
    "SCRIPT_METADATA_MISSING": "Keep script.raw_text/word_count so length and pacing can be verified.",
    "DURATION_INVALID": "Set script.duration_minutes to a positive integer.",
    "WORD_TARGET_INVALID": "Set script.word_count to a positive integer.",
}


def _recommended_actions(findings: list[dict]) -> list[str]:
    actions: list[str] = []
    for finding in findings:
        action = finding.get("recommendation") or _RECOMMENDATIONS.get(str(finding.get("code") or ""))
        if action and action not in actions:
            actions.append(action)
    return actions


def check_project(project: dict, scene_count: int | None = None) -> dict:
    """Pure audit of an in-memory project. Returns a JSON-serialisable report."""
    findings: list[dict] = []

    scenes = project.get("scenes") if isinstance(project.get("scenes"), list) else []
    characters = project.get("characters") if isinstance(project.get("characters"), list) else []
    backgrounds = project.get("backgrounds") if isinstance(project.get("backgrounds"), list) else []
    script = project.get("script") if isinstance(project.get("script"), dict) else {}

    # ---- 0. required schema shape (backward compatible: only what production cannot do without) ----
    project_id = project.get("project_id")
    if not isinstance(project_id, str) or not project_id.strip():
        _add(findings, "BLOCKER", "PROJECT_ID_MISSING",
             "pipeline.project_id is required and must be a non-empty string.", field="project_id")
    for key, value in (("characters", project.get("characters")),
                       ("backgrounds", project.get("backgrounds")),
                       ("scenes", project.get("scenes"))):
        if not isinstance(value, list):
            _add(findings, "BLOCKER", f"{key.upper()}_INVALID",
                 f"pipeline.{key} must be a JSON array.", field=key)

    # ---- 1. canonical structural validation (on a copy: validate() normalises in place) ----
    try:
        validate(copy.deepcopy(project), scene_count)
    except Exception as error:  # noqa: BLE001 - every structural failure is reported, never raised
        _add(findings, "BLOCKER", "STRUCTURE_INVALID", str(error))

    total = len(scenes)
    if not (MIN_SCENES <= total <= MAX_SCENES):
        _add(findings, "BLOCKER", "SCENE_COUNT_OUT_OF_RANGE",
             f"Expected {MIN_SCENES}-{MAX_SCENES} scenes, got {total}.")

    character_by_tag = {
        str(character.get("tag") or ""): character
        for character in characters
        if isinstance(character, dict) and str(character.get("tag") or "").strip()
    }
    background_tags = {
        str(background.get("tag") or "")
        for background in backgrounds
        if isinstance(background, dict)
    }
    try:
        strict = _is_strict_project(project, character_by_tag)
    except Exception:  # noqa: BLE001 - defensive: a malformed marker never hides the report
        strict = False

    # ---- 2. narration coverage (the production gate that follows generation) ----
    silent = [
        str(scene.get("scene_number"))
        for scene in scenes
        if isinstance(scene, dict)
        and str(scene.get("speaker") or "") in {"NARRATOR", "none", ""}
        and not str(scene.get("narration_text") or "").strip()
    ]
    if silent:
        _add(findings, "BLOCKER", "NARRATION_MISSING",
             "Non-character scenes require narration_text.",
             scenes=silent, field="narration_text")

    # ---- 3. SCENE INTELLIGENCE (identity, order, references, narration, prompts) ----
    seen_numbers: dict[int, int] = {}
    for index, scene in enumerate(scenes, 1):
        if not isinstance(scene, dict):
            _add(findings, "BLOCKER", "INVALID_SCENE",
                 f"Entry {index} in scenes[] is not an object.", scene=index, field="scenes")
            continue

        raw_number = scene.get("scene_number")
        if not _is_int(raw_number) or raw_number <= 0:
            number = index
            _add(findings, "BLOCKER", "INVALID_SCENE_ID",
                 f"Scene at position {index} has no positive integer scene_number.",
                 scene=number, field="scene_number")
        else:
            number = int(raw_number)
            if number in seen_numbers:
                _add(findings, "BLOCKER", "DUPLICATE_SCENE_ID",
                     f"scene_number {number} is used at positions {seen_numbers[number]} and {index}.",
                     scene=number, field="scene_number", positions=[seen_numbers[number], index])
            else:
                seen_numbers[number] = index
            if number != index:
                _add(findings, "BLOCKER", "SCENE_ORDER_INVALID",
                     f"Scene at position {index} has scene_number {number}; scene_number must be sequential from 1.",
                     scene=number, field="scene_number", expected=index)

        background = str(scene.get("background_tag") or "").strip()
        if not background:
            _add(findings, "BLOCKER", "BACKGROUND_TAG_MISSING",
                 f"Scene {number} has no background_tag.", scene=number, field="background_tag")
        elif background not in background_tags:
            _add(findings, "BLOCKER", "UNKNOWN_BACKGROUND_REFERENCE",
                 f"Scene {number} uses background {background}, which is not defined in backgrounds[].",
                 scene=number, field="background_tag", tag=background)

        raw_tags = scene.get("character_tags")
        if not isinstance(raw_tags, list):
            tags: list[str] = []
            _add(findings, "BLOCKER", "CHARACTER_TAGS_INVALID",
                 f"Scene {number} character_tags must be a JSON array.", scene=number, field="character_tags")
        else:
            tags = [str(tag) for tag in raw_tags if str(tag or "").strip()]
            for tag in tags:
                if tag not in character_by_tag:
                    _add(findings, "BLOCKER", "UNDEFINED_CHARACTER_REFERENCE",
                         f"Scene {number} references character {tag}, which is not defined in characters[].",
                         scene=number, field="character_tags", tag=tag)
            if len(tags) != len(set(tags)):
                _add(findings, "WARNING", "DUPLICATE_SCENE_CHARACTER",
                     f"Scene {number} repeats a character tag in character_tags.",
                     scene=number, field="character_tags")
        unique_tags = sorted(set(tags))

        speaker = str(scene.get("speaker") or "").strip()
        if not speaker:
            _add(findings, "BLOCKER", "SPEAKER_MISSING",
                 f"Scene {number} has no speaker.", scene=number, field="speaker")
        elif not (speaker in {"NARRATOR", "none"} or speaker in character_by_tag):
            _add(findings, "BLOCKER", "INVALID_SPEAKER",
                 f"Scene {number} speaker {speaker!r} is not NARRATOR, none, or a defined character tag.",
                 scene=number, field="speaker", speaker=speaker)
        if speaker.startswith("@CHAR-") and speaker not in tags:
            _add(findings, "BLOCKER", "SPEAKER_NOT_IN_SCENE",
                 f"Scene {number} speaker {speaker} is not present in scene.character_tags.",
                 scene=number, field="speaker", speaker=speaker)

        dialogue = str(scene.get("devanagari_dialogue") or "").strip()
        narration = str(scene.get("narration_text") or "").strip()
        if speaker.startswith("@CHAR-"):
            if not dialogue:
                _add(findings, "BLOCKER", "DIALOGUE_MISSING",
                     f"Scene {number} is spoken by {speaker} but has no devanagari_dialogue.",
                     scene=number, field="devanagari_dialogue", speaker=speaker)
            if narration:
                _add(findings, "WARNING", "UNUSED_NARRATION",
                     f"Scene {number} has narration_text but its speaker is {speaker}; the native Flow voice is used.",
                     scene=number, field="narration_text")
        elif dialogue:
            _add(findings, "WARNING", "ORPHAN_DIALOGUE",
                 f"Scene {number} has devanagari_dialogue but its speaker is {speaker or '(none)'}; the line is never spoken.",
                 scene=number, field="devanagari_dialogue")

        visual_action = str(scene.get("visual_action") or "").strip()
        if not visual_action:
            _add(findings, "BLOCKER", "VISUAL_ACTION_MISSING",
                 f"Scene {number} has no visual_action.", scene=number, field="visual_action")
        elif len(visual_action) < MIN_VISUAL_ACTION_CHARS:
            _add(findings, "WARNING", "WEAK_VISUAL_ACTION",
                 f"Scene {number} visual_action is only {len(visual_action)} characters; describe a specific, filmable beat.",
                 scene=number, field="visual_action", chars=len(visual_action), minimum=MIN_VISUAL_ACTION_CHARS)

        camera = str(scene.get("camera") or "").strip()
        if not camera:
            _add(findings, "WARNING", "CAMERA_MISSING",
                 f"Scene {number} has no camera description.", scene=number, field="camera")
        elif len(camera) < MIN_CAMERA_CHARS:
            _add(findings, "WARNING", "CAMERA_UNDERSPECIFIED",
                 f"Scene {number} camera is only {len(camera)} characters; give a concrete angle/scale/movement.",
                 scene=number, field="camera", chars=len(camera), minimum=MIN_CAMERA_CHARS)

        sound_design = str(scene.get("sound_design") or "").strip()
        if not sound_design:
            _add(findings, "WARNING", "SOUND_DESIGN_MISSING",
                 f"Scene {number} has no sound_design; the clip would have no ambience/SFX.",
                 scene=number, field="sound_design")
        elif len(sound_design) < MIN_SOUND_DESIGN_CHARS:
            _add(findings, "INFO", "SOUND_DESIGN_THIN",
                 f"Scene {number} sound_design is only {len(sound_design)} characters.",
                 scene=number, field="sound_design", chars=len(sound_design))
        if not str(scene.get("effects") or "").strip():
            _add(findings, "INFO", "EFFECTS_MISSING",
                 f"Scene {number} has no effects; confirm the shot truly needs none.",
                 scene=number, field="effects")

        prompt_key = "animation_prompt_WITH_lipsync" if speaker.startswith("@CHAR-") else "animation_prompt_NARRATOR_ONLY"
        if not str(scene.get(prompt_key) or "").strip():
            _add(findings, "WARNING", "ANIMATION_PROMPT_MISSING",
                 f"Scene {number} has no {prompt_key}; production would fail before submission.",
                 scene=number, field=prompt_key)

        if len(unique_tags) >= 2 and camera:
            try:
                unsafe = derive_camera_safety(len(unique_tags), camera).get("unsafe") or []
            except Exception:  # noqa: BLE001 - camera analysis must never crash the audit
                unsafe = []
            if unsafe:
                _add(findings, "WARNING", "CAMERA_UNSAFE_FOR_MULTI_CHARACTER",
                     f"Scene {number} uses ambiguous camera language for {len(unique_tags)} characters; "
                     "the prompt renderer normalises it to a stable composition.",
                     scene=number, field="camera", concepts=list(unsafe))

        if strict:
            for tag in unique_tags:
                character = character_by_tag.get(tag)
                if not character or not _is_strict_character(character):
                    continue
                ok, _outfit_id, _outfit, reason = _resolve_outfit(character, scene, True)
                if not ok:
                    _add(findings, "BLOCKER", "WARDROBE_UNRESOLVED",
                         f"Scene {number} wardrobe error: {reason}",
                         scene=number, field="outfit_ids", tag=tag)

    # ---- 4. spoken-beat repetition (user priority: no unnecessary repetition) ----
    seen: dict[str, list[int]] = {}
    for index, scene in enumerate(scenes, 1):
        if not isinstance(scene, dict):
            continue
        for key in ("devanagari_dialogue", "narration_text"):
            line = _normalise(scene.get(key))
            if len(line) >= MIN_REPEAT_CHARS:
                seen.setdefault(line, []).append(index)
    for line, scene_numbers in seen.items():
        unique = sorted(set(scene_numbers))
        if len(unique) > 1:
            _add(findings, "WARNING", "REPEATED_LINE",
                 f"The same spoken line appears in scenes {', '.join(map(str, unique))}: {line[:80]}",
                 scenes=unique)

    # ---- 5. repeated action beats ----
    seen_actions: dict[str, list[int]] = {}
    for index, scene in enumerate(scenes, 1):
        if not isinstance(scene, dict):
            continue
        action = _normalise(scene.get("visual_action"))
        if len(action) >= MIN_REPEAT_CHARS:
            seen_actions.setdefault(action, []).append(index)
    for action, scene_numbers in seen_actions.items():
        unique = sorted(set(scene_numbers))
        if len(unique) > 1:
            _add(findings, "WARNING", "REPETITIVE_SCENE",
                 f"The same visual action appears in scenes {', '.join(map(str, unique))}: {action[:80]}",
                 scenes=unique)

    # ---- 6. opening / ending strength ----
    if scenes and isinstance(scenes[0], dict):
        opening = _scene_text(scenes[0])
        if len(opening) < MIN_HOOK_CHARS:
            _add(findings, "WARNING", "WEAK_OPENING",
                 f"Scene 1 has only {len(opening)} characters of spoken/narrated text; the first 15-30 seconds are the retention hook.",
                 chars=len(opening))
    if scenes and isinstance(scenes[-1], dict):
        ending = _scene_text(scenes[-1])
        if not ending:
            _add(findings, "WARNING", "ENDING_UNCLEAR",
                 "The final scene has no narration or dialogue; confirm the story resolves on screen.")
        elif len(ending) < MIN_HOOK_CHARS:
            _add(findings, "WARNING", "ABRUPT_ENDING",
                 f"The final scene has only {len(ending)} characters of spoken/narrated text; confirm the resolution is complete.",
                 chars=len(ending))

    # ---- 7. story length vs the duration contract ----
    raw_text = str(script.get("raw_text") or "")
    words = len(re.findall(r"\S+", raw_text))
    duration = script.get("duration_minutes")
    target = script.get("word_count")
    if target is not None and (not _is_int(target) or target <= 0):
        _add(findings, "WARNING", "WORD_TARGET_INVALID",
             f"script.word_count must be a positive integer, got {target!r}.", field="word_count")
        target = None
    if duration is not None and (not _is_int(duration) or duration <= 0):
        _add(findings, "WARNING", "DURATION_INVALID",
             f"script.duration_minutes must be a positive integer, got {duration!r}.", field="duration_minutes")
        duration = None
    if not isinstance(script.get("raw_text"), str) or not raw_text.strip():
        _add(findings, "WARNING", "SCRIPT_METADATA_MISSING",
             "script.raw_text is missing/empty; story length and pacing cannot be verified.", field="raw_text")
    if not _is_int(target) and _is_int(duration):
        target = duration * 150
    if isinstance(target, int) and target > 0 and words > 0:
        if words < target * WORD_COUNT_LOW_RATIO or words > target * WORD_COUNT_HIGH_RATIO:
            _add(findings, "WARNING", "WORD_COUNT_OFF_TARGET",
                 f"Story is {words} words against a {target}-word target ({WORD_COUNT_LOW_RATIO:.0%}-{WORD_COUNT_HIGH_RATIO:.0%} accepted).",
                 words=words, target=target)

    # ---- 8. pacing vs the configured duration ----
    if _is_int(duration) and duration > 0 and total > 0:
        expected = duration * DEFAULT_SCENES_PER_MINUTE
        ratio = total / expected
        if ratio < PACING_LOW_RATIO or ratio > PACING_HIGH_RATIO:
            _add(findings, "WARNING", "SCENE_PACING_OFF_TARGET",
                 f"{total} scenes against a {expected}-scene target for {duration} min ({PACING_LOW_RATIO:.0%}-{PACING_HIGH_RATIO:.0%} accepted); confirm the natural pace.",
                 scenes=total, target=expected)

    # ---- 9. suspense progression (the templates require a climax confrontation) ----
    speaking = [scene for scene in scenes if isinstance(scene, dict) and str(scene.get("speaker") or "").startswith("@CHAR-")]
    if scenes and not speaking:
        _add(findings, "WARNING", "NO_CHARACTER_DIALOGUE",
             "No scene has a character-spoken line; confirm a fully narrated story is intended.")
    elif total >= 4:
        tail = [scene for scene in scenes[max(0, int(total * 0.6) - 1):] if isinstance(scene, dict)]
        if tail and not any(str(scene.get("speaker") or "").startswith("@CHAR-") for scene in tail):
            _add(findings, "WARNING", "SUSPENSE_PROGRESSION_WEAK",
                 "No character-spoken beat occurs in the final 40% of scenes; the climax may be unresolved.")

    # ---- 10. character-reference consistency ----
    names: dict[str, list[str]] = {}
    for character in characters:
        if not isinstance(character, dict):
            continue
        tag = str(character.get("tag") or "")
        name = _normalise(character.get("name"))
        if name:
            names.setdefault(name, []).append(tag)
        if character.get("age") is None or str(character.get("gender") or "") == "unknown" or str(character.get("profession") or "") == "unspecified":
            _add(findings, "WARNING", "CHARACTER_ATTRIBUTE_UNSPECIFIED",
                 f"{tag or '(untagged)'} has an unspecified age/gender/profession; confirm the script truly omits it.",
                 tag=tag)
        if not str(character.get("voice_description") or "").strip():
            _add(findings, "BLOCKER", "CHARACTER_VOICE_MISSING",
                 f"{tag or '(untagged)'} has no voice_description; the Flow voice contract is incomplete.",
                 tag=tag, field="voice_description")
        if not str(character.get("full_prompt") or "").strip():
            _add(findings, "WARNING", "CHARACTER_PROMPT_MISSING",
                 f"{tag or '(untagged)'} has no full_prompt; supply the character asset locally or regenerate it.",
                 tag=tag, field="full_prompt")
        if not str(character.get("look_summary") or "").strip() and not _appearance_text(character.get("appearance_lock")):
            _add(findings, "WARNING", "CHARACTER_LOOK_MISSING",
                 f"{tag or '(untagged)'} has no look_summary/appearance_lock.", tag=tag, field="look_summary")
        if strict and _is_strict_character(character) and not _appearance_text(character.get("appearance_lock")):
            _add(findings, "BLOCKER", "APPEARANCE_LOCK_MISSING",
                 f"{tag or '(untagged)'} is a strict character without appearance_lock data.",
                 tag=tag, field="appearance_lock")
    for name, tags in names.items():
        if len(set(tags)) > 1:
            _add(findings, "WARNING", "DUPLICATE_CHARACTER_NAME",
                 f"Several character tags share the display name '{name}': {', '.join(sorted(set(tags)))}.",
                 tags=sorted(set(tags)))

    if not strict:
        _add(findings, "INFO", "LEGACY_APPEARANCE_CONTRACT",
             "This project uses the legacy look_summary appearance fallback; strict appearance/wardrobe checks are skipped.")

    # ---- 11. background metadata ----
    for background in backgrounds:
        if not isinstance(background, dict):
            continue
        tag = str(background.get("tag") or "")
        if not str(background.get("location_name") or "").strip():
            _add(findings, "WARNING", "BACKGROUND_LOCATION_MISSING",
                 f"{tag or '(untagged)'} has no location_name.", tag=tag, field="location_name")
        if not str(background.get("look_summary") or "").strip() and not str(background.get("full_prompt") or "").strip():
            _add(findings, "WARNING", "BACKGROUND_PROMPT_MISSING",
                 f"{tag or '(untagged)'} has no look_summary/full_prompt; supply the background PNG locally or regenerate it.",
                 tag=tag, field="full_prompt")

    # ---- 12. asset usage ----
    used_backgrounds = {str(scene.get("background_tag") or "") for scene in scenes if isinstance(scene, dict)}
    unused = [str(bg.get("tag") or "") for bg in backgrounds if isinstance(bg, dict) and str(bg.get("tag") or "") not in used_backgrounds]
    if unused:
        _add(findings, "WARNING", "UNUSED_BACKGROUND", "Backgrounds are generated but never used by a scene.", tags=unused)

    used_characters = {
        str(tag)
        for scene in scenes if isinstance(scene, dict)
        for tag in (scene.get("character_tags") or [])
    }
    unused_characters = [str(ch.get("tag") or "") for ch in characters if isinstance(ch, dict) and str(ch.get("tag") or "") not in used_characters]
    if unused_characters:
        _add(findings, "WARNING", "UNUSED_CHARACTER", "Characters are generated but never used by a scene.", tags=unused_characters)

    dialogue_scenes = sum(1 for scene in scenes if isinstance(scene, dict) and str(scene.get("devanagari_dialogue") or "").strip())
    narration_scenes = sum(1 for scene in scenes if isinstance(scene, dict) and str(scene.get("narration_text") or "").strip())

    # ---- 13. classify + shape the report (backward compatible) ----
    blockers = [finding for finding in findings if finding["severity"] == "BLOCKER"]
    warnings = [finding for finding in findings if finding["severity"] == "WARNING"]
    infos = [finding for finding in findings if finding["severity"] == "INFO"]

    scene_findings_map: dict[int, list[dict]] = {}
    for finding in findings:
        if finding.get("scope") == "scene" and _is_int(finding.get("scene")):
            scene_findings_map.setdefault(int(finding["scene"]), []).append(finding)
    scene_findings = [
        {"scene": number, "findings": scene_findings_map[number]}
        for number in sorted(scene_findings_map)
    ]
    story_findings = [finding for finding in findings if finding.get("scope") == "story"]

    status = "BLOCKED" if blockers else ("REVIEW" if warnings else "PASS")

    return {
        "ok": not blockers,
        "status": status,
        "read_only": True,
        "project_id": str(project.get("project_id") or ""),
        "scenes": total,
        "characters": len(characters),
        "backgrounds": len(backgrounds),
        "counts": {
            "blockers": len(blockers),
            "warnings": len(warnings),
            "infos": len(infos),
        },
        "stats": {
            "words": words,
            "word_target": target if isinstance(target, int) else None,
            "dialogue_scenes": dialogue_scenes,
            "narration_scenes": narration_scenes,
        },
        "findings": findings,
        "story_findings": story_findings,
        "scene_findings": scene_findings,
        "errors": blockers,
        "warnings": warnings,
        "info": infos,
        "recommended_actions": _recommended_actions(findings),
    }


def _empty_report(project_file: str, code: str, message: str) -> dict:
    """Stable report shape for a project that could not even be read."""
    findings = [
        _finding(
            code,
            message,
            severity="BLOCKER",
            scope="story",
            recommendation=_RECOMMENDATIONS.get(code),
        )
    ]
    return {
        "ok": False,
        "status": "BLOCKED",
        "read_only": True,
        "project_id": "",
        "scenes": 0,
        "characters": 0,
        "backgrounds": 0,
        "counts": {"blockers": 1, "warnings": 0, "infos": 0},
        "stats": {"words": 0, "word_target": None, "dialogue_scenes": 0, "narration_scenes": 0},
        "findings": findings,
        "story_findings": findings,
        "scene_findings": [],
        "errors": findings,
        "warnings": [],
        "info": [],
        "recommended_actions": _recommended_actions(findings),
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
