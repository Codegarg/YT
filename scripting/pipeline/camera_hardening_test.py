"""Focused deterministic tests for character-count-aware camera safety (offline)."""
import copy
import pathlib
import re
import sys

SCRIPTING = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTING))
from pipeline.one_minute import make_prompts, derive_camera_safety  # noqa: E402

passed = 0


def check(label, condition, detail=None):
    global passed
    if condition:
        passed += 1
        print(f"PASS {label}")
    else:
        print("FAIL", label, detail)
        raise SystemExit(f"FAIL {label}")


BG = "#BGD-01-ARJUN-ROOM-WIDE"
CHARS = {
    "@CHAR-01-ARJUN": {"tag": "@CHAR-01-ARJUN", "name": "Arjun", "age": 22, "gender": "male",
                       "profession": "unspecified", "personality": "brave",
                       "look_summary": "22-year-old Indian man, short black hair, casual nightwear",
                       "voice_description": "Young adult male, North Indian accent."},
    "@CHAR-02-MAA": {"tag": "@CHAR-02-MAA", "name": "Maa", "age": None, "gender": "female",
                     "profession": "unspecified", "personality": "protective",
                     "look_summary": "Middle-aged Indian woman, simple saree",
                     "voice_description": "Middle-aged female, soft, North Indian accent."},
    "@CHAR-04-DADI": {"tag": "@CHAR-04-DADI", "name": "Dadi", "age": None, "gender": "female",
                      "profession": "unspecified", "personality": "wise",
                      "look_summary": "Elderly Indian woman, silver hair in bun, spectacles, simple saree",
                      "voice_description": "Elderly female, warm, North Indian accent."},
}
BGS = {BG: {"tag": BG, "location_name": "Arjun's Bedroom (Wide)",
            "look_summary": "Simple Indian bedroom, window facing old cremation ground, night"}}

ONE = ["@CHAR-01-ARJUN"]
TWO = ["@CHAR-01-ARJUN", "@CHAR-02-MAA"]
THREE = ["@CHAR-01-ARJUN", "@CHAR-02-MAA", "@CHAR-04-DADI"]
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def scene(characters, camera, action="Arjun stands near the window", dialogue="", speaker="NARRATOR"):
    return {"scene_number": 1, "title": "T", "background_tag": BG, "character_tags": characters,
            "speaker": speaker, "visual_action": action, "camera": camera, "effects": "rain",
            "sound_design": "rain", "devanagari_dialogue": dialogue}


def prompt(characters, camera, action="Arjun stands near the window", dialogue="", speaker="NARRATOR"):
    return make_prompts(copy.deepcopy(scene(characters, camera, action, dialogue, speaker)), CHARS, BGS)["animation_prompt_WITH_lipsync"]


def cam_line(text):
    return next((line for line in text.splitlines() if line.startswith("CAMERA: ")), "")


# 1/2. multi-character camera safety enabled for 2 and 3 characters
check("two-character scene enables multi-character camera safety", "### MULTI-CHARACTER CAMERA SAFETY" in prompt(TWO, "static wide shot"))
check("three-character scene enables multi-character camera safety", "### MULTI-CHARACTER CAMERA SAFETY" in prompt(THREE, "static wide shot"))

# 3. one-character scene retains cinematic freedom
one = prompt(ONE, "over-the-shoulder close-up, dynamic camera")
check("one-character scene keeps its cinematic camera wording", "CAMERA: over-the-shoulder close-up, dynamic camera" in one)
check("one-character scene has no multi-character camera block", "### MULTI-CHARACTER CAMERA SAFETY" not in one)

# 4-8. unsafe concepts detected and replaced for multi-character scenes
ots = derive_camera_safety(2, "over-the-shoulder, from Maa toward Arjun's back")
check("OTS detected", "over-the-shoulder" in ots["unsafe"])
check("OTS replaced in the normalized camera", "over-the-shoulder" not in ots["camera"].lower())
check("foreground-character framing detected", "foreground-character framing" in derive_camera_safety(2, "foreground character framing")["unsafe"])
check("shot/reverse-shot detected", "shot/reverse-shot" in derive_camera_safety(2, "shot/reverse-shot camera")["unsafe"])
check("camera-behind-character detected", "camera behind a character" in derive_camera_safety(2, "camera behind the character")["unsafe"])
check("side-switch detected", bool({"camera switching sides", "side switch"} & set(derive_camera_safety(2, "camera switches sides; side switch")["unsafe"])))
check("Hindi over-the-shoulder detected",
      "over-the-shoulder (Hindi)" in derive_camera_safety(2, "ओवर-द-शोल्डर, माँ की ओर से अर्जुन की पीठ")["unsafe"])
check("Hindi 'from behind' detected", "from behind (Hindi)" in derive_camera_safety(2, "कैमरा पीछे से")["unsafe"])

# 9. safe static/medium-wide camera preserved
safe = derive_camera_safety(2, "static medium-wide shot")
check("safe multi-character camera scale preserved", "medium-wide" in safe["camera"] and not safe["unsafe"])
check("multi-character prompt uses the safe scale", "medium-wide" in cam_line(prompt(TWO, "static medium-wide shot")))

# 10. story / action / dialogue unchanged
p = prompt(TWO, "over-the-shoulder, from Maa toward Arjun's back", action="Maa stands at the door, Arjun near the window", dialogue="अर्जुन, खिड़की बंद कर ले।", speaker="@CHAR-02-MAA")
check("story action unchanged", "SCENE ACTION: Maa stands at the door, Arjun near the window" in p)
check("dialogue unchanged", 'DIALOGUE (DEVANAGARI ONLY): "अर्जुन, खिड़की बंद कर ले।"' in p)
check("multi-character CAMERA line has no ambiguous wording",
      not any(w in cam_line(p).lower() for w in ("over-the-shoulder", "ots", "behind", "foreground", "reverse")))

# 11-14. preserved composition protections
check("character cardinality still correct", "### CHARACTER COUNT — EXACTLY TWO PEOPLE" in p)
check("duplicate protection still present", "### CHARACTER UNIQUENESS" in p and "There is NO second Arjun and NO duplicate Arjun." in p)
check("reflection protection still present", "### REFLECTION / MIRROR PROTECTION" in p)
check("visual cleanliness still present", "### VISUAL CLEANLINESS" in p)
check("identity continuity still present", "### IDENTITY CONTINUITY" in p)
check("physical realism still present", "### PHYSICAL REALISM" in p)

# 15-17. canonical identifiers are emitted for the TS hardener; the still prompt stays human-readable.
check("multi-character prompt carries canonical #BGD tag for TS hardening", BG in p)
check("multi-character prompt carries canonical @CHAR tags for TS hardening", all(tag in p for tag in TWO))
check("no UUID in multi-character prompt", not UUID.search(p))
still = make_prompts(copy.deepcopy(scene(TWO, "over-the-shoulder")), CHARS, BGS)["still_image_prompt"]
check("still prompt has no raw identifiers", "#BGD" not in still and "@CHAR" not in still)

# 18. deterministic output
check("deterministic output", prompt(TWO, "over-the-shoulder") == prompt(TWO, "over-the-shoulder"))

print(f"\nCAMERA HARDENING TESTS PASSED ({passed} checks)")
