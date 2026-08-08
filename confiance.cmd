@echo off
rem Bureau du Courrier — faire reconnaître le certificat du bureau.
rem
rem À lancer SUR LES AUTRES POSTES du bureau — pas sur celui qui garde le
rem registre. Une seule fois par ordinateur.
rem
rem Copiez ce fichier ET certificat.cer ensemble (par clé USB ou dossier
rem partagé), puis faites ici un CLIC DROIT > « Exécuter en tant
rem qu'administrateur ». Le magasin des autorités est commun à toute la
rem machine : sans ces droits, rien ne peut être ajouté.
rem
rem Après cela, l'adresse du bureau s'ouvre avec le cadenas, sans avertissement,
rem et l'application devient installable sur ce poste.
rem
rem Le script vous montrera l'empreinte du certificat et vous demandera de
rem confirmer avant d'ajouter quoi que ce soit.

chcp 65001 >nul
title Bureau du Courrier — certificat de confiance
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo   PowerShell est introuvable sur ce poste.
  echo.
  pause
  exit /b 1
)

if exist "%~dp0tools\confiance.ps1" (
  set SCRIPT=%~dp0tools\confiance.ps1
) else (
  set SCRIPT=%~dp0confiance.ps1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
exit /b %ERRORLEVEL%
