"""Provider-neutral text client for the scripting half of the pipeline."""
import json
import os
import random
import re
import time
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

Provider = Literal["openai", "groq"]
DEFAULT_MODELS: dict[Provider, str] = {"openai": "gpt-4.1-mini", "groq": "openai/gpt-oss-120b"}


def _retry_max_seconds() -> float:
    """Total time budget for retrying a single provider call (default 6 hours)."""
    return max(0.0, float(os.getenv("SCRIPT_RETRY_MAX_HOURS", "6")) * 3600.0)


def _retry_base_seconds() -> float:
    return max(1.0, float(os.getenv("SCRIPT_RETRY_BASE_SECONDS", "5")))


def _retry_cap_seconds() -> float:
    return max(_retry_base_seconds(), float(os.getenv("SCRIPT_RETRY_MAX_SECONDS", "300")))


def _status_code(error: Exception) -> int | None:
    for candidate in (getattr(error, "status_code", None), getattr(getattr(error, "response", None), "status_code", None)):
        if isinstance(candidate, int):
            return candidate
    return None


def _retryable(error: Exception) -> bool:
    """Retry rate limits, upstream 5xx errors, and transient network failures."""
    status = _status_code(error)
    if status is not None:
        return status == 429 or 500 <= status < 600
    name = type(error).__name__
    return name in {"RateLimitError", "APIConnectionError", "APITimeoutError", "InternalServerError", "APIError"}


def _retry_after_seconds(error: Exception) -> float | None:
    headers = getattr(getattr(error, "response", None), "headers", None)
    if headers is not None:
        try:
            value = headers.get("retry-after") or headers.get("Retry-After")
        except Exception:
            value = None
        if value:
            try:
                return float(value)
            except ValueError:
                pass
    match = re.search(r"try again in\s+([\d.]+)\s*s", str(error), re.I)
    return float(match.group(1)) if match else None


def select_provider() -> Provider:
    """Prefer OpenAI when both supported keys are intentionally configured."""
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("GROQ_API_KEY"):
        return "groq"
    raise RuntimeError("No writing-model key found. Add OPENAI_API_KEY or GROQ_API_KEY to scripting/.env (or set it in your environment).")


class ScriptClient:
    """Text-completions adapter using the available local provider."""
    def __init__(self, provider: Provider | None = None, model: str | None = None):
        self.provider = provider or select_provider()
        self.model = model or os.getenv(f"{self.provider.upper()}_MODEL") or DEFAULT_MODELS[self.provider]
        if self.provider == "openai":
            from openai import OpenAI
            self.client = OpenAI()
        else:
            from groq import Groq
            self.client = Groq()

    def complete(self, prompt: str, max_tokens: int = 7000, temperature: float = 0) -> str:
        deadline = time.monotonic() + _retry_max_seconds()
        attempt = 0
        while True:
            try:
                response = self.client.chat.completions.create(
                    model=self.model, max_tokens=max_tokens, temperature=temperature,
                    messages=[{"role": "user", "content": prompt}],
                )
                content = response.choices[0].message.content or ""
                if not content.strip():
                    raise ValueError(f"{self.provider} returned an empty response")
                return content
            except ValueError:
                raise
            except Exception as error:
                if not _retryable(error) or time.monotonic() >= deadline:
                    raise
                suggested = _retry_after_seconds(error)
                backoff = min(_retry_base_seconds() * (2 ** attempt), _retry_cap_seconds())
                delay = max(suggested or 0.0, backoff) + random.uniform(0, 1)
                remaining = deadline - time.monotonic()
                if delay > remaining:
                    raise
                attempt += 1
                print(f"[retry] {self.provider} call failed ({type(error).__name__}); waiting {delay:.0f}s before attempt {attempt}", flush=True)
                time.sleep(delay)


# Compatibility names used by the existing stage CLI.
GroqClient = ScriptClient
Claude = ScriptClient

def parse_jsonish(raw: str):
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    try: return json.loads(text)
    except json.JSONDecodeError:
        start, end = min([i for i in [text.find("["), text.find("{")] if i >= 0], default=-1), max(text.rfind("]"), text.rfind("}"))
        if start >= 0 and end > start: return json.loads(text[start:end+1])
        raise ValueError("Groq output was not JSON; preserve raw output and inspect the template's required structure")
