@echo off
rem Bureau du Courrier — installation pour un bureau à plusieurs ordinateurs.
rem
rem Double-cliquez sur ce fichier SUR LE POSTE QUI GARDERA LE REGISTRE — celui
rem du responsable. Les autres ordinateurs du bureau n'ont rien à installer :
rem ils ouvriront simplement une adresse dans leur navigateur, et l'application
rem vous dira laquelle une fois l'installation terminée.
rem
rem La différence avec installer.cmd tient en deux points :
rem   · le serveur accepte les connexions des autres postes du réseau ;
rem   · le pare-feu de Windows est ouvert sur le port de l'application.
rem
rem Ce second point demande des droits administrateur. Sans eux, l'installation
rem se fait quand même et la commande à lancer vous est affichée : sans elle,
rem les autres postes n'obtiennent qu'une page qui ne charge jamais, sans le
rem moindre message d'erreur.
rem
rem Marche à suivre complète : docs\plusieurs-postes.md

chcp 65001 >nul
title Bureau du Courrier — installation (plusieurs postes)
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

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\installer.ps1" -PlusieursPostes
set CODE=%ERRORLEVEL%

if not "%CODE%"=="0" (
  echo.
  echo   L'installation s'est interrompue.
  pause
)
exit /b %CODE%
