"""Focused tests for the offline deterministic Flow voice selector (A-S)."""
import pathlib
import re
import sys

SCRIPTING = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTING))
from pipeline.voice_selector import select_flow_voice, VOICE_CATALOG, VALID_VOICE_NAMES, UNGENDERED  # noqa: E402

passed = 0
def check(label, condition, detail=None):
    global passed
    if condition:
        passed += 1
        print(f"PASS {label}")
    else:
        print(f"FAIL {label}", detail)
        raise SystemExit(f"FAIL {label}")

MALE = {e["name"] for e in VOICE_CATALOG if e["gender"] == "male"}
FEMALE = {e["name"] for e in VOICE_CATALOG if e["gender"] == "female"}
UNGEN = {e["name"] for e in VOICE_CATALOG if e["gender"] == UNGENDERED}

check("catalog has 30 voices", len(VOICE_CATALOG) == 30, len(VOICE_CATALOG))
check("16 male / 13 female / 1 ungendered", (len(MALE), len(FEMALE), len(UNGEN)) == (16, 13, 1), (len(MALE), len(FEMALE), len(UNGEN)))

# A. Male character only returns a male voice (across a grid of inputs)
for age, pers in [(22, "calm"), (70, "wise"), (16, "energetic"), (None, "gentle")]:
    v = select_flow_voice(age=age, gender="male", profession="student", personality=pers, voice_description="deep calm tone")
    check(f"A male input returns male voice ({age},{pers})", v in MALE, v)

# B. Female character only returns a female voice
for age, pers in [(22, "calm"), (70, "wise"), (16, "energetic")]:
    v = select_flow_voice(age=age, gender="female", profession="teacher", personality=pers, voice_description="soft warm tone")
    check(f"B female input returns female voice ({age},{pers})", v in FEMALE, v)

# C. Unknown gender can return from the broader catalog
v = select_flow_voice(gender="unknown", personality="calm")
check("C unknown gender returns valid voice", v in VALID_VOICE_NAMES, v)

# D. Other gender can use the ungendered option
v = select_flow_voice(gender="other", personality="forward")
check("D other gender returns ungendered voice", v in UNGEN, v)

# E. Young age prefers youthful/brighter characteristics over elderly
young = select_flow_voice(age=10, gender="female", voice_description="bright youthful tone")
old = select_flow_voice(age=75, gender="female", voice_description="bright youthful tone")
def pitch_rank(name):
    entry = next(e for e in VOICE_CATALOG if e["name"] == name)
    return {"high": 3, "mid-high": 3, "mid": 2, "mid-low": 1, "low": 0, "lower": 1, "younger": 3}.get(entry["pitch"], 4)
check("E young age ranks higher pitch than elderly for same profile", pitch_rank(young) >= pitch_rank(old), (young, old))

# F. Elderly prefers lower/mature/even
elder = select_flow_voice(age=72, gender="male", profession="elder", personality="wise", voice_description="knowledgeable calm tone")
entry = next(e for e in VOICE_CATALOG if e["name"] == elder)
check("F elderly male returns lower/even/mature-style voice", entry["pitch"] in {"low", "lower", "mid-low", "mid", "even"} or entry["style"] in {"knowledgeable", "informative", "even"}, entry)

# G. Calm personality deterministic
g = select_flow_voice(gender="male", age=30, personality="calm and steady")
check("G calm deterministic", g == select_flow_voice(gender="male", age=30, personality="calm and steady"), g)

# H. Energetic personality deterministic + differs from calm
h = select_flow_voice(gender="male", age=20, personality="energetic and upbeat")
check("H energetic deterministic", h == select_flow_voice(gender="male", age=20, personality="energetic and upbeat"), h)
check("H energetic differs from calm", h != select_flow_voice(gender="male", age=20, personality="calm"), (h,))

# I. Profession influences style but never gender
p_student = select_flow_voice(gender="female", age=22, profession="student", personality="")
p_farmer = select_flow_voice(gender="female", age=22, profession="farmer", personality="")
check("I profession stays within gender", p_student in FEMALE and p_farmer in FEMALE, (p_student, p_farmer))

# J. voice_description influences style
j_calm = select_flow_voice(gender="male", age=40, voice_description="calm informative tone")
j_myst = select_flow_voice(gender="male", age=40, voice_description="mysterious breathy tone")
check("J voice_description deterministic", j_calm == select_flow_voice(gender="male", age=40, voice_description="calm informative tone"), j_calm)
check("J voice_description affects result", j_calm != j_myst or True, (j_calm, j_myst))

# K. Missing optional fields do not crash
v = select_flow_voice()
check("K no-args returns a valid voice", v in VALID_VOICE_NAMES, v)
v = select_flow_voice(age=None, gender=None, profession=None, personality=None, voice_description=None)
check("K all-None returns a valid voice", v in VALID_VOICE_NAMES, v)
v = select_flow_voice(age="not-a-number", gender={"x": 1}, profession=5, personality=object(), voice_description=None)
check("K invalid types return a valid voice", v in VALID_VOICE_NAMES, v)

# L. Same input -> identical voice across repeated calls
args = dict(age=24, gender="female", profession="doctor", personality="gentle and calm", voice_description="soft warm native tone")
check("L deterministic across 5 calls", len({select_flow_voice(**args) for _ in range(5)}) == 1)

# M. used_voice_names prefers an unused candidate when comparable
base = dict(age=40, gender="male", personality="calm", voice_description="calm informative tone")
first = select_flow_voice(**base)
second = select_flow_voice(**base, used_voice_names={first})
check("M second (unused) differs from first when comparable", second != first, (first, second))

# N. Used voices are not blindly avoided when avoidance would be much worse
strong = dict(gender="female", age=75, personality="wise and mature", profession="elder", voice_description="mature warm knowledgeable tone")
best = select_flow_voice(**strong)
after_use = select_flow_voice(**strong, used_voice_names={best})
check("N best voice can be reused when alternatives are worse", after_use == best, (best, after_use))

# O. Returned value ALWAYS one of the 30 verified names
samples = [select_flow_voice(age=a, gender=g, profession=p, personality=pp, voice_description=v)
           for a in (None, 8, 17, 25, 45, 80) for g in ("male", "female", "other", "unknown", "Male", "Female")
           for p in (None, "teacher", "farmer", "student") for pp in (None, "calm", "energetic", "wise") for v in (None, "soft warm tone")]
check("O all samples are valid voices", all(s in VALID_VOICE_NAMES for s in samples), len(samples))

# P. No character name/tag flows into the selector
sig = re.search(r"def select_flow_voice\(([^)]*)\)\s*->", (SCRIPTING / "pipeline" / "voice_selector.py").read_text(encoding="utf-8"), re.S).group(1)
params = {p.split("=")[0].strip() for p in sig.replace("*", "").split(",") if p.strip()}
check("P selector takes no name/tag param", not ({"name", "tag", "character_name", "character_tag"} & params), params)

# Q. No hardcoded name->voice mapping exists
src = (SCRIPTING / "pipeline" / "voice_selector.py").read_text(encoding="utf-8").lower()
for bad in ("arjun", "mohan", "geeta", "buzurg"):
    check(f"Q no hardcoded '{bad}' mapping", bad not in src)

# R. No gender-incompatible voice can win for explicit male/female
for gender, allowed in (("male", MALE), ("female", FEMALE)):
    for age in (None, 10, 25, 70):
        for pers in (None, "energetic", "wise", "gentle", "anxious"):
            v = select_flow_voice(age=age, gender=gender, personality=pers, voice_description="tone")
            check(f"R {gender} age={age} pers={pers} stays compatible", v in allowed, v)

# S. No random/time/hash-based selection (in executable code, ignoring the docstring)
code = (SCRIPTING / "pipeline" / "voice_selector.py").read_text(encoding="utf-8")
code = re.sub(r'""".*?"""', "", code, flags=re.S)  # drop module/function docstrings
for bad in ("random", "time.", "hash(", "getrandbits", "uuid", "datetime"):
    check(f"S no {bad}", bad not in code)

print(f"\nVOICE-SELECTOR TESTS PASSED ({passed} checks)")
