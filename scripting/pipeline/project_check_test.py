"""Focused offline tests for the READ-ONLY project check (`--check`).

No network, no model, no Flow, no writes to a real project. Temp files only.
"""
import copy
import json
import pathlib
import sys
import tempfile

SCRIPTING = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTING))
from pipeline.project_check import check_project, run_check  # noqa: E402

passed = 0

try:  # Devanagari detail strings must not crash the console on a cp1252 Windows shell
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover - non-reconfigurable stream
    pass


def check(label, condition, detail=None):
    global passed
    if condition:
        passed += 1
        print(f"PASS {label}")
    else:
        print("FAIL", label, detail)
        raise SystemExit(f"FAIL {label}")


BG = "#BGD-01-BUS-WIDE"
BG2 = "#BGD-02-BUS-CLOSE"
ARJUN = {
    "tag": "@CHAR-01-ARJUN", "name": "Arjun", "age": 22, "gender": "male",
    "profession": "student", "personality": "brave",
    "look_summary": "22-year-old Indian man.",
    "full_prompt": "Reference-sheet prompt.",
    "appearance_lock": {
        "age": "22-year-old adult Indian man", "gender": "male", "build": "medium build",
        "skin": "medium brown skin", "face": "oval face, clean-shaven",
        "hair": "short black hair", "facial_hair": "none", "marks": "none",
    },
    "wardrobe": {
        "default_outfit": "nightwear",
        "outfits": {"nightwear": {
            "label": "sleepwear", "top": "steel grey cotton t-shirt",
            "bottom": "navy blue pyjama trousers", "outerwear": "none",
            "footwear": "barefoot", "accessories": "none", "notes": "loose fit",
        }},
    },
    "voice_description": "Young adult male, North Indian accent.",
}
BACKGROUNDS = [
    {"tag": BG, "location_name": "Bus (wide)", "look_summary": "Empty night bus."},
    {"tag": BG2, "location_name": "Bus (close)", "look_summary": "Third seat, close."},
]


def scene(number=1, narration="बस की तीसरी सीट पर कोई बैठा था, और खिड़की के बाहर सिर्फ़ अंधेरा था।",
          dialogue="", speaker="NARRATOR", background=BG, characters=None):
    return {
        "scene_number": number, "title": f"Scene {number}", "background_tag": background,
        "character_tags": list(characters if characters is not None else [ARJUN["tag"]]),
        "speaker": speaker, "visual_action": "Arjun looks at the third seat.",
        "camera": "static wide shot", "effects": "rain", "sound_design": "rain",
        "devanagari_dialogue": dialogue, "narration_text": narration,
    }


def project(scenes=None, characters=None, backgrounds=None, script=None):
    return {
        "project_id": "test-project",
        "wardrobe_schema_version": 1,
        "characters": copy.deepcopy(characters if characters is not None else [ARJUN]),
        "backgrounds": copy.deepcopy(backgrounds if backgrounds is not None else BACKGROUNDS),
        "scenes": copy.deepcopy(scenes if scenes is not None else [scene(1), scene(2)]),
        "script": script if script is not None else {},
    }


def codes(report, key="warnings"):
    return [item["code"] for item in report[key]]


# ================== happy path ==================
report = check_project(project())
check("valid project passes read-only check", report["ok"] is True, report["errors"])
check("report is explicitly read-only", report["read_only"] is True)
check("report counts scenes/characters/backgrounds",
      report["scenes"] == 2 and report["characters"] == 1 and report["backgrounds"] == 2, report)
check("clean project raises no structural errors", report["errors"] == [], report["errors"])

# ================== structural failures are ERRORS ==================
bad = project(scenes=[scene(1, background="#BGD-99-UNKNOWN"), scene(2)])
report = check_project(bad)
check("unknown background tag is a structural error", report["ok"] is False and "STRUCTURE_INVALID" in codes(report, "errors"), report["errors"])

report = check_project(project(scenes=[scene(1, narration=""), scene(2, narration="")]))
check("missing narration on narrator scenes is an error", report["ok"] is False and "NARRATION_MISSING" in codes(report, "errors"), report["errors"])
check("missing narration names the affected scenes", report["errors"][0].get("scenes") == ["1", "2"], report["errors"])

report = check_project(project(scenes=[scene(1)]))
check("a single scene is below MIN_SCENES and fails", report["ok"] is False, report)

# ================== story-quality observations are WARNINGS ==================
report = check_project(project(scenes=[scene(1, narration="रात थी।"), scene(2, dialogue="मैं यहीं रुकूंगा।", speaker=ARJUN["tag"])]))
check("short opening is a warning, not a failure", report["ok"] is True and "WEAK_OPENING" in codes(report), report["warnings"])

repeated = "यह सीट हर रात तीसरी हो जाती है और कोई उस पर नहीं बैठता।"
report = check_project(project(scenes=[scene(1, narration=repeated), scene(2, narration=repeated)]))
check("repeated spoken line is a warning", report["ok"] is True and "REPEATED_LINE" in codes(report), report["warnings"])
repeated_item = next(item for item in report["warnings"] if item["code"] == "REPEATED_LINE")
check("repeated-line warning lists both scenes", repeated_item["scenes"] == [1, 2], repeated_item)

report = check_project(project(script={"raw_text": "short story only", "word_count": 750, "duration_minutes": 5}))
check("story far below its word target is a warning", report["ok"] is True and "WORD_COUNT_OFF_TARGET" in codes(report), report["warnings"])

report = check_project(project(scenes=[scene(1, narration=""), scene(2, narration="")]))
# narration errors dominate; the ending warning must still be present, not hidden.
check("silent ending is reported as a warning as well", "ENDING_UNCLEAR" in codes(report), report["warnings"])

second = copy.deepcopy(ARJUN)
second["tag"] = "@CHAR-02-ARJUN"
second["appearance_lock"]["age"] = "35-year-old adult Indian man"
report = check_project(project(characters=[ARJUN, second]))
check("duplicate display name across tags is a warning", "DUPLICATE_CHARACTER_NAME" in codes(report), report["warnings"])

unspecified = copy.deepcopy(ARJUN)
unspecified.update({"age": None, "gender": "unknown", "profession": "unspecified"})
report = check_project(project(characters=[unspecified]))
check("unspecified character attributes are surfaced as a warning", "CHARACTER_ATTRIBUTE_UNSPECIFIED" in codes(report), report["warnings"])

report = check_project(project(backgrounds=BACKGROUNDS + [{"tag": "#BGD-03-UNUSED", "location_name": "Unused", "look_summary": "x"}]))
check("unused background is surfaced as a warning", "UNUSED_BACKGROUND" in codes(report), report["warnings"])

# ================== read-only guarantee ==================
with tempfile.TemporaryDirectory() as tmp:
    target = pathlib.Path(tmp) / "pipeline.json"
    payload = project()
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    before = target.read_bytes()
    before_mtime = target.stat().st_mtime_ns
    checked = run_check(target)
    after = target.read_bytes()
    check("run_check reports the project file", checked["project_file"].endswith("pipeline.json"))
    check("run_check NEVER rewrites pipeline.json", after == before)
    check("run_check NEVER touches file mtime", target.stat().st_mtime_ns == before_mtime)
    check("run_check creates no sibling files", sorted(p.name for p in pathlib.Path(tmp).iterdir()) == ["pipeline.json"],
          sorted(p.name for p in pathlib.Path(tmp).iterdir()))

    bom_target = pathlib.Path(tmp) / "bom.json"
    bom_target.write_text("\ufeff" + json.dumps(payload), encoding="utf-8")
    check("run_check tolerates a UTF-8 BOM instead of crashing", run_check(bom_target)["ok"] is True, run_check(bom_target))

    missing = run_check(pathlib.Path(tmp) / "absent.json")
    check("missing project reports a clear error", missing["ok"] is False and missing["errors"][0]["code"] == "PROJECT_NOT_FOUND", missing)

    broken = pathlib.Path(tmp) / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    check("unreadable project reports a clear error", run_check(broken)["errors"][0]["code"] == "PROJECT_UNREADABLE", run_check(broken))

# ================== report shape is JSON-serialisable and stable ==================
report = check_project(project())
serialised = json.dumps(report, ensure_ascii=False)
check("report serialises to JSON", json.loads(serialised)["ok"] is True)
check("report keeps a stable top-level contract",
      set(report) >= {"ok", "read_only", "project_id", "scenes", "characters", "backgrounds", "stats", "errors", "warnings"}, set(report))

print(f"\nPROJECT-CHECK TESTS PASSED ({passed} checks)")
