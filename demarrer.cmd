@echo off
chcp 65001 >nul
title Bureau du Courrier
cd /d "%~dp0"

echo.
echo   Bureau du Courrier
echo   ------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js n'est pas installe sur ce poste.
  echo.
  echo   Telechargez la version LTS sur https://nodejs.org/fr
  echo   installez-la, puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\nodemailer" (
  if exist ".env" (
    echo   Installation du module d'envoi de courriel...
    call npm install --no-audit --no-fund
    echo.
  )
)

if not exist ".env" (
  echo   [!] Aucun fichier .env : l'envoi automatique sera inactif.
  echo       L'application fonctionnera, mais chaque message devra etre
  echo       envoye depuis votre logiciel de courriel.
  echo       Voir docs\installation-windows-gmail.md
  echo.
)

echo   Demarrage... le navigateur s'ouvrira tout seul.
echo   Laissez cette fenetre ouverte tant que vous utilisez l'application.
echo   Pour arreter : fermez la fenetre, ou Ctrl+C.
echo.

set OPEN_BROWSER=1
call npm start

echo.
echo   Le serveur s'est arrete.
pause
