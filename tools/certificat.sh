#!/usr/bin/env bash
# Bureau du Courrier — fabrique un certificat pour le réseau du bureau.
#
#   ./tools/certificat.sh
#
# Pourquoi : tant que l'application est en http, le mot de passe et le cookie de
# session circulent en clair sur le wifi, et les navigateurs refusent aux autres
# postes d'installer l'application ou de travailler hors ligne — ils réservent
# cela aux adresses qu'ils considèrent sûres.
#
# Ce script écrit data/cle.pem et data/certificat.pem, valables 825 jours, au nom
# de ce poste et de chacune de ses adresses réseau. Il ajoute les deux lignes
# qu'il faut au .env. Rien n'est envoyé nulle part : tout est fabriqué ici.
#
# Le certificat n'est pas signé par une autorité connue : chaque navigateur
# affichera un avertissement à la première visite, jusqu'à ce qu'on installe le
# certificat comme autorité de confiance sur les postes. Voir
# docs/plusieurs-postes.md.
set -u

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE" || exit 1

titre() { printf '\n\033[1m  %s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
souci() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fatal() {
  printf '  \033[31m✗\033[0m %s\n\n' "$1"
  exit 1
}

titre "Bureau du Courrier — certificat pour le réseau du bureau"

command -v openssl >/dev/null 2>&1 || fatal "OpenSSL est introuvable. Installez-le, puis relancez."

CLE="data/cle.pem"
CERT="data/certificat.pem"

if [ -f "$CERT" ] && [ -f "$CLE" ]; then
  fin="$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)"
  souci "Un certificat existe déjà (valable jusqu'au ${fin:-?})."
  souci "Pour le remplacer, effacez $CERT et $CLE, puis relancez."
  exit 0
fi

# Les noms sous lesquels ce serveur sera joint : le nom du poste, localhost, et
# chacune de ses adresses. Un navigateur refuse un certificat qui ne mentionne
# pas l'adresse exacte qu'on a tapée — d'où la liste complète.
NOM_POSTE="$(hostname 2>/dev/null | cut -d. -f1)"
[ -n "$NOM_POSTE" ] || NOM_POSTE="bureau-du-courrier"

NODE="./runtime/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || fatal "Node.js est introuvable. Lancez d'abord ./installer.sh"

ADRESSES="$("$NODE" -e '
  const r = require("./server/reseau.js");
  process.stdout.write(r.adressesLocales().map(function (a) { return a.adresse; }).join(" "));
' 2>/dev/null)"

ALT="DNS:$NOM_POSTE,DNS:localhost,IP:127.0.0.1"
for a in $ADRESSES; do
  ALT="$ALT,IP:$a"
done

info "Poste          : $NOM_POSTE"
info "Adresses       : ${ADRESSES:-aucune détectée}"

mkdir -p data
chmod 700 data 2>/dev/null || true

openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
  -keyout "$CLE" -out "$CERT" \
  -subj "/CN=$NOM_POSTE" \
  -addext "subjectAltName=$ALT" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1 ||
  fatal "OpenSSL n'a pas pu écrire le certificat."

# La clé privée vaut le mot de passe du serveur : elle n'a pas à être lisible
# par les autres comptes de la machine.
chmod 600 "$CLE" 2>/dev/null || true
info "Certificat écrit : $CERT (valable 825 jours)"

# ── le .env ───────────────────────────────────────────────────────────────────

if [ -f .env ] && grep -qE '^HTTPS_(KEY|CERT)=' .env; then
  info "Le .env mentionne déjà un certificat — inchangé."
else
  {
    printf '\n# Certificat écrit par tools/certificat.sh. Sans ces deux lignes,\n'
    printf '# l’application démarre en http et le mot de passe circule en clair.\n'
    printf 'HTTPS_KEY=./%s\n' "$CLE"
    printf 'HTTPS_CERT=./%s\n' "$CERT"
  } >>.env
  info "Les deux lignes HTTPS_KEY / HTTPS_CERT ont été ajoutées au .env."
fi

# ── ce qu'il reste à faire ────────────────────────────────────────────────────

titre "Certificat prêt."
info "1. Redémarrez l'application : le démarrage doit afficher « https://… »."
info "2. Sur chacun des autres postes, faites reconnaître le certificat une fois."
info "   Le fichier à leur porter est : $CERT"
info "   Marche à suivre par système : docs/plusieurs-postes.md"
info ""
info "Sans l'étape 2, tout fonctionne, mais chaque poste affichera un"
info "avertissement de sécurité à la première visite — et l'application n'y sera"
info "pas installable."
