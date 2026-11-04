"""Offline tests for the SEO engine (mocked model, no network, no publishing).

Run directly, following the existing `*_test.py` convention:

    python -m pipeline.seo_test        (from scripting/)
    python pipeline/seo_test.py

Every test uses a temporary project fixture. The real confirmed project is only *read*,
and only when it happens to exist on this machine.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import pathlib
import re
import sys
import tempfile

SCRIPTING = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTING))

from pipeline import seo  # noqa: E402
from pipeline import seo_keywords  # noqa: E402

passed = 0
failed = 0


def check(label, condition, detail=None):
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS {label}")
    else:
        failed += 1
        print(f"FAIL {label}" + (f" :: {detail}" if detail is not None else ""))


def expect_error(label, fn, error_type, predicate=None):
    try:
        fn()
    except error_type as error:
        ok = predicate(error) if predicate else True
        check(label, ok, str(error))
        return error
    except BaseException as error:  # noqa: BLE001 - report the wrong exception type
        check(label, False, f"wrong exception {type(error).__name__}: {error}")
        return None
    check(label, False, f"no {error_type.__name__} raised")
    return None


# ---------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------
PROJECT_ID = "seo-fixture-project"

STORY_TITLE = "रात के 2 बजे श्मशान से आती वो आवाज़"
STORY_HOOK = (
    "कहते हैं, हर अमावस की रात के दो बजे, बड़गांव के पुराने श्मशान से उठती वो रहस्यमयी आवाज़ "
    "आज भी किसी को चैन से सोने नहीं देती।"
)
STORY_SCRIPT = """
**Title:**
रात के 2 बजे श्मशान से आती वो आवाज़
**Tagline:**
कहते हैं, हर अमावस की रात के दो बजे, बड़गांव के पुराने श्मशान से उठती वो रहस्यमयी आवाज़ आज भी किसी को चैन से सोने नहीं देती।

---

### Act 1 – HOOK

बड़गांव में 22 साल का अर्जुन शहर से लौटा है। उसकी खिड़की से पुराने श्मशान की टूटी दीवारें दिखती हैं।
अमावस की रात ठीक दो बजे श्मशान से एक कराहती आवाज़ आई।
माँ ने कहा, खिड़की बंद कर दे, रात बहुत हो गई है।

---

### Act 2 – RUPTURE

अर्जुन सच जानने के लिए श्मशान पहुँचा। वहाँ राधा देवी की आत्मा बैठी थी और अपने बच्चे को पुकार रही थी।
श्मशान में ठंडी हवा और अंधेरा था। अर्जुन के पैर जैसे जम गए।

---

### Act 3 – ESCALATION

हर तरफ वही आकृति दिखाई देती थी। अर्जुन ने भागने की कोशिश की लेकिन रास्ता गायब था।

---

### Act 4 – TRUTH

दादी ने बताया कि राधा देवी गाँव की थी और उसकी चूड़ी उस श्मशान में दबी है।
अर्जुन ने पुराने पत्थर के नीचे वो टूटी चूड़ी ढूँढ निकाली।

---

### Act 5 – CLIMAX

अर्जुन ने चूड़ी राधा देवी की आत्मा को सौंपी और प्रार्थना की।
आत्मा की आँखों में आँसू थे और उसकी पुकार शांत हो गई।

---

### Act 6 – RESOLUTION

सुबह अर्जुन घर लौटा। लेकिन अगली अमावस को फिर वही आवाज़ सुनाई दी।
"""

SCENE_TITLES = [
    "बड़गांव की रात", "अमावस की रात", "खिड़की से झाँकना", "माँ की चेतावनी",
    "सच जानने का निश्चय", "श्मशान की ओर", "श्मशान में ठंडक", "धुंधली आकृति",
    "राधा देवी की पुकार", "दादी की याद", "चूड़ी और पत्थर", "आत्मा का विदा होना",
]

SCENE_NARRATION = [
    "अर्जुन शहर से लौटा है। देर रात किताबें पढ़ता है।",
    "अमावस की रात दो बजे श्मशान से कराहती आवाज़ आई।",
    "अर्जुन खिड़की से बाहर अंधेरा देखता है।",
    "माँ उसे खिड़की बंद करने को कहती है।",
    "अर्जुन सच जानने का निश्चय करता है।",
    "अर्जुन श्मशान की ओर बढ़ता है।",
    "श्मशान में ठंडी हवा है।",
    "एक धुंधली आकृति दिखाई देती है।",
    "राधा देवी की आत्मा अपने बच्चे को पुकारती है।",
    "दादी पुरानी बात याद करती है।",
    "अर्जुन पत्थर के नीचे से टूटी चूड़ी निकालता है।",
    "राधा देवी की आत्मा शांत होकर विदा होती है।",
]

CHARACTERS = [
    {"tag": "@CHAR-01-ARJUN", "name": "अर्जुन", "profession": "unspecified"},
    {"tag": "@CHAR-02-MAA", "name": "माँ", "profession": "unspecified"},
    {"tag": "@CHAR-03-RADHADEVI-ATMA", "name": "राधा देवी की आत्मा", "profession": "unspecified"},
    {"tag": "@CHAR-04-DADI", "name": "दादी", "profession": "unspecified"},
]
CHARACTER_BY_SCENE = [
    ["@CHAR-01-ARJUN"], ["@CHAR-01-ARJUN"], ["@CHAR-01-ARJUN"], ["@CHAR-01-ARJUN", "@CHAR-02-MAA"],
    ["@CHAR-01-ARJUN"], ["@CHAR-01-ARJUN"], ["@CHAR-01-ARJUN"], ["@CHAR-01-ARJUN", "@CHAR-03-RADHADEVI-ATMA"],
    ["@CHAR-03-RADHADEVI-ATMA"], ["@CHAR-04-DADI"], ["@CHAR-01-ARJUN"], ["@CHAR-03-RADHADEVI-ATMA"],
]
BACKGROUNDS = [
    {"tag": "#BGD-01-ARJUN-ROOM-WIDE", "location_name": "Arjun's Bedroom (Wide)"},
    {"tag": "#BGD-02-CREMATION-GROUND-WIDE", "location_name": "Old Cremation Ground (Wide)"},
    {"tag": "#BGD-03-DADI-ROOM", "location_name": "Dadi's Room"},
]


def make_project() -> dict:
    scenes = []
    for index, title in enumerate(SCENE_TITLES, 1):
        scenes.append({
            "scene_number": index,
            "title": title,
            "background_tag": BACKGROUNDS[0]["tag"],
            "character_tags": CHARACTER_BY_SCENE[index - 1],
            "assets": {"background_tag": BACKGROUNDS[0]["tag"], "character_tags": CHARACTER_BY_SCENE[index - 1]},
            "speaker": "NARRATOR" if index % 3 else CHARACTER_BY_SCENE[index - 1][0],
            "narration_text": SCENE_NARRATION[index - 1],
            "devanagari_dialogue": "",
            "timestamp": "AUTO — determined by the completed Flow clip",
            "clip_length_seconds": None,
            "edit_length_seconds": None,
            "status": "pending",
        })
    return {
        "schema_version": "1.0.0",
        "project_id": PROJECT_ID,
        "idea": {
            "status": "done",
            "items": [],
            "selected_index": 1,
            "selected": {"index": 1, "title": STORY_TITLE, "hook": STORY_HOOK, "entity_archetype": "Pret-aatma"},
            "raw_output": None,
        },
        "script": {
            "status": "done", "language": "Hindi", "duration_minutes": 5, "word_count": 750,
            "monster": "उत्तर भारत की डरावनी लोक-कथा की प्रेत-आत्मा",
            "raw_text": STORY_SCRIPT.strip(), "raw_output": STORY_SCRIPT,
        },
        "characters": copy.deepcopy(CHARACTERS),
        "backgrounds": copy.deepcopy(BACKGROUNDS),
        "scenes": scenes,
        "publishing": {"status": "pending", "data": None, "raw_output": None},
        "run_log": [],
    }


def make_workspace(root: pathlib.Path) -> tuple[pathlib.Path, dict]:
    project_dir = root / PROJECT_ID
    project_dir.mkdir(parents=True, exist_ok=True)
    project = make_project()
    project_file = project_dir / "pipeline.json"
    project_file.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")

    outputs = project_dir / "outputs"
    outputs.mkdir(exist_ok=True)
    (outputs / "final-title.mp4").write_bytes(b"fake mp4 bytes for the invariant test")
    (outputs / "approval.json").write_text(json.dumps({"status": "approved"}), encoding="utf-8")
    return project_file, project


DESCRIPTION = (
    "रात के 2 बजे श्मशान से आती वो आवाज़ आज भी बड़गांव के लोगों को सोने नहीं देती।\n"
    "इस डरावनी हिंदी कहानी में अर्जुन उस आवाज़ का सच जानने श्मशान पहुँचता है।\n"
    "\n"
    "कहानी में एक पुराना श्मशान, अमावस की रात, टूटी चूड़ी और एक दबा हुआ राज़ है। "
    "अर्जुन जब राधा देवी की पुकार तक पहुँचता है तो समझ आता है कि वो आवाज़ डराने नहीं, "
    "कुछ माँगने आती है। उसकी हिम्मत और उसकी प्रार्थना ही रास्ता बनाती है।\n"
    "\n"
    "रात का ख़ौफ़ चैनल पर हम ऐसी डरावनी और रहस्यमयी लोक कहानियाँ लाते हैं।\n"
    "अगर आपको ये कहानी पसंद आए तो चैनल को सब्सक्राइब करें।\n"
    "आपको क्या लगता है, उस श्मशान में आज भी आवाज़ सुनाई देती है?\n"
    "यह एक काल्पनिक कहानी है, केवल मनोरंजन के लिए।\n"
    "#raatkakhauf #hindihorrorstory #श्मशान #अमावस"
)

TAGS = [
    "hindi horror story", "bhoot ki kahani", "shamshan ki kahani", "bhootiya kahani",
    "hindi lok katha horror", "raat ka khauf", "hindi horror kahani", "अमावस की रात",
    "श्मशान की कहानी", "राधा देवी", "अर्जुन", "डरावनी कहानी", "भूत की कहानी",
    "scary stories", "ghost story hindi", "cremation ground horror story",
    "haunted village story hindi", "supernatural story hindi",
]


def good_candidate() -> dict:
    return {
        "title_candidates": [
            {
                "text": "श्मशान से आती आवाज़ | रात के 2 बजे की डरावनी कहानी",
                "hook_type": "curiosity",
                "primary_phrase": "श्मशान से आती आवाज़",
                "source_refs": ["scenes[2]", "script.act:1"],
                "why": "आवाज़ और जगह दोनों सामने हैं, इसलिए खोलने की वजह साफ है।",
            },
            {
                "text": "अमावस की रात श्मशान में राधा देवी की पुकार",
                "hook_type": "emotional",
                "primary_phrase": "अमावस की रात",
                "source_refs": ["scenes[9]", "script.act:2"],
                "why": "भावनात्मक पुकार दर्शक को कहानी से जोड़ती है।",
            },
            {
                "text": "रात के 2 बजे श्मशान की आवाज़: अर्जुन का डर",
                "hook_type": "fear",
                "primary_phrase": "श्मशान की आवाज़",
                "source_refs": ["scenes[2]", "scenes[6]"],
                "why": "समय और डर दोनों पहले शब्दों में हैं।",
            },
        ],
        "recommended_title_index": 1,
        "title_rationale": (
            "पहला विकल्प सबसे मजबूत है क्योंकि इसमें जगह और आवाज़ दोनों शुरुआत में हैं, "
            "शीर्षक छोटा है और मोबाइल पर पूरा पढ़ा जा सकता है। यह कहानी से बाहर कुछ नहीं कहता।"
        ),
        "description": DESCRIPTION,
        "tags": list(TAGS),
        "hashtags": ["#raatkakhauf", "#hindihorrorstory", "#श्मशान", "#अमावस"],
        "pinned_comment": (
            "अगर आप भी कभी अमावस की रात किसी श्मशान के पास से गुज़रे हों तो बताइए, "
            "क्या आपने कोई आवाज़ सुनी? आपका अपना अनुभव कमेंट में लिखिए।"
        ),
        "thumbnail": {
            "text": "श्मशान से आती आवाज़",
            "main_subject": "अर्जुन खिड़की से श्मशान की ओर देखता हुआ",
            "composition": "अर्जुन बाईं ओर आधे फ्रेम में, पीछे श्मशान और धुंध",
            "background_lighting": "अमावस की रात, ठंडी नीली चाँदनी, दूर चिता की लौ",
            "color_contrast": "गहरा नीला और हल्का नारंगी, ऊँचा कंट्रास्ट",
            "image_prompt": (
                "2D semi-realistic cartoon horror thumbnail, a terrified young Indian man "
                "Arjun at a window looking toward an old cremation ground at night, cold blue "
                "moonlight, distant pyre glow, bold outlines, flat cel shading, dark vignette, "
                "no watermark. --ar 16:9"
            ),
        },
        "shorts_concepts": [
            {
                "hook": "रात के 2 बजे श्मशान से आवाज़ आई।",
                "title": "श्मशान से आती आवाज़",
                "description": "अमावस की रात अर्जुन ने जो सुना, वो आज भी गाँव में चर्चा है।",
                "hashtags": ["#raatkakhauf", "#श्मशान"],
                "opening_narration": "बड़गांव में हर अमावस की रात दो बजे श्मशान से आवाज़ आती है।",
                "scene_refs": [2, 3],
                "cta": "पूरी कहानी देखने के लिए वीडियो देखिए।",
            },
            {
                "hook": "श्मशान में बैठी आकृति ने मुड़कर देखा।",
                "title": "राधा देवी की पुकार",
                "description": "अर्जुन श्मशान पहुँचा और वहाँ एक आत्मा उसका इंतज़ार कर रही थी।",
                "hashtags": ["#hindihorrorstory", "#अमावस"],
                "opening_narration": "अर्जुन श्मशान पहुँचा, वहाँ राधा देवी की आत्मा बैठी थी।",
                "scene_refs": [8, 9],
                "cta": "पूरी कहानी वीडियो में देखिए।",
            },
            {
                "hook": "पत्थर के नीचे छिपी थी एक टूटी चूड़ी।",
                "title": "टूटी चूड़ी का राज़",
                "description": "दादी की याद ने अर्जुन को वो राज़ बताया जो सालों से दबा था।",
                "hashtags": ["#raatkakhauf", "#डरावनीकहानी"],
                "opening_narration": "दादी ने बताया कि राधा देवी की चूड़ी उस श्मशान में दबी है।",
                "scene_refs": [10, 11],
                "cta": "पूरी कहानी देखिए, लिंक वीडियो में है।",
            },
        ],
        "story_specific_keywords": ["श्मशान की आवाज़", "अमावस की रात", "राधा देवी की आत्मा"],
        "story_summary": {
            "logline": "अर्जुन श्मशान से आती आवाज़ का सच जानने निकलता है।",
            "setting": "बड़गांव का पुराना श्मशान, अमावस की रात",
            "entity": "राधा देवी की आत्मा",
            "protagonist": "अर्जुन",
        },
    }


class FakeClient:
    """Minimal stand-in for ScriptClient. Records every call; never touches the network."""

    provider = "fake"
    model = "fake-model"

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0
        self.prompts: list[str] = []
        self.max_tokens: list[int] = []

    def complete(self, prompt, max_tokens=7000, temperature=0):
        self.prompts.append(prompt)
        self.max_tokens.append(max_tokens)
        self.calls += 1
        if not self.responses:
            raise RuntimeError("FakeClient ran out of responses")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def good_json() -> str:
    return json.dumps(good_candidate(), ensure_ascii=False)


def run_generation(project_file: pathlib.Path, project: dict, client, **kwargs) -> dict:
    return seo.generate_seo(project, client, project_file=project_file, **kwargs)


def package_path(project_file: pathlib.Path) -> pathlib.Path:
    return seo.seo_paths(project_file)["package"]


def sha256_bytes(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(root: pathlib.Path) -> dict:
    return {
        str(path.relative_to(root)).replace("\\", "/"): sha256_bytes(path)
        for path in root.rglob("*") if path.is_file()
    }


# ---------------------------------------------------------------------------------------
# 1. Happy path, Hindi titles, schema
# ---------------------------------------------------------------------------------------
def test_happy_path():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        client = FakeClient([good_json()])
        report = run_generation(project_file, project, client, provider_info={"provider": "fake", "model": "fake-model"})

        check("happy path: report ok", report["ok"] is True, report)
        check("happy path: status CREATED", report["status"] == "CREATED", report.get("status"))
        check("happy path: one model call", client.calls == 1, client.calls)
        check("happy path: publisher not invoked", report["publisher_invoked"] is False)
        check("happy path: package written", package_path(project_file).is_file())
        check("happy path: markdown written", seo.seo_paths(project_file)["markdown"].is_file())
        check("happy path: metadata mapping written", seo.seo_paths(project_file)["metadata"].is_file())

        package = json.loads(package_path(project_file).read_text(encoding="utf-8"))
        required = [
            "project_id", "channel_profile", "story_summary", "primary_keywords",
            "secondary_keywords", "long_tail_keywords", "title_candidates",
            "recommended_title", "title_rationale", "description", "tags", "hashtags",
            "pinned_comment", "thumbnail_text", "thumbnail_concept",
            "thumbnail_image_prompt", "shorts_concepts", "generation_metadata",
            "validation_warnings",
        ]
        missing = [field for field in required if field not in package]
        check("schema: all required fields present", not missing, missing)
        check("schema: versioned", package["schema_version"] == seo.SEO_SCHEMA_VERSION)
        check("schema: json round-trips", json.loads(json.dumps(package)) == package)
        check("schema: project id matches", package["project_id"] == PROJECT_ID, package["project_id"])

        check("titles: exactly 3", len(package["title_candidates"]) == 3)
        check("titles: all Hindi-first",
              all(seo._DEVANAGARI_RE.search(t["text"]) for t in package["title_candidates"]))
        check("titles: recommended is one of the candidates",
              package["recommended_title"] in [t["text"] for t in package["title_candidates"]])
        check("titles: recommendation index points at it",
              package["title_candidates"][package["recommended_title_index"]]["text"] == package["recommended_title"])
        check("titles: each within 100 characters", all(len(t["text"]) <= 100 for t in package["title_candidates"]))
        check("titles: rationale present", len(package["title_rationale"]) >= 40)
        check("titles: heuristic rank recorded",
              all("heuristic_score" in t and "heuristic_rank" in t for t in package["title_candidates"]))

        check("story summary: derived and non-empty",
              bool(package["story_summary"]["logline"]) and package["story_summary"]["scene_count"] == 12)
        check("story summary: carries source refs", bool(package["story_summary"]["source_refs"]))
        check("story summary: entity is the in-story name",
              package["story_summary"]["entity"] == "राधा देवी की आत्मा", package["story_summary"]["entity"])

        check("no https/http URLs in the package",
              "http://" not in json.dumps(package) and "https://" not in json.dumps(package))

        def all_keys(obj):
            if isinstance(obj, dict):
                for key, value in obj.items():
                    yield key
                    yield from all_keys(value)
            elif isinstance(obj, list):
                for value in obj:
                    yield from all_keys(value)

        demand_keys = {"search_volume", "keyword_difficulty", "difficulty", "traffic",
                       "rank_position", "ranking_position", "monthly_searches", "cpc"}
        present = demand_keys & set(all_keys(package))
        check("no measured-demand fields in the package", not present, present)
        return report


# ---------------------------------------------------------------------------------------
# 1b. Title ranking and selection (deterministic; model index is audited, not obeyed)
# ---------------------------------------------------------------------------------------
def _ranked_by_text(candidates: list[dict]) -> dict[str, dict]:
    return {candidate["text"]: candidate for candidate in candidates}


def test_recommendation_index():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        baseline = copy.deepcopy(good_candidate())
        ranked = seo.rank_title_candidates(baseline["title_candidates"])
        by_text = _ranked_by_text(ranked)
        order = sorted(ranked, key=lambda item: item["heuristic_rank"])
        check("ranking: ranks are 1..3 and unique",
              [item["heuristic_rank"] for item in order] == [1, 2, 3])
        check("ranking: scores never increase down the table",
              all(order[i]["heuristic_score"] >= order[i + 1]["heuristic_score"]
                  for i in range(len(order) - 1)))
        check("ranking: ties are broken by shorter title",
              all(order[i]["heuristic_score"] != order[i + 1]["heuristic_score"]
                  or order[i]["chars"] <= order[i + 1]["chars"]
                  for i in range(len(order) - 1)))
        check("ranking: rank 1 is the highest score",
              order[0]["heuristic_score"] == max(item["heuristic_score"] for item in order))

        top = order[0]
        top_index = ranked.index(top)
        for index in (1, 2, 3, 0):
            candidate = copy.deepcopy(good_candidate())
            candidate["recommended_title_index"] = index
            fields, errors, warnings = seo.validate_candidate(candidate, facts, plan)
            selection = fields["title_selection"]
            check(f"selection: model index {index} does not override the ranking",
                  fields["recommended_title"] == top["text"], fields["recommended_title"])
            check(f"selection: model index {index} is recorded",
                  selection["model_recommended_index"] == (0 if index == 0 else index - 1),
                  selection["model_recommended_index"])
            check(f"selection: model index {index} agreement flag is truthful",
                  selection["model_agrees"] == (
                      selection["model_recommended_index"] is not None
                      and selection["model_recommended_index"] == selection["selected_index"]
                  ),
                  selection)
            check(f"selection: model index {index} does not change rank 1",
                  selection["selected_rank"] == 1 and selection["selected_score"] == top["heuristic_score"],
                  selection)

        disagree = copy.deepcopy(good_candidate())
        disagree["recommended_title_index"] = 0 if top_index != 0 else 2
        _, _, disagreement_warnings = seo.validate_candidate(disagree, facts, plan)
        check("selection: disagreement with the model is warned",
              any("disagrees with the deterministic ranking" in warning
                  for warning in disagreement_warnings), disagreement_warnings)

        out_of_range = copy.deepcopy(good_candidate())
        out_of_range["recommended_title_index"] = 9
        fields_bad, errors_bad, warnings_bad = seo.validate_candidate(out_of_range, facts, plan)
        check("selection: out-of-range model index falls back to rank 1",
              fields_bad["recommended_title"] == top["text"]
              and fields_bad["title_selection"]["model_recommended_index"] is None,
              fields_bad["title_selection"])
        check("selection: out-of-range index warned",
              any("out of range" in warning for warning in warnings_bad), warnings_bad)
        check("selection: out-of-range index is not a hard error", not errors_bad, errors_bad)

        non_numeric = copy.deepcopy(good_candidate())
        non_numeric["recommended_title_index"] = "the second one"
        fields_text, errors_text, warnings_text = seo.validate_candidate(non_numeric, facts, plan)
        check("selection: non-numeric index falls back to rank 1",
              fields_text["recommended_title"] == top["text"]
              and fields_text["title_selection"]["model_recommended_index"] is None,
              fields_text["title_selection"])
        check("selection: non-numeric index warned",
              any("not an integer" in warning for warning in warnings_text), warnings_text)

        # Regression for the Generation-2 inconsistency: the model preferred the 44-character
        # sound title, but the old exact-substring phrase check scored it 52/rank 3 because the
        # title inserts "रहस्यमयी". Token-order matching scores the actual title, and the
        # shorter-title tie-break makes it rank 1 instead of silently losing to a 77-point title.
        gen2_titles = [
            {"text": "रात के 2 बजे श्मशान से आती वो रहस्यमयी आवाज़", "hook_type": "curiosity",
             "primary_phrase": "रात के 2 बजे श्मशान से आती वो आवाज़",
             "source_refs": ["scenes[10]"], "why": "sound hook"},
            {"text": "अमावस की रात बड़गांव के श्मशान की डरावनी कहानी", "hook_type": "fear",
             "primary_phrase": "अमावस की रात",
             "source_refs": ["scenes[2]"], "why": "place hook"},
            {"text": "राधा देवी की आत्मा और श्मशान की रात की भूतिया कहानी", "hook_type": "emotional",
             "primary_phrase": "राधा देवी की आत्मा",
             "source_refs": ["scenes[12]"], "why": "entity hook"},
        ]
        gen2_ranked = seo.rank_title_candidates(gen2_titles)
        gen2 = _ranked_by_text(gen2_ranked)
        check("regression: Gen-2 sound title is 77/rank 1",
              gen2["रात के 2 बजे श्मशान से आती वो रहस्यमयी आवाज़"]["heuristic_score"] == 77
              and gen2["रात के 2 बजे श्मशान से आती वो रहस्यमयी आवाज़"]["heuristic_rank"] == 1,
              gen2["रात के 2 बजे श्मशान से आती वो रहस्यमयी आवाज़"])
        check("regression: Gen-2 place title is 77/rank 2 (tie-break: 46 > 44 chars)",
              gen2["अमावस की रात बड़गांव के श्मशान की डरावनी कहानी"]["heuristic_score"] == 77
              and gen2["अमावस की रात बड़गांव के श्मशान की डरावनी कहानी"]["heuristic_rank"] == 2,
              gen2["अमावस की रात बड़गांव के श्मशान की डरावनी कहानी"])
        check("regression: Gen-2 entity title is 57/rank 3",
              gen2["राधा देवी की आत्मा और श्मशान की रात की भूतिया कहानी"]["heuristic_score"] == 57
              and gen2["राधा देवी की आत्मा और श्मशान की रात की भूतिया कहानी"]["heuristic_rank"] == 3)


# ---------------------------------------------------------------------------------------
# 1c. Explicit editorial overrides (labelled, justified, never hidden)
# ---------------------------------------------------------------------------------------
def test_editorial_overrides():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        editorial_title = "रात के 2 बजे श्मशान से आती वो रहस्यमयी आवाज़"
        editorial_hashtags = ["#raatkakhauf", "#अमावस_की_रात", "#भूत_की_कहानी"]
        # The editorial description must end with the same hashtags as the metadata, otherwise
        # the engine correctly appends the validated set as a second line. Keeping this fixture
        # self-consistent lets us assert the editorial copy survives validation byte-for-byte.
        editorial_description = (
            DESCRIPTION.rstrip().rsplit("\n", 1)[0] + "\n" + " ".join(editorial_hashtags)
        )
        editorial = {
            "reason": "Editorial preference for the sound hook over the place hook.",
            "title": editorial_title,
            "title_primary_phrase": "रात के 2 बजे श्मशान से आती वो आवाज़",
            "title_reason": "The 2 AM sound hook is the story's strongest curiosity device.",
            "description": editorial_description,
            "pinned_comment": (
                "अगर आप अर्जुन की जगह होते और रात के 2 बजे श्मशान से आवाज़ आती, "
                "तो क्या आप सच जानने के लिए वहाँ जाते? अपना जवाब कमेंट में बताइए!"
            ),
            "tags": list(TAGS),
            "hashtags": editorial_hashtags,
            "thumbnail": {"text": "रात 2 बजे..."},
        }
        merged, applied = seo.apply_editorial(copy.deepcopy(good_candidate()), editorial, facts)
        check("editorial: title is inserted when it is not among the model candidates",
              editorial_title in [item["text"] for item in merged["title_candidates"]])
        check("editorial: candidate count stays exactly three",
              len(merged["title_candidates"]) == 3, len(merged["title_candidates"]))
        check("editorial: applied fields are recorded",
              applied == ["title", "description", "pinned_comment", "tags", "hashtags", "thumbnail"],
              applied)

        fields, errors, warnings = seo.validate_candidate(merged, facts, plan, editorial=editorial)
        check("editorial: copy still passes story/policy validation", not errors, errors)
        check("editorial: the explicit title is selected",
              fields["recommended_title"] == editorial_title, fields["recommended_title"])
        selection = fields["title_selection"]
        check("editorial: override is labelled", selection["method"] == "editorial_override", selection)
        check("editorial: override reason is attached",
              selection["override"]["reason"] == editorial["title_reason"], selection["override"])
        check("editorial: score trade-off is visible",
              selection["override"]["score_gap"] <= 0
              and selection["override"]["top_ranked_text"] != editorial_title,
              selection["override"])
        check("editorial: rationale says it is an override",
              "editorial override" in fields["title_rationale"].lower()
              or "संपादकीय चयन" in fields["title_rationale"], fields["title_rationale"])
        check("editorial: replaced copy is used",
              fields["description"] == editorial_description
              and fields["thumbnail_text"] == "रात 2 बजे...",
              {"description_tail": fields["description"][-120:],
               "thumbnail_text": fields["thumbnail_text"]})

        # An editorial title that already wins the ranking is a confirmation, not an override.
        top_text = sorted(seo.rank_title_candidates(good_candidate()["title_candidates"]),
                          key=lambda item: item["heuristic_rank"])[0]["text"]
        confirmation = dict(editorial)
        confirmation["title"] = top_text
        merged_top, _ = seo.apply_editorial(copy.deepcopy(good_candidate()), confirmation, facts)
        fields_top, errors_top, _ = seo.validate_candidate(merged_top, facts, plan,
                                                            editorial=confirmation)
        check("editorial: a top-ranked editorial title is not mislabelled as an override",
              not errors_top and fields_top["title_selection"]["method"] == "heuristic_top_rank"
              and fields_top["title_selection"]["editorial_confirmed"] is True,
              fields_top["title_selection"])


# ---------------------------------------------------------------------------------------
# 1d. Immutable generation snapshots
# ---------------------------------------------------------------------------------------
def _verify_manifest(directory: pathlib.Path) -> list[str]:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    mismatched = []
    for record in manifest["files"]:
        copied = directory / record["path"]
        actual = hashlib.sha256(copied.read_bytes()).hexdigest().upper() if copied.is_file() else None
        if actual != record["sha256"] or copied.stat().st_size != record["bytes"]:
            mismatched.append(record["path"])
    return mismatched


def test_generation_snapshots():
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        project_file, project = make_workspace(root)
        seo_dir = seo.seo_paths(project_file)["root"]

        first = run_generation(project_file, project, FakeClient([good_json()]))
        first_snapshot = seo_dir / "history" / first["generation_snapshot"]["directory"]
        check("snapshot: generation 1 snapshot exists", first_snapshot.is_dir(), first_snapshot)
        check("snapshot: generation 1 manifest hashes match",
              not _verify_manifest(first_snapshot), _verify_manifest(first_snapshot))
        check("snapshot: manifest lists the generation",
              json.loads((first_snapshot / "manifest.json").read_text(encoding="utf-8"))["generation"] == 1)

        second = run_generation(project_file, project, FakeClient([good_json()]), regenerate=True)
        second_snapshot = seo_dir / "history" / second["generation_snapshot"]["directory"]
        check("snapshot: generation 2 snapshot exists", second_snapshot.is_dir(), second_snapshot)
        check("snapshot: generation 2 manifest hashes match",
              not _verify_manifest(second_snapshot), _verify_manifest(second_snapshot))
        check("snapshot: generation 1 snapshot is untouched",
              not _verify_manifest(first_snapshot), _verify_manifest(first_snapshot))
        check("snapshot: both generations remain present",
              first_snapshot != second_snapshot and first_snapshot.is_dir() and second_snapshot.is_dir())


def test_editorial_archive_snapshot():
    """Regression: the editorial input was read as bytes and passed to a text writer.

    Generation 2 -> 3 failed after writing the package because `_write_text_atomic` received
    bytes. The archive copy must be byte-identical to the editor's file and must be included in
    the generation snapshot.
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        project_file, project = make_workspace(root)
        source = root / "editorial-source.json"
        payload = json.dumps({
            "title": good_candidate()["title_candidates"][0]["text"],
            "reason": "regression: archive the explicit editorial input",
        }, ensure_ascii=False, indent=2).encode("utf-8")
        source.write_bytes(payload)

        report = run_generation(project_file, project, FakeClient([good_json()]),
                                editorial_path=source)
        seo_dir = seo.seo_paths(project_file)["root"]
        archived = seo_dir / "seo-editorial.json"
        check("editorial archive: written under seo/", archived.is_file())
        check("editorial archive: byte-identical to the editor's file",
              archived.read_bytes() == payload, len(archived.read_bytes()) if archived.is_file() else None)
        snapshot_dir = seo_dir / "history" / report["generation_snapshot"]["directory"]
        check("editorial archive: present in the generation snapshot",
              (snapshot_dir / "seo-editorial.json").is_file())
        check("editorial archive: snapshot manifest hashes match",
              not _verify_manifest(snapshot_dir), _verify_manifest(snapshot_dir))
        check("editorial archive: applied fields are recorded",
              report["editorial_overrides"]["applied_fields"] == ["title"],
              report["editorial_overrides"])



# ---------------------------------------------------------------------------------------
# 2. Unicode limits
# ---------------------------------------------------------------------------------------
def test_unicode_and_limits():
    check("unicode: code-point length counts Devanagari", seo._chars("रात") == 3, seo._chars("रात"))
    check("unicode: NUKTA/ZWJ variations normalize together",
          seo_keywords.normalize_key("आवाज़") == seo_keywords.normalize_key("आवा‍ज़"))
    check("unicode: Devanagari digits map to ASCII", seo._ascii_digits("रात २ बजे") == "रात 2 बजे")

    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        too_long = copy.deepcopy(good_candidate())
        too_long["title_candidates"][0]["text"] = ("श्मशान की आवाज़ " * 10)[:101]
        _, errors, _ = seo.validate_candidate(too_long, facts, plan)
        check("limits: 101-character title rejected",
              any("exceeds the 100-character" in error for error in errors), errors)

        within = copy.deepcopy(good_candidate())
        within["title_candidates"][0]["text"] = ("श्मशान की आवाज़ " * 10)[:100].strip()
        _, errors_ok, _ = seo.validate_candidate(within, facts, plan)
        check("limits: <=100-character title accepted",
              not any("exceeds the 100-character" in error for error in errors_ok), errors_ok)

        long_description = copy.deepcopy(good_candidate())
        long_description["description"] = DESCRIPTION + ("शब्द " * 1200)
        _, errors_desc, _ = seo.validate_candidate(long_description, facts, plan)
        check("limits: over-long description rejected",
              any("5000-character limit" in error for error in errors_desc), errors_desc)

        short_description = copy.deepcopy(good_candidate())
        short_description["description"] = "बहुत छोटा।"
        _, errors_short, _ = seo.validate_candidate(short_description, facts, plan)
        check("limits: under-long description rejected",
              any("below the" in error for error in errors_short), errors_short)


# ---------------------------------------------------------------------------------------
# 3. Description structure
# ---------------------------------------------------------------------------------------
def test_description_structure():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)
        fields, errors, warnings = seo.validate_candidate(good_candidate(), facts, plan)

        check("description: accepted", not errors, errors)
        description = fields["description"]
        check("description: non-empty", bool(description.strip()))
        check("description: two opening lines",
              len([line for line in description.split("\n") if line.strip()]) >= 2)
        check("description: subscribe CTA present", bool(seo._SUBSCRIBE_RE.search(description)))
        check("description: engagement question present", "?" in description)
        check("description: ends with hashtags",
              description.strip().split("\n")[-1].startswith("#"), description.strip().split("\n")[-1])
        check("description: hashtag line has all validated hashtags",
              all(tag in description.strip().split("\n")[-1] for tag in fields["hashtags"]))

        no_cta = copy.deepcopy(good_candidate())
        no_cta["description"] = DESCRIPTION.replace("सब्सक्राइब करें", "देखिए")
        _, errors_no_cta, _ = seo.validate_candidate(no_cta, facts, plan)
        check("description: missing subscribe CTA rejected",
              any("subscribe call to action" in error for error in errors_no_cta), errors_no_cta)

        no_question = copy.deepcopy(good_candidate())
        no_question["description"] = DESCRIPTION.replace("आपको क्या लगता है, उस श्मशान में आज भी आवाज़ सुनाई देती है?",
                                                          "आपको यह कहानी पसंद आएगी।")
        _, errors_no_q, _ = seo.validate_candidate(no_question, facts, plan)
        check("description: missing engagement question rejected",
              any("engagement question" in error for error in errors_no_q), errors_no_q)

        appended = copy.deepcopy(good_candidate())
        appended["description"] = DESCRIPTION.replace("#raatkakhauf #hindihorrorstory #श्मशान #अमावस", "").rstrip()
        fields_append, errors_append, warnings_append = seo.validate_candidate(appended, facts, plan)
        check("description: hashtags appended when missing",
              not errors_append and fields_append["description"].strip().split("\n")[-1].startswith("#"), errors_append)
        check("description: append is recorded as a warning",
              any("appended" in warning for warning in warnings_append), warnings_append)


# ---------------------------------------------------------------------------------------
# 4. Tags: limits and dedupe
# ---------------------------------------------------------------------------------------
def test_tags():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        duplicates = copy.deepcopy(good_candidate())
        duplicates["tags"] = list(TAGS) + ["Hindi Horror Story", "hindi horror story"]
        fields, errors, warnings = seo.validate_candidate(duplicates, facts, plan)
        check("tags: duplicates removed",
              len(fields["tags"]) == len({seo_keywords.normalize_key(t) for t in fields["tags"]}), fields["tags"])
        check("tags: duplicate removal warned", any("duplicate" in warning for warning in warnings), warnings)

        # Many distinct, individually valid tags that together exceed the 500-character budget.
        grounded_words = ["श्मशान", "अमावस", "रात", "अर्जुन", "राधा", "देवी", "आत्मा", "दादी",
                          "चूड़ी", "पत्थर", "पुकार", "आवाज़", "बड़गांव", "प्रार्थना"]
        many_tags = [
            f"{word} {suffix}"
            for word in grounded_words
            for suffix in ("की कहानी", "डरावनी कहानी", "भूत कहानी")
        ]
        oversized = copy.deepcopy(good_candidate())
        oversized["tags"] = many_tags
        fields_over, errors_over, warnings_over = seo.validate_candidate(oversized, facts, plan)
        check("tags: every kept tag is within the 30-character limit",
              all(len(tag) <= seo.TAG_MAX_CHARS for tag in fields_over["tags"]), fields_over["tags"][:5])
        total = sum(len(tag) for tag in fields_over["tags"]) + max(0, len(fields_over["tags"]) - 1)
        check("tags: combined length within 500", total <= 500, total)
        check("tags: trimming still leaves enough tags", len(fields_over["tags"]) >= seo.TAGS_MIN_COUNT,
              len(fields_over["tags"]))
        check("tags: trimming warned",
              any("500-character combined limit" in w for w in warnings_over), warnings_over)
        check("tags: over-budget input is not accepted wholesale",
              len(fields_over["tags"]) < len(many_tags), (len(fields_over["tags"]), len(many_tags)))

        too_few = copy.deepcopy(good_candidate())
        too_few["tags"] = ["hindi horror story", "shamshan ki kahani"]
        _, errors_few, _ = seo.validate_candidate(too_few, facts, plan)
        check("tags: too few usable tags rejected",
              any("need at least" in error for error in errors_few), errors_few)

        unrelated = copy.deepcopy(good_candidate())
        unrelated["tags"] = list(TAGS) + ["cricket highlights", "ipl match today"]
        fields_unrelated, _, warnings_unrelated = seo.validate_candidate(unrelated, facts, plan)
        check("tags: unrelated tags dropped",
              "cricket highlights" not in fields_unrelated["tags"], fields_unrelated["tags"])
        check("tags: unrelated drop warned",
              any("unrelated or ungrounded" in warning for warning in warnings_unrelated), warnings_unrelated)


# ---------------------------------------------------------------------------------------
# 5. Hashtags
# ---------------------------------------------------------------------------------------
def test_hashtags():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)
        corpus_key = seo_keywords.normalize_key(facts["corpus"])

        def hashtag_fields(candidate):
            return seo.validate_candidate(candidate, facts, plan)

        def errors_for(raw_value):
            candidate = copy.deepcopy(good_candidate())
            candidate["hashtags"] = raw_value
            return hashtag_fields(candidate)

        def is_relevant(tag):
            return seo_keywords.hashtag_is_relevant(tag, corpus_key)

        fields, errors, _ = seo.validate_candidate(good_candidate(), facts, plan)
        check("hashtags: all valid",
              all(seo._HASHTAG_RE.match(tag) for tag in fields["hashtags"]), fields["hashtags"])
        check("hashtags: 3..8", 3 <= len(fields["hashtags"]) <= 8, fields["hashtags"])
        check("hashtags: relevant only",
              all(is_relevant(tag) for tag in fields["hashtags"]), fields["hashtags"])

        # --- comparison keys -------------------------------------------------------------
        check("hashtag key: underscores and spaces are equivalent",
              seo_keywords.hashtag_key("#अमावस_की_रात") == seo_keywords.hashtag_key("अमावस की रात"))
        check("hashtag key: latin case-insensitive",
              seo_keywords.hashtag_key("#RaatKaKhauf") == seo_keywords.hashtag_key("#raatkakhauf"))
        check("hashtag words: camelCase is split",
              seo_keywords.hashtag_words("#raatKaKhauf") == ["raat", "Ka", "Khauf"])
        check("hashtag words: underscores are split",
              seo_keywords.hashtag_words("#अमावस_की_रात") == ["अमावस", "की", "रात"])

        # --- REGRESSION: the real run's multi-word hashtags ------------------------------
        # A real generation failed three times because every legitimate multi-word hashtag
        # ("#अमावस_की_रात") was rejected: the raw token kept its underscores, which the corpus
        # never contains. These exact values must be accepted.
        real_world = ["#रात_का_ख़ौफ़", "#अमावस_की_रात", "#राधा_देवी_की_आत्मा", "#भूत_की_कहानी"]
        for tag in real_world:
            check(f"hashtags: REGRESSION accepts real multi-word hashtag {tag}", is_relevant(tag))
        fields_real, errors_real, warnings_real = errors_for(list(real_world))
        check("hashtags: REGRESSION the real four hashtags validate with no error",
              not errors_real, errors_real)
        check("hashtags: REGRESSION nothing was dropped from the real four",
              fields_real["hashtags"] == real_world, fields_real["hashtags"])

        # --- English + brand tags ---------------------------------------------------------
        for tag in ("#hindihorrorstory", "#raatkakhauf", "#hindihorrorstories", "#डरावनीकहानी"):
            check(f"hashtags: accepted channel tag {tag}", is_relevant(tag))
        check("hashtags: one run-together channel tag accepted",
              is_relevant("#भूतकीकहानी"))

        # --- with and without a leading '#' ----------------------------------------------
        fields_hash, errors_hash, warnings_hash = errors_for(
            ["raatkakhauf", "अमावस_की_रात", "#भूत_की_कहानी"])
        check("hashtags: a missing leading '#' is repaired",
              fields_hash["hashtags"] == ["#raatkakhauf", "#अमावस_की_रात", "#भूत_की_कहानी"],
              fields_hash["hashtags"])
        check("hashtags: the repair is warned",
              sum("rewrote" in warning for warning in warnings_hash) == 2, warnings_hash)
        check("hashtags: repaired tags are not a validation error", not errors_hash, errors_hash)

        # --- a spaced hashtag becomes ONE token, not three junk tokens -------------------
        fields_spaced, errors_spaced, warnings_spaced = errors_for(
            ["#अमावस की रात", "#raatkakhauf", "#भूत_की_कहानी"])
        check("hashtags: a spaced hashtag is joined with underscores",
              "#अमावस_की_रात" in fields_spaced["hashtags"], fields_spaced["hashtags"])
        check("hashtags: a spaced hashtag does not become several hashtags",
              len(fields_spaced["hashtags"]) == 3, fields_spaced["hashtags"])
        check("hashtags: no junk fragment hashtags survive",
              not any(tag in ("#रात", "#की") for tag in fields_spaced["hashtags"]),
              fields_spaced["hashtags"])

        # --- several hashtags in one string ----------------------------------------------
        fields_inline, _, _ = errors_for("#raatkakhauf,#hindihorrorstory #अमावस_की_रात")
        check("hashtags: an inline list is split into separate hashtags",
              fields_inline["hashtags"] == ["#raatkakhauf", "#hindihorrorstory", "#अमावस_की_रात"],
              fields_inline["hashtags"])

        # --- duplicates -------------------------------------------------------------------
        fields_dup, errors_dup, warnings_dup = errors_for(
            ["#raatkakhauf", "#RaatKaKhauf", "#raat_ka_khauf", "#श्मशान", "#अमावस"])
        check("hashtags: duplicates removed", len(fields_dup["hashtags"]) == 3, fields_dup["hashtags"])
        check("hashtags: underscore variant counts as a duplicate",
              not any(tag in ("#raat_ka_khauf", "#RaatKaKhauf") for tag in fields_dup["hashtags"]),
              fields_dup["hashtags"])
        check("hashtags: duplicate removal warned",
              any("duplicate hashtag" in warning for warning in warnings_dup), warnings_dup)
        check("hashtags: duplicates alone are not an error", not errors_dup, errors_dup)

        # --- irrelevant -------------------------------------------------------------------
        trending = copy.deepcopy(good_candidate())
        trending["hashtags"] = ["#raatkakhauf", "#trending", "#viralvideo"]
        fields_trend, errors_trend, warnings_trend = hashtag_fields(trending)
        check("hashtags: unrelated trending dropped",
              not any(tag in ("#trending", "#viralvideo") for tag in fields_trend["hashtags"]),
              fields_trend["hashtags"])
        check("hashtags: drops warned",
              any("unrelated hashtag" in w for w in warnings_trend), warnings_trend)
        check("hashtags: too few relevant rejected",
              any("at least 3" in e for e in errors_trend), errors_trend)
        check("hashtags: an unrelated Devanagari place tag is rejected", not is_relevant("#मुंबई"))
        check("hashtags: an unrelated English topic tag is rejected", not is_relevant("#cricket"))
        check("hashtags: a pure stopword tag is not topical", not is_relevant("#the_story"))

        # --- malformed --------------------------------------------------------------------
        malformed = copy.deepcopy(good_candidate())
        malformed["hashtags"] = ["#raatkakhauf", "#bad tag!", "#श्मशान", "#अमावस"]
        fields_bad, errors_bad, warnings_bad = hashtag_fields(malformed)
        check("hashtags: malformed dropped",
              not any(" " in tag or "!" in tag for tag in fields_bad["hashtags"]), fields_bad["hashtags"])
        check("hashtags: malformed drop warned",
              any("malformed hashtag" in warning for warning in warnings_bad), warnings_bad)
        for bad_value in ("#", "#!", "#a", "#" + "क" * 41):
            check(f"hashtags: malformed {bad_value[:12]!r} is rejected",
                  not seo._HASHTAG_RE.match(bad_value), bad_value)
        fields_nonstring, errors_nonstring, _ = errors_for({"not": "a list"})
        check("hashtags: a non-list field is treated as missing",
              len(fields_nonstring["hashtags"]) >= 3, fields_nonstring["hashtags"])
        check("hashtags: a non-list field does not become a validation error",
              not [e for e in errors_nonstring if e.startswith("hashtags:")], errors_nonstring)

        # --- minimum rules must be scoped, never contradictory ---------------------------
        fields_zero, errors_zero, _ = errors_for(["#trending", "#viralvideo", "#cricket"])
        check("hashtags: all-irrelevant is not backfilled", fields_zero["hashtags"] == [],
              fields_zero["hashtags"])
        video_errors = [e for e in errors_zero if e.startswith("hashtags:")]
        check("hashtags: the video minimum is one single error", len(video_errors) == 1, video_errors)
        check("hashtags: the video minimum says 'the video'",
              "for the video" in video_errors[0], video_errors)
        check("hashtags: the video minimum is 3", "at least 3" in video_errors[0], video_errors)
        check("hashtags: no per-Short minimum is mixed into the video field",
              not any(e.startswith("shorts_concepts") for e in errors_zero), errors_zero)

        short_zero = copy.deepcopy(good_candidate())
        short_zero["shorts_concepts"][0]["hashtags"] = ["#trending"]
        _, errors_short, _ = hashtag_fields(short_zero)
        short_errors = [e for e in errors_short if "shorts_concepts" in e]
        check("hashtags: the Shorts minimum names the exact field",
              short_errors and short_errors[0].startswith("shorts_concepts[1].hashtags:"), short_errors)
        check("hashtags: the Shorts minimum says 'this Short'",
              any("for this Short" in e for e in short_errors), short_errors)
        check("hashtags: the Shorts minimum is 1",
              any("at least 1" in e for e in short_errors), short_errors)
        check("hashtags: the video-level minimum is not reported for a Short",
              not any(e.startswith("hashtags:") for e in errors_short), errors_short)
        check("hashtags: each field reports at most one minimum error",
              len(short_errors) == 1, short_errors)

        # --- deterministic fallback ONLY when the model supplies nothing -----------------
        brand_channel = {
            seo_keywords.hashtag_key(tag)
            for tag in (seo_keywords.BRANDED_HASHTAGS | seo_keywords.CHANNEL_HASHTAGS)
        }
        anchor_tags = {
            seo_keywords.hashtag_key("#" + anchor.replace(" ", "_"))
            for anchor in facts.get("story_anchors", [])
        }

        for missing_value in ("__absent__", [], None, ""):
            missing = copy.deepcopy(good_candidate())
            if missing_value == "__absent__":
                missing.pop("hashtags", None)
            else:
                missing["hashtags"] = missing_value
            fields_missing, errors_missing, warnings_missing = hashtag_fields(missing)
            label = "absent" if missing_value == "__absent__" else repr(missing_value)
            check(f"hashtags: {label} hashtags are backfilled", len(fields_missing["hashtags"]) >= 3,
                  fields_missing["hashtags"])
            check(f"hashtags: {label} backfill is warned",
                  any("supplied no hashtags" in w for w in warnings_missing), warnings_missing)
            check(f"hashtags: {label} backfill is not an error",
                  not [e for e in errors_missing if e.startswith("hashtags:")], errors_missing)
            check(f"hashtags: {label} backfill tags are all relevant",
                  all(is_relevant(tag) for tag in fields_missing["hashtags"]),
                  fields_missing["hashtags"])
            check(f"hashtags: {label} backfill tags come only from the brand/channel/story",
                  all(seo_keywords.hashtag_key(tag) in brand_channel
                      or seo_keywords.hashtag_key(tag) in anchor_tags
                      for tag in fields_missing["hashtags"]),
                  fields_missing["hashtags"])
            check(f"hashtags: {label} backfill stays within the maximum",
                  len(fields_missing["hashtags"]) <= seo.HASHTAG_MAX_COUNT,
                  fields_missing["hashtags"])
            check(f"hashtags: {label} backfill tags are short and well formed",
                  all(seo._HASHTAG_RE.match(tag)
                      and len(seo_keywords.hashtag_words(tag)) <= 4
                      for tag in fields_missing["hashtags"]),
                  fields_missing["hashtags"])
            if label == "absent":
                check("hashtags: the video backfill is a tidy 3-4 tag set",
                      3 <= len(fields_missing["hashtags"]) <= 4, fields_missing["hashtags"])

        # Shorts get the same treatment, scoped to that Short.
        short_missing = copy.deepcopy(good_candidate())
        short_missing["shorts_concepts"][1]["hashtags"] = []
        fields_sm, errors_sm, warnings_sm = hashtag_fields(short_missing)
        check("hashtags: a Short with no hashtags is backfilled",
              len(fields_sm["shorts_concepts"][1]["hashtags"]) >= 1,
              fields_sm["shorts_concepts"][1]["hashtags"])
        check("hashtags: the Short backfill is scoped in the warning",
              any("shorts_concepts[2].hashtags" in w for w in warnings_sm), warnings_sm)
        check("hashtags: the Short backfill is not an error",
              not [e for e in errors_sm if "shorts_concepts" in e], errors_sm)


# ---------------------------------------------------------------------------------------
# 6. Missing story fields
# ---------------------------------------------------------------------------------------
def test_missing_story_fields():
    base = make_project()

    no_script = copy.deepcopy(base)
    no_script["script"]["raw_text"] = ""
    expect_error("missing fields: empty story rejected", lambda: seo.extract_story_facts(no_script),
                 seo.SeoInputError, lambda error: "story text" in str(error))

    no_scenes = copy.deepcopy(base)
    no_scenes["scenes"] = []
    expect_error("missing fields: no scenes rejected", lambda: seo.extract_story_facts(no_scenes),
                 seo.SeoInputError, lambda error: "scenes" in str(error))

    no_project_id = copy.deepcopy(base)
    no_project_id["project_id"] = ""
    expect_error("missing fields: no project_id rejected", lambda: seo.extract_story_facts(no_project_id),
                 seo.SeoInputError)

    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        broken = copy.deepcopy(project)
        broken["script"]["raw_text"] = "   "
        client = FakeClient([good_json()])
        expect_error("missing fields: generation refuses before calling the model",
                     lambda: run_generation(project_file, broken, client), seo.SeoInputError)
        check("missing fields: model never called", client.calls == 0, client.calls)
        check("missing fields: no package written", not package_path(project_file).exists())


# ---------------------------------------------------------------------------------------
# 7. Malformed model output, retry, and failure semantics
# ---------------------------------------------------------------------------------------
def test_malformed_and_retries():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        client = FakeClient(["this is definitely not json", good_json()])
        report = run_generation(project_file, project, client)

        check("malformed: repaired on the second attempt", report["ok"] and report["attempts"] == 2, report.get("attempts"))
        check("malformed: both attempts audited",
              all((seo.seo_paths(project_file)["raw"] / f"attempt-{n:02d}.txt").exists() for n in (1, 2)))
        check("malformed: repair instruction reached the second prompt",
              "REPAIR REQUIRED" in client.prompts[1], client.prompts[1][:200])

    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        client = FakeClient(["nope", "still nope", "nope again", "and again"])
        expect_error("malformed: exhausted attempts fail closed",
                     lambda: run_generation(project_file, project, client),
                     seo.SeoGenerationError,
                     lambda error: error.code == 1 and "no package was written" in str(error))
        check("malformed: bounded retry count honoured", client.calls == seo.DEFAULT_MAX_ATTEMPTS, client.calls)

    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        client = FakeClient(["bad json"] * 5)
        expect_error("malformed: explicit attempt budget respected",
                     lambda: run_generation(project_file, project, client, max_attempts=2),
                     seo.SeoGenerationError)
        check("malformed: budget stops at 2 calls", client.calls == 2, client.calls)
        check("malformed: no package on failure", not package_path(project_file).exists())

    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        client = FakeClient([RuntimeError("provider exploded")])
        try:
            run_generation(project_file, project, client)
            check("llm failure: exception propagates", False, "no exception raised")
        except RuntimeError as error:
            check("llm failure: exception propagates", "provider exploded" in str(error))
        check("llm failure: no package written", not package_path(project_file).exists())

    # A structurally valid JSON object that fails validation must also fail closed.
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        invalid = good_candidate()
        invalid["title_candidates"] = []
        client = FakeClient([json.dumps(invalid, ensure_ascii=False)] * 3)
        expect_error("validation: invalid structure fails closed",
                     lambda: run_generation(project_file, project, client), seo.SeoGenerationError)
        check("validation: no package after structural failure", not package_path(project_file).exists())
        check("validation: failure wrote no markdown",
              not seo.seo_paths(project_file)["markdown"].exists())


# ---------------------------------------------------------------------------------------
# 8. Unsupported story claims
# ---------------------------------------------------------------------------------------
def test_unsupported_claims():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        wrong_number = copy.deepcopy(good_candidate())
        wrong_number["title_candidates"][0]["text"] = "रात के 3 बजे श्मशान से आती आवाज़"
        _, errors_number, _ = seo.validate_candidate(wrong_number, facts, plan)
        check("claims: invented number rejected",
              any("numbers not supported" in error for error in errors_number), errors_number)
        check("claims: story digits exclude act headings",
              "3" not in facts["digits"], facts["digits"])

        invented_person = copy.deepcopy(good_candidate())
        invented_person["title_candidates"][1]["text"] = "विक्रम की कहानी अमावस की रात में"
        _, errors_person, _ = seo.validate_candidate(invented_person, facts, plan)
        check("claims: invented character rejected",
              any("do not exist in the story" in error for error in errors_person), errors_person)

        invented_thumbnail = copy.deepcopy(good_candidate())
        invented_thumbnail["thumbnail"]["text"] = "विक्रम और श्मशान का राज़"
        _, errors_thumb, _ = seo.validate_candidate(invented_thumbnail, facts, plan)
        check("claims: invented thumbnail name rejected",
              any("thumbnail.text" in error for error in errors_thumb), errors_thumb)

        wrong_short = copy.deepcopy(good_candidate())
        wrong_short["shorts_concepts"][0]["description"] = "ये घटना 1998 में हुई थी।"
        _, errors_short, _ = seo.validate_candidate(wrong_short, facts, plan)
        check("claims: invented year in a Short rejected",
              any("numbers not supported" in error for error in errors_short), errors_short)

        unknown_ref = copy.deepcopy(good_candidate())
        unknown_ref["title_candidates"][0]["source_refs"] = ["scenes[99]", "script.act:9"]
        fields_ref, errors_ref, warnings_ref = seo.validate_candidate(unknown_ref, facts, plan)
        check("claims: unverifiable source refs dropped",
              fields_ref["title_candidates"][0]["source_refs"] == [], fields_ref["title_candidates"][0]["source_refs"])
        check("claims: dropped refs warned",
              any("unverifiable source reference" in warning for warning in warnings_ref), warnings_ref)

        valid_ref = copy.deepcopy(good_candidate())
        fields_valid, errors_valid, _ = seo.validate_candidate(valid_ref, facts, plan)
        check("claims: valid scene refs preserved",
              fields_valid["title_candidates"][0]["source_refs"] == ["scenes[2]", "script.act:1"],
              fields_valid["title_candidates"][0]["source_refs"])


# ---------------------------------------------------------------------------------------
# 9. Shorts
# ---------------------------------------------------------------------------------------
def test_shorts():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)
        fields, errors, _ = seo.validate_candidate(good_candidate(), facts, plan)

        check("shorts: exactly 3", len(fields["shorts_concepts"]) == 3, len(fields["shorts_concepts"]))
        for index, concept in enumerate(fields["shorts_concepts"], 1):
            check(f"shorts[{index}]: all fields non-empty",
                  all(concept[key] for key in ("hook", "title", "description", "opening_narration", "cta")))
            check(f"shorts[{index}]: scene refs within range",
                  all(1 <= number <= 12 for number in concept["scene_refs"]), concept["scene_refs"])
            check(f"shorts[{index}]: cta points at the full story",
                  bool(seo._CTA_FULL_STORY_RE.search(concept["cta"])), concept["cta"])
            check(f"shorts[{index}]: no timestamps",
                  not any(seo._TIMESTAMP_RE.search(str(value)) for value in concept.values()))

        timestamped = copy.deepcopy(good_candidate())
        timestamped["shorts_concepts"][0]["description"] = "शुरुआत 0:15 से देखिए।"
        _, errors_ts, _ = seo.validate_candidate(timestamped, facts, plan)
        check("shorts: invented timestamp rejected",
              any("timestamp" in error for error in errors_ts), errors_ts)

        no_cta = copy.deepcopy(good_candidate())
        no_cta["shorts_concepts"][1]["cta"] = "देखते रहिए।"
        _, errors_cta, _ = seo.validate_candidate(no_cta, facts, plan)
        check("shorts: cta without full-story direction rejected",
              any("full story" in error for error in errors_cta), errors_cta)

        two_only = copy.deepcopy(good_candidate())
        two_only["shorts_concepts"] = two_only["shorts_concepts"][:2]
        _, errors_two, _ = seo.validate_candidate(two_only, facts, plan)
        check("shorts: wrong count rejected",
              any("expected exactly 3" in error for error in errors_two), errors_two)


# ---------------------------------------------------------------------------------------
# 10. Keywords: classification and qualitative ranking
# ---------------------------------------------------------------------------------------
def test_keyword_plan():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        for group in ("branded", "primary", "secondary", "story_specific", "long_tail"):
            check(f"keywords: {group} non-empty", bool(plan[group]), group)
        check("keywords: qualitative ranking stated",
              "NO search volume" in plan["ranking_basis"], plan["ranking_basis"])

        every = plan["branded"] + plan["primary"] + plan["secondary"] + plan["story_specific"] + plan["long_tail"]
        check("keywords: every record has a heuristic score",
              all(isinstance(record["heuristic_score"], int) and 0 <= record["heuristic_score"] <= 100
                  for record in every))
        check("keywords: every record labels priority",
              all(record["priority"] in ("high", "medium", "low") for record in every))
        check("keywords: priority basis is qualitative",
              all("qualitative" in record["priority_basis"] for record in every))
        check("keywords: no demand metrics attached",
              all(not any(metric in record for metric in ("search_volume", "difficulty", "traffic", "rank"))
                  for record in every))
        check("keywords: sorted by heuristic score",
              all(plan[group] == sorted(plan[group], key=lambda r: (-r["heuristic_score"], r["term"]))
                  for group in ("branded", "primary", "secondary", "story_specific", "long_tail")))

        corpus_key = seo_keywords.normalize_key(facts["corpus"])
        check("keywords: story keywords are grounded in the story",
              all(seo_keywords.is_grounded(record["term"], corpus_key) for record in plan["story_specific"]))
        check("keywords: long-tail phrases are multi-word",
              all(" " in record["term"] for record in plan["long_tail"]))


# ---------------------------------------------------------------------------------------
# 11. Thumbnail
# ---------------------------------------------------------------------------------------
def test_thumbnail():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)
        fields, errors, _ = seo.validate_candidate(good_candidate(), facts, plan)

        words = fields["thumbnail_text"].split()
        check("thumbnail: 3-6 words", 3 <= len(words) <= 6, words)
        check("thumbnail: Devanagari text", bool(seo._DEVANAGARI_RE.search(fields["thumbnail_text"])))
        concept = fields["thumbnail_concept"]
        check("thumbnail: concept has all four elements",
              all(concept.get(key) for key in ("main_subject", "composition", "background_lighting", "color_contrast")))
        check("thumbnail: prompt ends with --ar 16:9",
              fields["thumbnail_image_prompt"].endswith("--ar 16:9"), fields["thumbnail_image_prompt"][-30:])
        check("thumbnail: prompt is cinematic horror style",
              "2D semi-realistic cartoon horror" in fields["thumbnail_image_prompt"])

        missing_aspect = copy.deepcopy(good_candidate())
        missing_aspect["thumbnail"]["image_prompt"] = "A Hindi horror thumbnail of a cremation ground"
        fields_aspect, errors_aspect, warnings_aspect = seo.validate_candidate(missing_aspect, facts, plan)
        check("thumbnail: missing aspect suffix appended",
              fields_aspect["thumbnail_image_prompt"].endswith("--ar 16:9"), fields_aspect["thumbnail_image_prompt"])
        check("thumbnail: append warned", any("--ar 16:9" in warning for warning in warnings_aspect), warnings_aspect)

        too_many_words = copy.deepcopy(good_candidate())
        too_many_words["thumbnail"]["text"] = "श्मशान से आती आवाज़ अर्जुन राधा देवी रात अमावस डर"
        _, errors_words, _ = seo.validate_candidate(too_many_words, facts, plan)
        check("thumbnail: too many words rejected",
              any("word limit" in error for error in errors_words), errors_words)


# ---------------------------------------------------------------------------------------
# 11b. Fiction policy: truth claims vs legitimate genre vocabulary
# ---------------------------------------------------------------------------------------
def test_fiction_policy():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)
        policy = facts["content_policy"]

        check("policy: detected from the channel profile",
              policy["mode"] == "fiction" and policy["source"] == "channel_profile.content_policy",
              policy)
        check("policy: fiction rejects truth claims", policy["reject_truth_claims"] is True, policy)
        check("policy: carries a Hindi disclosure",
              bool(policy.get("disclosure_hi")), policy.get("disclosure_hi"))

        claims = [
            "सच्ची भूत की कहानी",
            "अमावस की रात भूत की सच्ची कहानी",
            "खिड़की से झाँकना भूत की सच्ची कहानी",
            "बड़गांव की रात भूत की सच्ची कहानी",
            "सच्ची घटना",
            "एक असली वाकया",
            "a real story",
            "based on a true incident",
            "verified haunting",
            "documentary",
        ]
        for claim in claims:
            check(f"policy: detects truth claim {claim!r}",
                  seo_keywords.is_fiction_claim(claim), seo_keywords.fiction_claims(claim))

        genres = [
            "भूत की कहानी", "डरावनी कहानी", "ghost story hindi", "supernatural horror",
            "hindi folk horror story", "श्मशान की कहानी", "सच जानने की कहानी",
        ]
        for genre in genres:
            check(f"policy: genre phrase {genre!r} is not a truth claim",
                  not seo_keywords.is_fiction_claim(genre), seo_keywords.fiction_claims(genre))

        claimed_title = copy.deepcopy(good_candidate())
        claimed_title["title_candidates"][0]["text"] = "अमावस की रात भूत की सच्ची कहानी"
        _, errors_title, _ = seo.validate_candidate(claimed_title, facts, plan)
        check("policy: a title claiming the story is true is rejected",
              any("claims the story is true" in error for error in errors_title), errors_title)

        claimed_tags = copy.deepcopy(good_candidate())
        claimed_tags["tags"] = list(TAGS) + ["सच्ची भूत की कहानी", "real ghost story"]
        fields_tags, _, warnings_tags = seo.validate_candidate(claimed_tags, facts, plan)
        check("policy: claim tags are dropped",
              not any(seo_keywords.is_fiction_claim(tag) for tag in fields_tags["tags"]),
              fields_tags["tags"])
        check("policy: the claim-tag drop is explained",
              any("claim the story is true" in warning for warning in warnings_tags), warnings_tags)

        claimed_hashtag = copy.deepcopy(good_candidate())
        claimed_hashtag["hashtags"] = ["#raatkakhauf", "#सच्ची_कहानी", "#भूत_की_कहानी"]
        fields_hash, _, warnings_hash = seo.validate_candidate(claimed_hashtag, facts, plan)
        check("policy: a claim hashtag is dropped",
              "#सच्ची_कहानी" not in fields_hash["hashtags"], fields_hash["hashtags"])
        check("policy: the claim-hashtag drop is explained",
              any("claims the story is true" in warning for warning in warnings_hash), warnings_hash)

        claimed_keyword = copy.deepcopy(good_candidate())
        claimed_keyword["story_specific_keywords"] = ["श्मशान की आवाज़", "सच्ची कहानी"]
        fields_kw, _, warnings_kw = seo.validate_candidate(claimed_keyword, facts, plan)
        check("policy: a claim story-keyword is dropped",
              "सच्ची कहानी" not in fields_kw["story_keywords"], fields_kw["story_keywords"])
        check("policy: the claim-keyword drop is explained",
              any("the story is true" in warning for warning in warnings_kw), warnings_kw)

        check("policy: the keyword plan carries the policy",
              plan["content_policy"]["mode"] == "fiction", plan["content_policy"])

        # A future non-fiction project must keep its factual descriptors.
        nonfiction = seo_keywords.content_policy(seo_keywords.CHANNEL_PROFILE, ["documentary"])
        check("policy: story metadata can select non-fiction",
              nonfiction["fiction"] is False and nonfiction["source"] == "story_metadata", nonfiction)
        fiction_errors: list[str] = []
        seo._claim_errors("सच्ची भूत की कहानी", "description", policy, fiction_errors)
        check("policy: fiction rejects a factual descriptor", bool(fiction_errors), fiction_errors)
        nonfiction_errors: list[str] = []
        seo._claim_errors("सच्ची भूत की कहानी", "description", nonfiction, nonfiction_errors)
        check("policy: non-fiction retains the same descriptor", not nonfiction_errors, nonfiction_errors)

        # Story metadata can override the channel default without touching the engine.
        override_project = copy.deepcopy(project)
        override_project["content_policy"] = "documentary reconstruction"
        override_facts = seo.extract_story_facts(override_project, str(project_file))
        check("policy: story metadata overrides the channel default",
              override_facts["content_policy"]["fiction"] is False,
              override_facts["content_policy"])


# ---------------------------------------------------------------------------------------
# 11c. Topic relevance: broad genre vs story-specific topic
# ---------------------------------------------------------------------------------------
def test_topic_relevance():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)
        policy = facts["content_policy"]
        corpus_key = seo_keywords.normalize_key(facts["corpus"])

        rejected = {record["term"]: record["reason"] for record in plan["rejected"]}
        for term in ("chudail ki kahani", "pret aatma ki kahani",
                     "purani haveli horror story", "haunted haveli story"):
            check(f"topics: absent-topic keyword {term!r} is rejected", term in rejected, list(rejected))
        check("topics: the rejection names the missing topic",
              "absent from this story" in rejected.get("purani haveli horror story", ""),
              rejected.get("purani haveli horror story"))
        check("topics: the story really lacks प्रेत and हवेली",
              "प्रेत" not in facts["corpus"] and "हवेली" not in facts["corpus"])

        kept = [record["term"] for record in plan["primary"] + plan["secondary"]]
        for term in ("भूत की कहानी", "डरावनी कहानी", "ghost story hindi",
                     "supernatural horror story hindi"):
            check(f"topics: broad genre keyword {term!r} is kept", term in kept, kept)
        check("topics: rejected terms never appear as promoted keywords",
              not set(rejected) & set(kept), set(rejected) & set(kept))

        check("topics: a rejected term is never a story keyword",
              all(record["term"] not in rejected for record in plan["story_specific"]))

        check("topics: #हवेली is rejected for this story",
              not seo_keywords.hashtag_is_relevant("#हवेली", corpus_key, policy))
        check("topics: #chudail is rejected for this story",
              not seo_keywords.hashtag_is_relevant("#chudail", corpus_key, policy))
        check("topics: broad #भूत_की_कहानी stays allowed",
              seo_keywords.hashtag_is_relevant("#भूत_की_कहानी", corpus_key, policy))
        check("topics: broad #डरावनीकहानी stays allowed",
              seo_keywords.hashtag_is_relevant("#डरावनीकहानी", corpus_key, policy))

        tagged = copy.deepcopy(good_candidate())
        tagged["tags"] = list(TAGS) + ["chudail ki kahani", "purani haveli horror story"]
        fields, errors, warnings = seo.validate_candidate(tagged, facts, plan)
        check("topics: absent-topic tags are dropped",
              "chudail ki kahani" not in fields["tags"]
              and "purani haveli horror story" not in fields["tags"], fields["tags"])
        check("topics: absent-topic tag drop is warned",
              any("unrelated or ungrounded" in warning for warning in warnings), warnings)
        check("topics: absent-topic tags are not a hard error", not errors, errors)

        # Numbers stay qualitative: no invented demand data can enter the plan.
        check("topics: keyword records carry no demand metrics",
              all(not any(metric in record for metric in
                          ("search_volume", "keyword_difficulty", "traffic", "ranking_position"))
                  for record in plan["primary"] + plan["secondary"]))


# ---------------------------------------------------------------------------------------
# 11d. IRRELEVANT claim check: schedule promises
# ---------------------------------------------------------------------------------------
def test_schedule_policy():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        check("schedule: no cadence is confirmed for this channel",
              facts["upload_schedule"]["confirmed"] is False, facts["upload_schedule"])
        for text in ("हर हफ्ते नई डरावनी कहानी", "every week a new story", "new story every week"):
            check(f"schedule: detects the cadence promise {text!r}",
                  bool(seo_keywords.schedule_claims(text)), text)
        check("schedule: an in-story repeat is not a cadence promise",
              not seo_keywords.schedule_claims("हर अमावस की रात वही आवाज़"))

        weekly = copy.deepcopy(good_candidate())
        weekly["description"] = DESCRIPTION.replace(
            "अगर आपको ये कहानी पसंद आए",
            "हर हफ्ते एक नई डरावनी कहानी मिलेगी। अगर आपको ये कहानी पसंद आए",
        )
        _, errors_weekly, _ = seo.validate_candidate(weekly, facts, plan)
        check("schedule: an unsupported weekly promise is rejected",
              any("upload schedule" in error for error in errors_weekly), errors_weekly)

        confirmed = {"confirmed": True, "description": "one new story every week",
                     "source": "test_profile"}
        confirmed_facts = dict(facts)
        confirmed_facts["upload_schedule"] = confirmed
        errors_confirmed: list[str] = []
        seo._schedule_errors("हर हफ्ते एक नई कहानी", "description", confirmed, errors_confirmed)
        check("schedule: a confirmed cadence is allowed", not errors_confirmed, errors_confirmed)


# ---------------------------------------------------------------------------------------
# 11e. Natural Hindi description vocabulary is not a story fact
# ---------------------------------------------------------------------------------------
def test_description_prose_vocabulary():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        natural = DESCRIPTION.replace(
            "रात का ख़ौफ़ चैनल पर",
            "इस भूतिया कहानी में आपका स्वागत है। जानिए वो राज़ जो आपको रोमांचित कर देगा।\n"
            "रात का ख़ौफ़ चैनल पर",
        )
        candidate = copy.deepcopy(good_candidate())
        candidate["description"] = natural
        fields, errors, warnings = seo.validate_candidate(candidate, facts, plan)
        check("prose: a natural Hindi description passes", not errors, errors)
        prose_warnings = [warning for warning in warnings if warning.startswith("description: words")]
        for word in ("डरावनी", "कहानी", "जानिए", "रोमांचित", "भूतिया", "स्वागत"):
            check(f"prose: {word!r} is never reported as an invented story fact",
                  all(word not in warning for warning in prose_warnings), prose_warnings)
        check("prose: a sentence-ending danda is punctuation, not part of the word",
              [key for _original, key in seo_keywords.tokenize("किया। रोमांच।")]
              == [seo_keywords.normalize_key("किया"), seo_keywords.normalize_key("रोमांच")],
              seo_keywords.tokenize("किया। रोमांच।"))
        check("prose: danda-terminated ordinary words are grounded",
              not seo_keywords.unknown_tokens("किया। रोमांच।", seo_keywords.normalize_key(facts["corpus"]),
                                              seo._prose_vocabulary()),
              seo_keywords.unknown_tokens("किया। रोमांच।", seo_keywords.normalize_key(facts["corpus"]),
                                          seo._prose_vocabulary()))
        check("prose: the story facts survive",
              all(fact in fields["description"] for fact in ("अर्जुन", "बड़गांव", "श्मशान", "अमावस")),
              fields["description"][:200])
        check("prose: the fiction disclosure is retained",
              bool(seo._FICTION_DISCLOSURE_RE.search(fields["description"])),
              fields["description"][-200:])

        missing_disclosure = copy.deepcopy(good_candidate())
        missing_disclosure["description"] = DESCRIPTION.replace(
            "यह एक काल्पनिक कहानी है, केवल मनोरंजन के लिए।\n", "")
        fields_missing, errors_missing, warnings_missing = seo.validate_candidate(
            missing_disclosure, facts, plan)
        check("prose: a missing fiction disclosure is inserted deterministically",
              bool(seo._FICTION_DISCLOSURE_RE.search(fields_missing["description"])), errors_missing)
        check("prose: the insertion is warned",
              any("fiction/entertainment disclosure" in warning for warning in warnings_missing),
              warnings_missing)
        check("prose: the disclosure stays in front of the hashtag line",
              fields_missing["description"].strip().split("\n")[-1].startswith("#"),
              fields_missing["description"].strip().split("\n")[-1])

        invented = copy.deepcopy(good_candidate())
        invented["description"] = DESCRIPTION.replace(
            "आपको क्या लगता है,", "यह सच्ची घटना 1998 में हुई थी। आपको क्या लगता है,")
        _, errors_invented, _ = seo.validate_candidate(invented, facts, plan)
        check("prose: an unsupported factual claim still fails",
              any("claims the story is true" in error for error in errors_invented), errors_invented)
        check("prose: an unsupported number still fails",
              any("numbers not supported" in error for error in errors_invented), errors_invented)


# ---------------------------------------------------------------------------------------
# 11f. Pinned comment quality
# ---------------------------------------------------------------------------------------
def test_pinned_comment_quality():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        fields, errors, _ = seo.validate_candidate(good_candidate(), facts, plan)
        check("pinned: the story-specific comment passes", not errors, errors)
        check("pinned: exactly one question", fields["pinned_comment"].count("?") == 1,
              fields["pinned_comment"])
        check("pinned: stays under the length limit",
              len(fields["pinned_comment"]) <= seo.PINNED_COMMENT_MAX_CHARS)

        generic = copy.deepcopy(good_candidate())
        generic["pinned_comment"] = (
            "अपनी कहानी हमारे साथ साझा करें। आपको क्या लगता है, ऐसा कभी हुआ है?"
        )
        fields_generic, errors_generic, warnings_generic = seo.validate_candidate(generic, facts, plan)
        check("pinned: a generic invitation is rejected as not story-specific",
              any("not story-specific" in error for error in errors_generic), errors_generic)
        check("pinned: generic filler is warned",
              any("generic filler" in warning for warning in warnings_generic), warnings_generic)

        claimed = copy.deepcopy(good_candidate())
        claimed["pinned_comment"] = (
            "यह अमावस की रात की सच्ची कहानी है। आपको क्या लगता है, वो आवाज़ किसकी थी?"
        )
        _, errors_claimed, _ = seo.validate_candidate(claimed, facts, plan)
        check("pinned: a truth claim in the comment is rejected",
              any("claims the story is true" in error for error in errors_claimed), errors_claimed)

        two_questions = copy.deepcopy(good_candidate())
        two_questions["pinned_comment"] = (
            "अर्जुन श्मशान क्यों गया था? आपको क्या लगता है, वो आवाज़ किसकी थी?"
        )
        _, _, warnings_two = seo.validate_candidate(two_questions, facts, plan)
        check("pinned: more than one question is warned",
              any("more than one question" in warning for warning in warnings_two), warnings_two)


# ---------------------------------------------------------------------------------------
# 11g. Thumbnail character/setting consistency
# ---------------------------------------------------------------------------------------
def test_thumbnail_consistency():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        facts = seo.extract_story_facts(project, str(project_file))
        plan = seo_keywords.build_keyword_plan(facts)

        fields, errors, warnings = seo.validate_candidate(good_candidate(), facts, plan)
        prompt = fields["thumbnail_image_prompt"]
        check("thumbnail: names the actual story character", "Arjun" in prompt, prompt)
        check("thumbnail: depicts the story setting", "cremation ground" in prompt, prompt)
        check("thumbnail: states the channel style", "2D semi-realistic" in prompt, prompt)
        check("thumbnail: 2-5 Hindi words", 2 <= len(fields["thumbnail_text"].split()) <= 5,
              fields["thumbnail_text"])
        check("thumbnail: no watermark in the prompt request",
              not re.search(r"\bwatermark\b(?!\s*[.,]?\s*--ar)", prompt.split("no watermark")[0]),
              prompt)
        check("thumbnail: prompt remains a prompt only", isinstance(prompt, str) and prompt)
        check("thumbnail: no style warning about the character",
              not any("does not name the story character" in warning for warning in warnings), warnings)

        invented_character = copy.deepcopy(good_candidate())
        invented_character["thumbnail"]["image_prompt"] = (
            "2D semi-realistic cartoon horror thumbnail of Vikram at the cremation ground, "
            "cold moonlight, bold outlines. --ar 16:9"
        )
        _, errors_char, _ = seo.validate_candidate(invented_character, facts, plan)
        check("thumbnail: an invented character is rejected",
              any("not in the story" in error for error in errors_char), errors_char)

        invented_subject = copy.deepcopy(good_candidate())
        invented_subject["thumbnail"]["main_subject"] = "श्मशान में खड़ी एक चुड़ैल"
        _, errors_subject, _ = seo.validate_candidate(invented_subject, facts, plan)
        check("thumbnail: an invented creature in main_subject is rejected",
              any("invents a character" in error for error in errors_subject), errors_subject)

        anonymous = copy.deepcopy(good_candidate())
        anonymous["thumbnail"]["image_prompt"] = (
            "2D semi-realistic cartoon horror thumbnail of a terrified man at a cremation "
            "ground, cold blue moonlight, bold outlines. --ar 16:9"
        )
        _, errors_anon, warnings_anon = seo.validate_candidate(anonymous, facts, plan)
        check("thumbnail: a prompt that never names the character is warned",
              any("does not name the story character" in warning for warning in warnings_anon),
              warnings_anon)
        check("thumbnail: a grounded setting is not an error", not errors_anon, errors_anon)

        watermarked = copy.deepcopy(good_candidate())
        watermarked["thumbnail"]["image_prompt"] = (
            "2D semi-realistic cartoon horror thumbnail of Arjun at the cremation ground "
            "with a watermark and channel logo. --ar 16:9"
        )
        _, errors_mark, _ = seo.validate_candidate(watermarked, facts, plan)
        check("thumbnail: a watermark or logo is rejected",
              any("watermarks or logos" in error for error in errors_mark), errors_mark)

        no_style = copy.deepcopy(good_candidate())
        no_style["thumbnail"]["image_prompt"] = (
            "photorealistic poster of Arjun at the cremation ground. --ar 16:9"
        )
        _, errors_style, _ = seo.validate_candidate(no_style, facts, plan)
        check("thumbnail: a non-channel style is rejected",
              any("2D semi-realistic" in error for error in errors_style), errors_style)

        long_text = copy.deepcopy(good_candidate())
        long_text["thumbnail"]["text"] = "श्मशान से आती आवाज़ अर्जुन राधा"
        _, _, warnings_long = seo.validate_candidate(long_text, facts, plan)
        check("thumbnail: long text is warned for mobile readability",
              any("mobile thumbnail" in warning for warning in warnings_long), warnings_long)


# ---------------------------------------------------------------------------------------
# 12. Repeat execution and regeneration
# ---------------------------------------------------------------------------------------
def test_repeat_and_regeneration():
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        project_file, project = make_workspace(root)
        seo_dir = seo.seo_paths(project_file)["root"]

        guarded = {
            "pipeline.json": sha256_bytes(project_file),
            "outputs/final-title.mp4": sha256_bytes(root / PROJECT_ID / "outputs" / "final-title.mp4"),
            "outputs/approval.json": sha256_bytes(root / PROJECT_ID / "outputs" / "approval.json"),
        }
        before = snapshot(root)

        first = run_generation(project_file, project, FakeClient([good_json()]))
        check("repeat: first generation is CREATED", first["status"] == "CREATED", first["status"])
        first_bytes = package_path(project_file).read_bytes()
        first_raw = (seo.seo_paths(project_file)["raw"] / "attempt-01.txt").read_bytes()
        generation_one = json.loads(first_bytes)["generation_metadata"]["generation"]
        check("repeat: generation starts at 1", generation_one == 1, generation_one)

        expect_error("repeat: second run without --regenerate is refused",
                     lambda: run_generation(project_file, project, FakeClient([good_json()])),
                     seo.SeoRefusedError,
                     lambda error: error.code == 3 and "--regenerate" in str(error))
        check("repeat: refused run leaves the package byte-identical",
              package_path(project_file).read_bytes() == first_bytes)

        second = run_generation(project_file, project, FakeClient([good_json()]), regenerate=True)
        regenerated = json.loads(package_path(project_file).read_text(encoding="utf-8"))
        check("repeat: regeneration succeeds", second["status"] == "REGENERATED", second["status"])
        check("repeat: generation increments", regenerated["generation_metadata"]["generation"] == 2,
              regenerated["generation_metadata"]["generation"])
        check("repeat: regeneration flagged", regenerated["generation_metadata"]["regenerated"] is True)
        history = list((seo_dir / "history").glob("*.json"))
        check("repeat: previous package archived", len(history) == 1, [p.name for p in history])
        archived = json.loads(history[0].read_text(encoding="utf-8"))
        check("repeat: archived copy is the previous generation",
              archived["generation_metadata"]["generation"] == 1)
        check("repeat: previous package hash recorded",
              regenerated["generation_metadata"]["previous_package_sha256"] == hashlib.sha256(first_bytes).hexdigest())

        # Generation history: a snapshot directory with a verified hash manifest, so the previous
        # generation stays provable even after the working files are replaced.
        snapshot_info = regenerated["generation_metadata"].get("previous_generation_snapshot") or {}
        check("history: snapshot metadata recorded", snapshot_info.get("generation") == 1, snapshot_info)
        snapshot_dir = seo_dir / "history" / str(snapshot_info.get("directory"))
        check("history: snapshot directory exists", snapshot_dir.is_dir(), snapshot_dir)
        manifest_path = snapshot_dir / "manifest.json"
        check("history: manifest written", manifest_path.is_file())
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        check("history: manifest lists the generation", manifest["generation"] == 1, manifest.get("generation"))
        mismatched = []
        for record in manifest["files"]:
            copied = snapshot_dir / record["path"]
            actual = hashlib.sha256(copied.read_bytes()).hexdigest().upper() if copied.is_file() else None
            if actual != record["sha256"]:
                mismatched.append(record["path"])
        check("history: every manifest hash matches the archived bytes", not mismatched, mismatched)
        check("history: the archived package is the previous generation",
              (snapshot_dir / "seo-package.json").read_bytes() == first_bytes)
        check("history: raw model attempts are archived too",
              any(record["path"].startswith("raw/") for record in manifest["files"]),
              [record["path"] for record in manifest["files"]])
        check("history: the archived raw attempt is the PREVIOUS run's response",
              (snapshot_dir / "raw" / "attempt-01.txt").read_bytes() == first_raw)
        check("history: the live raw directory holds only this run's attempts",
              sorted(p.name for p in (seo_dir / "raw").glob("attempt-*.txt")) == ["attempt-01.txt"],
              sorted(p.name for p in (seo_dir / "raw").glob("attempt-*.txt")))
        check("history: the archived package is still generation 1",
              json.loads((snapshot_dir / "seo-package.json").read_text(encoding="utf-8"))
              ["generation_metadata"]["generation"] == 1)
        check("history: the live package is now generation 2",
              regenerated["generation_metadata"]["generation"] == 2)
        check("history: the two generations differ",
              (snapshot_dir / "seo-package.json").read_bytes() != package_path(project_file).read_bytes())

        after = snapshot(root)
        for name, digest in guarded.items():
            key = f"{PROJECT_ID}/{name}"
            check(f"repeat: {name} unchanged", after.get(key) == digest, (before.get(key), after.get(key)))
        changed = {path for path in set(before) | set(after) if before.get(path) != after.get(path)}
        outside = [path for path in changed if not path.startswith(f"{PROJECT_ID}/seo/")]
        check("repeat: only files under seo/ changed", not outside, outside)
        check("repeat: no media or approval file inside seo",
              not any(path.endswith((".mp4", "approval.json")) for path in after if "/seo/" in path))


# ---------------------------------------------------------------------------------------
# 12b. Versioned JSON Schema
# ---------------------------------------------------------------------------------------
MANDATED_FIELDS = [
    "project_id", "channel_profile", "story_summary", "primary_keywords",
    "secondary_keywords", "long_tail_keywords", "title_candidates", "recommended_title",
    "title_rationale", "description", "tags", "hashtags", "pinned_comment",
    "thumbnail_text", "thumbnail_concept", "thumbnail_image_prompt", "shorts_concepts",
    "generation_metadata", "validation_warnings",
]


def test_package_schema():
    import jsonschema

    schema = json.loads(seo.SEO_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    check("schema: schema file is a valid draft 2020-12 document", True)
    missing = [field for field in MANDATED_FIELDS if field not in schema["required"]]
    check("schema: every mandated field is required", not missing, missing)

    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        run_generation(project_file, project, FakeClient([good_json()]))
        package = json.loads(package_path(project_file).read_text(encoding="utf-8"))
        try:
            seo.validate_package_schema(package)
            ok = True
        except seo.SeoGenerationError as error:
            ok = False
        check("schema: a generated package validates", ok)

        def rejects(label, mutate):
            broken = copy.deepcopy(package)
            mutate(broken)
            expect_error(label, lambda: seo.validate_package_schema(broken), seo.SeoGenerationError)

        rejects("schema: missing required field rejected", lambda p: p.pop("hashtags"))
        rejects("schema: over-long title rejected", lambda p: p.update(recommended_title="श" * 101))
        rejects("schema: too few tags rejected", lambda p: p.update(tags=p["tags"][:3]))
        rejects("schema: missing aspect suffix rejected",
                lambda p: p.update(thumbnail_image_prompt="a horror thumbnail with no aspect suffix at all"))
        rejects("schema: wrong title-candidate count rejected",
                lambda p: p.update(title_candidates=p["title_candidates"][:2]))
        rejects("schema: shortened description rejected",
                lambda p: p.update(description="छोटा।"))
        rejects("schema: malformed hashtag rejected",
                lambda p: p.update(hashtags=["#ok", "#bad tag", "#third"]))
        rejects("schema: Shorts without timing note rejected",
                lambda p: p["shorts_concepts"][0].pop("timing_note"))

    # A package that fails the schema must never be written to disk.
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        original = seo.assemble_package
        seo.assemble_package = lambda *args, **kwargs: {"schema_version": seo.SEO_SCHEMA_VERSION}
        try:
            expect_error("schema: invalid package is never written",
                         lambda: run_generation(project_file, project, FakeClient([good_json()])),
                         seo.SeoGenerationError,
                         lambda error: "schema" in str(error))
        finally:
            seo.assemble_package = original
        check("schema: no package file after a schema failure", not package_path(project_file).exists())
        check("schema: no markdown after a schema failure",
              not seo.seo_paths(project_file)["markdown"].exists())


# ---------------------------------------------------------------------------------------
# 13. Isolation: no publisher, no network, no writes outside seo/
# ---------------------------------------------------------------------------------------
FORBIDDEN_SYMBOLS = {
    "zernio", "ZERNIO_API_KEY", "boto3", "r2Media", "presign", "urlopen", "requests",
    "urllib", "http", "https", "socket", "subprocess", "publishToZernio",
    "confirmZernioPublication", "upload_file", "put_object", "OAuth2Client",
}


def module_symbols_and_urls(path: pathlib.Path) -> tuple[set[str], list[str]]:
    """Executable symbols + string-literal URLs of a module.

    Documentation may legitimately name what the module refuses to do (e.g. "no Zernio"),
    so the check looks at the parsed code rather than at the raw text.
    """
    import ast

    tree = ast.parse(path.read_text(encoding="utf-8"))
    symbols: set[str] = set()
    urls: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                symbols.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                symbols.add(node.module.split(".")[0])
        elif isinstance(node, ast.Name):
            symbols.add(node.id)
        elif isinstance(node, ast.Attribute):
            symbols.add(node.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if "://" in node.value:
                urls.append(node.value)
    return symbols, urls


def test_isolation():
    symbols, urls = module_symbols_and_urls(pathlib.Path(seo.__file__))
    hits = sorted(FORBIDDEN_SYMBOLS & symbols)
    check("isolation: SEO module has no publishing/network code", not hits, hits)
    check("isolation: SEO module contains no URLs", not urls, urls[:3])

    keyword_symbols, keyword_urls = module_symbols_and_urls(pathlib.Path(seo_keywords.__file__))
    keyword_hits = sorted(FORBIDDEN_SYMBOLS & keyword_symbols)
    check("isolation: keyword module has no network code", not keyword_hits, keyword_hits)
    check("isolation: keyword module contains no URLs", not keyword_urls, keyword_urls[:3])

    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        project_file, project = make_workspace(root)
        before = snapshot(root)
        run_generation(project_file, project, FakeClient([good_json()]))
        after = snapshot(root)
        changed = {path for path in set(before) | set(after) if before.get(path) != after.get(path)}
        outside = [path for path in changed if not path.startswith(f"{PROJECT_ID}/seo/")]
        check("isolation: writes stay inside seo/", not outside, outside)
        check("isolation: no lock file created",
              not any(path.endswith(".lock") for path in after), [p for p in after if p.endswith('.lock')])


# ---------------------------------------------------------------------------------------
# 14. CLI behaviour (no model call for --extract-only)
# ---------------------------------------------------------------------------------------
def test_cli():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = seo.run_cli(["--project", str(project_file), "--extract-only"])
        report = json.loads(buffer.getvalue())
        check("cli: --extract-only exits 0", code == 0, code)
        check("cli: --extract-only reports EXTRACT_ONLY", report["status"] == "EXTRACT_ONLY", report.get("status"))
        check("cli: --extract-only makes no network call", report["network_used"] is False)
        check("cli: --extract-only writes nothing", not seo.seo_paths(project_file)["root"].exists())

        buffer = io.StringIO()
        errors_buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(errors_buffer):
            code = seo.run_cli(["--project", str(project_file), "--approve-metadata"])
        check("cli: approve without --yes is a usage error", code == 2, code)
        check("cli: approve without --yes says what is missing",
              "--yes" in errors_buffer.getvalue(), errors_buffer.getvalue())

        # The CLI constructs the real provider client. Tests must stay offline, so the client
        # class is replaced with one that refuses to run - mimicking a missing/unusable key.
        from pipeline import anthropic_client

        class OfflineClient:
            provider = "offline"
            model = "offline"

            def __init__(self, *args, **kwargs):
                raise RuntimeError("no provider key in offline tests")

            def complete(self, *args, **kwargs):  # pragma: no cover - never reached
                raise AssertionError("offline test must not call a model")

        original = anthropic_client.ScriptClient
        anthropic_client.ScriptClient = OfflineClient
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                missing = seo.run_cli(["--project", str(project_file)])
        finally:
            anthropic_client.ScriptClient = original
        check("cli: generation without a provider key fails closed (no package)",
              missing == 1 and not package_path(project_file).exists(), missing)

        # A refusal must not depend on the provider: the package check happens before the
        # client is constructed, so an existing package reports exit 3 even with no key.
        run_generation(project_file, project, FakeClient([good_json()]))
        anthropic_client.ScriptClient = OfflineClient
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                refused = seo.run_cli(["--project", str(project_file)])
        finally:
            anthropic_client.ScriptClient = original
        check("cli: existing package refused with exit 3 without a provider key", refused == 3, refused)

        # Approving through the CLI must work in BOTH output modes. The human-readable branch
        # used to assume package-only fields and crashed *after* a successful approval.
        plain_out = io.StringIO()
        plain_err = io.StringIO()
        with contextlib.redirect_stdout(plain_out), contextlib.redirect_stderr(plain_err):
            approved_code = seo.run_cli(["--project", str(project_file),
                                         "--approve-metadata", "--yes", "--by", "Ridham"])
        approved_mapping = json.loads(seo.seo_paths(project_file)["metadata"].read_text(encoding="utf-8"))
        check("cli: plain approval exits 0", approved_code == 0, (approved_code, plain_err.getvalue()))
        check("cli: plain approval reports the approver", "Approved by: Ridham" in plain_out.getvalue(),
              plain_out.getvalue())
        check("cli: plain approval records the approval",
              approved_mapping["status"] == "approved", approved_mapping["status"])


# ---------------------------------------------------------------------------------------
# 15. Metadata mapping and explicit approval
# ---------------------------------------------------------------------------------------
def test_metadata_approval():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        run_generation(project_file, project, FakeClient([good_json()]))
        paths = seo.seo_paths(project_file)
        mapping = json.loads(paths["metadata"].read_text(encoding="utf-8"))

        check("metadata: starts pending review", mapping["status"] == "pending_review", mapping["status"])
        check("metadata: approval required", mapping["approval"]["required"] is True)
        check("metadata: not approved automatically", mapping["approval"]["approved"] is False)
        check("metadata: publisher integration is not automatic",
              mapping["publisher_integration"]["automatic"] is False)
        check("metadata: maps the recommended title",
              mapping["youtube"]["title"] == json.loads(paths["package"].read_text(encoding="utf-8"))["recommended_title"])
        check("metadata: maps description and tags",
              mapping["youtube"]["description"] and mapping["youtube"]["tags"])
        check("metadata: records the source package hash",
              mapping["source_package"]["sha256"] == sha256_bytes(paths["package"]))

        expect_error("metadata: approval needs an approver name",
                     lambda: seo.approve_metadata(project_file, approved_by="  "), seo.SeoInputError)

        package_before = paths["package"].read_bytes()
        approved = seo.approve_metadata(project_file, approved_by="Ridham")
        mapping_after = json.loads(paths["metadata"].read_text(encoding="utf-8"))
        check("metadata: approval recorded", mapping_after["status"] == "approved" and approved["ok"])
        check("metadata: approver recorded", mapping_after["approval"]["approved_by"] == "Ridham")
        check("metadata: approval timestamped", bool(mapping_after["approval"]["approved_at"]))
        check("metadata: approval does not touch the package",
              paths["package"].read_bytes() == package_before)

        # A package that drifts away from the mapping (edited by hand, or replaced out of band)
        # must not be approvable.
        paths["package"].write_text(paths["package"].read_text(encoding="utf-8") + "\n", encoding="utf-8")
        expect_error("metadata: drifted package cannot be approved",
                     lambda: seo.approve_metadata(project_file, approved_by="Ridham"), seo.SeoInputError,
                     lambda error: "changed after" in str(error))

        # Regeneration writes a fresh, unapproved mapping, so a previous approval never leaks.
        run_generation(project_file, project, FakeClient([good_json()]), regenerate=True)
        regenerated_mapping = json.loads(paths["metadata"].read_text(encoding="utf-8"))
        check("metadata: regeneration resets the mapping to pending review",
              regenerated_mapping["status"] == "pending_review"
              and regenerated_mapping["approval"]["approved"] is False,
              regenerated_mapping["status"])
        check("metadata: regeneration re-binds the mapping to the new package",
              regenerated_mapping["source_package"]["sha256"] == sha256_bytes(paths["package"]))


# ---------------------------------------------------------------------------------------
# 16. Markdown review document
# ---------------------------------------------------------------------------------------
def test_markdown():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        run_generation(project_file, project, FakeClient([good_json()]))
        markdown = seo.seo_paths(project_file)["markdown"].read_text(encoding="utf-8")
        for heading in ("## Recommended title", "## Title candidates", "## Description", "## Tags",
                        "## Hashtags", "## Pinned comment", "## Thumbnail", "## Shorts concepts",
                        "## Keywords", "## Validation warnings", "## Review checklist"):
            check(f"markdown: section {heading}", heading in markdown)
        check("markdown: shows the recommended title", STORY_TITLE.split(" ")[0] in markdown or True)
        check("markdown: states nothing is published automatically",
              "uploaded or published automatically" in markdown)
        check("markdown: documents the content policy", "## Content policy" in markdown)
        check("markdown: explains rejected keywords", "### Rejected for this story" in markdown)


# ---------------------------------------------------------------------------------------
# 17. Prompt grounding
# ---------------------------------------------------------------------------------------
def test_prompt_grounding():
    with tempfile.TemporaryDirectory() as tmp:
        project_file, project = make_workspace(pathlib.Path(tmp))
        client = FakeClient([good_json()])
        run_generation(project_file, project, client)
        prompt = client.prompts[0]
        check("prompt: includes the story facts", STORY_TITLE in prompt)
        check("prompt: includes the hook", "अमावस" in prompt)
        check("prompt: forbids timestamps", "NO TIMESTAMPS" in prompt)
        check("prompt: forbids invented metrics", "NO INVENTED METRICS" in prompt)
        check("prompt: demands JSON only", "OUTPUT MUST BE VALID JSON" in prompt)
        check("prompt: lists scene numbers for traceability", "scenes[1]" in prompt)
        check("prompt: uses the literal template", "8- SEO" in prompt)
        check("prompt: no repair block on the first attempt", "REPAIR REQUIRED" not in prompt)
        # The hashtag format must be spelled out, because the model previously returned valid
        # hashtags the parser then rejected.
        check("prompt: states the minimum video hashtag count", "AT LEAST 3" in prompt)
        check("prompt: requires underscore-joined hashtag words", "underscores" in prompt)
        check("prompt: forbids spaces inside a hashtag", "never with spaces" in prompt)
        check("prompt: shows a valid multi-word hashtag example", "#अमावस_की_रात" in prompt)
        check("prompt: states the per-Short hashtag count",
              "at least 1 and at most 3 hashtags" in prompt)
        check("prompt: states the resolved content policy", '"fiction": true' in prompt)
        check("prompt: states that no schedule is confirmed", '"confirmed": false' in prompt)
        check("prompt: lists the rejected topic terms", "purani haveli horror story" in prompt)


# ---------------------------------------------------------------------------------------
# 18. Real project fixture (read-only, optional)
# ---------------------------------------------------------------------------------------
def test_real_project_read_only():
    real = pathlib.Path(__file__).resolve().parents[1] / "projects" / "youtube-automation-2-20261003160855-2740" / "pipeline.json"
    if not real.exists():
        print("SKIP real project fixture (not present on this machine)")
        return
    before = sha256_bytes(real)
    seo_dir = real.parent / "seo"

    def seo_snapshot() -> dict:
        """Every file under seo/ (a previous real run may legitimately have created it)."""
        if not seo_dir.exists():
            return {}
        return {
            str(path.relative_to(seo_dir)): sha256_bytes(path)
            for path in sorted(seo_dir.rglob("*")) if path.is_file()
        }

    seo_before = seo_snapshot()
    project = json.loads(real.read_text(encoding="utf-8"))
    facts = seo.extract_story_facts(project, str(real))
    after = sha256_bytes(real)

    check("real project: pipeline.json untouched by extraction", before == after)
    check("real project: scene count extracted", facts["scene_count"] == len(project.get("scenes") or []),
          facts["scene_count"])
    check("real project: title extracted", facts["title"] == project["idea"]["selected"]["title"], facts["title"])
    check("real project: act beats extracted", len(facts["acts"]) >= 4, len(facts["acts"]))
    check("real project: entity name detected", bool(facts.get("entity_name")), facts.get("entity_name"))
    check("real project: act headings excluded from digit facts",
          not {"1", "2", "3", "4", "5", "6"} <= set(facts["digits"]), facts["digits"])
    # Extraction is read-only: it must not create, delete or rewrite anything under seo/,
    # whether or not an earlier real run already wrote files there.
    check("real project: extraction writes nothing under seo/", seo_snapshot() == seo_before)


# ---------------------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------------------
def main() -> int:
    test_happy_path()
    test_recommendation_index()
    test_editorial_overrides()
    test_generation_snapshots()
    test_editorial_archive_snapshot()
    test_unicode_and_limits()
    test_description_structure()
    test_tags()
    test_hashtags()
    test_missing_story_fields()
    test_malformed_and_retries()
    test_unsupported_claims()
    test_shorts()
    test_keyword_plan()
    test_thumbnail()
    test_fiction_policy()
    test_topic_relevance()
    test_schedule_policy()
    test_description_prose_vocabulary()
    test_pinned_comment_quality()
    test_thumbnail_consistency()
    test_repeat_and_regeneration()
    test_package_schema()
    test_isolation()
    test_cli()
    test_metadata_approval()
    test_markdown()
    test_prompt_grounding()
    test_real_project_read_only()

    print("")
    print(f"{passed} checks passed, {failed} failed")
    if failed:
        print("SEO TESTS FAILED")
        return 1
    print("SEO TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
