<#
  Bureau du Courrier — fabrique un certificat pour le réseau du bureau (Windows).

  Lancé par certificat.cmd, sur le poste qui garde le registre.

  Pourquoi : tant que l'application est en http, le mot de passe et le cookie de
  session circulent en clair sur le wifi du bureau, et les navigateurs refusent
  aux autres postes d'installer l'application ou de travailler hors ligne — ils
  réservent cela aux adresses qu'ils considèrent sûres.

  Ce script n'a besoin d'aucun outil supplémentaire : New-SelfSignedCertificate
  est fourni avec Windows depuis la version 10. Pas d'OpenSSL à installer.

  Il écrit :
    data\certificat.pfx  — la clé et le certificat, pour le serveur (ne pas diffuser)
    data\certificat.cer  — le certificat seul, à porter sur les autres postes
  et ajoute au .env les deux lignes qui les désignent.

  Le certificat n'est signé par aucune autorité connue : chaque poste affichera
  un avertissement jusqu'à ce qu'on y lance confiance.cmd une fois.
  Voir docs\plusieurs-postes.md.
#>

$ErrorActionPreference = 'Stop'

$Racine = Split-Path -Parent $PSScriptRoot
Set-Location $Racine

function Titre($t) { Write-Host ''; Write-Host "  $t" -ForegroundColor White }
function Info($t) { Write-Host "  $t" }
function Souci($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Fatal($t) {
  Write-Host "  x $t" -ForegroundColor Red
  Write-Host ''
  exit 1
}

Titre 'Bureau du Courrier — certificat pour le réseau du bureau'

if (-not (Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue)) {
  Fatal 'Cette version de Windows ne sait pas fabriquer de certificat. Voir docs\mise-en-service-https.md.'
}

$Data = Join-Path $Racine 'data'
New-Item -ItemType Directory -Force -Path $Data | Out-Null
$Pfx = Join-Path $Data 'certificat.pfx'
$Cer = Join-Path $Data 'certificat.cer'

if (Test-Path $Pfx) {
  Souci 'Un certificat existe déjà (data\certificat.pfx).'
  Souci 'Pour le remplacer, effacez-le puis relancez.'
  exit 0
}

# Les noms sous lesquels ce serveur sera joint. Un navigateur refuse un
# certificat qui ne mentionne pas l'adresse exacte qu'on a tapée : il faut donc
# le nom du poste, localhost, et chacune de ses adresses réseau.
$NomPoste = $env:COMPUTERNAME
$Noms = New-Object System.Collections.Generic.List[string]
$Noms.Add($NomPoste)
$Noms.Add('localhost')
$Noms.Add('127.0.0.1')

$Node = Join-Path $Racine 'runtime\node.exe'
if (-not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if ($Node) {
  $trouvees = & $Node -e 'const r=require("./server/reseau.js");process.stdout.write(r.adressesLocales().map(a=>a.adresse).join(" "))' 2>$null
  foreach ($a in ($trouvees -split ' ')) { if ($a) { $Noms.Add($a) } }
} else {
  Souci 'Node.js introuvable : le certificat ne portera pas les adresses réseau de ce poste.'
  Souci 'Lancez installer.cmd d''abord, puis relancez ce script.'
}

Info "Poste     : $NomPoste"
Info "Noms      : $($Noms -join ', ')"

# Le mot de passe du .pfx ne protège rien d'autre que le fichier lui-même, qui
# reste sur ce poste : il est tiré au sort et écrit dans le .env, à côté.
$octets = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($octets)
$MotDePasse = [Convert]::ToBase64String($octets)
$Secure = ConvertTo-SecureString -String $MotDePasse -Force -AsPlainText

try {
  $cert = New-SelfSignedCertificate `
    -DnsName $Noms.ToArray() `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -FriendlyName 'Bureau du Courrier' `
    -NotAfter (Get-Date).AddDays(825) `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
} catch {
  Fatal "Windows n'a pas pu fabriquer le certificat : $($_.Exception.Message)"
}

Export-PfxCertificate -Cert $cert -FilePath $Pfx -Password $Secure | Out-Null
Export-Certificate -Cert $cert -FilePath $Cer -Type CERT | Out-Null
# Le certificat vit maintenant dans les deux fichiers : on le retire du magasin
# personnel pour ne pas en laisser traîner une copie oubliée.
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue

Info "Certificat écrit : data\certificat.pfx (valable 825 jours)"
Info "À porter sur les autres postes : data\certificat.cer"

# ── le .env ───────────────────────────────────────────────────────────────────

$EnvFichier = Join-Path $Racine '.env'
if ((Test-Path $EnvFichier) -and ((Get-Content $EnvFichier) -match '^HTTPS_')) {
  Info 'Le .env mentionne déjà un certificat — inchangé.'
} else {
  $ajout = @"

# Certificat écrit par certificat.cmd. Sans ces lignes, l'application démarre
# en http et le mot de passe circule en clair sur le réseau.
HTTPS_PFX=./data/certificat.pfx
HTTPS_PFX_PASS=$MotDePasse
"@
  Add-Content -Path $EnvFichier -Value $ajout -Encoding UTF8
  Info 'Les lignes HTTPS_PFX / HTTPS_PFX_PASS ont été ajoutées au .env.'
}

Titre 'Certificat prêt.'
Info '1. Redémarrez l''application : le démarrage doit afficher « https://… ».'
Info '2. Sur chacun des autres postes, lancez confiance.cmd une seule fois,'
Info '   en emportant avec lui le fichier data\certificat.cer.'
Info ''
Info 'Sans l''étape 2, tout fonctionne, mais chaque poste affichera un'
Info 'avertissement de sécurité — et l''application n''y sera pas installable.'
Write-Host ''
