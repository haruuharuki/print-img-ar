@echo off
setlocal
cd /d "%~dp0"

set CREATOR_URL=http://127.0.0.1:8080/creator.html

where py >nul 2>nul
if %errorlevel%==0 (
  start "Print AR Creator Helper" cmd /k "cd /d ""%~dp0"" && py -3 tools\creator_helper.py"
) else (
  start "Print AR Creator Helper" cmd /k "cd /d ""%~dp0"" && python tools\creator_helper.py"
)

timeout /t 2 /nobreak >nul
start "" "%CREATOR_URL%"
