@echo off
rem Bureau du Courrier — fabrique le certificat du bureau (Windows).
rem
rem À lancer SUR LE POSTE QUI GARDE LE REGISTRE, une seule fois, après
rem installer-plusieurs-postes.cmd.
rem
rem Pourquoi : tant que l'application est en http, le mot de passe circule en
rem clair sur le wifi du bureau, et les autres postes ne peuvent ni installer
rem l'application ni travailler hors ligne.
rem
rem Rien à installer : Windows sait fabriquer le certificat tout seul.
rem Ensuite, portez data\certificat.cer sur chacun des autres postes et
rem lancez-y confiance.cmd. Marche à suivre : docs\plusieurs-postes.md

chcp 65001 >nul
title Bureau du Courrier — certificat
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo   PowerShell est introuvable sur ce poste.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\certificat.ps1"
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
