"""Focused offline tests for prompt hardening (STEP prompt-safety).

No network, no LLM, no Flow, no file writes. Verifies that internal asset tags
never reach Flow prompt text while story semantics, lipsync and narrator
behavior are preserved, and that the parser fallbacks stay consistent.
"""
import copy
import hashlib
import json
import pathlib
import re
import sys

SCRIPTING = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTING))
from pipeline.one_minute import make_prompts  # noqa: E402
from pipeline.prompt_safety import strip_internal_tags, contains_internal_tag  # noqa: E402
from pipeline import parsers  # noqa: E402

passed = 0


def check(label, condition, detail=None):
    global passed
    if condition:
        passed += 1
        print(f"PASS {label}")
    else:
        print("FAIL", label, detail)
        raise SystemExit(f"FAIL {label}")


BG_TAG = "#BGD-01-ARJUN-ROOM-WIDE"
CHARS = {
    "@CHAR-01-ARJUN": {
        "tag": "@CHAR-01-ARJUN", "name": "Arjun", "age": 22, "gender": "male",
        "profession": "unspecified", "personality": "curious, brave, compassionate",
        "look_summary": "22-year-old Indian man, average build, medium brown skin, short black hair, casual nightwear",
        "voice_description": "Young adult male, thoughtful, North Indian accent.",
    },
    "@CHAR-02-MAA": {
        "tag": "@CHAR-02-MAA", "name": "Maa", "age": None, "gender": "female",
        "profession": "unspecified", "personality": "caring, protective",
        "look_summary": "Middle-aged Indian woman, medium build, wheatish skin, gentle features, simple saree",
        "voice_description": "Middle-aged female, soft, North Indian accent.",
    },
}
BGS = {
    BG_TAG: {
        "tag": BG_TAG, "location_name": "Arjun's Bedroom (Wide)",
        "look_summary": "Simple Indian bedroom, window facing old cremation ground, night, teal-blue rainy light",
    },
}

# Scene-4-style: two roles in two distinct positions with a directional camera.
SCENE4 = {
    "scene_number": 4, "title": "Maa's warning", "background_tag": BG_TAG,
    "character_tags": ["@CHAR-01-ARJUN", "@CHAR-02-MAA"], "speaker": "@CHAR-02-MAA",
    "visual_action": "Maa stands at the door, Arjun near the window",
    "camera": "over-the-shoulder, from Maa toward Arjun's back",
    "effects": "soft blue room light, Maa's shadow",
    "sound_design": "rain outside, tense silence",
    "devanagari_dialogue": "अर्जुन, खिड़की बंद कर ले।",
}

out = make_prompts(copy.deepcopy(SCENE4), CHARS, BGS)
lip = out["animation_prompt_WITH_lipsync"]
nar = out["animation_prompt_NARRATOR_ONLY"]
still = out["still_image_prompt"]
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

# 1/2/3. animation prompts now carry the canonical identifiers the TS hardener needs.
check("lipsync prompt carries canonical #BGD tag for TS hardening", BG_TAG in lip)
check("lipsync prompt carries every canonical @CHAR tag", all(tag in lip for tag in CHARS))
check("narrator prompt carries canonical #BGD tag for TS hardening", BG_TAG in nar)
check("narrator prompt carries every canonical @CHAR tag", all(tag in nar for tag in CHARS))
check("no internal UUID introduced in animation prompts", not UUID.search(lip + nar))
check("no competing resolved background description in animation prompt", "Simple Indian bedroom" not in lip)
check("no competing resolved character identity in animation prompt", "22-year-old Indian man" not in lip)

# 4. human-readable metadata remains in the still prompt and names remain usable for construction.
check("still background location_name present", "Arjun's Bedroom (Wide)" in still)
check("still background look_summary present", "Simple Indian bedroom" in still)
check("still character 1 look_summary present", "22-year-old Indian man" in still)
check("still character 2 look_summary present", "Middle-aged Indian woman" in still)
check("character names present in animation construction", "Arjun" in lip and "Maa" in lip)

# 5/6. cardinality + visual-cleanliness guards
check("cardinality guard present", "exactly ONE visible instance" in lip)
check("cardinality anti-duplication wording present", "Never duplicate, clone, repeat, mirror" in lip)
check("visual-cleanliness guard present", "### VISUAL CLEANLINESS" in lip)
check("visual-cleanliness lists text/labels/UI", "NO visible text, labels, asset tags, captions, cards, or UI" in lip)
check("visual-cleanliness lists frames/borders", "NO borders, rounded frames" in lip)
check("existing negative restrictions retained", "### NEGATIVE RESTRICTIONS" in lip and "NO dual-character lip-sync" in lip)

# 7. story semantics preserved
check("visual_action preserved", "SCENE ACTION: Maa stands at the door, Arjun near the window" in lip)
_lip_cam = next((line for line in lip.splitlines() if line.startswith("CAMERA: ")), "")
check("multi-character CAMERA line normalized to a stable composition",
      "medium-wide stable shot from in front of the characters" in _lip_cam)
check("multi-character CAMERA line has no ambiguous camera wording",
      not any(w in _lip_cam.lower() for w in ("over-the-shoulder", "ots", "behind", "foreground", "reverse")))
check("multi-character camera safety block present", "### MULTI-CHARACTER CAMERA SAFETY" in lip)
check("effects preserved", "PHYSICS/EFFECTS: soft blue room light, Maa's shadow" in lip)

# 8. lipsync requirements preserved + speaker rendered as a name, not a tag
check("lipsync block preserved", "### LIP-SYNC CONTROL & AUDIO" in lip)
check("lipsync lock preserved", "[LIP-SYNC LOCK]" in lip)
check("speaker rendered by name", "Only Maa's mouth animates" in lip)
check("dialogue preserved", "DIALOGUE (DEVANAGARI ONLY): \"अर्जुन, खिड़की बंद कर ले।\"" in lip)
check("speaker identity preserved", "SPEAKER IDENTITY: Middle-aged female, soft, North Indian accent." in lip)
check("sound design preserved", "SOUND DESIGN: rain outside, tense silence" in lip)

# 9. narrator-only behavior preserved
check("narrator-only lock preserved", "No character speaks" in nar)
check("narrator layering note preserved", "Narrator voiceover will be layered in editing." in nar)
check("narrator no-dialogue rule preserved", "Do not add any dialogue." in nar)
check("narrator prompt excludes the spoken dialogue line", "खिड़की बंद कर ले" not in nar)

# 10. Scene4-style single-instance spatial anchoring (no second character)
check("spatial anchor block present for two roles", "### SINGLE-INSTANCE SPATIAL ANCHOR" in lip)
check("Arjun anchored to one position", "Arjun remains the single person near the window." in lip)
check("Maa anchored to the other position", "Maa remains the single person at the door." in lip)
check("camera-widening duplication guard present", "a wider or moving camera must never create a second instance" in lip)
check("no unfounded positive two-instance wording", not re.search(r"(?<!NO )\b(two|second|another|duplicate) (Arjun|Maa)\b", lip, re.I))

# 10c. contextual character-composition blocks (exact count, uniqueness, one role each, etc.)
check("character-count block present (TWO PEOPLE)", "### CHARACTER COUNT — EXACTLY TWO PEOPLE" in lip)
check("enumerates each character with one physical instance",
      "1. Arjun — exactly one physical instance." in lip and "2. Maa — exactly one physical instance." in lip)
check("character-uniqueness block present", "### CHARACTER UNIQUENESS" in lip)
check("uniqueness forbids a second instance anywhere", "Do not create a second instance of any character anywhere" in lip)
check("spatial-ownership block present", "### SPATIAL OWNERSHIP — ONE POSITION PER CHARACTER" in lip)
check("spatial ownership assigns exactly one position per character",
      "Arjun: exactly one physical body, one visible face, one identity, positioned near the window (and nowhere else)." in lip
      and "Maa: exactly one physical body, one visible face, one identity, positioned at the door (and nowhere else)." in lip)
check("camera-continuity block present", "### CAMERA CONTINUITY" in lip and "Reframing a character does not create another character." in lip)
check("identity-continuity block present", "### IDENTITY CONTINUITY" in lip and "No face swapping" in lip)
check("physical-realism block present", "### PHYSICAL REALISM" in lip and "One head per person, one body per person" in lip)
check("extra-person prohibition block present", "### EXTRA-PERSON PROHIBITION" in lip and "NO EXTRA PEOPLE" in lip)
check("explicit no-second-character statements",
      "There is NO second Arjun and NO duplicate Arjun." in lip and "There is NO second Maa and NO duplicate Maa." in lip)
check("reflection / mirror protection present",
      "### REFLECTION / MIRROR PROTECTION" in lip and "A reflection is not a second character." in lip)
check("strengthened cleanliness lists title cards and overlays",
      "generated title cards" in lip and "NO text overlays, subtitles, prompt text" in lip)

# 10d. contradictory spatial wording is detected and resolved deterministically
contradictory = make_prompts(copy.deepcopy({**SCENE4,
    "visual_action": "Maa stands at the door, Arjun near the window, Arjun beside the camera"}),
    CHARS, BGS)["animation_prompt_WITH_lipsync"]
check("contradictory spatial wording is resolved deterministically",
      "Spatial contradiction detected and deterministically resolved" in contradictory
      and "positioned near the window (and nowhere else)" in contradictory)
check("discarded conflicting position is not assigned", "positioned beside the camera" not in contradictory)

# 10b. movement-only two-role scene: a movement clause is never mislabelled as a position
moving = make_prompts(copy.deepcopy({**SCENE4, "visual_action": "Arjun moves forward, the figure sits still"}),
                      CHARS, BGS)["animation_prompt_WITH_lipsync"]
check("movement-only role uses generic single-instance anchor",
      "Arjun remains a single person; show exactly one Arjun in the frame." in moving)
check("movement clause not used as a spatial position", "single person moves forward" not in moving)

# 11. still_image_prompt internal-tag safety (composition otherwise preserved)
check("still prompt has no raw #BGD-* tag", "#BGD" not in still)
check("still prompt has no raw @CHAR-* tag", "@CHAR" not in still)
check("still prompt keeps human-readable environment", "Arjun's Bedroom (Wide)" in still)
check("still prompt keeps action and camera", "Maa stands at the door" in still and "Camera: over-the-shoulder" in still)
check("still prompt keeps flat-vector cleanliness clause", "no text, no labels, no asset tags, no watermark" in still)
check("still prompt removes reference-sheet-only pose language",
      "neutral 3/4 pose" not in still and "reference sheet" not in still.lower())

# 12. cardinality guard also applies to single-character scenes
single = make_prompts(copy.deepcopy({**SCENE4, "character_tags": ["@CHAR-01-ARJUN"], "speaker": "@CHAR-01-ARJUN"}),
                      CHARS, BGS)
check("single-character scene still gets cardinality guard", "exactly ONE visible instance" in single["animation_prompt_WITH_lipsync"])
check("single-character scene gets no two-role anchor", "SINGLE-INSTANCE SPATIAL ANCHOR" not in single["animation_prompt_WITH_lipsync"])
check("single-character scene states EXACTLY ONE PERSON",
      "### CHARACTER COUNT — EXACTLY ONE PERSON" in single["animation_prompt_WITH_lipsync"])
check("single-character scene declares exactly one physical human character",
      "There is exactly ONE physical human character in the entire scene:" in single["animation_prompt_WITH_lipsync"])
check("single-character scene still forbids extra people",
      "NO EXTRA PEOPLE. The number of visible human characters must equal exactly ONE." in single["animation_prompt_WITH_lipsync"])
check("single-character scene retains its cinematic camera (freedom preserved)",
      "CAMERA: over-the-shoulder, from Maa toward Arjun's back" in single["animation_prompt_WITH_lipsync"])
check("single-character scene gets no multi-character camera block",
      "### MULTI-CHARACTER CAMERA SAFETY" not in single["animation_prompt_WITH_lipsync"])

# 13. internal identity is preserved separately from prompt text
check("assets keep the real internal tags", out["assets"] == {"background_tag": BG_TAG, "character_tags": ["@CHAR-01-ARJUN", "@CHAR-02-MAA"]})

# 14. shared sanitizer is pure + idempotent
raw = "plate [#BGD-01-ARJUN-ROOM-WIDE] with @CHAR-01-ARJUN id 123e4567-e89b-12d3-a456-426614174000"
clean = strip_internal_tags(raw)
check("sanitizer removes bg/char tags", "#BGD" not in clean and "@CHAR" not in clean)
check("sanitizer removes raw UUIDs", not UUID.search(clean))
check("sanitizer is idempotent", strip_internal_tags(clean) == clean)
check("sanitizer leaves clean text byte-identical", strip_internal_tags("pure prompt, no tags") == "pure prompt, no tags")
check("contains_internal_tag detects leaks", contains_internal_tag(raw) and not contains_internal_tag(clean))

# 15. parser consistency: JSON path + text path + narrator variant
parsed_json = parsers.scenes('[{"scene_number":1,"speaker":"@CHAR-01-ARJUN",'
                             '"background_tag":"#BGD-01-ARJUN-ROOM-WIDE",'
                             '"character_tags":["@CHAR-01-ARJUN"],'
                             '"still_image_prompt":"art #BGD-01-ARJUN-ROOM-WIDE @CHAR-01-ARJUN",'
                             '"animation_prompt_WITH_lipsync":"ENV #BGD-01-ARJUN-ROOM-WIDE; CAST @CHAR-01-ARJUN"}]')
pj = parsed_json[0]
check("parsed JSON lipsync prompt sanitized", "#BGD" not in pj["animation_prompt_WITH_lipsync"] and "@CHAR" not in pj["animation_prompt_WITH_lipsync"])
check("parsed JSON still prompt sanitized", "#BGD" not in pj["still_image_prompt"] and "@CHAR" not in pj["still_image_prompt"])
check("parsed JSON keeps internal asset identity", pj["assets"]["background_tag"] == "#BGD-01-ARJUN-ROOM-WIDE")
check("parsed JSON preserves the additive outfit_ids field", pj.get("outfit_ids") == {})

raw_text = (
    "--- SCENE 1 — Test\n"
    "ASSETS: [#BGD-01-ARJUN-ROOM-WIDE] + [@CHAR-01-ARJUN]\n"
    "SPEAKER: @CHAR-01-ARJUN\n"
    "STILL IMAGE PROMPT: 2D art, #BGD-01-ARJUN-ROOM-WIDE environment, @CHAR-01-ARJUN present.\n"
    "## ANIMATION + AUDIO PROMPT\n"
    "ACTIVE ENVIRONMENT: #BGD-01-ARJUN-ROOM-WIDE\n"
    "ACTIVE CHARACTERS: @CHAR-01-ARJUN\n"
    'DIALOGUE (DEVANAGARI ONLY): "नमस्ते"\n'
)
text_scenes = parsers._text_scenes(raw_text)
check("text parser produced a scene", len(text_scenes) == 1)
ts = text_scenes[0]
check("text parser lipsync prompt sanitized", "#BGD" not in ts["animation_prompt_WITH_lipsync"] and "@CHAR" not in ts["animation_prompt_WITH_lipsync"])
check("text parser narrator prompt sanitized", "#BGD" not in ts["animation_prompt_NARRATOR_ONLY"] and "@CHAR" not in ts["animation_prompt_NARRATOR_ONLY"])
check("text parser still prompt sanitized", "#BGD" not in ts["still_image_prompt"] and "@CHAR" not in ts["still_image_prompt"])

variant = parsers._narrator_variant("### VISUAL ACTION & CAMERA\nSCENE ACTION: @CHAR-01-ARJUN at #BGD-01-X\n"
                                    "### LIP-SYNC CONTROL & AUDIO\nAUDIO PROTOCOL: voice\n"
                                    "### NEGATIVE RESTRICTIONS\n- NO text")
check("narrator variant strips tags", "#BGD" not in variant and "@CHAR" not in variant)
check("narrator variant keeps narrator instruction", variant.endswith("Do not add any dialogue."))

# 16. on-screen text / character-name-label prohibition (Scene 17 defect class)
check("dedicated on-screen-text prohibition block present", "### NO ON-SCREEN TEXT OR CHARACTER LABELS" in lip)
check("prohibits character name labels/badges/cards/nameplates",
      "name label, name badge, circular name card, floating nameplate" in lip)
check("states character names are internal metadata", "INTERNAL generation metadata only" in lip)
check("forbids text attached to a person",
      "Do NOT attach text to a character or display text beside, above, or below a person." in lip)
check("identity only in visual appearance",
      "All character identity exists ONLY in each character's visual appearance, never as on-screen text." in lip)
check("name-aware prohibition: never render/spell/visualize any character name",
      "NEVER render, display, print, write, spell, translate, stylize, or visualize any character name" in lip)
check("names inside scene action explicitly covered",
      "If a character name appears in the story action above, treat that occurrence as narrative information only" in lip)
check("prohibits emblem / identification marker / profile card / lower-third",
      all(w in lip for w in ["emblem", "identification marker", "profile card", "lower-third"]))
check("positive illustration-only instruction present",
      "The frame contains ONLY the illustrated story scene and its physical environment." in lip
      and "Characters are identified ONLY by their visual appearance." in lip
      and "There are NO informational overlays of any kind." in lip)

# 16b. reconstruct the authoritative scenes offline and verify the hardening
_PIPE = pathlib.Path(SCRIPTING / "projects" / "youtube-automation-2-20261003160855-2740" / "pipeline.json")
_proj = json.loads(_PIPE.read_text(encoding="utf-8"))
_pchars = {c["tag"]: c for c in _proj["characters"]}
_pbgs = {b["tag"]: b for b in _proj["backgrounds"]}


def _rebuild(n):
    s = next(x for x in _proj["scenes"] if x["scene_number"] == n)
    return make_prompts(copy.deepcopy(s), _pchars, _pbgs)["animation_prompt_WITH_lipsync"]


_REQUIRED_SAFEGUARDS = [
    "### CHARACTER CARDINALITY", "### CHARACTER COUNT", "### CHARACTER UNIQUENESS",
    "### SPATIAL OWNERSHIP", "### CAMERA CONTINUITY", "### IDENTITY CONTINUITY",
    "### PHYSICAL REALISM", "### EXTRA-PERSON PROHIBITION", "### REFLECTION / MIRROR PROTECTION",
    "### VISUAL CLEANLINESS",
]
for _n in (4, 5, 11, 12, 17):
    _p = _rebuild(_n)
    check(f"scene {_n} has on-screen-text prohibition", "### NO ON-SCREEN TEXT OR CHARACTER LABELS" in _p)
    check(f"scene {_n} has strengthened name-aware prohibition",
          "NEVER render, display, print, write, spell, translate, stylize, or visualize any character name" in _p
          and "If a character name appears in the story action above" in _p)
    check(f"scene {_n} has positive illustration-only instruction",
          "The frame contains ONLY the illustrated story scene and its physical environment." in _p
          and "There are NO informational overlays of any kind." in _p)
    check(f"scene {_n} carries canonical tags and no uuid",
          "#BGD" in _p and "@CHAR" in _p and not UUID.search(_p))
    check(f"scene {_n} keeps all safeguards", all(s in _p for s in _REQUIRED_SAFEGUARDS))
    _scene = next(x for x in _proj["scenes"] if x["scene_number"] == _n)
    if len(_scene.get("character_tags", [])) >= 2:
        check(f"scene {_n} keeps multi-character camera safety", "### MULTI-CHARACTER CAMERA SAFETY" in _p)
    else:
        check(f"scene {_n} (single character) has no multi-camera block", "### MULTI-CHARACTER CAMERA SAFETY" not in _p)

_p17 = _rebuild(17)
check("scene 17 still uses character names internally for construction",
      "अर्जुन" in _p17 and "राधा देवी की आत्मा" in _p17)
check("scene 17 retains the Hindi name in narrative/internal prompt text",
      "राधा देवी की आत्मा" in _p17)
check("scene 17 explicitly prohibits visual rendering of that same name",
      "NEVER render, display, print, write, spell, translate, stylize, or visualize any character name" in _p17)
check("scene 17 name usage is explicitly non-visual",
      "MUST NOT appear as visible text" in _p17)
check("scene 17 prohibits emblems/identifier/profile card/lower-third",
      all(w in _p17 for w in ["emblem", "identification marker", "profile card", "lower-third"]))
check("scene 17 names inside scene action are covered",
      "If a character name appears in the story action above" in _p17)
check("prompt generation deterministic after hardening", _rebuild(17) == _rebuild(17))
check("scene 17 reconstructed SHA differs from the pre-strengthening SHA",
      hashlib.sha256(_p17.encode()).hexdigest() != "829a38540c33a1d85c1135d69f09c42c1a11ac86908fcb9abf622d8d4e8ebd16")
check("scene 17 reconstructed SHA differs from the rejected prompt SHA",
      hashlib.sha256(_p17.encode()).hexdigest() != "83aaa86692be2615a0adc91373b4ce70213d45824983f596ab9a17a63ebbc754")
check("authoritative pipeline.json byte-for-byte unchanged",
      hashlib.sha256(_PIPE.read_bytes()).hexdigest() == "f55742df5cc7aee679d3a9bf7861e4816412c8f8ec0ba6ed410672a9dd4f2167")

print(f"\nALL PASSED: {passed} checks")
