"""Shared filesystem conventions for the scripting half.

The TypeScript workflow (`production/src/video.ts`) locates projects with `PROJECTS_ROOT`
and defaults it to `<repo>/scripting/projects` (absolute). The Python entry points run with
`scripting/` as their working directory, so their historical default is the cwd-relative
`projects` — the same directory, expressed differently.

`PROJECTS_DIR` remains the explicit Python override (unchanged). `PROJECTS_ROOT` is honoured
as a second, shared override ONLY when it is an absolute path, because a relative value is
resolved against `production/` by the TypeScript side and would silently point somewhere
else here. This keeps one documented setting working for both halves without changing the
historical default for existing checkouts.
"""
from __future__ import annotations

import os
from pathlib import Path


def resolve_projects_root() -> Path:
    """Directory that holds `<project-id>/pipeline.json` (default: `scripting/projects`)."""
    explicit = os.environ.get("PROJECTS_DIR")
    if explicit:
        return Path(explicit)
    shared = os.environ.get("PROJECTS_ROOT")
    if shared and Path(shared).is_absolute():
        return Path(shared)
    return Path("projects")
