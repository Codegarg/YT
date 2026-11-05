# Windows setup from a fresh clone

This document takes an empty machine to a checkout that can (a) run every offline check and
(b) create a new video project. It installs nothing on your behalf: every install step is an
explicit command you choose to run.

Nothing here requires the authoring machine. Generated media, the Chrome/Flow profile, project
directories and private credentials are deliberately **not** in Git (see
[What a clone does not contain](#10-what-a-clone-does-not-contain)).

Verified on: Windows 11, Node.js 24.20.0, Python 3.11.9, FFmpeg 9.0.2 (Gyan build).
Minimums below are the versions the code actually relies on.

---

## 1. Prerequisites

| Tool | Minimum | Why |
|---|---|---|
| Git | any current | clone, and `git check-ignore` diagnostics |
| Node.js | **20** | `node --import tsx`, `node --test`, ESM |
| Python | **3.10** | `groq`, `openai`, `jsonschema`, `python-dotenv` |
| FFmpeg + ffprobe | any recent build | clip validation, mixing, final render |

`ffmpeg` must include `libx264` and `aac` support (any standard full build does).

Check what you already have:

```powershell
git --version
node --version
python --version
ffmpeg -version
ffprobe -version
```

> PowerShell execution policy
> If `npm` or `.ps1` files refuse to run (`npm.ps1 cannot be loaded because running scripts is
> disabled`), use `npm.cmd` instead of `npm` for the rest of these instructions, or allow scripts
> for the current shell only:
> ```powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> ```
> This changes nothing permanently.

---

## 2. Clone

```powershell
git clone https://github.com/Codegarg/YT.git
cd YT
```

Pick a path without spaces or non-ASCII characters if you can; FFmpeg filter graphs are quoted,
but a plain ASCII path avoids a whole class of avoidable failures.

---

## 3. Node dependencies

```powershell
cd production
npm ci
```

`npm ci` (not `npm install`) is the supported path: `production/package-lock.json` is committed,
so the dependency tree is reproducible.

`npm ci` installs the Playwright **libraries** but not the browser binaries. That is intentional:
Flow runs through your installed Google Chrome (`FLOW_BROWSER_CHANNEL` defaults to `chrome`), and
downloading Chromium is neither required for the offline checks nor for a Chrome-channel run.

---

## 4. Python environment

The TypeScript workflow looks for the interpreter in this order: `scripting/.venv/Scripts/python.exe`,
then `scripting/.venv/bin/python`, then `python` on `PATH`. Using the repo venv keeps the pipeline
isolated from your global Python.

```powershell
cd ..\scripting
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Dependencies installed: `groq`, `openai`, `jsonschema`, `python-dotenv`.

You do **not** need to activate the venv for `npm run smoke` or `npm run video`; they resolve the
venv directly. Activation only matters for running the Python modules by hand from `scripting/`.

---

## 5. FFmpeg

Installing FFmpeg is a system change, so it is not automated. Two common options:

```powershell
# Option A - winget (recommended)
winget install --id Gyan.FFmpeg -e

# Option B - manual
# Download a "full" build from https://ffmpeg.org/download.html, extract it, and add its bin\
# directory to PATH (or point FFMPEG_PATH/FFPROBE_PATH at the executables).
```

Open a **new** terminal afterwards so `PATH` is refreshed, then verify:

```powershell
ffmpeg -version
ffprobe -version
```

If you prefer not to touch `PATH`, set both paths explicitly for the session (or in your user
environment):

```powershell
$env:FFMPEG_PATH  = "C:\tools\ffmpeg\bin\ffmpeg.exe"
$env:FFPROBE_PATH = "C:\tools\ffmpeg\bin\ffprobe.exe"
```

Production stages, media QA and the smoke test all honour these two variables. When they are not
set, the bare names `ffmpeg` / `ffprobe` are resolved from `PATH`.

---

## 6. Local configuration

### 6.1 Writing model (required for `video create`)

The story, SEO and metadata stages need exactly one of `OPENAI_API_KEY` or `GROQ_API_KEY`. If both
are present, OpenAI wins.

```powershell
cd ..\scripting
Copy-Item .env.example .env
notepad .env      # set OPENAI_API_KEY=... or GROQ_API_KEY=...
```

`scripting/.env` is ignored by Git and must stay that way.

> **How `.env` is loaded.** Two different mechanisms exist:
> - `scripting/.env` is read by the Python stages (`python-dotenv`) and by `start-video.ps1`,
>   which copies its values into the process environment before delegating to `npm run video`.
> - The TypeScript CLI (`npm run video`) does **not** parse `.env` itself. If you invoke it
>   directly, export the variables in the shell first:
>   ```powershell
>   $env:OPENAI_API_KEY = "sk-..."      # or GROQ_API_KEY
>   ```
>   Or run `.\start-video.ps1 -Title "..."` from the repository root, which handles it for you.

### 6.2 Optional integrations

All optional. Missing values produce a clear, named error only when the corresponding feature is
used — never at startup, and never for the offline checks.

| Feature | Variables | Needed for |
|---|---|---|
| Gemini TTS narration | `GEMINI_API_KEY`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` (+ optional `GEMINI_TTS_LANGUAGE`) | `npm run narration` |
| Music bed | `FREESOUND_CLIENT_ID`, `FREESOUND_CLIENT_SECRET`, `FREESOUND_REFRESH_TOKEN` | `npm run freesound` |
| YouTube publishing | `ZERNIO_API_KEY` | `npm run zernio`, `video publish-status` |
| Private media hosting | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | the publisher's upload step |
| Model overrides | `OPENAI_MODEL`, `GROQ_MODEL` | stage-level model choice |
| Retry budgets | `SCRIPT_RETRY_MAX_HOURS`, `SCRIPT_RETRY_BASE_SECONDS`, `SCRIPT_RETRY_MAX_SECONDS`, `FLOW_MAX_RETRY_HOURS`, `FLOW_RETRY_BASE_MS`, `FLOW_RETRY_MAX_MS` | rate-limit backoff |

### 6.3 Publish destination allowlist (local only)

`production/config/youtube-accounts.json` pins each project to one approved YouTube account. It is
**ignored by Git** because this repository is public. The committed
`production/config/youtube-accounts.example.json` shows the shape:

```powershell
cd ..\production
Copy-Item config\youtube-accounts.example.json config\youtube-accounts.json
# then replace your-project-id / YOUR_APPROVED_YOUTUBE_ACCOUNT_ID / "Your channel"
```

Only project IDs, account IDs and display names belong in that file — never API keys or tokens.
You do not need this file until you publish; the smoke test reports its absence as informational.

---

## 7. Runtime directories

The repository ships no project data. Two rules matter:

| Directory | Created by | Notes |
|---|---|---|
| `scripting/projects/` | `video create` | pipeline JSON + SEO history per project |
| `production/outputs/` | production stages | rendered scenes, final renders, `run.log.jsonl` |
| `production/inputs/` | **you** | human-supplied assets; tooling **never** creates it |

Create the human-input root once:

```powershell
cd ..\production
New-Item -ItemType Directory -Force inputs | Out-Null
```

Then, per project, create `production/inputs/<project-id>/` with the subdirectories the pipeline
lists (`backgrounds/`, `characters/`, `narration/`, `flow-clips/`, `music/`, `branding/`). Filenames
are contractually significant — see `production/docs/raat-ka-khauf-3am-kuan-inputs.md` for the
naming rules, accepted formats and size requirements, and run `npm run video -- status --project
<scripting\projects\<id>\pipeline.json>` to see exactly what is missing.

Nothing in this step requires (or fabricates) the original project's assets.

---

## 8. Verify the checkout: `npm run smoke`

From `production/`:

```powershell
npm run smoke
```

The smoke test is **offline and free**. It never opens Chrome, never calls Flow, never downloads
a model response, never uploads, never publishes, and never writes inside an existing project. Its
only writes are inside a temporary directory under `%TEMP%`, removed when it finishes.

It runs 14 checks:

| Check | What it proves |
|---|---|
| `node-version` | Node is >= 20 |
| `node-dependencies` | every `package.json` dependency exists in `node_modules` |
| `typecheck` | `tsc --noEmit` is clean |
| `python` | an interpreter resolves (repo venv first, then `PATH`) and is >= 3.10 |
| `python-imports` | `pipeline.one_minute`, `pipeline.seo`, `pipeline.project_check`, `pipeline.anthropic_client` import |
| `python-dependencies` | `groq`, `openai`, `jsonschema`, `dotenv` import |
| `project-schema` | `scripting/schema/*.json` are valid JSON Schema (checked with `jsonschema`) |
| `ffmpeg` | `ffmpeg` and `ffprobe` execute |
| `cli-help` | `video --help` exits 0 and lists every command |
| `cli-status` | `video status` on a missing project reports `NOT_FOUND` and creates nothing |
| `config` | the committed allowlist example validates; the local file is only reported by presence |
| `env-template` | `scripting/.env.example` documents the keys and holds no values |
| `runtime-dirs` | the documented layout can be created and written under a temp root |
| `credentials` | reports which provider keys are present (never their values); does not require them |

Useful variants:

```powershell
npm run smoke -- --json                      # machine-readable result
npm run smoke -- --only ffmpeg,python        # a subset of checks
```

Exit code is `0` when no check fails. A `FAIL` prints the fix hint next to it, e.g. missing
`node_modules` still reports every other check instead of stopping.

`npm run typecheck` and `npm test` remain the authoritative suite commands; the smoke test is the
fast "is this clone usable?" check and does not replace them.

---

## 9. Create your first project

From the repository root:

```powershell
.\start-video.ps1 -Title "आख़िरी बस की तीसरी सीट"
```

or the canonical command (run from `production/`, with the key exported in the shell):

```powershell
cd production
npm run video -- create --title "आख़िरी बस की तीसरी सीट"
```

`create` writes `scripting/projects/<project-id>/pipeline.json`, creates
`production/inputs/<project-id>/` and `production/outputs/<project-id>/`, and prints the next
commands. It does **not** call Flow, approve, or publish.

---

## 10. What a clone does not contain

These are ignored on purpose (credentials, cookies, private media, generated output). They are
never needed to pass the offline checks:

```text
scripting/.env                       scripting/.venv/            scripting/projects/
production/inputs/                   production/outputs/         production/reports/
production/chrome-profile*/          production/.playwright-browsers/
production/config/youtube-accounts.json
node_modules/                        **/__pycache__/
```

### Recovering the original completed project

This repository intentionally does not regenerate or fake the finished RAAT KA KHAUF project.
If you have the local backup (created before the migration, outside the repository), treat
restoring it as a **separate, manual operation**:

1. Copy `scripting/projects/<project-id>/` back under `scripting/projects/`.
2. Copy `production/inputs/<project-id>/` and `production/outputs/<project-id>/` back into place.
3. Verify the protected hashes you rely on (see the backup's `MANIFEST.sha256`) before touching
   approval or publishing state.
4. Delete nothing; restore over an empty target.

Do not copy backup files into the repository to make a test pass.

---

## 11. Environment variable reference

Everything the code reads, with its default. Only the first group is normally needed.

### Locations and tools

| Variable | Default | Read by |
|---|---|---|
| `FFMPEG_PATH` | `ffmpeg` on `PATH` | production stages, media QA, mixing |
| `FFPROBE_PATH` | `ffprobe` on `PATH` | clip validation, QA, production check |
| `PROJECTS_ROOT` | `<repo>/scripting/projects` | the TypeScript workflow |
| `PROJECTS_DIR` | `projects` (relative to `scripting/`) | Python entry points; wins over an absolute `PROJECTS_ROOT` |
| `INPUTS_ROOT` | `<cwd>/inputs` (`production/inputs`) | the TypeScript workflow |
| `OUTPUTS_ROOT` | `<cwd>/outputs` (`production/outputs`) | the TypeScript workflow, media prep |
| `PRODUCTION_INPUTS_DIR` | `<cwd>/inputs` | `npm run narration` |
| `CHROME_PATH` | first installed Chrome under Program Files / `%LOCALAPPDATA%` | `npm run login` |
| `PLAYWRIGHT_BROWSERS_PATH` | `production/.playwright-browsers` when present | Flow browser launch |
| `LOG_MAX_BYTES` | `5000000` | run-log rotation |
| `LOG_RETENTION` | `5` | rotated run-log copies kept |

`PROJECTS_ROOT` must be **absolute** if you set it, so the Python side resolves the same
directory; a relative value is ignored there to avoid creating `scripting/scripting/projects`.

### Flow

| Variable | Default | Read by |
|---|---|---|
| `FLOW_URL` | `https://flow.google.com` (`https://labs.google/flow` for `login`) | CLI, session, character provider |
| `FLOW_PROJECT_URL` | none | `npm run flow` project entry (direct URL instead of a card search) |
| `FLOW_USER_DATA_DIR` | `production/chrome-profile` | `video resume --flow-session` |
| `FLOW_BROWSER_CHANNEL` | `chrome` | Playwright launch channel; empty = bundled Chromium |
| `FLOW_DOWNLOAD_DIR` | `%USERPROFILE%\Downloads` | Flow clip downloads |
| `FLOW_LOGIN_TIMEOUT_MS` | `600000` (minimum 60000) | `npm run flow` sign-in wait |

### Providers, publishing and retries

See §6.2. `ZERNIO_API_KEY`, R2 and Freesound values are only read by their own commands, and are
reported by variable name when missing — never printed.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm.ps1 cannot be loaded because running scripts is disabled` | PowerShell execution policy | use `npm.cmd ...` or `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` |
| `node-dependencies  FAIL` in smoke | `npm ci` not run, or run in the wrong directory | `cd production; npm ci` |
| `python  FAIL` / `"python" could not run` | no venv and no Python on `PATH` | complete §4 |
| `python-dependencies FAIL` | requirements not installed | `scripting\.venv\Scripts\python.exe -m pip install -r requirements.txt` |
| `python-imports FAIL` with `ModuleNotFoundError: pipeline` | wrong working directory | run from `scripting/`, or use `npm run smoke` which sets it |
| `ffmpeg FAIL` / `ffprobe could not read the clip` | FFmpeg missing or not on `PATH` | §5, then set `FFMPEG_PATH`/`FFPROBE_PATH` |
| `UnicodeEncodeError: 'charmap' codec ...` when running Python tests | cp1252 console vs Devanagari output | `$env:PYTHONIOENCODING = "utf-8"; $env:PYTHONUTF8 = "1"` |
| `Google Chrome not found. Set CHROME_PATH ...` | Chrome installed elsewhere | `$env:CHROME_PATH = "C:\path\to\chrome.exe"` |
| `YouTube account allowlist is missing or unreadable` | publishing attempted without the local file | §6.3 |
| `project "..." already exists; refusing to regenerate` | `create` collision guard | pick another title or use `resume` |
| `No Flow project card matching "..." was found` | duplicate-project guard | set `FLOW_PROJECT_URL` to the existing project URL |
| `ENOENT ... scripting/projects/<id>/pipeline.json` in the TS suite | those tests are pinned to a finished project that a fresh clone does not contain | expected; see §10 — they are not offline-reproducible by design |

Known pre-existing test failures in this repository, unrelated to setup:

- `scripting/pipeline/prompt_hardening_test.py` pins an obsolete `pipeline.json` SHA.
- `production/tests/flow_prompt_hardening_test.mts` case `SA10` asserts that no `approval.json`
  exists, while the completed local project has one.

Neither is caused by a fresh clone, and neither should be "fixed" by weakening the assertion.
