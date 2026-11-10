"""Generate a validated multi-scene (default 5-minute) project from the PDF prompts."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from .anthropic_client import ScriptClient
from .models import new_project, save
from .paths import resolve_projects_root
from .prompts import render, STYLE_LOCK
from .prompt_safety import strip_internal_tags
from .voice_selector import select_flow_voice

CHAR_TAG = re.compile(r"^@CHAR-\d{2}-[A-Z][A-Z0-9-]*$")
BG_TAG = re.compile(r"^#BGD-\d{2}-[A-Z][A-Z0-9-]*$")
PROJECTS_ROOT = resolve_projects_root()
DEFAULT_SCENES_PER_MINUTE = 7
SCENE_BATCH_SIZE = 12
WORDS_PER_MINUTE = 150
NARRATION_FILL_ATTEMPTS = 3
MAX_SCENES = 35
MIN_SCENES = 2


def ask(client: ScriptClient, prompt: str, max_tokens: int = 4800):
    return client.complete(prompt, max_tokens=max_tokens, temperature=0)


def json_object(raw: str) -> dict:
    clean = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw.strip(), flags=re.I)
    try:
        result = json.loads(clean)
    except json.JSONDecodeError:
        start, end = clean.find("{"), clean.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Groq did not return a JSON object")
        result = json.loads(clean[start:end + 1])
    if not isinstance(result, dict):
        raise ValueError("Expected a JSON object")
    return result


def save_stage(path: Path, project: dict, name: str, raw: str):
    project.setdefault("raw_stages", {})[name] = raw
    save(path, project)


UNSPECIFIED = "unspecified"


def _derive_age(text: str) -> int | None:
    """Deterministically read an explicit age from character text, else None."""
    match = re.search(r"aged?\s+(?:about\s+)?(\d{1,3})", text, re.I)
    if not match:
        match = re.search(r"(\d{1,3})\s*(?:-year-old|year old|years old|yr|वर्ष)", text, re.I)
    if not match:
        match = re.search(r"appearing\s+(?:about\s+)?(\d{1,3})", text, re.I)
    if match:
        value = int(match.group(1))
        if 0 < value < 130:
            return value
    return None


def _derive_gender(text: str) -> str:
    """Derive gender only from explicit gendered wording (never from a name)."""
    if re.search(r"\b(female|woman|girl|lady|mother|queen)\b|महिला|स्त्री|लड़की", text, re.I):
        return "female"
    if re.search(r"\b(male|man|boy|father|king)\b|पुरुष|आदमी|लड़का", text, re.I):
        return "male"
    return "unknown"


def _derive_profession(text: str) -> str:
    match = re.search(r"\b(?:works as|profession|occupation)\s*[:\-]?\s*([A-Za-z][A-Za-z \-]{2,40})", text, re.I)
    return match.group(1).strip() if match else UNSPECIFIED


def _derive_personality(character: dict) -> str:
    look = str(character.get("look_summary", ""))
    expression = re.search(r"(?:pose with|with|,\s*)\s*(?:a\s+)?([a-z][a-z \-]{2,40}?)\s+expression", look, re.I) \
        or re.search(r"([a-z][a-z \-]{2,40}?)\s+expression", look, re.I)
    if expression:
        value = expression.group(1).strip(" ,")
        if value and value.lower() not in {"pose", "with", "a"}:
            return value
    voice = str(character.get("voice_description", "")).strip()
    tone = re.search(r"tone\s*[:.]?\s*([A-Za-z][A-Za-z ,'\-]{2,60})", voice, re.I)
    if tone:
        return tone.group(1).strip().rstrip(".")
    return UNSPECIFIED


def assign_flow_voices(characters: list[dict]) -> list[dict]:
    """Assign a deterministic Flow voiceName to characters without one.

    Preserves any explicit voice.voiceName (backward compatibility). Selection
    is offline/deterministic and never uses the character name/tag. Tracks used
    voices so multiple characters prefer distinct voices where reasonable.
    """
    used: set[str] = set()
    for character in characters:
        explicit = ((character.get("voice") or {}).get("voiceName") if isinstance(character.get("voice"), dict) else None) \
            or character.get("voiceName")
        if str(explicit or "").strip():
            used.add(str(explicit).strip())
    for character in characters:
        voice = character.get("voice") if isinstance(character.get("voice"), dict) else {}
        if str(voice.get("voiceName") or character.get("voiceName") or "").strip():
            continue
        selected = select_flow_voice(
            age=character.get("age"),
            gender=character.get("gender"),
            profession=character.get("profession"),
            personality=character.get("personality"),
            voice_description=character.get("voice_description"),
            used_voice_names=used,
        )
        voice = dict(voice)
        voice["voiceName"] = selected
        character["voice"] = voice
        used.add(selected)
    return characters


def ensure_character_attributes(characters: list[dict]) -> list[dict]:
    """Ensure structured character attributes for the future voice selector.

    Validation/fallback only. Explicit values are preserved; missing values are
    derived deterministically from existing character text, and otherwise set to
    a clearly documented placeholder. Facts are never fabricated.
    """
    valid_genders = {"male", "female", "other", "unknown"}
    for character in characters:
        text = " ".join(str(character.get(field, "")) for field in ("look_summary", "full_prompt", "voice_description"))

        # AGE: preserve a valid explicit integer age; else derive; never invent.
        age = character.get("age")
        if isinstance(age, bool) or not isinstance(age, int) or not (0 < age < 130):
            derived_age = _derive_age(text)
            if derived_age is not None:
                character["age"] = derived_age
            elif "age" in character:
                character["age"] = None

        # GENDER: preserve explicit; else derive; else "unknown".
        gender = str(character.get("gender", "")).strip().lower()
        if gender not in valid_genders:
            character["gender"] = _derive_gender(text)
            gender = character["gender"]
        else:
            character["gender"] = gender

        # PROFESSION: preserve explicit; else derive; else "unspecified".
        if not str(character.get("profession", "")).strip():
            character["profession"] = _derive_profession(text)

        # PERSONALITY: preserve explicit; else derive; else "unspecified".
        if not str(character.get("personality", "")).strip():
            character["personality"] = _derive_personality(character)

    return characters


def ensure_voice_descriptions(characters: list[dict]) -> list[dict]:
    """Guarantee a non-empty voice_description for every character.

    The character stage is asked for voice_description, but models sometimes omit
    it. make_prompts and Flow voice setup require it, so derive a deterministic
    fallback from the locked look when it is missing.
    """
    for character in characters:
        if str(character.get("voice_description", "")).strip():
            continue
        look = str(character.get("look_summary", ""))
        if re.search(r"ghost|spirit|entity|supernatural|आत्मा|प्रेत|चुड़ैल|भूत|पिशाच|डायन", look, re.I):
            character["voice_description"] = (
                "Restrained, sorrowful spectral voice, native North Indian Hindi, cold and echoing"
            )
            continue
        age = re.search(r"(\d{1,2})\s*(?:-|\s)?(?:year|yr|वर्ष)", look, re.I)
        female = re.search(r"\b(woman|female|girl|lady)\b|महिला|स्त्री|लड़की", look, re.I)
        gender = "female" if female else "male"
        prefix = f"{age.group(1)}-year-old " if age else ""
        character["voice_description"] = (
            f"{prefix}{gender}, native North Indian Hindi voice, natural folk-horror narration tone"
        )
    return characters


def fill_missing_narration(scenes: list[dict], story: str, client: ScriptClient | None = None,
                           attempts: int = NARRATION_FILL_ATTEMPTS) -> list[dict]:
    """Guarantee every NARRATOR/none scene has non-empty narration text.

    Validate after scene generation, retry the missing lines with the writing
    model, then fall back to the scene's own Hindi action so the pipeline can
    never silently ship an empty narrator line.
    """
    def pending_scenes() -> list[dict]:
        return [s for s in scenes if s["speaker"] in {"NARRATOR", "none"} and not str(s.get("narration_text", "")).strip()]

    pending = pending_scenes()
    if not pending:
        return scenes

    if client is not None:
        for _ in range(max(0, attempts)):
            scene_lines = "\n".join(
                f"- scene {s['scene_number']}: title={s.get('title', '')}; action={s.get('visual_action', '')}; sound={s.get('sound_design', '')}"
                for s in pending
            )
            prompt = (
                "You write the Hindi narrator voiceover for a locked folk-horror story. Return ONLY JSON:\n"
                '{"narration": [{"scene_number": 1, "narration_text": "..."}]}\n\n'
                f"Return exactly one item for EACH of these scene numbers: {[s['scene_number'] for s in pending]}. Do not skip any.\n"
                "Each narration_text is ONE concise Devanagari Hindi narration line matching the locked story and that scene's action. "
                "No dialogue, no stage directions, never blank.\n\n"
                "LOCKED STORY:\n" + story + "\n\n"
                "SCENES:\n" + scene_lines + "\n"
            )
            raw = ask(client, prompt, 2000)
            try:
                items = json_object(raw).get("narration") or []
            except ValueError:
                continue
            if isinstance(items, dict):
                items = [{"scene_number": key, "narration_text": value} for key, value in items.items()]
            by_number = {s["scene_number"]: s for s in scenes}
            for item in items:
                try:
                    number = int(item.get("scene_number"))
                except (TypeError, ValueError, AttributeError):
                    continue
                text = str(item.get("narration_text", "")).strip()
                if text and number in by_number:
                    by_number[number]["narration_text"] = text
            pending = pending_scenes()
            if not pending:
                return scenes

    # Last resort: never leave a narrator scene silent.
    for scene in pending:
        scene["narration_text"] = str(scene.get("visual_action", "")).strip() or "कहानी आगे बढ़ती है।"
        print(f"[warn] scene {scene['scene_number']}: model omitted narration; using fallback narration text")
    return scenes


_PLACEHOLDER_VALUES = {"", "unspecified", "unknown", "none", "null", "n/a", "na"}
# Contract slots keep meaningful "none" values (for example outerwear: none, marks: none).
_EMPTY_CONTRACT_VALUES = {"", "unspecified", "unknown", "null", "n/a", "na"}

# Reference-sheet-only language is valid for a character asset, never for scene-facing prose.
_REFERENCE_SHEET_PATTERNS = (
    r"neutral\s+(?:3\s*/\s*4|three[-\s]quarter)\s+(?:reference\s+)?pose",
    r"neutral\s+(?:3\s*/\s*4|three[-\s]quarter)\s+reference",
    r"\b(?:full\s+)?character\s+reference\s+sheet\b",
    r"\breference[-\s]sheet\b",
    r"\bclear\s+front[-\s]facing\s+expression\b",
    r"\bfront[-\s]facing\s+expression\b",
    r"\bneutral\s+grey\s+studio\s+background\b",
    r"\bgrey\s+studio\s+background\b",
    r"\bneutral\s+grey\s+backdrop\b",
    r"\bgrey\s+backdrop\b",
    r"\bturnaround\s+sheet\b",
    r"--ar\s+\d+:\d+",
    r"\bneutral\s+pose\b",
)


def _strip_reference_sheet_phrases(value) -> str:
    """Remove reference-sheet-only wording from scene-facing text, then repair punctuation."""
    out = str(value or "")
    for pattern in _REFERENCE_SHEET_PATTERNS:
        out = re.sub(pattern, "", out, flags=re.I)
    out = re.sub(r"\(\s*\)", "", out)
    out = re.sub(r",\s*([.;!?])", r"\1", out)
    out = re.sub(r"\s+([,.;:!?])", r"\1", out)
    out = re.sub(r"([,;:])\s*([,.;!?])", r"\1", out)
    out = re.sub(r"\.{2,}", ".", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s+$", "", out, flags=re.M)
    return out.strip()


def _has_reference_sheet_language(value) -> bool:
    src = str(value or "")
    return any(re.search(pattern, src, re.I) for pattern in _REFERENCE_SHEET_PATTERNS)


def _is_strict_character(character: dict) -> bool:
    return isinstance(character.get("appearance_lock"), dict) or isinstance(character.get("wardrobe"), dict)


def _appearance_text(appearance) -> str:
    if not isinstance(appearance, dict):
        return ""
    fields = ("age", "gender", "build", "skin", "face", "hair", "facial_hair", "marks")
    bits: list[str] = []
    for field in fields:
        value = str(appearance.get(field) or "").strip()
        if value.lower() in _EMPTY_CONTRACT_VALUES:
            continue
        bits.append(f"{field}: {value}")
    return "; ".join(bits)


def _outfit_text(outfit) -> str:
    if not isinstance(outfit, dict):
        return ""
    fields = ("top", "bottom", "outerwear", "footwear", "accessories", "hair", "notes")
    bits: list[str] = []
    for field in fields:
        value = str(outfit.get(field) or "").strip()
        if value.lower() in _EMPTY_CONTRACT_VALUES:
            continue
        bits.append(f"{field}: {value}")
    return "; ".join(bits)


def _compact_character(character: dict) -> dict:
    out = {
        "tag": character.get("tag"),
        "name": character.get("name"),
        "look_summary": character.get("look_summary", ""),
    }
    if _is_strict_character(character):
        out["appearance_lock"] = character.get("appearance_lock")
        out["wardrobe"] = character.get("wardrobe")
    return out


def _is_strict_project(project: dict, chars: dict) -> bool:
    try:
        if int(project.get("wardrobe_schema_version") or 0) >= 1:
            return True
    except (TypeError, ValueError):
        pass
    return any(_is_strict_character(c) for c in chars.values())


def _resolve_outfit(character: dict, scene: dict | None, strict: bool) -> tuple[bool, str, dict, str]:
    """Return (ok, outfit_id, outfit, reason). Never invents an outfit."""
    if not strict:
        return False, "", {}, "legacy character has no explicit wardrobe contract"
    wardrobe = character.get("wardrobe")
    if not isinstance(wardrobe, dict):
        return False, "", {}, f"character {character.get('tag')} is missing wardrobe"
    outfits = wardrobe.get("outfits")
    if not isinstance(outfits, dict) or not outfits:
        return False, "", {}, f"character {character.get('tag')} wardrobe has no outfits"
    overrides = (scene or {}).get("outfit_ids")
    overrides = overrides if isinstance(overrides, dict) else {}
    has_override = character.get("tag") in overrides
    override = overrides.get(character.get("tag"))
    if has_override and not str(override or "").strip():
        return False, "", {}, f"character {character.get('tag')} has an empty scene outfit selection"
    default_id = str(wardrobe.get("default_outfit") or "").strip()
    if not has_override and not default_id:
        return False, "", {}, f"character {character.get('tag')} wardrobe has no default_outfit"
    outfit_id = str(override or default_id).strip()
    if outfit_id not in outfits:
        return False, outfit_id, {}, f"character {character.get('tag')} selects unknown outfit {outfit_id!r}"
    outfit = outfits.get(outfit_id)
    if not isinstance(outfit, dict):
        return False, outfit_id, {}, f"character {character.get('tag')} outfit {outfit_id!r} is not an object"
    wardrobe_text = _outfit_text(outfit)
    if not wardrobe_text:
        return False, outfit_id, {}, f"character {character.get('tag')} outfit {outfit_id!r} has no garment data"
    return True, outfit_id, outfit, ""


def _validate_wardrobe_contract(project: dict, chars: dict) -> None:
    """Fail closed on missing/unknown wardrobe data for a strict project."""
    if not _is_strict_project(project, chars):
        return
    for tag, character in chars.items():
        appearance = _appearance_text(character.get("appearance_lock"))
        if not appearance:
            raise ValueError(f"Missing appearance_lock for strict character {tag}")
        if _has_reference_sheet_language(appearance):
            raise ValueError(f"appearance_lock for {tag} contains reference-sheet-only language")
        wardrobe = character.get("wardrobe")
        if not isinstance(wardrobe, dict):
            raise ValueError(f"Missing wardrobe for strict character {tag}")
        outfits = wardrobe.get("outfits")
        if not isinstance(outfits, dict) or not outfits:
            raise ValueError(f"Wardrobe for {tag} has no outfits")
        default_id = str(wardrobe.get("default_outfit") or "").strip()
        if not default_id or default_id not in outfits:
            raise ValueError(f"Wardrobe for {tag} has no valid default_outfit")
        for outfit_id, outfit in outfits.items():
            if not str(outfit_id or "").strip():
                raise ValueError(f"Wardrobe for {tag} has an empty outfit id")
            text = _outfit_text(outfit)
            if not text:
                raise ValueError(f"Outfit {outfit_id!r} for {tag} has no garment data")
            if _has_reference_sheet_language(text):
                raise ValueError(f"Outfit {outfit_id!r} for {tag} contains reference-sheet-only language")
    for index, scene in enumerate(project.get("scenes", []), 1):
        tags = list(scene.get("character_tags") or [])
        overrides = scene.get("outfit_ids")
        if overrides is not None and not isinstance(overrides, dict):
            raise ValueError(f"outfit_ids must be an object at scene {index}")
        for tag, outfit_id in (overrides or {}).items():
            if tag not in tags:
                raise ValueError(f"Scene {index} selects an outfit for undeclared character {tag}")
            if tag not in chars:
                raise ValueError(f"Scene {index} selects an outfit for unknown character {tag}")
            if not str(outfit_id or "").strip():
                raise ValueError(f"Scene {index} has an empty outfit selection for {tag}")
        for tag in tags:
            character = chars.get(tag)
            if not character:
                continue
            ok, outfit_id, _, reason = _resolve_outfit(character, scene, True)
            if not ok:
                raise ValueError(f"Scene {index} wardrobe error: {reason}")


def _tag_name_part(tag: str) -> str:
    """Human-readable name derived from an internal tag suffix (never the raw tag)."""
    match = re.match(r"^[@#](?:CHAR|BGD)-\d{2}-(.+)$", str(tag or ""))
    return match.group(1).replace("-", " ").strip().title() if match else ""


def _display_name(char: dict, tag: str) -> str:
    name = str((char or {}).get("name") or "").strip()
    return name or _tag_name_part(tag) or "the character"


def _character_descriptor(char: dict, tag: str) -> str:
    """Human-readable character description from existing metadata only.

    Never emits the internal tag and never invents facts: unavailable fields are
    simply omitted.
    """
    char = char or {}
    name = _display_name(char, tag)
    bits: list[str] = []
    look = str(char.get("look_summary") or "").strip()
    if look:
        bits.append(look)
    else:
        physical: list[str] = []
        age = char.get("age")
        if isinstance(age, int) and not isinstance(age, bool) and age > 0:
            physical.append(f"{age}-year-old")
        gender = str(char.get("gender") or "").strip()
        if gender.lower() not in _PLACEHOLDER_VALUES:
            physical.append(gender)
        if physical:
            bits.append(" ".join(physical))
    personality = str(char.get("personality") or "").strip()
    if personality.lower() not in _PLACEHOLDER_VALUES:
        bits.append(f"personality: {personality}")
    profession = str(char.get("profession") or "").strip()
    if profession.lower() not in _PLACEHOLDER_VALUES:
        bits.append(f"profession: {profession}")
    detail = "; ".join(bits)
    return f"{name} ({detail})" if detail else name


def _background_descriptor(bg: str, record: dict) -> str:
    """Human-readable environment from existing metadata only (never the raw tag)."""
    record = record or {}
    location = str(record.get("location_name") or "").strip()
    look = str(record.get("look_summary") or "").strip()
    if location and look:
        return f"{location} — {look}"
    return location or look or _tag_name_part(bg) or "an unspecified location"


_CLAUSE_SPLIT = re.compile(r"[,;।\.\n]+")
_EN_LOCATIVE = re.compile(
    r"\b(?:at|in|on|near|by|beside|behind|beneath|under|above|over|inside|outside|before|between|against|towards?)\b",
    re.I,
)
# Hindi locative postpositions (the noun precedes the marker). Compound markers
# are unambiguous; a bare postposition is only trusted in a short locative tail so
# a whole action clause ("... stones, keeps it down ...") is never treated as a position.
_HI_LOCATIVE_COMPOUND = ("के पास", "के सामने", "के पीछे", "के ऊपर", "के नीचे", "के बगल में", "के भीतर", "के आगे")
_HI_LOCATIVE_SIMPLE = ("पर", "में")
_HI_SIMPLE_MAX = 30


def _locative_suffix(text: str) -> str:
    """Drop a leading English verb phrase so the anchor reads "near the window".

    Locative markers in Hindi follow the noun, so non-English text is returned
    unchanged (its natural word order is already the position phrase).
    """
    match = _EN_LOCATIVE.search(text)
    if match and match.start() > 0:
        return text[match.start():].strip()
    return text


def _clause_position(text: str, name: str) -> str:
    """Locative phrase for `name` within a single clause, else ""."""
    rest = " ".join(text.replace(name, " ").split()).strip(" -—:;,।.")
    if not rest or len(rest) > 80:
        return ""
    if _EN_LOCATIVE.search(rest):
        return _locative_suffix(rest)
    if any(marker in rest for marker in _HI_LOCATIVE_COMPOUND):
        return rest
    if len(rest) <= _HI_SIMPLE_MAX and any(marker in rest for marker in _HI_LOCATIVE_SIMPLE):
        return rest
    return ""


def _spatial_position(action: str, name: str) -> str:
    """Deterministically extract a character's first locative phrase, else "".

    Only genuine position phrases are returned, so a movement clause such as
    "moves forward" is never mislabelled as a fixed spatial position.
    """
    if not action or not name:
        return ""
    for clause in _CLAUSE_SPLIT.split(str(action)):
        text = clause.strip()
        if not text or name not in text:
            continue
        position = _clause_position(text, name)
        if position:
            return position
    return ""


def _position_candidates(action: str, name: str) -> list[str]:
    """All distinct locative phrases for `name` across clauses (contradiction input)."""
    out: list[str] = []
    if not action or not name:
        return out
    for clause in _CLAUSE_SPLIT.split(str(action)):
        text = clause.strip()
        if not text or name not in text:
            continue
        position = _clause_position(text, name)
        if position and position not in out:
            out.append(position)
    return out


def _cardinality_block(names: list[str], action: str) -> str:
    """Deterministic cardinality + single-instance spatial anchor (Flow duplicate guard)."""
    if not names:
        return (
            "### CHARACTER CARDINALITY\n"
            "- No characters appear in this scene; do not add any people.\n\n"
        )
    lines = [
        "### CHARACTER CARDINALITY",
        f"- Show exactly ONE visible instance of each character: {', '.join(names)}.",
        "- Never duplicate, clone, repeat, mirror, reflect, or multiply any character.",
        "- Add no other people unless the scene action explicitly requires them.",
    ]
    if len(names) >= 2:
        lines += ["", "### SINGLE-INSTANCE SPATIAL ANCHOR"]
        for name in names:
            position = _spatial_position(action, name)
            if position:
                lines.append(f"- {name} remains the single person {position}.")
            else:
                lines.append(f"- {name} remains a single person; show exactly one {name} in the frame.")
        lines.append(
            "- Each character stays in their own position for the whole shot; a wider or moving "
            "camera must never create a second instance of any character."
        )
    return "\n".join(lines) + "\n\n"


_NUMBER_WORDS = {0: "ZERO", 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE", 6: "SIX", 7: "SEVEN", 8: "EIGHT"}


def _count_word(n: int) -> str:
    return _NUMBER_WORDS.get(int(n), str(int(n)))


def _character_composition_block(names: list[str], action: str) -> str:
    """Contextual character-composition hardening for a Flow video prompt.

    States the exact people count, enumerates each character with ONE spatial role,
    resolves any contradictory spatial wording deterministically, and adds uniqueness,
    camera-continuity, identity-continuity, physical-realism, extra-person and
    reflection/mirror protections. Never changes the story/action/dialogue.
    """
    count = len(names)
    count_word = _count_word(count)
    noun = "PERSON" if count == 1 else "PEOPLE"
    lines: list[str] = [f"### CHARACTER COUNT — EXACTLY {count_word} {noun}"]

    if count == 0:
        lines.append("- No human characters appear in this scene; do not add any people.")
    else:
        verb = "is" if count == 1 else "are"
        lines.append(
            f"There {verb} exactly {count_word} physical human "
            f"{'character' if count == 1 else 'characters'} in the entire scene:"
        )
        for index, name in enumerate(names, 1):
            lines.append(f"{index}. {name} — exactly one physical instance.")

    # ---- uniqueness ----
    lines += [
        "",
        "### CHARACTER UNIQUENESS",
        "- Each named character exists exactly once in the entire physical scene.",
        "- Never duplicate, clone, copy, repeat, multiply, mirror, split, or recreate a character.",
        "- Do not create a second instance of any character anywhere: foreground, background, side of",
        "  frame, doorway, window, mirror, reflection, glass, screen, photograph, television, shadow, or",
        "  secondary composition.",
        "- No extra human characters.",
        f"- The total number of human characters must remain exactly {count_word} throughout the clip.",
    ]

    # ---- spatial ownership (one position per character) ----
    lines += ["", "### SPATIAL OWNERSHIP — ONE POSITION PER CHARACTER"]
    contradiction = False
    for name in names:
        candidates = _position_candidates(action, name)
        canonical = candidates[0] if candidates else ""
        if len(candidates) > 1:
            contradiction = True
        if canonical:
            lines.append(f"- {name}: exactly one physical body, one visible face, one identity, positioned {canonical} (and nowhere else).")
        else:
            lines.append(f"- {name}: exactly one physical body, one visible face, one identity, occupying one fixed position (and nowhere else).")
    if contradiction:
        lines.append(
            "- Spatial contradiction detected and deterministically resolved: where the source wording"
            " places a character in more than one location, only the single authoritative position listed"
            " above applies; every other placement of that character is discarded."
        )
    lines.append(
        "- A character may be referred to more than once linguistically, but every reference must resolve"
        " to the same single physical instance."
    )

    # ---- camera continuity ----
    lines += [
        "",
        "### CAMERA CONTINUITY",
        "- Camera movement may pan, dolly, tilt, zoom, or reframe the same physical characters, but must",
        "  never create a new physical character.",
        "- Reframing a character does not create another character.",
        "- Maintain continuous physical identity throughout the entire clip.",
        "- Do not introduce a character merely because the camera changes angle.",
    ]

    # ---- identity continuity ----
    lines += [
        "",
        "### IDENTITY CONTINUITY",
        "- Every character maintains the same face, hairstyle, clothing, age, body proportions, identity,",
        "  and physical-position continuity.",
        "- No face swapping, identity swapping, cloned faces, duplicated clothing, or character morphing.",
    ]

    # ---- physical realism ----
    lines += [
        "",
        "### PHYSICAL REALISM",
        "- Anatomically normal human bodies with natural proportions.",
        "- One head per person, one body per person, natural hands and limbs.",
        "- Correct occlusion, realistic depth and perspective, and physically coherent interaction.",
        "- No fused people, duplicated limbs, floating people, impossible overlaps, cloned people, or",
        "  unexplained background humans.",
    ]

    # ---- extra-person prohibition ----
    lines += [
        "",
        "### EXTRA-PERSON PROHIBITION",
        f"- NO EXTRA PEOPLE. The number of visible human characters must equal exactly {count_word}.",
        "- Do not invent background people unless the scene action explicitly requires them.",
    ]
    for name in names:
        lines.append(f"- There is NO second {name} and NO duplicate {name}.")
    lines.append("- The foreground must not contain another copy of any character.")

    # ---- reflection / mirror protection ----
    lines += [
        "",
        "### REFLECTION / MIRROR PROTECTION",
        "- Reflections in mirrors, reflective glass, windows, polished surfaces, photographs, screens,",
        "  televisions, and shadow silhouettes must never be rendered as another physical human instance.",
        "- A reflection is not a second character.",
    ]
    return "\n".join(lines) + "\n\n"


# ---- character-count-aware camera safety (offline, deterministic) ----

_UNSAFE_CAMERA_CONCEPTS: tuple[tuple[str, str], ...] = (
    ("over-the-shoulder", r"over[\s\-]*the[\s\-]*shoulder"),
    ("OTS", r"\bots\b"),
    ("shot/reverse-shot", r"shot[\s/\-]*reverse"),
    ("reverse angle", r"reverse[\s\-]*angle"),
    ("camera behind a character", r"camera\s+(?:behind|passes?\s+behind|moves?\s+behind)"),
    ("behind a named character", r"behind\s+(?:the\s+)?(?:character|subject|person|figure|him|her|them|mother|arjun|maa|माँ|अर्जुन)"),
    ("foreground-character framing", r"foreground[\s\-]*(?:character|subject|figure|person|mother|arjun|maa|माँ|अर्जुन)"),
    ("side switch", r"side[\s\-]*switch"),
    ("camera switching sides", r"camera\s+(?:switches|switching|changes|changing)\s+sides?"),
    ("camera moving around a character", r"camera\s+(?:moves?|moving)\s+around"),
    ("over-the-shoulder (Hindi)", r"ओवर[\s\-]*द[\s\-]*(?:शोल्डर|सोल्डर)"),
    ("reverse shot (Hindi)", r"(?:रिवर्स[\s\-]*(?:शॉट|एंगल)|शॉट[\s/\-]*रिवर्स)"),
    ("camera behind (Hindi)", r"कैमरा[^\n]{0,16}?(?:पीछे|पीछे\s+से)"),
    ("from behind (Hindi)", r"पीछे\s+से"),
    ("foreground (Hindi)", r"(?:अग्र(?:भूमि|भाग)|फोरग्राउंड)"),
)
_UNSAFE_CAMERA_REGEX = tuple((label, re.compile(pattern, re.I)) for label, pattern in _UNSAFE_CAMERA_CONCEPTS)


def _unsafe_camera_concepts(camera_text: str) -> list[str]:
    """Return the labels of unsafe/ambiguous camera constructions present in the text."""
    text = str(camera_text or "")
    return [label for label, regex in _UNSAFE_CAMERA_REGEX if regex.search(text)]


def _safe_shot_scale(camera_text: str) -> str:
    """Preserve a safe shot scale for a multi-character scene (default medium-wide).

    Close-up is intentionally upgraded to medium-wide so every named character
    remains visible in one continuous composition.
    """
    text = str(camera_text or "")
    if re.search(r"medium[\s\-]*wide|मीडियम[\s\-]*वाइड", text, re.I):
        return "medium-wide"
    if re.search(r"\bwide\b|वाइड", text, re.I):
        return "wide"
    if re.search(r"\bmedium\b|मीडियम|मध्यम", text, re.I):
        return "medium"
    return "medium-wide"


def derive_camera_safety(character_count: int, camera_text: str) -> dict:
    """Pure, deterministic camera-safety decision for ONE scene.

    Multi-character scenes (>= 2 unique characters) are forced onto a physically
    stable, low-ambiguity composition; single-character scenes keep their existing
    cinematic camera. The story action and dialogue are never touched, no character
    is ever invented, and internal tags are never exposed.
    """
    count = int(character_count)
    source = strip_internal_tags(str(camera_text or "")).strip()
    unsafe = _unsafe_camera_concepts(source)
    if count >= 2:
        scale = _safe_shot_scale(source)
        normalized = (
            f"{scale} stable shot from in front of the characters, camera static or a gentle slow push-in, "
            "camera stays on one side of the room and keeps the existing people in one continuous composition"
        )
        return {"multi": True, "unsafe": unsafe, "source": source, "camera": normalized}
    return {"multi": False, "unsafe": unsafe, "source": source, "camera": source}


def _multi_character_camera_block(names: list[str], camera_safety: dict) -> str:
    """Positive stable composition + explicit prohibition of ambiguous camera language."""
    if not camera_safety.get("multi"):
        return ""
    count_word = _count_word(len(names))
    lines = [
        "### MULTI-CHARACTER CAMERA SAFETY",
        f"- Exactly {count_word} people are present; the camera keeps all of them in one continuous, physically stable composition.",
        "- Preferred camera language: wide shot, medium-wide shot, stable frontal composition, static camera, gentle slow push-in, simple lateral movement, or a simple continuous pan that does not reposition characters.",
        "- The camera remains on the same side of the room for the whole clip.",
        "- Do not move the camera behind either character.",
        "- Do not place a character in the foreground as a separate subject while the same character remains visible elsewhere.",
        "- The camera reframes the existing people only; it never creates a new physical viewpoint containing another copy of a character.",
        "- Avoid any over-the-shoulder, OTS, shot/reverse-shot, reverse-angle, behind-the-character, side-switching, foreground-character, or viewpoint-recreating camera construction, and any sudden reframing that changes a character's spatial ownership.",
    ]
    if camera_safety.get("unsafe"):
        lines.append(
            f"- The original camera wording was physically ambiguous for {count_word} people and has been replaced by the stable composition above."
        )
    return "\n".join(lines) + "\n\n"


def make_prompts(scene: dict, chars: dict, bgs: dict) -> dict:
    bg = scene["background_tag"]
    tags = scene["character_tags"]
    speaker = scene["speaker"]

    # Story semantics are preserved verbatim; any leaked internal tag is stripped
    # purely defensively (the pipeline fields do not normally contain one).
    action = _strip_reference_sheet_phrases(strip_internal_tags(scene.get("visual_action", "")))
    camera = _strip_reference_sheet_phrases(strip_internal_tags(scene.get("camera", "")))
    effects = _strip_reference_sheet_phrases(strip_internal_tags(scene.get("effects", "")))
    sound_design = strip_internal_tags(scene.get("sound_design", ""))

    bg_desc = _strip_reference_sheet_phrases(_background_descriptor(bg, bgs.get(bg, {})))
    char_names = [_display_name(chars.get(tag, {}), tag) for tag in tags]
    # Character-count-aware camera policy: >=2 characters get a stable, low-ambiguity
    # composition; single-character scenes keep their cinematic camera.
    camera_safety = derive_camera_safety(len(char_names), camera)
    camera_view = camera_safety["camera"]

    # The still prompt is a human-readable image prompt, so it never carries machine tags. Strict
    # characters contribute explicit appearance + exact resolved wardrobe; legacy characters keep
    # their look_summary. Reference-sheet-only language is always removed.
    still_bits: list[str] = []
    for tag in tags:
        character = chars.get(tag) or {}
        name = _display_name(character, tag)
        if _is_strict_character(character):
            appearance = _appearance_text(character.get("appearance_lock"))
            ok, _, outfit, _ = _resolve_outfit(character, scene, True)
            wardrobe = _outfit_text(outfit) if ok else ""
            detail = "; ".join(part for part in (appearance, f"wearing {wardrobe}" if wardrobe else "") if part)
            if detail:
                still_bits.append(f"{name}: {detail}")
        else:
            look = _strip_reference_sheet_phrases(str(character.get("look_summary") or "").strip())
            if look:
                still_bits.append(f"{name}: {look}")
    look = "; ".join(still_bits) or "no visible characters"

    still = (
        "2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, "
        f"{bg_desc} environment, {look}. "
        f"{action} Camera: {camera}. "
        "Moody teal-blue rainy night lighting, natural adult human anatomy and proportions, "
        "flat 2D vector art, no text, no labels, no asset tags, no watermark, --ar 16:9."
    )
    # The animation prompt carries the canonical machine identifiers on purpose. The TypeScript
    # hardener is the single renderer that resolves them into human descriptions; Python must not
    # build a competing resolved-identity prompt.
    active_characters = " | ".join(tags) if tags else "none"
    common = (
        "### SYSTEM & ENVIRONMENT\n"
        "CLIP LENGTH: Let Flow determine the natural clip length needed to complete the action and dialogue. "
        "Do not truncate a spoken line or force a fixed duration.\n"
        "STYLE ANCHOR: 2D semi-realistic cartoon illustration, bold clean outlines, "
        "smooth flat cel shading. Maintain 100% flat 2D vector art aesthetics and realistic "
        "adult human proportions.\n"
        f"ACTIVE ENVIRONMENT: {bg}\nACTIVE CHARACTERS: {active_characters}\n\n"
        "### VISUAL ACTION & CAMERA\n"
        f"SCENE ACTION: {action}\n"
        f"CAMERA: {camera_view}\n"
        f"PHYSICS/EFFECTS: {effects}\n\n"
        + _cardinality_block(char_names, action)
        + _character_composition_block(char_names, action)
        + _multi_character_camera_block(char_names, camera_safety)
    )
    restrictions = (
        "### NEGATIVE RESTRICTIONS\n- NO photorealism\n- NO 3D rendering\n"
        "- NO CGI shading\n- NO oversized head or body\n- NO realistic skin/hair textures\n"
        "- NO depth-of-field that breaks the 2D plane\n- NO English-accent inflection\n"
        "- NO dual-character lip-sync\n- NO text overlays\n- NO watermarks\n\n"
        "### VISUAL CLEANLINESS\n- NO visible text, labels, asset tags, captions, cards, or UI\n"
        "- NO borders, rounded frames, interface elements, or watermarks\n"
        "- NO text overlays, subtitles, prompt text, scene labels, character labels, decorative frames, or generated title cards\n"
        "- Never render internal asset tags, identifiers, or UUIDs as visible content\n"
        "- Keep a clean full-bleed illustration with no overlay graphics\n\n"
        "### NO ON-SCREEN TEXT OR CHARACTER LABELS\n"
        "- Character names are INTERNAL generation metadata only and MUST NOT appear as visible text in the rendered video.\n"
        "- Character names, including names that appear inside the scene action, dialogue context, character descriptions, spatial descriptions, or other metadata above, are INTERNAL generation metadata only. NEVER render, display, print, write, spell, translate, stylize, or visualize any character name as visible content.\n"
        "- If a character name appears in the story action above, treat that occurrence as narrative information only; do NOT reproduce that text visually.\n"
        "- Do NOT render any character name, name label, name badge, circular name card, floating nameplate, emblem, identification marker, profile card, lower-third, subtitle, caption, cast list, or identification tag.\n"
        "- Do NOT attach text to a character or display text beside, above, or below a person.\n"
        "- Do NOT render UI-style character cards, on-screen character metadata, or any character identification overlay.\n"
        "- The frame contains ONLY the illustrated story scene and its physical environment. Characters are identified ONLY by their visual appearance. There are NO informational overlays of any kind.\n"
        "- All character identity exists ONLY in each character's visual appearance, never as on-screen text."
    )
    dialogue = strip_internal_tags(str(scene.get("devanagari_dialogue", "")).strip())
    if speaker.startswith("@CHAR-"):
        speaker_name = _display_name(chars.get(speaker, {}), speaker)
        others = [_display_name(chars.get(tag, {}), tag) for tag in tags if tag != speaker]
        speaker_identity = strip_internal_tags(str((chars.get(speaker) or {}).get("voice_description") or ""))
        lip = (
            "### LIP-SYNC CONTROL & AUDIO\n"
            f"[LIP-SYNC LOCK]: Only {speaker_name}'s mouth animates to the dialogue. "
            f"All other characters ({', '.join(others) or 'none'}) "
            "keep mouths completely closed and still.\n"
            "AUDIO PROTOCOL: Native Indian voice synthesis only.\n"
            f"SPEAKER IDENTITY: {speaker_identity}\n"
            "LINGUISTIC CONSTRAINT: 100% native North Indian Hindi accent; no Western/English cadence.\n"
            f"DIALOGUE (DEVANAGARI ONLY): \"{dialogue}\"\n"
            f"SOUND DESIGN: {sound_design}\n\n"
        )
    else:
        lip = ""
    silent = (
        "### LIP-SYNC CONTROL & AUDIO\n"
        "[LIP-SYNC LOCK]: No character speaks. All mouths closed and static.\n"
        "AUDIO PROTOCOL: No voice synthesis. Narrator voiceover will be layered in editing.\n"
        f"SOUND DESIGN: {sound_design}\n"
        "Do not add any dialogue.\n\n"
    )
    scene["assets"] = {"background_tag": bg, "character_tags": tags}
    # Flow owns the duration. A fixed length cuts off Hindi dialogue when the
    # generation needs more time to finish a performance.
    scene["clip_length_seconds"] = None
    scene["edit_length_seconds"] = None
    scene["still_image_prompt"] = still
    scene["animation_prompt_WITH_lipsync"] = common + lip + restrictions
    scene["animation_prompt_NARRATOR_ONLY"] = common + silent + restrictions
    scene["status"] = "pending"
    scene["error"] = None
    return scene


def validate(project: dict, scene_count: int | None = None):
    chars = {x["tag"]: x for x in project["characters"]}
    bgs = {x["tag"]: x for x in project["backgrounds"]}
    if len(chars) != len(project["characters"]) or not all(CHAR_TAG.fullmatch(t) for t in chars):
        raise ValueError("Duplicate or invalid character tags")
    if len(bgs) != len(project["backgrounds"]) or not all(BG_TAG.fullmatch(t) for t in bgs):
        raise ValueError("Duplicate or invalid background tags")
    _validate_wardrobe_contract(project, chars)
    missing_voice = [c["tag"] for c in project["characters"] if not str(c.get("voice_description", "")).strip()]
    if missing_voice:
        raise ValueError(f"Missing voice_description for characters: {', '.join(missing_voice)}")
    total = len(project["scenes"])
    if not (MIN_SCENES <= total <= MAX_SCENES):
        raise ValueError(f"Expected {MIN_SCENES}–{MAX_SCENES} scenes, got {total}")
    for i, scene in enumerate(project["scenes"], 1):
        if scene["scene_number"] != i or scene["background_tag"] not in bgs:
            raise ValueError(f"Invalid scene number or background at scene {i}")
        if any(tag not in chars for tag in scene["character_tags"]):
            raise ValueError(f"Undefined character in scene {i}")
        if scene["speaker"] not in {"NARRATOR", "none", *chars}:
            raise ValueError(f"Invalid speaker in scene {i}")
        if scene["speaker"].startswith("@CHAR-") and scene["speaker"] not in scene["character_tags"]:
            raise ValueError(f"Speaker absent from scene {i}")
        scene["timestamp"] = "AUTO — determined by the completed Flow clip"
        make_prompts(scene, chars, bgs)


def scene_schema(min_count: int = MIN_SCENES, max_count: int = MAX_SCENES) -> str:
    return (
        f'Return ONLY JSON with {{"scenes":[{{"scene_number":1,"title":"...","background_tag":"#BGD-01-NAME",'
        f'"character_tags":["@CHAR-01-NAME"],"speaker":"NARRATOR|none|@CHAR-01-NAME",'
        f'"outfit_ids":{{"@CHAR-01-NAME":"OUTFIT_ID"}},"visual_action":"...",'
        f'"camera":"...","effects":"...","sound_design":"...","devanagari_dialogue":"...","narration_text":"..."}}]}} '
        f"containing the natural number of scene objects between {min_count} and {max_count} inclusive, in script order. "
        f"Determine the natural number of scenes the story needs; use the MINIMUM number needed to tell the COMPLETE story; "
        f"do not pad and do not target {max_count}. Never exceed {max_count} scenes. Preserve setup, escalation, climax and "
        "resolution; if the story has more individual beats than fit, merge related beats instead of adding unnecessary scenes. "
        "Renumber scenes sequentially from 1. "
        "Use ONLY listed tags. Dialogue must be an exact line from the script; for narration, keep the exact line as metadata "
        "for later editing, not in the Flow animation prompt. Do not specify, request, or assume a fixed clip length: Flow must "
        "choose the natural length needed to complete the action and any dialogue. For every NARRATOR or none scene, narration_text "
        "is mandatory: provide one concise Devanagari Hindi narration line consistent with the locked script, never blank. "
        "Do not invent character dialogue. Only include outfit_ids when the locked script explicitly changes a character's "
        "clothing; keys must be character_tags used in that scene and values must be an outfit id from that character's wardrobe. "
        "Otherwise omit outfit_ids (or use {}). Never invent a new outfit or a new garment in visual_action."
    )


def compress_scenes(scenes: list[dict], client: ScriptClient) -> list[dict]:
    """Run exactly ONE merge pass to reduce >MAX_SCENES scenes to <=MAX_SCENES.

    Preserves the complete narrative; never blindly truncates. Renumbers from 1.
    """
    if len(scenes) <= MAX_SCENES:
        return scenes
    prompt = (
        f"Merge related or adjacent scene beats to reduce the story to at most {MAX_SCENES} scenes. "
        "Preserve the complete narrative, character relationships, important events, escalation, climax, dialogue, narration "
        "and final resolution. Do not delete the ending. Do not simply truncate the scene list. Renumber scenes sequentially from 1. "
        f"Return between {MIN_SCENES} and {MAX_SCENES} scenes. Return ONLY JSON in this schema:\n"
        + scene_schema()
        + "\nLOCKED SCENES:\n"
        + json.dumps({"scenes": scenes}, ensure_ascii=False)
    )
    raw = ask(client, prompt, 8000)
    merged = json_object(raw).get("scenes", [])
    for index, scene in enumerate(merged, 1):
        scene["scene_number"] = index
    return merged


def generate(project_id: str, model: str | None = None, title: str | None = None, concept: str | None = None,
             duration_minutes: int = 5, scene_count: int | None = None, monster: str | None = None):
    duration_minutes = max(1, int(duration_minutes))
    # 35 is a HARD MAXIMUM, not a target. The story determines its natural scene
    # count (bounded to MIN_SCENES..MAX_SCENES); an explicit scene_count only caps it.
    if scene_count is None:
        scene_count = MAX_SCENES
    scene_count = min(MAX_SCENES, max(MIN_SCENES, int(scene_count)))
    word_count = duration_minutes * WORDS_PER_MINUTE
    monster = monster or "उत्तर भारत की डरावनी लोक-कथा की प्रेत-आत्मा"

    client = ScriptClient(model=model)
    path = PROJECTS_ROOT / project_id / "pipeline.json"
    concept = concept or "उत्तर भारत के एक काल्पनिक कस्बे में लोक-कथाओं से जुड़ी डरावनी घटना"
    project = new_project(project_id, "B", concept, 3)
    # New projects opt into the explicit appearance/wardrobe contract. Legacy projects without this
    # marker keep the historical look_summary fallback.
    project["wardrobe_schema_version"] = 1
    project["style_reference"] = STYLE_LOCK
    project["flow_project_name"] = f"YouTube Automation - {(title or 'Last Bus')[:48]}"
    save(path, project)

    if title:
        raw = "Title supplied directly by the user; idea selection intentionally skipped."
    else:
        idea_prompt = render("ideas", {"CATEGORY": "", "CONCEPT": concept, "NUMBER_OF_IDEAS": 3})
        raw = ask(client, idea_prompt + "\nReturn the numbered list exactly as requested. Do not invent real place names.", 1800)
    save_stage(path, project, "ideas", raw)
    project["idea"].update(status="done", raw_output=raw)
    # User delegated selection. Lock the topic before the next call so later stages cannot drift.
    if title:
        hook = ask(client, f"Write one single-sentence Devanagari Hindi folk-horror hook for this exact video title: {title}. Keep it original, set in a fictional North Indian town, and use no real people or places. Return only the hook.", 220)
        selected = {"index": 1, "title": title.strip(), "hook": hook.strip(), "entity_archetype": "Pret-aatma"}
    else:
        selected = {"index": 1, "title": "आख़िरी बस की तीसरी सीट (Aakhri Bus Ki Teesri Seat)",
                    "hook": "बरसाती रात की आख़िरी बस में तीसरी सीट हर पड़ाव पर भीग जाती है, जबकि उस पर कोई दिखाई नहीं देता।",
                    "entity_archetype": "Pret-aatma"}
    project["idea"].update(items=[selected], selected_index=1, selected=selected)
    save(path, project)

    story = render("story", {"TITLE": selected["title"], "HOOK": selected["hook"], "LANGUAGE": "Hindi",
                               "DURATION_MINUTES": duration_minutes, "WORD_COUNT": word_count, "MONSTER": monster})
    raw = ask(client, story + f"\nWrite the full {word_count - 15}–{word_count + 15}-word Hindi story now. Use only fictional named people and a fictional unnamed North Indian town. Every line that will be spoken must be written in Devanagari. Keep one clear protagonist and one consistent supernatural entity. Do not switch to another premise.", 6000)
    project["script"].update(status="done", language="Hindi", duration_minutes=duration_minutes, word_count=word_count,
                             monster=monster, raw_text=raw, raw_output=raw)
    save(path, project)

    char_schema = """Return ONLY JSON: {"characters":[{"tag":"@CHAR-01-NAME","name":"...","age":22,"gender":"male|female|other|unknown","profession":"...","personality":"...","look_summary":"...","full_prompt":"...","appearance_lock":{"age":"22-year-old Indian man","gender":"male","build":"...","skin":"...","face":"...","hair":"...","facial_hair":"...","marks":"..."},"wardrobe":{"default_outfit":"nightwear","outfits":{"nightwear":{"label":"...","top":"...","bottom":"...","outerwear":"none","footwear":"...","accessories":"none","notes":"..."}}},"voice_description":"..."}]}.
All names/roles must come from the locked script. Never include a tag table as a character. Provide AGE (integer years), GENDER, PROFESSION, and PERSONALITY as factual character attributes taken from the locked script — do not guess them from the name and do not fabricate. If the script does not state an attribute, use age null / gender "unknown" / profession "unspecified" / personality "unspecified".
appearance_lock is the ONLY source of physical identity: age, gender, build, skin, face, hair, facial hair, marks. Do not put clothing, outfit, expression, pose, camera, reference-sheet wording, or "neutral 3/4 pose" in appearance_lock.
wardrobe is the ONLY source of clothing. default_outfit must exist in outfits. Every outfit id must be lowercase snake_case. Each outfit must specify exact top, bottom, outerwear, footwear, accessories, hair and notes; use "none" where a slot is intentionally empty. Do not put expression, pose, reference-sheet wording, or scene action in wardrobe.
look_summary and full_prompt remain reference-sheet metadata and must agree with appearance_lock + the default outfit, but they are NEVER used as scene clothing. Each full_prompt must be a complete 16:9 human-proportioned 2D reference-sheet prompt with the exact face, clothes, age and neutral reference pose.
Adult characters must have an adult age in both age and appearance_lock.age. If the locked script contains a childhood or younger version of a character, create a SEPARATE character tag (for example @CHAR-05-YOUNG-ARJUN) with its own child appearance_lock and wardrobe instead of reusing the adult tag."""
    raw = ask(client, render("characters", {"SCRIPT": raw}) + "\n" + char_schema, 3000)
    project["characters"] = assign_flow_voices(
        ensure_voice_descriptions(
            ensure_character_attributes(
                [{**c, "status": "pending", "error": None} for c in json_object(raw)["characters"]]
            )
        )
    )
    save_stage(path, project, "characters", raw)

    bg_schema = """Return ONLY JSON: {"backgrounds":[{"tag":"#BGD-01-NAME","location_name":"...","look_summary":"...","full_prompt":"..."}]}.
Every recurring location gets a wide and a close angle as separate tagged plates. All plates must be empty, 16:9, and in the locked 2D style."""
    raw = ask(client, render("backgrounds", {"SCRIPT": project["script"]["raw_text"]}) + "\n" + bg_schema, 3000)
    project["backgrounds"] = [{**b, "status": "pending", "error": None} for b in json_object(raw)["backgrounds"]]
    save_stage(path, project, "backgrounds", raw)

    compact_chars = [_compact_character(c) for c in project["characters"]]
    compact_bgs = [{"tag": b["tag"], "location_name": b["location_name"], "look_summary": b["look_summary"]} for b in project["backgrounds"]]

    # The story determines its natural scene count (bounded by MAX_SCENES). Batching
    # exists only for the writing model's response limit; it no longer assumes a
    # precomputed total. Every batch asks for the next chunk up to the cap.
    scenes: list[dict] = []
    while len(scenes) < MAX_SCENES:
        remaining = MAX_SCENES - len(scenes)
        chunk = min(SCENE_BATCH_SIZE, remaining)
        header = render("scenes", {"DURATION_MINUTES": duration_minutes, "MINIMUM_SCENES": MIN_SCENES,
                                   "MAX_SCENES": MAX_SCENES, "SCRIPT": project["script"]["raw_text"],
                                   "CHARACTERS": json.dumps(compact_chars, ensure_ascii=False),
                                   "BACKGROUNDS": json.dumps(compact_bgs, ensure_ascii=False)})
        if not scenes:
            continuation = "Start from the beginning of the story and continue naturally."
        else:
            continuation = (f"Scenes 1–{len(scenes)} already exist; continue the chronological story from where it stopped "
                            "without repeating or renumbering them. If the story is already complete, return an empty scene list.")
        instruction = (
            f"Generate the next natural batch of scenes (at most {chunk}, up to {MAX_SCENES} total). "
            f"{continuation} Cover the story's natural beats; do not pad and do not target {MAX_SCENES}."
        )
        raw = ask(client, header + "\n" + instruction + "\n" + scene_schema(MIN_SCENES, MAX_SCENES), 6000)
        items = json_object(raw).get("scenes", [])
        if not items:
            break
        for scene in items[:chunk]:
            scene["scene_number"] = len(scenes) + 1
            scenes.append(scene)
        save_stage(path, project, f"scenes_batch_{len(scenes)}", raw)

    # If the model overshot the hard cap, run exactly ONE merge pass (no truncation).
    if len(scenes) > MAX_SCENES:
        merged = compress_scenes(scenes, client)
        if len(merged) > MAX_SCENES:
            raise ValueError(f"Scene compression failed: still {len(merged)} scenes after one merge pass (max {MAX_SCENES}).")
        scenes = merged

    project["scenes"] = scenes
    fill_missing_narration(project["scenes"], project["script"]["raw_text"], client=client)
    validate(project, scene_count)
    missing_narration = [str(s["scene_number"]) for s in project["scenes"] if s["speaker"] in {"NARRATOR", "none"} and not str(s.get("narration_text", "")).strip()]
    if missing_narration:
        raise ValueError(f"Narration text is required for every non-character scene; missing scenes: {', '.join(missing_narration)}")
    save(path, project)
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", default="youtube-automation-last-bus")
    parser.add_argument("--model", default=None, help="Optional model override for the selected OpenAI or Groq provider.")
    parser.add_argument("--title", default=None, help="A supplied title skips idea selection and generates the locked scene project.")
    parser.add_argument("--concept", default=None, help="Optional premise detail to guide the title-based story.")
    parser.add_argument("--duration", type=int, default=5, help="Target duration in minutes (default 5).")
    parser.add_argument("--scenes", type=int, default=None, help="Exact scene count override (default: story-determined, max 35).")
    parser.add_argument("--monster", default=None, help="Optional supernatural entity override.")
    parser.add_argument("--check", action="store_true",
                        help="READ-ONLY audit of an existing project (--project-id or --project-file). "
                             "Writes nothing and calls no model.")
    parser.add_argument("--project-file", default=None,
                        help="With --check: explicit path to a pipeline.json (default: <projects>/<project-id>/pipeline.json).")
    parser.add_argument("--strict", action="store_true",
                        help="With --check: also exit 1 when story/scene WARNINGS need human review (blockers already exit 1).")
    args = parser.parse_args()
    if args.check:
        from . import project_check  # imported here so the generator path never depends on it

        target = Path(args.project_file) if args.project_file else PROJECTS_ROOT / args.project_id / "pipeline.json"
        report = project_check.run_check(target)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        failed = not report["ok"] or (args.strict and report.get("status") != "PASS")
        raise SystemExit(1 if failed else 0)
    print(generate(args.project_id, args.model, title=args.title, concept=args.concept,
                   duration_minutes=args.duration, scene_count=args.scenes, monster=args.monster))
