@echo off
cd /d "%~dp0"
title LifeLink - Publish Online
echo ============================================
echo   Publish LifeLink to the internet
echo ============================================
echo.

REM ---- Node.js is needed for the Firebase tool ----
call npm --version >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed.
  echo.
  echo     1^) Download it from https://nodejs.org  ^(pick the LTS button^)
  echo     2^) Install it, then CLOSE this window and run deploy.bat again
  echo.
  pause
  exit /b 1
)
echo [1/4] Node.js found.

REM ---- Firebase command line tool ----
call firebase --version >nul 2>nul
if errorlevel 1 (
  echo [2/4] Installing the Firebase tool ^(first time only, takes a minute^)...
  call npm install -g firebase-tools
  call firebase --version >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [X] Could not install firebase-tools.
    echo     Try opening PowerShell as Administrator and running:
    echo         npm install -g firebase-tools
    echo.
    pause
    exit /b 1
  )
) else (
  echo [2/4] Firebase tool already installed.
)

REM ---- Sign in ----
echo.
echo [3/4] Signing in to Firebase. A browser window will open -
echo       choose the SAME Google account you used for the project.
echo.
call firebase login

REM ---- Deploy ----
echo.
echo [4/4] Uploading your site...
echo.
call firebase deploy --only hosting --project lifelink-0002

echo.
echo ============================================
echo   Done. Your link is the "Hosting URL" above,
echo   normally:  https://lifelink-0002.web.app
echo ============================================
echo.
pause
