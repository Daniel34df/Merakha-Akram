<#
  Bureau du Courrier — installation complète, sans intervention (Windows).

  Lancé par installer.cmd. Dans l'ordre :
    1. cherche un Node.js utilisable sur le poste ;
    2. s'il n'y en a pas, télécharge la version LTS depuis nodejs.org, vérifie
       son empreinte SHA-256 et la range dans .\runtime — rien n'est installé
       sur le système, rien ne touche au PATH, tout se supprime en effaçant le
       dossier de l'application ;
    3. écrit un .env avec une clé de chiffrement tirée au sort ;
    4. installe nodemailer si le réseau le permet (facultatif) ;
    5. pose un raccourci sur le Bureau ;
    6. démarre le serveur et ouvre le navigateur.

  Aucun droit administrateur n'est requis. Relancer est sans danger : ce qui est
  déjà en place est conservé.
#>

param(
  # Le bureau tient l'accueil sur plusieurs ordinateurs reliés au même wifi ou
  # au même câble. Le registre reste sur celui-ci ; les autres l'ouvrent dans
  # leur navigateur. Sans cette option, le serveur n'écoute que sur ce poste —
  # plus prudent, et c'est ce qu'il faut à un bureau seul.
  [switch]$PlusieursPostes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # sinon la barre de progression ralentit le téléchargement

$Racine = Split-Path -Parent $PSScriptRoot
Set-Location $Racine
$Runtime = Join-Path $Racine 'runtime'
$NodeMinMajeur = 20
$NodeRepli = 'v22.14.0'   # utilisé seulement si nodejs.org ne répond pas

function Titre($t) { Write-Host ''; Write-Host "  $t" -ForegroundColor White }
function Info($t) { Write-Host "  $t" }
function Souci($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
# Le code de reprise ne s'affiche qu'ici, une fois : seule son empreinte est
# conservee, personne ne peut le retrouver ensuite.
function AnnoncerCodeMaitre($code) {
  $groupe = ($code -replace '(.{4})', '$1 ').Trim()
  Write-Host ''
  Write-Host '  Code de reprise du compte responsable' -ForegroundColor White
  Write-Host '  ------------------------'
  Write-Host ''
  Write-Host "      $groupe" -ForegroundColor White
  Write-Host ''
  Info 'Notez-le sur papier et rangez-le : il ne se retrouve pas.'
  Info 'Il sert si le responsable perd son mot de passe. Il n''ouvre pas le registre.'
}

function Fatal($t) { Write-Host ''; Write-Host "  X $t" -ForegroundColor Red; Write-Host ''; exit 1 }

Titre 'Bureau du Courrier — installation'

# ── 1. un Node.js utilisable ? ────────────────────────────────────────────────

function VersionMajeure($exe) {
  try {
    $v = & $exe -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>$null
    return [int]$v
  } catch { return 0 }
}

$Node = $null
$candidats = @((Join-Path $Runtime 'node.exe'))
$surLePoste = Get-Command node -ErrorAction SilentlyContinue
if ($surLePoste) { $candidats += $surLePoste.Source }

foreach ($c in $candidats) {
  if ($c -and (Test-Path $c) -and (VersionMajeure $c) -ge $NodeMinMajeur) { $Node = $c; break }
}

if ($Node) {
  Info "Node.js $(& $Node -v) trouvé — $Node"
} else {
  Info 'Aucun Node.js récent sur ce poste : téléchargement de la version LTS.'

  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { $arch = 'x64' }
    'ARM64' { $arch = 'arm64' }
    'x86'   { $arch = 'x86' }
    default { Fatal "Processeur non reconnu : $($env:PROCESSOR_ARCHITECTURE)" }
  }

  # La version LTS courante, demandée à nodejs.org ; sinon une version connue.
  $Version = $null
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 20
    $Version = ($index | Where-Object { $_.lts -is [string] -and $_.lts } | Select-Object -First 1).version
  } catch { }
  if (-not $Version) {
    Souci "nodejs.org ne répond pas — on prend la version connue $NodeRepli."
    $Version = $NodeRepli
  }

  $archive = "node-$Version-win-$arch.zip"
  $base = "https://nodejs.org/dist/$Version"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("bdc-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null

  try {
    Info "Téléchargement de $archive… (une centaine de mégaoctets)"
    Invoke-WebRequest -Uri "$base/$archive" -OutFile (Join-Path $tmp $archive) -TimeoutSec 900

    # Vérifier l'empreinte : on s'apprête à exécuter ce qu'on vient de télécharger.
    Info "Vérification de l'empreinte SHA-256…"
    $verifiee = $false
    try {
      $sommes = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -TimeoutSec 60).Content
      $ligne = ($sommes -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($archive))\s*$" } | Select-Object -First 1)
      if ($ligne) {
        $attendue = ($ligne -split '\s+')[0]
        $obtenue = (Get-FileHash -Path (Join-Path $tmp $archive) -Algorithm SHA256).Hash
        if ($attendue.ToLower() -ne $obtenue.ToLower()) {
          Fatal "Empreinte incorrecte — le fichier téléchargé n'est pas celui publié par nodejs.org."
        }
        $verifiee = $true
      }
    } catch { }
    if ($verifiee) { Info 'Empreinte conforme.' }
    else { Souci 'Empreintes indisponibles : installation poursuivie sans vérification.' }

    Info 'Décompression…'
    if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
    Expand-Archive -Path (Join-Path $tmp $archive) -DestinationPath $tmp -Force
    # L'archive contient un dossier « node-vXX-win-arch » : on le remonte d'un cran.
    $extrait = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'node-*' } | Select-Object -First 1
    if (-not $extrait) { Fatal "Archive inattendue : le dossier Node.js est introuvable." }
    Move-Item -Path $extrait.FullName -Destination $Runtime

    $Node = Join-Path $Runtime 'node.exe'
    if (-not (Test-Path $Node)) { Fatal "Node.js n'est pas là où il devrait être après décompression." }
    Info "Node.js $(& $Node -v) installé dans .\runtime (rien sur le système)."
  } catch {
    Fatal "Téléchargement impossible ($($_.Exception.Message)). Vérifiez la connexion, puis relancez."
  } finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

$DossierNode = Split-Path -Parent $Node
$Npm = Join-Path $DossierNode 'npm.cmd'
if (-not (Test-Path $Npm)) {
  $n = Get-Command npm -ErrorAction SilentlyContinue
  $Npm = if ($n) { $n.Source } else { $null }
}

# ── 2. configuration ──────────────────────────────────────────────────────────

$EnvFichier = Join-Path $Racine '.env'
$Hote = if ($PlusieursPostes) { '0.0.0.0' } else { '127.0.0.1' }

if (Test-Path $EnvFichier) {
  Info 'Configuration .env déjà présente — conservée.'
  # On ne réécrit pas la configuration de quelqu'un. Mais si l'accès aux autres
  # postes est demandé et que le fichier dit le contraire, il faut le dire.
  if ($PlusieursPostes -and ((Get-Content $EnvFichier) -match '^HOST=(127\.|localhost|::1)')) {
    Souci 'Votre .env garde HOST=127.0.0.1 : le serveur n''écoutera que sur ce poste.'
    Souci 'Remplacez cette ligne par HOST=0.0.0.0 pour ouvrir l''accès aux autres.'
  }
} else {
  Info 'Écriture de la configuration…'
  $secret = & $Node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'
  # Un code de reprise propre a ce bureau : celui du depot est public.
  $codeMaitre = & $Node (Join-Path $Racine 'tools\code-maitre.js') '--brut'
  $contenu = @"
# Écrit par installer.cmd — modifiable à tout moment.
# Chaque réglage est expliqué dans .env.example.
PORT=3000
# Qui peut joindre ce serveur.
#   127.0.0.1  ce seul ordinateur (par défaut, le plus prudent)
#   0.0.0.0    tous les postes du bureau sur le même wifi ou le même câble
# Relancez installer-plusieurs-postes.cmd pour ouvrir l'accès, ou changez cette
# ligne à la main. Voir docs\plusieurs-postes.md
HOST=$Hote
DB_FILE=./data/db.json

# Clé de chiffrement des secrets enregistrés. Tirée au sort à l'installation.
# À sauvegarder avec le registre ; sans elle, les boîtes reliées sont à refaire.
APP_SECRET=$secret

# Code de reprise du compte responsable, tire au sort a l'installation.
# Il permet de changer l'adresse ou le mot de passe du responsable, ou de
# supprimer son compte pour reinstaller. Il ne donne pas acces au registre.
# Seule son empreinte est conservee : s'il est perdu, il ne se retrouve pas.
MASTER_CODE=$codeMaitre

# Aucun serveur de courriel pour l'instant : les messages s'ouvrent dans le
# logiciel de courriel de l'employé·e. Voir docs\installation-windows-gmail.md
# pour activer l'envoi automatique.
MAIL_DRY_RUN=false

REMINDER_DAYS=15
ESCALATION_DAYS=15
DIGEST_DAY=1
DIGEST_HOUR=8
"@
  # UTF-8 sans BOM : Node lit le .env tel quel, un BOM parasiterait la première clé.
  [System.IO.File]::WriteAllText($EnvFichier, $contenu, (New-Object System.Text.UTF8Encoding($false)))
  Info 'Clé de chiffrement créée.'
  AnnoncerCodeMaitre $codeMaitre
}

# Un bureau installe avant que l'installateur ne tire ce code garde celui du
# depot, qui est public. On ajoute la ligne sans toucher au reste : le serveur
# la reprend au demarrage suivant.
if ((Test-Path $EnvFichier) -and -not ((Get-Content $EnvFichier) -match '^MASTER_CODE=')) {
  $codeMaitre = & $Node (Join-Path $Racine 'tools\code-maitre.js') '--brut'
  $ajout = "`r`n# Code de reprise du compte responsable, ajoute par l'installateur.`r`n" +
           "# Celui livre avec l'application est public : celui-ci ne l'est pas.`r`nMASTER_CODE=$codeMaitre`r`n"
  [System.IO.File]::AppendAllText($EnvFichier, $ajout, (New-Object System.Text.UTF8Encoding($false)))
  Souci 'Votre .env n''avait pas de code de reprise : il utilisait celui, public, du depot.'
  AnnoncerCodeMaitre $codeMaitre
}

$Donnees = Join-Path $Racine 'data'
if (-not (Test-Path $Donnees)) { New-Item -ItemType Directory -Path $Donnees | Out-Null }

# ── 3. module d'envoi de courriel (facultatif) ────────────────────────────────

if (Test-Path (Join-Path $Racine 'node_modules\nodemailer')) {
  Info "Module d'envoi de courriel déjà installé."
} elseif ($Npm) {
  Info "Installation du module d'envoi de courriel…"
  # npm cherche « node » dans le PATH : sans cette ligne, un poste sans Node.js
  # système échoue alors que le runtime local est là.
  $env:PATH = "$DossierNode;$env:PATH"
  & $Npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Info 'Module installé.'
  } else {
    Souci "Installation impossible (réseau ou dépôt npm). L'application fonctionne"
    Souci 'sans lui : les messages s''ouvriront dans votre logiciel de courriel.'
  }
}

# ── 3 bis. le pare-feu, quand le bureau a plusieurs postes ────────────────────

# Sans règle de pare-feu, les autres postes reçoivent un silence : pas de refus,
# pas de message, juste une page qui ne charge jamais. C'est la panne la plus
# coûteuse à diagnostiquer, et la plus simple à éviter. Elle demande des droits
# administrateur : si on ne les a pas, on le dit avec la commande exacte plutôt
# que d'échouer sans explication.
if ($PlusieursPostes) {
  $portApp = 3000
  $ligne = Select-String -Path $EnvFichier -Pattern '^PORT=(\d+)' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($ligne) { $portApp = [int]$ligne.Matches[0].Groups[1].Value }

  $nomRegle = 'Bureau du Courrier'
  $admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

  if ($admin) {
    try {
      # netsh plutôt que New-NetFirewallRule : présent sur toutes les éditions.
      & netsh advfirewall firewall delete rule name="$nomRegle" 2>&1 | Out-Null
      & netsh advfirewall firewall add rule name="$nomRegle" dir=in action=allow `
        protocol=TCP localport=$portApp profile=private 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Info "Pare-feu ouvert sur le port $portApp (réseaux privés seulement)."
      } else {
        Souci "Règle de pare-feu non posée. Voir la commande ci-dessous."
        Souci "netsh advfirewall firewall add rule name=`"$nomRegle`" dir=in action=allow protocol=TCP localport=$portApp profile=private"
      }
    } catch {
      Souci "Règle de pare-feu non posée : $($_.Exception.Message)"
    }
  } else {
    Souci 'Sans droits administrateur, le pare-feu de Windows bloquera les autres postes.'
    Souci 'Ouvrez une invite de commandes « en tant qu''administrateur » et lancez :'
    Souci "netsh advfirewall firewall add rule name=`"$nomRegle`" dir=in action=allow protocol=TCP localport=$portApp profile=private"
  }
}

# ── 4. vérification ───────────────────────────────────────────────────────────

Info "Vérification de l'installation…"
& $Node --test 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Info 'Contrôles internes passés.' }
else { Souci "Certains contrôles internes n'ont pas abouti — l'application démarre quand même." }

# ── 5. raccourci sur le Bureau ────────────────────────────────────────────────

try {
  $bureau = [Environment]::GetFolderPath('Desktop')
  $lien = Join-Path $bureau 'Bureau du Courrier.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $raccourci = $shell.CreateShortcut($lien)
  $raccourci.TargetPath = Join-Path $Racine 'demarrer.cmd'
  $raccourci.WorkingDirectory = $Racine
  $raccourci.IconLocation = Join-Path $Racine 'assets\icons\favicon.ico'
  $raccourci.Description = 'Registre des destinataires et notifications de courrier'
  $raccourci.Save()
  Info 'Raccourci « Bureau du Courrier » posé sur le Bureau.'
} catch {
  Souci "Raccourci impossible à créer — lancez demarrer.cmd depuis ce dossier."
}

# ── 6. lancement ──────────────────────────────────────────────────────────────

Titre 'Installation terminée.'
Info 'Le serveur démarre, le navigateur va s''ouvrir sur http://localhost:3000'
Info 'Pour arrêter : fermez cette fenêtre, ou Ctrl+C.'
Info 'Pour redémarrer plus tard : le raccourci du Bureau, ou demarrer.cmd.'
Write-Host ''

$env:OPEN_BROWSER = '1'
& $Node (Join-Path $Racine 'server\index.js')
