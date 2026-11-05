"""Offline tests for the shared scripting path convention (`pipeline.paths`).

Covers the documented `PROJECTS_DIR` / `PROJECTS_ROOT` rules that keep the Python entry
points and the TypeScript workflow looking at the same project directory. No network, no
model, no Flow, no writes: every filesystem touch is a pure path computation.
"""
import importlib
import os
import pathlib
import sys
import tempfile

SCRIPTING = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTING))
from pipeline import one_minute, seo  # noqa: E402
from pipeline.paths import resolve_projects_root  # noqa: E402

passed = 0

try:  # keep the console safe on cp1252 Windows shells
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


class env:
    """Temporarily set/clear the two documented variables."""

    KEYS = ("PROJECTS_DIR", "PROJECTS_ROOT")

    def __init__(self, **values):
        self.values = values
        self.saved = {}

    def __enter__(self):
        for key in self.KEYS:
            self.saved[key] = os.environ.pop(key, None)
        for key, value in self.values.items():
            if value is not None:
                os.environ[key] = value
        return self

    def __exit__(self, *exc):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return False


# ---------------------------------------------------------------------------
# 1. Default is the historical cwd-relative `projects` (== scripting/projects)
# ---------------------------------------------------------------------------
with env():
    check("default root is the cwd-relative 'projects'", resolve_projects_root() == pathlib.Path("projects"))
    check("default root is not absolute", not resolve_projects_root().is_absolute())

# ---------------------------------------------------------------------------
# 2. PROJECTS_DIR is the explicit Python override and wins
# ---------------------------------------------------------------------------
with env(PROJECTS_DIR="custom-projects"):
    check("PROJECTS_DIR relative value is honoured", resolve_projects_root() == pathlib.Path("custom-projects"))

with env(PROJECTS_DIR="dir-wins", PROJECTS_ROOT="C:/shared/root"):
    check("PROJECTS_DIR wins over PROJECTS_ROOT", resolve_projects_root() == pathlib.Path("dir-wins"))

# ---------------------------------------------------------------------------
# 3. PROJECTS_ROOT is the shared override, but only when absolute
# ---------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as tmp:
    absolute = pathlib.Path(tmp).resolve()
    with env(PROJECTS_ROOT=str(absolute)):
        check("absolute PROJECTS_ROOT is honoured", resolve_projects_root() == absolute)

with env(PROJECTS_ROOT="relative/root"):
    check("relative PROJECTS_ROOT is ignored (no silent nesting)", resolve_projects_root() == pathlib.Path("projects"))

# ---------------------------------------------------------------------------
# 4. Both entry points consume the same helper
# ---------------------------------------------------------------------------
with env():
    check("one_minute uses the shared default", one_minute.PROJECTS_ROOT == pathlib.Path("projects"))

with tempfile.TemporaryDirectory() as tmp:
    absolute = pathlib.Path(tmp).resolve()
    with env(PROJECTS_DIR=str(absolute)):
        reloaded = importlib.reload(one_minute)
        check("one_minute re-reads PROJECTS_DIR at import", reloaded.PROJECTS_ROOT == absolute)
    with env(PROJECTS_ROOT=str(absolute)):
        reloaded = importlib.reload(one_minute)
        check("one_minute honours an absolute PROJECTS_ROOT", reloaded.PROJECTS_ROOT == absolute)
    with env():
        reloaded = importlib.reload(one_minute)
        check("one_minute restores the default", reloaded.PROJECTS_ROOT == pathlib.Path("projects"))
    check("reload did not create the projects directory", not pathlib.Path("custom-projects").exists())

# ---------------------------------------------------------------------------
# 5. SEO --project-id resolution follows the same root
# ---------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as tmp:
    absolute = pathlib.Path(tmp).resolve()
    with env(PROJECTS_ROOT=str(absolute)):
        resolved = seo.resolve_project_file(None, "demo-project")
        check("seo --project-id resolves under PROJECTS_ROOT", resolved == (absolute / "demo-project" / "pipeline.json").resolve(), resolved)
        check("seo resolution is absolute", resolved.is_absolute())

with env(PROJECTS_DIR="custom-projects"):
    resolved = seo.resolve_project_file(None, "demo-project")
    check("seo --project-id honoured via PROJECTS_DIR", resolved == (pathlib.Path("custom-projects") / "demo-project" / "pipeline.json").resolve(), resolved)

# An explicit --project always wins over both environment variables.
with env(PROJECTS_ROOT="C:/ignored/root"):
    explicit = seo.resolve_project_file("some/dir/pipeline.json", "demo-project")
    check("explicit --project wins over the env root", explicit == (pathlib.Path.cwd() / "some/dir/pipeline.json").resolve(), explicit)

# Missing both arguments is still a hard input error (no guessing).
try:
    seo.resolve_project_file(None, None)
    check("seo rejects a missing --project/--project-id", False)
except seo.SeoInputError:
    check("seo rejects a missing --project/--project-id", True)

print(f"\nPATH CONVENTION TESTS PASSED ({passed} checks)")
