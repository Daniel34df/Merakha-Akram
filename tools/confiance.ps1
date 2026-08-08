<#
  Bureau du Courrier — faire reconnaître le certificat du bureau (Windows).

  Lancé par confiance.cmd, SUR LES AUTRES POSTES — pas sur celui qui garde le
  registre. Une seule fois par poste.

  Ce qu'il fait : range le certificat du bureau parmi les autorités de confiance
  de cet ordinateur. Après cela, le navigateur affiche le cadenas au lieu d'un
  avertissement de sécurité, et l'application devient installable.

  Ce qu'il ne fait pas : il n'installe rien d'autre, ne modifie aucun réglage
  réseau, et n'ouvre aucun accès entrant sur ce poste.

  À savoir avant de le lancer : ajouter une autorité de confiance est un geste
  qui compte. Cet ordinateur fera désormais confiance à tout certificat signé
  par cette clé. Ne le faites qu'avec le certificat de votre propre bureau,
  celui que le poste du responsable a fabriqué — jamais avec un fichier reçu
  par courriel ou trouvé ailleurs.

  Demande les droits administrateur : le magasin des autorités est commun à
  toute la machine.
#>

$ErrorActionPreference = 'Stop'

function Titre($t) { Write-Host ''; Write-Host "  $t" -ForegroundColor White }
function Info($t) { Write-Host "  $t" }
function Souci($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Fatal($t) {
  Write-Host "  x $t" -ForegroundColor Red
  Write-Host ''
  Read-Host '  Appuyez sur Entrée pour fermer'
  exit 1
}

Titre 'Bureau du Courrier — faire reconnaître le certificat'

# Le certificat, cherché à côté de ce script puis dans data\.
$Ici = $PSScriptRoot
$Candidats = @(
  (Join-Path $Ici 'certificat.cer'),
  (Join-Path $Ici 'data\certificat.cer'),
  (Join-Path (Split-Path -Parent $Ici) 'data\certificat.cer')
)
$Cer = $Candidats | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $Cer) {
  Souci 'Le fichier certificat.cer est introuvable.'
  Souci 'Copiez-le à côté de ce script — il vient du poste qui garde le registre,'
  Souci 'dans son dossier data\, et il a été fabriqué par certificat.cmd.'
  Fatal 'Rien n''a été modifié.'
}

$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Souci 'Ce script a besoin des droits administrateur.'
  Souci 'Faites un clic droit sur confiance.cmd, puis « Exécuter en tant qu''administrateur ».'
  Fatal 'Rien n''a été modifié.'
}

# On montre ce qu'on s'apprête à approuver, plutôt que de le faire en silence.
try {
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $Cer
} catch {
  Fatal "Ce fichier n'est pas un certificat lisible : $($_.Exception.Message)"
}

Info "Fichier   : $Cer"
Info "Émis pour : $($cert.Subject)"
Info "Valable   : du $($cert.NotBefore.ToString('d MMMM yyyy')) au $($cert.NotAfter.ToString('d MMMM yyyy'))"
Info "Empreinte : $($cert.Thumbprint)"
Write-Host ''
Info 'Vérifiez que cette empreinte est bien celle affichée sur le poste du'
Info 'responsable. Si elle diffère, arrêtez-vous : ce n''est pas votre certificat.'
Write-Host ''

$reponse = Read-Host '  Ajouter ce certificat aux autorités de confiance de ce poste ? (o/N)'
if ($reponse -notmatch '^[oOyY]') {
  Info 'Abandon. Rien n''a été modifié.'
  Write-Host ''
  exit 0
}

try {
  $magasin = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  $magasin.Open('ReadWrite')
  $magasin.Add($cert)
  $magasin.Close()
} catch {
  Fatal "Ajout impossible : $($_.Exception.Message)"
}

Titre 'C''est fait.'
Info 'Ouvrez maintenant l''adresse du bureau dans votre navigateur : le cadenas'
Info 'doit apparaître, sans avertissement.'
Info ''
Info 'Pour revenir en arrière un jour : certmgr.msc, dossier « Autorités de'
Info 'certification racines de confiance », supprimer « Bureau du Courrier ».'
Write-Host ''
Read-Host '  Appuyez sur Entrée pour fermer'
