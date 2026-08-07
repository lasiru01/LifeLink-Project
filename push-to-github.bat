@echo off
cd /d "%~dp0"
title LifeLink - Push to GitHub
echo ============================================
echo   Send LifeLink to GitHub
echo ============================================
echo.

git --version >nul 2>nul
if errorlevel 1 (
  echo [X] Git is not installed.
  echo.
  echo     Download it from https://git-scm.com/download/win
  echo     Install with all the default options, then close this
  echo     window and run this file again.
  echo.
  pause
  exit /b 1
)
echo Git is installed.
echo.
echo Before continuing, create an EMPTY repository on GitHub:
echo.
echo   1^) Go to https://github.com/new
echo   2^) Repository name:  lifelink
echo   3^) Choose Public or Private
echo   4^) Do NOT tick "Add a README file"
echo   5^) Click "Create repository"
echo   6^) Copy the address it shows, ending in .git
echo.
set /p REPOURL="Paste that address here and press Enter: "

if "%REPOURL%"=="" (
  echo.
  echo No address entered. Nothing was sent.
  pause
  exit /b 1
)

echo.
echo Connecting...
git remote remove origin >nul 2>nul
git remote add origin %REPOURL%
if errorlevel 1 (
  echo [X] That address was not accepted. Check you copied the whole thing.
  pause
  exit /b 1
)

echo Uploading...
echo ^(A sign-in window may appear - log in with your GitHub account.^)
echo.
git push -u origin main

if errorlevel 1 (
  echo.
  echo [X] The upload did not finish. Common reasons:
  echo     - The repository is not empty ^(you ticked "Add a README"^)
  echo     - You signed in with the wrong GitHub account
  echo     - The address was mistyped
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Done. Your code is now on GitHub.
echo   %REPOURL%
echo ============================================
echo.
echo To send later changes, run this file again
echo or use:  git add -A ^&^& git commit -m "update" ^&^& git push
echo.
pause
