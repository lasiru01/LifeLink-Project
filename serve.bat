@echo off
cd /d "%~dp0"
title LifeLink
echo ============================================
echo   LifeLink
echo ============================================
echo.

set "PY="
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 (
  set "PY=py -3"
  goto :found
)
python -c "import sys" >nul 2>nul
if not errorlevel 1 (
  set "PY=python"
  goto :found
)
"%LOCALAPPDATA%\Programs\Python\Python313\python.exe" -c "import sys" >nul 2>nul
if not errorlevel 1 (
  set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  goto :found
)

echo [X] Python was not found on this computer.
echo.
echo     Install it from https://www.python.org/downloads/
echo     and tick "Add python.exe to PATH" on the first screen.
echo.
pause
exit /b 1

:found
echo Opening LifeLink at http://127.0.0.1:5500
echo.
echo   Leave this window open while you use the app.
echo   Press Ctrl+C to stop.
echo.
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:5500"
%PY% -m http.server 5500 --bind 127.0.0.1

echo.
echo Stopped.
pause
