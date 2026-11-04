"""Offline deterministic Flow voice selection.

Given structured character metadata (age, gender, profession, personality,
voice_description) choose exactly one voice from the verified Google Flow
catalog. Pure/deterministic: no randomness, no time, no hash(), no I/O.

Flow exposes only gender/style/pitch for each voice. Age is therefore a
*preference* over pitch/style characteristics, never a claim that Flow labels
voices by age.
"""
from __future__ import annotations

import re

UNGENDERED = "ungendered"

# Catalog in a FIXED order (this order is the deterministic tie-break).
# Each entry: name, gender, style, pitch, and keyword tags used for scoring.
VOICE_CATALOG: list[dict] = [
    # --- male ---
    {"name": "Achird", "gender": "male", "style": "friendly", "pitch": "mid"},
    {"name": "Algenib", "gender": "male", "style": "gravelly", "pitch": "low"},
    {"name": "Algieba", "gender": "male", "style": "easy-going", "pitch": "mid-low"},
    {"name": "Alnilam", "gender": "male", "style": "firm", "pitch": "mid-low"},
    {"name": "Charon", "gender": "male", "style": "informative", "pitch": "lower"},
    {"name": "Enceladus", "gender": "male", "style": "breathy", "pitch": "lower"},
    {"name": "Fenrir", "gender": "male", "style": "excitable", "pitch": "younger"},
    {"name": "Iapetus", "gender": "male", "style": "clear", "pitch": "mid-low"},
    {"name": "Orus", "gender": "male", "style": "firm", "pitch": "mid-low"},
    {"name": "Puck", "gender": "male", "style": "upbeat", "pitch": "mid"},
    {"name": "Rasalgethi", "gender": "male", "style": "informative", "pitch": "mid"},
    {"name": "Sadachbia", "gender": "male", "style": "lively", "pitch": "low"},
    {"name": "Sadaltager", "gender": "male", "style": "knowledgeable", "pitch": "mid"},
    {"name": "Schedar", "gender": "male", "style": "even", "pitch": "mid-low"},
    {"name": "Umbriel", "gender": "male", "style": "smooth", "pitch": "lower"},
    {"name": "Zubenelgenubi", "gender": "male", "style": "casual", "pitch": "mid-low"},
    # --- female ---
    {"name": "Achernar", "gender": "female", "style": "soft", "pitch": "high"},
    {"name": "Aoede", "gender": "female", "style": "breezy", "pitch": "mid"},
    {"name": "Autonoe", "gender": "female", "style": "bright", "pitch": "mid"},
    {"name": "Callirrhoe", "gender": "female", "style": "easy-going", "pitch": "mid"},
    {"name": "Despina", "gender": "female", "style": "smooth", "pitch": "mid"},
    {"name": "Erinome", "gender": "female", "style": "clear", "pitch": "mid"},
    {"name": "Gacrux", "gender": "female", "style": "mature", "pitch": "mid"},
    {"name": "Kore", "gender": "female", "style": "firm", "pitch": "mid"},
    {"name": "Laomedeia", "gender": "female", "style": "upbeat", "pitch": "mid-high"},
    {"name": "Leda", "gender": "female", "style": "youthful", "pitch": "mid-high"},
    {"name": "Sulafat", "gender": "female", "style": "warm", "pitch": "mid"},
    {"name": "Vindemiatrix", "gender": "female", "style": "gentle", "pitch": "mid"},
    {"name": "Zephyr", "gender": "female", "style": "bright", "pitch": "mid-high"},
    # --- ungendered ---
    {"name": "Pulcherrima", "gender": UNGENDERED, "style": "forward", "pitch": "mid-high"},
]

VALID_VOICE_NAMES = frozenset(entry["name"] for entry in VOICE_CATALOG)
assert len(VOICE_CATALOG) == 30, f"expected 30 voices, found {len(VOICE_CATALOG)}"
assert len(VALID_VOICE_NAMES) == 30

# Age bucket -> characteristic keywords this bucket prefers (pitch/style words).
AGE_PREFERENCES: dict[str, set[str]] = {
    "child": {"youthful", "bright", "upbeat", "high", "mid-high", "excitable", "younger"},
    "teenager": {"youthful", "bright", "upbeat", "mid-high", "excitable", "younger"},
    "young_adult": {"mid", "mid-high", "upbeat", "clear", "friendly", "youthful"},
    "adult": {"mid", "mid-low", "even", "informative", "firm", "knowledgeable"},
    "elderly": {"low", "lower", "even", "mature", "knowledgeable", "gravelly"},
    "unknown": set(),
}

# Signal keyword -> characteristics that satisfy it. Signals are generic
# (style/delivery), never character-specific.
SIGNAL_KEYWORDS: dict[str, set[str]] = {
    "calm": {"informative", "smooth", "even", "warm", "gentle", "easy-going"},
    "anxious": {"soft", "breathy", "smooth", "clear"},
    "energetic": {"upbeat", "lively", "excitable", "bright"},
    "serious": {"firm", "informative", "even", "knowledgeable"},
    "mysterious": {"low", "lower", "smooth", "breathy"},
    "gentle": {"soft", "warm", "gentle", "smooth"},
    "confident": {"firm", "informative", "clear"},
    "wise": {"knowledgeable", "informative", "low", "lower", "even"},
    "haunting": {"low", "lower", "breathy", "smooth", "soft"},
    "eerie": {"low", "lower", "breathy", "smooth", "soft"},
}

# Profession -> delivery style words (NEVER affects gender compatibility).
PROFESSION_STYLES: dict[str, set[str]] = {
    "teacher": {"clear", "informative"},
    "doctor": {"clear", "informative", "smooth"},
    "farmer": {"easy-going", "warm", "casual"},
    "police": {"firm", "informative"},
    "student": {"youthful", "clear", "friendly"},
    "elder": {"knowledgeable", "informative", "low", "lower"},
}

# Weights (gender is a hard filter, applied before scoring).
WEIGHT_AGE = 20
WEIGHT_PERSONALITY = 30
WEIGHT_PROFESSION = 10
WEIGHT_VOICE_DESCRIPTION = 30
WEIGHT_COHERENCE = 10

_GENDER_ALIASES = {"male": "male", "m": "male", "man": "male", "boy": "male",
                   "female": "female", "f": "female", "woman": "female", "girl": "female",
                   "other": "other", "nonbinary": "other", "non-binary": "other", "ungendered": "other"}


def _normalize_gender(value) -> str:
    text = str(value or "").strip().lower()
    if text in _GENDER_ALIASES:
        return _GENDER_ALIASES[text]
    if text in {"unknown", ""}:
        return "unknown"
    return "unknown"


def _age_category(age) -> str:
    if isinstance(age, bool) or not isinstance(age, int):
        return "unknown"
    if age < 0 or age >= 130:
        return "unknown"
    if age < 13:
        return "child"
    if age < 20:
        return "teenager"
    if age < 30:
        return "young_adult"
    if age < 60:
        return "adult"
    return "elderly"


def _words(text) -> str:
    return str(text or "").strip().lower()


def _characteristics(entry: dict) -> set[str]:
    return {entry["style"].lower(), entry["pitch"].lower()}


def _signal_score(text: str, signals: dict[str, set[str]]) -> int:
    hits = 0
    for keyword, traits in signals.items():
        if re.search(rf"\b{re.escape(keyword)}\b", text):
            hits += len(traits)
    return hits


def _score(entry: dict, age_category: str, personality: str, profession: str, voice_description: str) -> int:
    traits = _characteristics(entry)
    age_pref = AGE_PREFERENCES.get(age_category, set())
    personality_hits = sum(len(SIGNAL_KEYWORDS[k] & traits) for k in SIGNAL_KEYWORDS if re.search(rf"\b{k}\b", personality))
    profession_traits = set()
    for key, styles in PROFESSION_STYLES.items():
        if re.search(rf"\b{key}\b", profession):
            profession_traits |= styles
    description_hits = sum(len(SIGNAL_KEYWORDS[k] & traits) for k in SIGNAL_KEYWORDS if re.search(rf"\b{k}\b", voice_description))
    coherence = len(age_pref & traits) + len(profession_traits & traits)
    return (WEIGHT_AGE * len(age_pref & traits)
            + WEIGHT_PERSONALITY * personality_hits
            + WEIGHT_PROFESSION * len(profession_traits & traits)
            + WEIGHT_VOICE_DESCRIPTION * description_hits
            + WEIGHT_COHERENCE * coherence)


def select_flow_voice(*, age=None, gender=None, profession=None, personality=None,
                      voice_description=None, used_voice_names=None) -> str:
    """Return one verified Flow voice name for the given character metadata.

    Deterministic: identical input always yields the identical voice. Gender is
    a hard compatibility filter (male/female); 'other' uses ungendered voices;
    'unknown' uses the full catalog with no gender preference.
    """
    normalized_gender = _normalize_gender(gender)
    used = {str(name) for name in (used_voice_names or set())}

    candidates = list(VOICE_CATALOG)  # fixed order = deterministic tie-break
    if normalized_gender == "male":
        candidates = [e for e in candidates if e["gender"] == "male"]
    elif normalized_gender == "female":
        candidates = [e for e in candidates if e["gender"] == "female"]
    elif normalized_gender == "other":
        candidates = [e for e in candidates if e["gender"] == UNGENDERED]
    # "unknown" -> full catalog, no gender preference

    age_category = _age_category(age)
    personality_text = _words(personality)
    profession_text = _words(profession)
    description_text = _words(voice_description)

    best = None  # (score-band, used_penalty, catalog_index, name)
    scored = []
    for index, entry in enumerate(candidates):
        score = _score(entry, age_category, personality_text, profession_text, description_text)
        scored.append((score, entry["name"], index, entry["name"] in used))
    top = max(s[0] for s in scored)
    # Preference band: an unused voice may displace a used voice ONLY within a
    # small margin of the top score, so uniqueness never forces a poor match.
    # When signals tie (margin 0, e.g. no metadata), uniqueness is still applied
    # because all candidates are genuinely equivalent.
    margin = 0.2 * top if top > 0 else 0
    pool = [s for s in scored if s[0] >= top - margin] or scored
    for score, name, index, is_used in pool:
        key = (1 if is_used else 0, -score, index)
        if best is None or key < best[0]:
            best = (key, name)
    return best[1]
