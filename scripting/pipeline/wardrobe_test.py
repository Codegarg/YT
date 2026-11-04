"""Focused offline tests for the explicit appearance/wardrobe contract (Python side).

No network, no LLM, no Flow, no file writes. These tests mirror the TypeScript contract:
deterministic outfit resolution, exact clothing, unknown-outfit failure, missing-wardrobe
failure, reference-sheet rejection, and parser preservation of the additive fields.
"""
import copy
import pathlib
import sys

SCRIPTING = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTING))
from pipeline.one_minute import (  # noqa: E402
    _appearance_text,
    _outfit_text,
    _resolve_outfit,
    _strip_reference_sheet_phrases,
    _validate_wardrobe_contract,
    make_prompts,
    validate,
)
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


def expect_error(label, fn):
    try:
        fn()
    except ValueError:
        check(label, True)
        return
    check(label, False, "expected ValueError")


BG = "#BGD-01-ARJUN-ROOM-WIDE"
ARJUN = {
    "tag": "@CHAR-01-ARJUN",
    "name": "Arjun",
    "age": 22,
    "gender": "male",
    "look_summary": "22-year-old Indian man, neutral 3/4 pose.",
    "full_prompt": "Reference-sheet prompt with an old red shirt and neutral 3/4 pose.",
    "appearance_lock": {
        "age": "22-year-old adult Indian man",
        "gender": "male",
        "build": "medium build",
        "skin": "medium brown skin",
        "face": "oval face, clean-shaven",
        "hair": "short black hair",
        "facial_hair": "none",
        "marks": "none",
    },
    "wardrobe": {
        "default_outfit": "nightwear",
        "outfits": {
            "nightwear": {
                "label": "sleepwear",
                "top": "steel grey cotton t-shirt",
                "bottom": "navy blue pyjama trousers",
                "outerwear": "none",
                "footwear": "barefoot",
                "accessories": "none",
                "notes": "loose comfortable fit",
            },
            "rain_coat": {
                "label": "rain outfit",
                "top": "dark green rain jacket",
                "bottom": "navy blue pyjama trousers",
                "outerwear": "dark green hooded raincoat",
                "footwear": "black rubber sandals",
                "accessories": "none",
                "notes": "hood down",
            },
        },
    },
    "voice_description": "Young adult male, North Indian accent.",
}
CHARACTERS = {ARJUN["tag"]: ARJUN}
BACKGROUNDS = {BG: {"tag": BG, "location_name": "Arjun's Bedroom (Wide)", "look_summary": "Night bedroom."}}
SCENE = {
    "scene_number": 1,
    "title": "Night",
    "background_tag": BG,
    "character_tags": [ARJUN["tag"]],
    "speaker": "NARRATOR",
    "visual_action": "Arjun stands near the window.",
    "camera": "static wide shot",
    "effects": "rain",
    "sound_design": "rain",
    "devanagari_dialogue": "",
    "narration_text": "बारिश रुकने का नाम नहीं लेती।",
}


def project_with(scene=None, character=None):
    return {
        "wardrobe_schema_version": 1,
        "characters": [character or ARJUN],
        "backgrounds": [BACKGROUNDS[BG]],
        "scenes": [scene or SCENE],
    }


# Deterministic formatting / resolution.
check("appearance_lock formats every explicit physical field",
      _appearance_text(ARJUN["appearance_lock"]) ==
      "age: 22-year-old adult Indian man; gender: male; build: medium build; skin: medium brown skin; "
      "face: oval face, clean-shaven; hair: short black hair; facial_hair: none; marks: none")
check("wardrobe formats the exact garment slots",
      "top: steel grey cotton t-shirt" in _outfit_text(ARJUN["wardrobe"]["outfits"]["nightwear"])
      and "bottom: navy blue pyjama trousers" in _outfit_text(ARJUN["wardrobe"]["outfits"]["nightwear"]))
ok, outfit_id, outfit, reason = _resolve_outfit(ARJUN, SCENE, True)
check("default outfit resolves deterministically", ok and outfit_id == "nightwear" and not reason)
check("default outfit carries exact clothing", outfit["top"] == "steel grey cotton t-shirt")

override_scene = copy.deepcopy(SCENE)
override_scene["outfit_ids"] = {ARJUN["tag"]: "rain_coat"}
ok, outfit_id, outfit, reason = _resolve_outfit(ARJUN, override_scene, True)
check("explicit scene override selects the exact outfit", ok and outfit_id == "rain_coat" and outfit["top"] == "dark green rain jacket")
check("override does not mutate the default outfit", ARJUN["wardrobe"]["outfits"]["nightwear"]["top"] == "steel grey cotton t-shirt")

unknown_scene = copy.deepcopy(SCENE)
unknown_scene["outfit_ids"] = {ARJUN["tag"]: "missing_outfit"}
ok, outfit_id, _, reason = _resolve_outfit(ARJUN, unknown_scene, True)
check("unknown outfit id fails closed", not ok and outfit_id == "missing_outfit" and "unknown outfit" in reason)

# Whole-project validation.
_validate_wardrobe_contract(project_with(), CHARACTERS)
check("valid strict project passes wardrobe validation", True)

valid_project = project_with()
valid_project["scenes"] = [copy.deepcopy(SCENE), {**copy.deepcopy(SCENE), "scene_number": 2}]
validate(valid_project, 2)
check("strict project passes the full pipeline validate/make_prompts path", True)
check("validated animation prompt carries canonical tags", BG in valid_project["scenes"][0]["animation_prompt_NARRATOR_ONLY"])
check("validated still prompt uses the exact default outfit", "steel grey cotton t-shirt" in valid_project["scenes"][0]["still_image_prompt"])

missing = copy.deepcopy(ARJUN)
missing.pop("wardrobe")
expect_error("missing wardrobe fails strict validation",
             lambda: _validate_wardrobe_contract(project_with(), {missing["tag"]: missing}))

missing_appearance = copy.deepcopy(ARJUN)
missing_appearance.pop("appearance_lock")
expect_error("missing appearance_lock fails strict validation",
             lambda: _validate_wardrobe_contract(
                 project_with(character=missing_appearance), {missing_appearance["tag"]: missing_appearance}))

unknown_project_scene = copy.deepcopy(override_scene)
unknown_project_scene["outfit_ids"] = {ARJUN["tag"]: "missing_outfit"}
expect_error("unknown outfit fails whole-project validation",
             lambda: _validate_wardrobe_contract(project_with(scene=unknown_project_scene), CHARACTERS))

undeclared_scene = copy.deepcopy(SCENE)
undeclared_scene["outfit_ids"] = {"@CHAR-09-OTHER": "nightwear"}
expect_error("outfit selection for an undeclared character fails validation",
             lambda: _validate_wardrobe_contract(project_with(scene=undeclared_scene), CHARACTERS))

reference_character = copy.deepcopy(ARJUN)
reference_character["appearance_lock"]["face"] = "oval face, neutral 3/4 pose"
expect_error("reference-sheet pose in appearance_lock fails validation",
             lambda: _validate_wardrobe_contract(
                 project_with(character=reference_character), {reference_character["tag"]: reference_character}))

# Scene-facing sanitization.
clean = _strip_reference_sheet_phrases("22-year-old Indian man, casual nightwear, neutral 3/4 pose.")
check("reference-sheet pose is removed", "neutral 3/4 pose" not in clean.lower())
check("reference-sheet removal keeps the identity", "22-year-old Indian man" in clean and "casual nightwear" in clean)
check("reference-sheet removal is deterministic", clean == _strip_reference_sheet_phrases("22-year-old Indian man, casual nightwear, neutral 3/4 pose."))

# Prompt builder: animation carries canonical tags; still is human-readable and exact.
prompt_scene = copy.deepcopy(override_scene)
built = make_prompts(prompt_scene, CHARACTERS, BACKGROUNDS)
lip = built["animation_prompt_WITH_lipsync"]
still = built["still_image_prompt"]
check("animation prompt carries canonical tags for the TS hardener", BG in lip and ARJUN["tag"] in lip)
check("animation prompt does not pre-resolve character identity", "short black hair" not in lip)
check("still prompt uses the exact selected outfit", "dark green rain jacket" in still)
check("still prompt does not use the unselected default outfit", "steel grey cotton t-shirt" not in still)
check("still prompt carries no raw machine tags", "#BGD" not in still and "@CHAR" not in still)
check("still prompt carries no reference-sheet pose", "neutral 3/4 pose" not in still.lower())
check("still prompt carries no reference-sheet language", "reference-sheet prompt" not in still.lower())

# Parser preservation of the additive contract.
raw_chars = ('[{"tag":"@CHAR-01-ARJUN","name":"Arjun","look_summary":"x","full_prompt":"y",'
             '"appearance_lock":{"age":"22-year-old adult Indian man"},'
             '"wardrobe":{"default_outfit":"nightwear","outfits":{"nightwear":{"top":"t-shirt"}}}}]')
parsed = parsers.characters(raw_chars)[0]
check("parser preserves appearance_lock", parsed["appearance_lock"]["age"] == "22-year-old adult Indian man")
check("parser preserves wardrobe", parsed["wardrobe"]["default_outfit"] == "nightwear")
raw_scene = ('[{"scene_number":1,"speaker":"NARRATOR","background_tag":"#BGD-01-X",'
             '"character_tags":["@CHAR-01-ARJUN"],"outfit_ids":{"@CHAR-01-ARJUN":"rain_coat"}}]')
parsed_scene = parsers.scenes(raw_scene)[0]
check("parser preserves outfit_ids", parsed_scene["outfit_ids"] == {"@CHAR-01-ARJUN": "rain_coat"})

print(f"\nALL PASSED: {passed} checks")
