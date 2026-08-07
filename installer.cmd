@echo off
rem Bureau du Courrier — installation en un clic (Windows).
rem
rem Double-cliquez sur ce fichier. Il n'y a rien d'autre à faire : Node.js est
rem téléchargé si besoin, la configuration est écrite, le serveur démarre et le
rem navigateur s'ouvre. Aucun droit administrateur n'est nécessaire.
rem
rem Ce fichier ne fait que lancer tools\installer.ps1, qui contient le travail.
rem PowerShell refuse par défaut d'exécuter un script : -ExecutionPolicy Bypass
rem lève ce refus pour cette exécution seulement, sans rien changer au poste.

chcp 65001 >nul
title Bureau du Courrier — installation
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo   PowerShell est introuvable sur ce poste.
  echo   Installez Node.js depuis https://nodejs.org/fr puis lancez demarrer.cmd
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\installer.ps1"
set CODE=%ERRORLEVEL%

if not "%CODE%"=="0" (
  echo.
  echo   L'installation s'est interrompue.
  pause
)
exit /b %CODE%
