# AsureFlow (AI Assistant)

Real-time transcription + AI notes in a lightweight local web app (FastAPI + WebSockets).

## Features (high level)
- Live transcription (Whisper / faster-whisper)
- Optional audio capture (mic / system audio; platform-dependent)
- Speaker diarization (identify speakers)
- AI-assisted notes (actions/decisions/etc.)
- Local web UI (served from the FastAPI app)

## Quick start (Windows)
1. Install Python 3.11+.
2. Run `run.bat`.

## Run in VS Code
1. Open the folder in VS Code.
2. Run and Debug:
   - `AI Assistant (no Audio)` (recommended), or
   - `AI Assistant (with Audio)`
3. Press `F5`.

The debug config runs `AI Assistant: Setup venv` first (creates `.venv` and installs `requirements.txt`).

## Run manually
```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe main.py
```

## Configuration
Common env vars:
- `AI_ASSISTANT_ENABLE_AUDIO` = `0` / `1`
- `AI_ASSISTANT_PORT` = port number (default `8000`)
- `AI_ASSISTANT_USE_WEBVIEW` = `0` / `1` (embed UI in a WebView window)
- `AI_ASSISTANT_CONFIG_PATH` = path to a config file (optional)

## Repo layout
- `main.py`: FastAPI app + UI server + orchestration
- `backend/`: audio, transcription, diarization, LLM helpers
- `index.html`, `js/`, `css/`: UI assets
- `.vscode/`: debug/tasks setup

## Notes
- First startup can take a while because models may download/cache.
- Audio capture is disabled by default; enable it only if you need it.
