"""Channel-level SEO profile and deterministic keyword taxonomy for RAAT KA KHAUF.

WHY THIS FILE EXISTS
The SEO engine must never invent search demand. Nothing here contains, estimates, or
simulates search volume, keyword difficulty, ranking position, or traffic. Every keyword
carries a *qualitative* relevance score computed from nothing but:

  · whether the term actually occurs in the generated story (story relevance),
  · what kind of query the term looks like (search intent),
  · how naturally it reads (natural language fit),
  · whether it matches a Hindi-first, India-first audience (audience fit).

That score is a heuristic ranking device, not a demand measurement, and every emitted
keyword records ``priority_basis`` accordingly.

This module is pure data + pure functions: no I/O, no network, no LLM, no environment
access. It is safe to import from tests.
"""
from __future__ import annotations

import re
import unicodedata

ENGINE_VERSION = "1.1.0"

CHANNEL_PROFILE = {
    "channel_name": "RAAT KA KHAUF",
    "channel_name_devanagari": "रात का ख़ौफ़",
    "format": "2D semi-realistic animated Hindi folk-horror storytelling, 16:9, ~5 minutes",
    "language_policy": {
        "primary": "Hindi (Devanagari)",
        "supporting": ["Romanized Hindi (Hinglish)", "English"],
        "title_policy": "Hindi-first: the recommended title must contain Devanagari.",
    },
    "niche": [
        "Hindi horror storytelling",
        "Supernatural mysteries",
        "Ghost stories",
        "Haunted locations",
        "Cremation ground horror",
        "Suspense and paranormal stories",
    ],
    "audience": {
        "primary": "Hindi-speaking viewers in India",
        "secondary": "Hindi-speaking viewers worldwide",
        "tertiary": "General horror-storytelling audience",
        "age_note": "general horror audience; no age metric is measured or claimed",
    },
    "regional_focus": "India-first",
    # Factuality policy. The SEO engine reads this instead of hard-coding "fiction" so a future
    # channel can opt into documentary/true-story content without changing the validator.
    "content_policy": "fiction",
    "content_maturity": "fiction, entertainment, no real people or real places",
    "factuality_note": "every story is an original fictional folk-horror tale, not a real incident",
    "fiction_disclosure_hi": "यह एक काल्पनिक कहानी है, केवल मनोरंजन के लिए।",
    # No upload cadence is confirmed, so the description must never promise one. Set this to a
    # human-readable cadence (e.g. "one new story every Friday") to allow schedule claims.
    "upload_schedule": None,
}

# ---------------------------------------------------------------------------------------
# Keyword taxonomy
#
# `intent` is a label, not a metric:
#   search    — phrasing people plausibly type into YouTube search
#   discovery — phrasing used by browse/suggested recommendations
#   brand     — channel identity terms
#   story     — derived from this specific story (see build_keyword_plan)
# ---------------------------------------------------------------------------------------

BRANDED_KEYWORDS = [
    ("raat ka khauf", "brand"),
    ("raat ka khauf horror", "brand"),
    ("raat ka khauf stories", "brand"),
    ("रात का ख़ौफ़", "brand"),
    ("raat ka khauf hindi horror", "brand"),
]

PRIMARY_KEYWORDS = [
    ("hindi horror story", "search"),
    ("hindi horror kahani", "search"),
    ("भूत की कहानी", "search"),
    ("डरावनी कहानी", "search"),
    ("hindi animated horror story", "search"),
    ("भूतिया कहानी", "search"),
    ("hindi horror stories animated", "search"),
    ("darr ki kahani", "search"),
]

# Broad genre / discovery terms. These are allowed for ANY story on this channel: they describe
# the genre, not a specific setting, creature or event, so they can never invent story detail.
SECONDARY_KEYWORDS = [
    ("shamshan ki kahani", "discovery"),
    ("cremation ground horror story", "discovery"),
    ("supernatural story hindi", "discovery"),
    ("ghost story hindi", "discovery"),
    ("bhootiya kahani", "discovery"),
    ("रात की डरावनी कहानी", "discovery"),
    ("अमावस की रात", "discovery"),
    ("भूतिया श्मशान", "discovery"),
    ("haunted village story hindi", "discovery"),
    ("supernatural horror story hindi", "discovery"),
    ("hindi lok katha horror", "discovery"),
    ("hindi folk horror story", "discovery"),
]

# Specific-topic terms. Each carries the story words it depends on. They are only promoted into
# the keyword plan when those words actually occur in THIS story, so a haveli/chudail/pret term
# can never be attached to a story that has no haveli, chudail or pret. Every rejected term is
# reported with its missing marker so the diagnostics explain the decision.
TOPIC_KEYWORDS = [
    ("chudail ki kahani", "discovery", ["chudail", "चुड़ैल", "चुडैल", "चुड़ैलें"]),
    ("pret aatma ki kahani", "discovery", ["pret", "प्रेत", "pretaatma", "प्रेतात्मा"]),
    ("purani haveli horror story", "discovery", ["haveli", "हवेली", "हवेलियों"]),
    ("haunted haveli story", "discovery", ["haveli", "हवेली"]),
    ("daayan ki kahani", "discovery", ["daayan", "डायन", "डायनों"]),
    ("jinn ki kahani", "discovery", ["jinn", "जिन्न", "जिन्नात"]),
    ("pishach ki kahani", "discovery", ["pishach", "पिशाच"]),
    ("school horror story hindi", "discovery", ["school", "स्कूल"]),
    ("hostel horror story hindi", "discovery", ["hostel", "होस्टल"]),
    ("jungle horror story hindi", "discovery", ["jungle", "जंगल"]),
    ("mandir horror story hindi", "discovery", ["mandir", "मंदिर"]),
    ("train horror story hindi", "discovery", ["train", "ट्रेन", "रेल"]),
]

# Search-shaped suffixes used to build long-tail phrases from GROUNDED story anchors only.
# A suffix may never claim the story is true, so "भूत की सच्ची कहानी" is deliberately absent.
LONG_TAIL_SUFFIXES_HI = ["डरावनी हिंदी कहानी", "हिंदी हॉरर स्टोरी", "भूतिया हिंदी कहानी"]
LONG_TAIL_SUFFIXES_EN = ["hindi horror story", "hindi horror kahani", "bhoot ki kahani"]

# Hashtags that are legitimate for this channel regardless of the story.
BRANDED_HASHTAGS = {
    "#raatkakhauf",
    "#raatkakhaufhorror",
}

# Nichest-level hashtags that are always on-topic for this channel.
CHANNEL_HASHTAGS = {
    "#hindihorrorstory",
    "#horrorstory",
    "#bhootkikahani",
    "#hindihorrorstories",
    "#animatedhorrorstory",
    "#scarystories",
    "#डरावनीकहानी",
    "#भूतकीकहानी",
}

# Words that are common enough that their presence in a title is not evidence of an
# invented story claim. Hindi function words, narrative filler, and SEO vocabulary.
HINDI_STOPWORDS = {
    "एक", "और", "का", "की", "के", "को", "में", "से", "पर", "है", "हैं", "था", "थी", "थे",
    "वो", "वह", "वही", "ये", "यह", "जो", "जिस", "जब", "तब", "कि", "नहीं", "ना", "क्या",
    "कौन", "कैसे", "क्यों", "कहाँ", "कहां", "कब", "अब", "फिर", "भी", "तो", "ही", "सिर्फ",
    "रात", "रातों", "दिन", "बजे", "समय", "आधी", "पूरी", "सारी", "नई", "नया", "पुरानी",
    "पुराना", "बड़ी", "बड़ा", "छोटी", "छोटा", "सबसे", "बहुत", "कुछ", "कोई", "सब", "लोग",
    "कहानी", "कहानियाँ", "कहानियां", "कथा", "लोककथा", "लोक", "डरावनी", "डरावना", "डर",
    "खौफ", "ख़ौफ़", "भयानक", "सनसनी", "रोमांच", "रहस्य", "रहस्यमयी", "रहस्यमय", "असली",
    "सच्ची", "सच्चा", "हिंदी", "हॉरर", "स्टोरी", "वीडियो", "चैनल", "भूत", "भूतिया",
    "भूतों", "प्रेत", "प्रेतात्मा", "आत्मा", "आत्माएँ", "साया", "छाया", "आवाज़", "आवाज",
    "आवाजें", "श्राप", "शाप", "कहते", "कहा", "सुना", "सुनो", "देखा", "देखिए", "सुनिए",
    "जानिए", "हुआ", "हुई", "हुए", "गया", "गई", "गए", "कर", "करने", "किया", "लिए", "साथ",
    "बाद", "पहले", "अंदर", "बाहर", "ऊपर", "नीचे", "पास", "दूर", "यहाँ", "यहां", "वहाँ",
    "वहां", "सब्सक्राइब", "शेयर", "कमेंट", "बताइए", "बताएं", "जुड़िए", "जुड़ें",
    "दोस्तों", "दोस्त", "कमेंट्स", "अनुभव", "अनुभवों", "सवाल", "जवाब", "मिलता", "मिलती",
    "करें", "करना", "करता", "करती", "होता", "होती", "रहा", "रही", "रहे", "सकता", "सकती",
    "वाला", "वाली", "वाले", "जैसे", "वैसे", "इस", "उस", "इन", "उन", "यही", "वहीं", "भीतर",
    "वाला", "बिना", "साथ", "अपनी", "अपना", "अपने", "मेरा", "मेरी", "तेरा", "तेरी", "उसकी",
    "उसका", "उसके", "इसकी", "इसका", "इसके", "जादू", "टोना", "मंत्र", "पूजा", "मंदिर",
    "श्मशान", "कब्र", "कब्रें", "कब्रिस्तान", "मुर्दा", "मुर्दों", "अंत्येष्टि", "चिता",
    "गाँव", "गांव", "कस्बा", "शहर", "घर", "कमरा", "आँगन", "दरवाज़ा", "दरवाजा", "खिड़की",
    "अंधेरा", "अंधेरे", "रोशनी", "ठंड", "ठंडी", "हवा", "बारिश", "धुंध", "आग", "धुआँ",
    "अंत", "अंतिम", "शुरुआत", "अध्याय", "भाग", "हिस्सा", "कड़ी", "सीरीज़", "सीरीज",
    "सच", "झूठ", "सच में", "हकीकत", "वाकई", "दिखा", "दिखी", "सुनाई", "महसूस", "एहसास",
    "पल", "रातों", "हर", "कभी", "कभी-कभी", "फिर", "फिर से", "अचानक", "धीरे", "तेज़",
    "तेज", "बंद", "खुला", "खुली", "गायब", "लौट", "लौटा", "लौटी", "मिला", "मिली",
}

ENGLISH_STOPWORDS = {
    "the", "a", "an", "in", "of", "to", "and", "or", "for", "with", "on", "at", "is",
    "are", "was", "were", "be", "by", "from", "as", "that", "this", "these", "those",
    "it", "its", "her", "his", "him", "she", "he", "they", "them", "their", "you",
    "your", "we", "our", "i", "my", "me", "not", "no", "do", "does", "did", "what",
    "who", "why", "how", "when", "where", "story", "stories", "horror", "hindi",
    "kahani", "video", "channel", "subscribe", "new", "best", "full", "watch", "night",
    "dark", "ghost", "ghosts", "spirit", "spirits", "haunted", "animated", "animation",
    "real", "true", "short", "shorts", "shortfilm", "episode", "part", "series", "facts",
    "scary", "creepy", "mystery", "supernatural", "paranormal", "storytime", "viral",
    "audio", "hd", "4k", "official",
}

_DEVANAGARI_DIGITS = "०१२३४५६७८९"
_ASCII_DIGITS = "0123456789"

# ---------------------------------------------------------------------------------------
# Natural-language vocabulary for prose fields
#
# Description / pinned-comment / thumbnail prose legitimately uses ordinary Hindi storytelling
# language that is NOT a story fact: genre adjectives ("डरावनी"), narration verbs ("जानिए",
# "देखिए"), CTA words ("सब्सक्राइब", "कमेंट") and the fiction disclosure. Those words must never
# be reported as "invented story facts", while a genuinely new name, place, number or event must
# still fail. Keeping this list separate from the story corpus is what makes that distinction
# possible; it is NOT a way to switch grounding off.
# ---------------------------------------------------------------------------------------
NARRATIVE_VOCABULARY = (
    # genre adjectives / atmosphere
    "डरावनी", "डरावना", "डरावने", "भूतिया", "भयानक", "खौफनाक", "ख़ौफ़नाक", "रहस्यमयी", "रहस्यमय",
    "सनसनीखेज", "सनसनी", "रोमांचक", "रोमांचित", "रोमांच", "दिलचस्प", "हैरान", "चौंकाने", "डर",
    "खौफ", "ख़ौफ़", "अनोखी", "अनोखा", "अजीब", "अजीबोगरीब", "रोमांचकारी", "भावुक", "दिलचस्पी",
    # storytelling nouns / verbs
    "कहानी", "कहानियाँ", "कहानियां", "कथा", "किस्सा", "किस्से", "दास्तान", "सफर", "सफ़र", "यात्रा",
    "जानिए", "जानें", "देखिए", "देखें", "सुनिए", "सुनें", "मिलिए", "जुड़िए", "जुड़ें", "चलिए",
    "शुरुआत", "अंत", "अंतिम", "मोड़", "राज़", "रहस्य", "सच", "सच्चाई", "सवाल", "जवाब", "कहानीकार",
    "सुनाएंगे", "सुनाते", "दिखाएंगे", "दिखाते", "बताएंगे", "बताते", "लेकर", "आएंगे", "आते", "मिलेंगे",
    "गुज़ारिश", "प्रार्थना", "उम्मीद", "हिम्मत", "डरावनेपन", "माहौल", "एहसास", "अनुभव", "अनुभवों",
    "किरदार", "पात्र", "कहानीपन", "दृश्य", "मंज़र", "मंजर", "सफ़रनामा", "अध्याय", "हिस्सा", "भाग",
    # channel / CTA / engagement
    "चैनल", "वीडियो", "सब्सक्राइब", "सब्सक्राइबर", "लाइक", "शेयर", "कमेंट", "कमेंट्स", "बताइए",
    "बताएं", "लिखिए", "लिखें", "जरूर", "ज़रूर", "दोस्तों", "दोस्त", "दर्शकों", "दर्शक", "स्वागत",
    "हमारे", "हमारा", "हमारी", "आपका", "आपकी", "आपके", "आपको", "आपसे", "हमसे", "हमें", "नई", "नया",
    "नए", "हर", "हफ्ते", "हफ़्ते", "सप्ताह", "रोज़", "रोज", "प्रशंसक", "परिवार", "समुदाय",
    # fiction disclosure
    "काल्पनिक", "कल्पना", "मनोरंजन", "प्रेरित", "लोककथा", "लोककथाओं", "आधारित", "केवल", "सिर्फ",
    "सिर्फ़", "तक", "कृपया", "धन्यवाद",
    # general Hindi prose glue that is not a fact
    "दुनिया", "जगह", "जगहों", "लोगों", "लोग", "बात", "बातें", "तरह", "तरीके", "वजह", "कारण",
    "असर", "अनुभूति", "भावना", "भावनाएं", "दिल", "मन", "आँखों", "आंखों", "सामने", "पीछे", "आसपास",
    "भीतर", "बाहर", "ऊपर", "नीचे", "दूर", "पास", "साथ", "बिना", "दौरान", "बाद", "पहले", "अब",
    "आज", "कल", "हमेशा", "कभी", "कभी-कभी", "फिर", "अचानक", "धीरे", "तेज़", "तेज", "शायद",
    # ordinary CTA / viewer-language observed in real generations (never a story fact)
    "अगर", "आपने", "गुज़रे", "गुजरे", "किया", "करें", "पसंद", "पाएगा", "फैसला", "लगता", "राय",
    "सबसे", "सामना", "छुपे", "छुपा", "आइकन", "बेल", "दबाएं", "दबाएँ", "रोमांच", "बताएं",
    # ordinary narration verbs / pronouns seen in editor-reviewed prose (never a story fact)
    "सुनाई", "जिसकी", "मौजूदगी", "सुराग", "करीब", "मिलती", "बुलाए", "करेंगे", "खामोशी",
)

# ---------------------------------------------------------------------------------------
# Factuality / fiction policy
#
# The channel profile says the content is fiction. A fiction package must never claim the story
# is true, real, actual, verified or a real incident, and it must carry one disclosure line.
# The markers below are *claim-shaped* on purpose: "सच" alone is legitimate ("सच जानने का
# निश्चय" is the story itself), while "सच्ची कहानी" is a factuality claim.
# ---------------------------------------------------------------------------------------
FICTION_CLAIM_PATTERNS = (
    r"सच्च(?:ी|ा|े)\s+(?:भूत\s+की\s+)?(?:कहानी|घटना|वाकया|किस्सा)",
    r"भूत\s+की\s+सच्ची\s+कहानी",
    r"(?:असली|वास्तविक|सत्य|प्रामाणिक)\s+(?:कहानी|घटना|वाकया|किस्सा|वीडियो)",
    r"(?:हकीकत|हक़ीक़त)\s+(?:में|पर\s+आधारित|की\s+कहानी|कहानी)",
    r"सच\s+पर\s+आधारित",
    r"वास्तविक\s+घटना",
    r"\bbased\s+on\s+(?:a\s+)?true\b",
    r"\btrue\s+(?:story|stories|incident|events?|haunting|horror|crime)\b",
    r"\breal\s+(?:story|stories|incident|events?|life|haunting|paranormal|ghost|crime)\b",
    r"\bactually\s+happened\b",
    r"\bverified\s+(?:story|incident|haunting|case)\b",
    r"\bdocumentary\b",
)
_FICTION_CLAIM_RE = re.compile("|".join(FICTION_CLAIM_PATTERNS), re.I)

# Single words that make a tag/hashtag a factuality claim when the content is fiction.
FICTION_CLAIM_WORDS = (
    "सच्ची", "सच्चा", "सच्चे", "असली", "वास्तविक", "हकीकत", "हक़ीक़त", "सत्य", "प्रामाणिक",
    "true", "real", "actual", "actually", "verified", "authentic", "documentary", "truestory",
    "reallife", "realstory", "based",
)

NONFICTION_MARKERS = (
    "non-fiction", "nonfiction", "documentary", "true events", "real events", "based on true",
    "वृत्तचित्र", "तथ्यात्मक", "सच्ची घटना",
)
FICTION_MARKERS = (
    "fiction", "fictional", "काल्पनिक", "entertainment", "मनोरंजन", "no real people",
    "not a real", "original story",
)

# ---------------------------------------------------------------------------------------
# Upload-schedule claims
#
# The channel profile confirms no cadence, so "हर हफ्ते नई कहानी" is an unsupported promise.
# A future profile can set `upload_schedule` and the same rule will then allow the claim.
# ---------------------------------------------------------------------------------------
SCHEDULE_CLAIM_PATTERNS = (
    r"हर\s+(?:हफ्ते|हफ़्ते|सप्ताह|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|दिन|रोज़|रोज|महीने)",
    r"(?:साप्ताहिक|रोज़ाना|रोजाना|दैनिक|मासिक)\s+(?:नई|नया|एक|कहानी|वीडियो|एपिसोड)",
    r"\bevery\s+(?:week|day|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
    r"\b(?:weekly|daily|monthly)\s+(?:new\s+)?(?:story|stories|video|episode|upload)",
    r"\bnew\s+(?:story|video|episode)\s+every\b",
)
_SCHEDULE_CLAIM_RE = re.compile("|".join(SCHEDULE_CLAIM_PATTERNS), re.I)

_NUKTA = "\u093c"
_ZW = "\u200c\u200d\ufeff"


def fold_text(text: str) -> str:
    """Comparison form for policy matching: keeps matras, folds nukta/ZWJ and lowercases.

    ``normalize_key`` strips matras, which is right for grounding but destroys the difference
    between "सच" and "सच्ची". Policy matching therefore uses this lighter fold.
    """
    value = unicodedata.normalize("NFC", str(text or ""))
    for char in _ZW:
        value = value.replace(char, "")
    value = value.replace(_NUKTA, "")
    value = value.translate(str.maketrans(_DEVANAGARI_DIGITS, _ASCII_DIGITS))
    return unicodedata.normalize("NFC", value).lower()


_FOLDED_CLAIM_WORDS = tuple(fold_text(word) for word in FICTION_CLAIM_WORDS)


def fiction_claims(text: str) -> list[str]:
    """Return the factuality claims found in ``text`` (empty list when it is clean).

    Claim-shaped phrases ("सच्ची कहानी", "based on a true story") and claim words
    ("सच्ची", "real", "verified") are both detected, so titles, tags, hashtags, prose and
    thumbnail text can share one rule.
    """
    folded = fold_text(text)
    found: list[str] = []
    for match in _FICTION_CLAIM_RE.finditer(folded):
        snippet = match.group(0).strip()
        if snippet and snippet not in found:
            found.append(snippet)
    for word in _FOLDED_CLAIM_WORDS:
        if re.search(rf"(?<![\w\u0900-\u097F]){re.escape(word)}(?![\w\u0900-\u097F])", folded):
            if word not in found:
                found.append(word)
    return found


def is_fiction_claim(text: str) -> bool:
    return bool(fiction_claims(text))


def schedule_claims(text: str) -> list[str]:
    """Return upload-cadence promises found in ``text``."""
    folded = fold_text(text)
    found: list[str] = []
    for match in _SCHEDULE_CLAIM_RE.finditer(folded):
        snippet = match.group(0).strip()
        if snippet and snippet not in found:
            found.append(snippet)
    return found


def _mode_from_text(text: str) -> str | None:
    folded = fold_text(text)
    # "non-fiction" contains "fiction", so the nonfiction markers are checked first.
    if any(marker in folded for marker in NONFICTION_MARKERS):
        return "nonfiction"
    if any(marker in folded for marker in FICTION_MARKERS):
        return "fiction"
    return None


def content_policy(profile: dict | None = None, story_metadata=None) -> dict:
    """Detect the factuality policy from the channel profile and the story metadata.

    ``story_metadata`` may be a string, a mapping or a list of strings. An explicit statement in
    the story metadata wins over the channel default, so a future documentary project can opt
    out of the fiction rules without editing this module.
    """
    profile = profile if isinstance(profile, dict) else CHANNEL_PROFILE
    evidence: list[str] = []
    if isinstance(story_metadata, str):
        evidence.append(story_metadata)
    elif isinstance(story_metadata, dict):
        for value in story_metadata.values():
            if isinstance(value, str):
                evidence.append(value)
            elif isinstance(value, (list, tuple)):
                evidence.extend(str(item) for item in value if isinstance(item, str))
    elif isinstance(story_metadata, (list, tuple, set)):
        evidence.extend(str(item) for item in story_metadata if isinstance(item, str))

    for value in evidence:
        mode = _mode_from_text(value)
        if mode:
            return _policy_record(mode, "story_metadata", evidence, profile)
    for key in ("content_policy", "factuality", "content_maturity", "factuality_note"):
        value = profile.get(key)
        if isinstance(value, str):
            mode = _mode_from_text(value)
            if mode:
                return _policy_record(mode, f"channel_profile.{key}", evidence, profile)
    mode = "fiction" if not any(_mode_from_text(value) == "nonfiction" for value in evidence) else "nonfiction"
    return _policy_record(mode, "default", evidence, profile)


def _policy_record(mode: str, source: str, evidence: list[str], profile: dict) -> dict:
    fiction = mode != "nonfiction"
    return {
        "mode": mode,
        "fiction": fiction,
        "reject_truth_claims": fiction,
        "source": source,
        "disclosure_hi": profile.get("fiction_disclosure_hi") if fiction else None,
        "channel_statement": profile.get("factuality_note") or profile.get("content_maturity"),
        "story_metadata_evidence": list(dict.fromkeys(evidence))[:4],
    }


def upload_schedule(profile: dict | None = None) -> dict:
    """The channel's explicitly confirmed upload cadence, if any."""
    profile = profile if isinstance(profile, dict) else CHANNEL_PROFILE
    value = profile.get("upload_schedule") or profile.get("publishing_cadence")
    if isinstance(value, str) and value.strip():
        return {"confirmed": True, "description": value.strip(), "source": "channel_profile.upload_schedule"}
    return {"confirmed": False, "description": None, "source": "channel_profile.upload_schedule"}


def narrative_vocabulary() -> set[str]:
    """Normalized ordinary-language words allowed in prose but never treated as facts."""
    return {normalize_key(word) for word in NARRATIVE_VOCABULARY if normalize_key(word)}


# ---------------------------------------------------------------------------------------
# Topic relevance: broad genre vs specific story topic
# ---------------------------------------------------------------------------------------
def topic_markers(term: str) -> list[str]:
    """The specific-topic words a taxonomy term depends on ([] for a broad genre term)."""
    folded = fold_text(term)
    markers: list[str] = []
    for _term, _intent, term_markers in TOPIC_KEYWORDS:
        if fold_text(_term) != folded:
            continue
        markers = list(term_markers)
        break
    if not markers:
        # Fall back to the catalogue so a caller-supplied term is still classified.
        for _term, _intent, term_markers in TOPIC_KEYWORDS:
            for marker in term_markers:
                if fold_text(marker) in folded.split() or f" {fold_text(marker)} " in f" {folded} ":
                    markers.append(marker)
            if markers:
                break
    return list(dict.fromkeys(markers))


def topic_support(term: str, corpus: str) -> tuple[bool, list[str]]:
    """Return (supported, missing_markers) for a specific-topic term against one story corpus."""
    markers = topic_markers(term)
    if not markers:
        return True, []
    folded = fold_text(corpus)
    missing = [marker for marker in markers if fold_text(marker) not in folded]
    return not missing, missing


def rejected_topic_reason(term: str, missing: list[str]) -> str:
    return (
        "specific story topic absent from this story: "
        + ", ".join(missing[:3])
        + " (the story never mentions it)"
    )


# Marker used in the generated package so a reader can never mistake the heuristic for
# measured demand.
PRIORITY_BASIS = (
    "qualitative relevance estimate derived from story grounding, intent, language fit and "
    "audience fit; NO search volume, keyword difficulty, ranking position or traffic data "
    "was measured, estimated or invented"
)

_DEVANAGARI_RUN = re.compile(r"[\u0900-\u0963\u0966-\u097F]+")
_ASCII_RUN = re.compile(r"[A-Za-z][A-Za-z'-]*")
_COMBINING = re.compile(r"[\u0300-\u036f\u0900-\u0903\u093a-\u094f\u0951-\u0957\u0962\u0963]")


def normalize_key(text: str) -> str:
    """Unicode-safe comparison key.

    NUKTA/ZWJ/matra differences and Devanagari digits must not decide whether a word is
    "grounded" in the story, so the key strips zero-width joiners, maps Devanagari digits
    to ASCII and removes combining marks. The original text is never modified.
    """
    value = unicodedata.normalize("NFC", str(text or ""))
    value = value.replace("\u200c", "").replace("\u200d", "").replace("\ufeff", "")
    value = value.translate(str.maketrans(_DEVANAGARI_DIGITS, _ASCII_DIGITS))
    value = _COMBINING.sub("", value)
    value = unicodedata.normalize("NFC", value)
    return value.lower()


def keywords_for_grounding() -> set[str]:
    """Every BROAD taxonomy term, in normalized form, plus brand vocabulary.

    Specific-topic terms (`TOPIC_KEYWORDS`) are deliberately excluded: a haveli/chudail/pret
    word is only grounded when the story itself contains it (see `topic_support`), never because
    it appears in the reusable catalogue.
    """
    terms: set[str] = set()
    for term, _intent in BRANDED_KEYWORDS + PRIMARY_KEYWORDS + SECONDARY_KEYWORDS:
        terms.add(normalize_key(term))
    for suffix in LONG_TAIL_SUFFIXES_HI + LONG_TAIL_SUFFIXES_EN:
        terms.add(normalize_key(suffix))
    for tag in BRANDED_HASHTAGS | CHANNEL_HASHTAGS:
        terms.add(normalize_key(tag.lstrip("#")))
    return {term for term in terms if term}


def words_for_grounding() -> set[str]:
    """Individual normalized words from every taxonomy term (multi-word terms included)."""
    words: set[str] = set()
    for term in keywords_for_grounding():
        for word in re.split(r"[\s|,/-]+", term):
            if len(word) >= 2:
                words.add(word)
    return words


def tokenize(text: str) -> list[tuple[str, str]]:
    """Split text into (original_token, normalized_token) pairs. Unicode-safe."""
    tokens: list[tuple[str, str]] = []
    for match in _DEVANAGARI_RUN.finditer(str(text or "")):
        tokens.append((match.group(0), normalize_key(match.group(0))))
    for match in _ASCII_RUN.finditer(str(text or "")):
        tokens.append((match.group(0), normalize_key(match.group(0))))
    return tokens


def _score(term: str, intent: str, corpus_key: str, title_key: str) -> dict:
    """Deterministic 0..100 heuristic. NOT a demand or difficulty metric."""
    key = normalize_key(term)
    words = [w for w in re.split(r"\s+", key) if w]
    if key and key in corpus_key:
        relevance = 40
    elif key and key in title_key:
        relevance = 32
    elif any(w and w in corpus_key for w in words):
        relevance = 24
    else:
        relevance = 10

    intent_score = {"search": 25, "discovery": 19, "brand": 14, "story": 22}.get(intent, 10)

    count = len(words) if words else 1
    fit = 20 if 2 <= count <= 4 else (14 if count == 1 else 8)

    has_devanagari = bool(_DEVANAGARI_RUN.search(term or ""))
    audience = 15 if has_devanagari else (12 if count and not re.search(r"[^a-z0-9\s'-]", key) else 9)

    total = relevance + intent_score + fit + audience
    band = "high" if total >= 72 else ("medium" if total >= 52 else "low")
    return {
        "heuristic_score": total,
        "priority": band,
        "priority_basis": PRIORITY_BASIS,
        "ranking_inputs": {
            "story_relevance": relevance,
            "search_intent": intent_score,
            "natural_language_fit": fit,
            "audience_fit": audience,
        },
    }


def _keyword_record(term: str, keyword_class: str, intent: str, corpus_key: str, title_key: str,
                    source: str, *, topic: str = "broad_genre",
                    story_support: list[str] | None = None) -> dict:
    record = {
        "term": term,
        "class": keyword_class,
        "intent": intent,
        "source": source,
        "topic": topic,
    }
    if story_support:
        record["story_support"] = list(story_support)
    record.update(_score(term, intent, corpus_key, title_key))
    return record


def build_keyword_plan(facts: dict, policy: dict | None = None) -> dict:
    """Build the deterministic keyword plan for one story.

    ``facts`` comes from ``seo.extract_story_facts``. Only grounded story anchors are used
    for story-specific and long-tail keywords, so the plan cannot invent a topic. Two reusable
    gates run here and every rejection is reported with its reason:

      · fiction gate — a term that claims the story is true/real is never promoted when the
        content policy is fictional;
      · topic gate — a specific setting/creature/location term is promoted only when the story
        actually contains it. Broad genre terms are always kept.
    """
    corpus_key = normalize_key(facts.get("corpus", ""))
    title_key = normalize_key(facts.get("title", "") + " " + facts.get("hook", ""))
    corpus_text = facts.get("corpus", "")
    policy = policy or facts.get("content_policy") or content_policy()
    reject_claims = bool(policy.get("reject_truth_claims", policy.get("fiction", True)))

    rejected: list[dict] = []

    def reject(term: str, keyword_class: str, reason: str) -> None:
        rejected.append({"term": term, "class": keyword_class, "reason": reason})

    def claim_gate(term: str, keyword_class: str) -> bool:
        if not reject_claims:
            return True
        claims = fiction_claims(term)
        if claims:
            reject(term, keyword_class,
                   "claims the story is true/real (" + ", ".join(claims[:3])
                   + "), but the content policy is fiction")
            return False
        return True

    def broad(term: str, keyword_class: str, intent: str) -> dict | None:
        if not claim_gate(term, keyword_class):
            return None
        return _keyword_record(term, keyword_class, intent, corpus_key, title_key, "channel_profile")

    branded = [record for record in
               (broad(term, "branded", intent) for term, intent in BRANDED_KEYWORDS) if record]
    primary = [record for record in
               (broad(term, "primary", intent) for term, intent in PRIMARY_KEYWORDS) if record]
    secondary = [record for record in
                 (broad(term, "secondary", intent) for term, intent in SECONDARY_KEYWORDS) if record]

    # Specific-topic catalogue: only promoted when the story supports every marker word.
    for term, intent, markers in TOPIC_KEYWORDS:
        if not claim_gate(term, "secondary"):
            continue
        supported, missing = topic_support(term, corpus_text)
        if not supported:
            reject(term, "secondary", rejected_topic_reason(term, missing))
            continue
        supported_markers = [marker for marker in markers if marker not in missing]
        secondary.append(_keyword_record(
            term, "secondary", intent, corpus_key, title_key, "channel_profile",
            topic="story_topic", story_support=supported_markers,
        ))

    anchors = [anchor for anchor in facts.get("story_anchors", []) if anchor]
    story_specific: list[dict] = []
    seen = {normalize_key(r["term"]) for r in branded + primary + secondary}
    for anchor in anchors:
        key = normalize_key(anchor)
        if not key or key in seen:
            continue
        if not claim_gate(anchor, "story_specific"):
            continue
        seen.add(key)
        story_specific.append(_keyword_record(anchor, "story_specific", "story", corpus_key, title_key,
                                              "story", topic="story_topic"))

    long_tail: list[dict] = []
    for anchor in anchors:
        # Only multi-word, reasonably short anchors produce readable long-tail phrases.
        if " " not in anchor or len(anchor) > 32:
            continue
        hi = bool(_DEVANAGARI_RUN.search(anchor))
        for suffix in (LONG_TAIL_SUFFIXES_HI[:2] if hi else LONG_TAIL_SUFFIXES_EN[:2]):
            term = f"{anchor} {suffix}"
            key = normalize_key(term)
            if key in seen:
                continue
            if not claim_gate(term, "long_tail"):
                continue
            seen.add(key)
            long_tail.append(_keyword_record(term, "long_tail", "search", corpus_key, title_key,
                                             "story", topic="story_topic"))
        if len(long_tail) >= 10:
            break

    for group in (branded, primary, secondary, story_specific, long_tail):
        group.sort(key=lambda item: (-item["heuristic_score"], item["term"]))

    return {
        "branded": branded,
        "primary": primary,
        "secondary": secondary,
        "story_specific": story_specific,
        "long_tail": long_tail[:10],
        "ranking_basis": PRIORITY_BASIS,
        "content_policy": policy,
        "rejected": rejected,
    }


def is_grounded(text: str, corpus_key: str, vocabulary: set[str] | None = None) -> bool:
    """True when every meaningful token occurs in the story corpus or the channel vocabulary.

    Grounding uses substring containment on the normalized corpus so that ordinary Hindi
    inflection/compound variation ("श्मशान" vs "श्मशानों") still counts, while a genuinely
    new name or place does not.
    """
    vocab = vocabulary if vocabulary is not None else keywords_for_grounding()
    for original, key in tokenize(text):
        if not key or len(key) < 3:
            continue
        if key in HINDI_STOPWORDS or key in ENGLISH_STOPWORDS or key in vocab:
            continue
        if key in corpus_key:
            continue
        return False
    return True


def unknown_tokens(text: str, corpus_key: str, vocabulary: set[str] | None = None) -> list[str]:
    """Original-form tokens that appear nowhere in the story or channel vocabulary."""
    vocab = vocabulary if vocabulary is not None else keywords_for_grounding()
    unknown: list[str] = []
    for original, key in tokenize(text):
        if not key or len(key) < 3:
            continue
        if key in HINDI_STOPWORDS or key in ENGLISH_STOPWORDS or key in vocab:
            continue
        if key in corpus_key:
            continue
        if original not in unknown:
            unknown.append(original)
    return unknown


# ---------------------------------------------------------------------------------------
# Hashtag relevance
#
# A YouTube hashtag cannot contain spaces, so a multi-word hashtag is *always* written as one
# token: "#अमावस_की_रात", "#राधा_देवी_की_आत्मा", "#raatkakhauf". Comparing the raw token to
# the story and the taxonomy therefore rejects every legitimate multi-word story tag (the
# comparison key keeps the underscores, which the corpus never contains).
#
# Relevance is consequently decided on two levels:
#   1. the whole tag, collapsed to a space/underscore/hyphen-free key, against the branded,
#      channel and taxonomy vocabulary and against the collapsed story corpus, and
#   2. if that misses, word by word: every word must be a known word (story, taxonomy, or a
#      stopword) and at least one word must be topical (present in the story or the taxonomy).
# A trending/unrelated tag fails both levels, so the strictness is unchanged.
# ---------------------------------------------------------------------------------------
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_HASHTAG_SEPARATORS = re.compile(r"[_\-\s\u2010\u2011\u2012\u2013\u2014\u2015]+")

# Grammatical particles carry no topic, so they can never make a hashtag relevant alone.
# Stored in normalized form because that is what the comparison key produces.
HASHTAG_CONNECTORS = {
    normalize_key(word)
    for word in (
        "का", "की", "के", "को", "में", "से", "पर", "और", "है", "हैं", "था", "थी", "थे",
        "वो", "वह", "ये", "यह", "जो", "कि", "भी", "तो", "ही", "अब", "फिर", "एक",
        "of", "in", "and", "or", "the", "a", "an", "to", "for", "with", "on", "at",
    )
}


def hashtag_words(tag: str) -> list[str]:
    """Split a hashtag into its original-form words.

    Handles underscores, hyphens, spaces and camelCase ("#raatKaKhauf" -> raat, Ka, Khauf),
    which is how the story tokens are compared. Returns [] for an empty tag.
    """
    raw = unicodedata.normalize("NFC", str(tag or "")).lstrip("#")
    raw = _CAMEL_BOUNDARY.sub(" ", raw)
    raw = _HASHTAG_SEPARATORS.sub(" ", raw)
    return [word for word in raw.split(" ") if word]


def hashtag_key(tag: str) -> str:
    """Space/underscore/hyphen-insensitive comparison key for a hashtag."""
    return normalize_key(" ".join(hashtag_words(tag))).replace(" ", "")


_COLLAPSED_BRANDED_HASHTAGS = {hashtag_key(tag) for tag in BRANDED_HASHTAGS}
_COLLAPSED_CHANNEL_HASHTAGS = {hashtag_key(tag) for tag in CHANNEL_HASHTAGS}
_COLLAPSED_TAXONOMY = {
    key.replace(" ", "") for key in keywords_for_grounding() if key
}
_GROUNDING_WORDS = words_for_grounding()


def hashtag_is_relevant(tag: str, corpus_key: str, policy: dict | None = None) -> bool:
    """True when a hashtag is branded/channel, grounded in the story, or fully on-topic.

    Unrelated trending tags ("#viralvideo", "#trending") still return False. When the content
    policy is fictional, a tag that claims the story is true ("#सच्ची_कहानी", "#truestory")
    returns False as well, even if every word is otherwise grounded.
    """
    policy = policy or {}
    if policy.get("reject_truth_claims", policy.get("fiction", False)) and is_fiction_claim(
            str(tag).replace("_", " ")):
        return False
    words = hashtag_words(tag)
    key = hashtag_key(tag)
    if not key:
        return False
    if key in _COLLAPSED_BRANDED_HASHTAGS or key in _COLLAPSED_CHANNEL_HASHTAGS:
        return True
    if key in _COLLAPSED_TAXONOMY:
        return True
    if key in str(corpus_key or "").replace(" ", ""):
        return True
    if not words:
        return False

    topical = False
    for word in words:
        word_key = normalize_key(word)
        if not word_key:
            continue
        in_corpus = word_key in corpus_key
        known = (
            in_corpus
            or word_key in HINDI_STOPWORDS
            or word_key in ENGLISH_STOPWORDS
            or word_key in _GROUNDING_WORDS
        )
        if not known:
            return False
        # Topical means "comes from this story". A word that is only part of the generic
        # genre vocabulary ("#the_story", "#shorts") is not evidence of story relevance, so it
        # cannot make the hashtag relevant on its own.
        if word_key not in HASHTAG_CONNECTORS and in_corpus:
            topical = True
    return topical
