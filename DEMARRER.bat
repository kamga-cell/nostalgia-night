@echo off
cd /d "%~dp0"
set PATH=%PATH%;C:\Program Files\nodejs
echo.
echo  ========================================
echo   NOSTALGIA NIGHT - Demarrage serveur
echo  ========================================
echo.
node server.js
pause
