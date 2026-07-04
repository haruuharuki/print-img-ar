@echo off
setlocal
cd /d "%~dp0"

set CREATOR_URL=http://127.0.0.1:8080/creator.html
start "" "%CREATOR_URL%"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 tools\creator_helper.py
) else (
  python tools\creator_helper.py
)
