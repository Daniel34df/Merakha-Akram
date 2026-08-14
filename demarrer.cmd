@echo off
rem Bureau du Courrier — démarrage quotidien.
rem
rem Si vous n'avez encore rien installé, double-cliquez plutôt sur
rem installer.cmd : il télécharge Node.js, écrit la configuration et lance tout.
rem Ce fichier-ci se contente de démarrer le serveur.

chcp 65001 >nul
title Bureau du Courrier
cd /d "%~dp0"

echo.
echo   Bureau du Courrier
echo   ------------------
echo.

rem Node.js installé par installer.cmd dans .\runtime, sinon celui du poste.
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

where %NODE% >nul 2>nul
if errorlevel 1 (
  if not exist "%~dp0runtime\node.exe" (
    echo   Node.js n'est pas installe sur ce poste.
    echo.
    echo   Double-cliquez sur installer.cmd : il s'occupe de tout,
    echo   sans droits administrateur.
    echo.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo   [!] Aucun fichier .env : l'envoi automatique sera inactif.
  echo       Lancez installer.cmd pour ecrire la configuration.
  echo.
)

echo   Demarrage... le navigateur s'ouvrira tout seul.
echo   Laissez cette fenetre ouverte tant que vous utilisez l'application.
echo   Pour arreter : fermez la fenetre, ou Ctrl+C.
echo.

set OPEN_BROWSER=1
"%NODE%" server\index.js

echo.
echo   Le serveur s'est arrete.
pause
