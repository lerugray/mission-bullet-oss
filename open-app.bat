@echo off
REM Double-click to launch the mission-bullet desktop app.
REM Runs `bun run ui` from the repo root so the Excalidraw sketch
REM bundle rebuilds if needed, then boots electron.
REM
REM Closing this cmd window also closes the app.

cd /d "%~dp0"
bun run ui
