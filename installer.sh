#!/usr/bin/env bash
# Bureau du Courrier — installation complète, sans intervention.
#
#   ./installer.sh
#
# Ce que fait ce script, dans l'ordre :
#   1. cherche un Node.js utilisable sur le poste ;
#   2. s'il n'y en a pas, télécharge la version LTS depuis nodejs.org, vérifie
#      son empreinte SHA-256 et la range dans ./runtime — rien n'est installé
#      sur le système, rien ne touche au PATH, tout se supprime en effaçant le
#      dossier ;
#   3. écrit un .env avec une clé de chiffrement tirée au sort ;
#   4. installe nodemailer si le réseau le permet (facultatif) ;
#   5. démarre le serveur et ouvre le navigateur.
#
# Aucun droit administrateur n'est requis. Relancer le script est sans danger :
# ce qui est déjà en place est conservé.
set -u

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RACINE" || exit 1

RUNTIME="$RACINE/runtime"
NODE_MIN_MAJEUR=20
NODE_REPLI="v22.14.0" # utilisé seulement si nodejs.org ne répond pas

# ./installer.sh --plusieurs-postes : le bureau tient l'accueil sur plusieurs
# ordinateurs reliés au même réseau. Le registre reste sur celui-ci ; les autres
# l'ouvrent dans leur navigateur. Sans cette option, le serveur n'écoute que sur
# ce poste — c'est plus prudent, et c'est ce qu'il faut à un bureau seul.
PLUSIEURS_POSTES=0
for arg in "$@"; do
  case "$arg" in
    --plusieurs-postes | --postes | --reseau) PLUSIEURS_POSTES=1 ;;
  esac
done
HOTE="127.0.0.1"
[ "$PLUSIEURS_POSTES" = "1" ] && HOTE="0.0.0.0"

titre() { printf '\n\033[1m  %s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
souci() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# Le code de reprise ne s'affiche qu'ici, une fois : seule son empreinte est
# conservée, personne ne peut le retrouver ensuite. Il doit donc sauter aux
# yeux dans le défilement de l'installation.
#
# Pas de cadre à remplir : printf compte les octets, pas les colonnes, et les
# caractères de filet en occupent trois chacun — un cadre se décale dès qu'on y
# met autre chose que de l'ASCII. Un trait au-dessus et en dessous ne peut pas
# se désaligner.
annoncer_code_maitre() {
  # Groupé par quatre pour se dicter et se recopier : « 4821 9037 5164 ».
  groupe="$(printf '%s' "$1" | sed 's/.\{4\}/& /g;s/ *$//')"
  printf '\n'
  printf '  \033[1m%s\033[0m\n' 'Code de reprise du compte responsable'
  printf '  \033[2m%s\033[0m\n' '────────────────────────'
  printf '\n      \033[1m%s\033[0m\n\n' "$groupe"
  info "Notez-le sur papier et rangez-le : il ne se retrouve pas."
  info "Il sert si le responsable perd son mot de passe. Il n'ouvre pas le registre."
}
fatal() {
  printf '  \033[31m✗\033[0m %s\n\n' "$1"
  exit 1
}

titre "Bureau du Courrier — installation"

# ── 1. un Node.js utilisable ? ────────────────────────────────────────────────

version_majeure() { "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null; }

NODE=""
for candidat in "$RUNTIME/bin/node" "$(command -v node 2>/dev/null || true)"; do
  [ -n "$candidat" ] && [ -x "$candidat" ] || continue
  majeure="$(version_majeure "$candidat")"
  if [ -n "$majeure" ] && [ "$majeure" -ge "$NODE_MIN_MAJEUR" ] 2>/dev/null; then
    NODE="$candidat"
    break
  fi
done

if [ -n "$NODE" ]; then
  info "Node.js $("$NODE" -v) trouvé — $NODE"
else
  info "Aucun Node.js récent sur ce poste : téléchargement de la version LTS."

  case "$(uname -s)" in
    Darwin) plateforme="darwin" ;;
    Linux) plateforme="linux" ;;
    *) fatal "Système non reconnu. Sous Windows, lancez installer.cmd." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) fatal "Processeur non reconnu : $(uname -m)" ;;
  esac

  # La version LTS courante, demandée à nodejs.org ; sinon une version connue.
  VERSION="$(curl -fsSL --max-time 20 https://nodejs.org/dist/index.json 2>/dev/null |
    tr '{' '\n' | grep '"lts":"[A-Z]' | head -1 | sed 's/.*"version":"\([^"]*\)".*/\1/')"
  [ -n "$VERSION" ] || {
    souci "nodejs.org ne répond pas — on prend la version connue $NODE_REPLI."
    VERSION="$NODE_REPLI"
  }

  archive="node-$VERSION-$plateforme-$arch.tar.gz"
  base="https://nodejs.org/dist/$VERSION"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  info "Téléchargement de $archive…"
  curl -fL --progress-bar --max-time 600 "$base/$archive" -o "$tmp/$archive" ||
    fatal "Téléchargement impossible. Vérifiez la connexion, puis relancez."

  # Vérifier l'empreinte : on s'apprête à exécuter ce qu'on vient de télécharger.
  info "Vérification de l'empreinte SHA-256…"
  if curl -fsSL --max-time 60 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"; then
    attendue="$(grep " $archive\$" "$tmp/SHASUMS256.txt" | awk '{print $1}')"
    obtenue="$( (sha256sum "$tmp/$archive" 2>/dev/null || shasum -a 256 "$tmp/$archive") | awk '{print $1}')"
    [ -n "$attendue" ] && [ "$attendue" = "$obtenue" ] ||
      fatal "Empreinte incorrecte — le fichier téléchargé n'est pas celui publié par nodejs.org."
    info "Empreinte conforme."
  else
    souci "Empreintes indisponibles : installation poursuivie sans vérification."
  fi

  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME"
  tar -xzf "$tmp/$archive" -C "$RUNTIME" --strip-components=1 ||
    fatal "Décompression impossible."
  NODE="$RUNTIME/bin/node"
  [ -x "$NODE" ] || fatal "Node.js n'est pas là où il devrait être après décompression."
  info "Node.js $("$NODE" -v) installé dans ./runtime (rien sur le système)."
fi

NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm 2>/dev/null || true)"

# ── 2. configuration ──────────────────────────────────────────────────────────

if [ -f .env ]; then
  info "Configuration .env déjà présente — conservée."
  # Le .env est conservé tel quel : on ne réécrit pas la configuration de
  # quelqu'un. Mais si l'accès aux autres postes est demandé et que le fichier
  # dit le contraire, mieux vaut le signaler que le laisser croire.
  if [ "$PLUSIEURS_POSTES" = "1" ] && grep -qE '^HOST=(127\.|localhost|::1)' .env; then
    souci "Votre .env garde HOST=127.0.0.1 : le serveur n'écoutera que sur ce poste."
    souci "Remplacez cette ligne par HOST=0.0.0.0 pour ouvrir l'accès aux autres."
  fi
else
  info "Écriture de la configuration…"
  secret="$("$NODE" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
  # Un code de reprise propre à ce bureau : celui du dépôt est public.
  code_maitre="$("$NODE" tools/code-maitre.js --brut)"
  cat > .env <<ENV
# Écrit par installer.sh — modifiable à tout moment.
# Chaque réglage est expliqué dans .env.example.
PORT=3000
# Qui peut joindre ce serveur.
#   127.0.0.1  ce seul ordinateur (par défaut, le plus prudent)
#   0.0.0.0    tous les postes du bureau sur le même wifi ou le même câble
# Relancez ./installer.sh --plusieurs-postes pour ouvrir l'accès, ou changez
# cette ligne à la main. Voir docs/plusieurs-postes.md
HOST=$HOTE
DB_FILE=./data/db.json

# Clé de chiffrement des secrets enregistrés. Tirée au sort à l'installation.
# À sauvegarder avec le registre ; sans elle, les boîtes reliées sont à refaire.
APP_SECRET=$secret

# Code de reprise du compte responsable, tiré au sort à l'installation.
# Il permet de changer l'adresse ou le mot de passe du responsable, ou de
# supprimer son compte pour réinstaller. Il ne donne pas accès au registre.
# Seule son empreinte est conservée : s'il est perdu, il ne se retrouve pas —
# relancez l'installateur pour en tirer un nouveau.
MASTER_CODE=$code_maitre

# Aucun serveur de courriel pour l'instant : les messages s'ouvrent dans le
# logiciel de courriel de l'employé·e. Voir docs/installation-windows-gmail.md
# pour activer l'envoi automatique.
MAIL_DRY_RUN=false

REMINDER_DAYS=15
ESCALATION_DAYS=15
DIGEST_DAY=1
DIGEST_HOUR=8
ENV
  chmod 600 .env 2>/dev/null || true
  info "Clé de chiffrement créée. Le fichier .env n'est lisible que par vous."
  annoncer_code_maitre "$code_maitre"
fi

# Un bureau installé avant que l'installateur ne tire ce code garde celui du
# dépôt, qui est public. On ajoute la ligne sans toucher au reste : le serveur
# la reprend au démarrage suivant, et l'avertissement rouge des Réglages
# disparaît de lui-même.
if [ -f .env ] && ! grep -q '^MASTER_CODE=' .env; then
  code_maitre="$("$NODE" tools/code-maitre.js --brut)"
  {
    printf '\n# Code de reprise du compte responsable, ajouté par installer.sh.\n'
    printf '# Celui livré avec l’application est public : celui-ci ne l’est pas.\n'
    printf 'MASTER_CODE=%s\n' "$code_maitre"
  } >> .env
  souci "Votre .env n'avait pas de code de reprise : il utilisait celui, public, du dépôt."
  annoncer_code_maitre "$code_maitre"
fi

mkdir -p data
chmod 700 data 2>/dev/null || true

# ── 3. module d'envoi de courriel (facultatif) ────────────────────────────────

if [ -d node_modules/nodemailer ]; then
  info "Module d'envoi de courriel déjà installé."
elif [ -n "$NPM" ]; then
  info "Installation du module d'envoi de courriel…"
  # npm est un script qui cherche « node » dans le PATH : sans cette ligne, un
  # poste sans Node.js système échoue alors que le runtime local est là.
  export PATH="$(dirname "$NODE"):$PATH"
  if "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1; then
    info "Module installé."
  else
    souci "Installation impossible (réseau ou dépôt npm). L'application fonctionne"
    souci "sans lui : les messages s'ouvriront dans votre logiciel de courriel."
  fi
fi

# ── 3 bis. le pare-feu, quand le bureau a plusieurs postes ────────────────────

# Sans règle de pare-feu, les autres postes reçoivent un silence : pas de refus,
# pas de message, juste une page qui ne charge jamais. C'est la panne la plus
# coûteuse à diagnostiquer, et la plus simple à éviter.
if [ "$PLUSIEURS_POSTES" = "1" ]; then
  PORT_APP="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"
  [ -n "$PORT_APP" ] || PORT_APP=3000
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
    if sudo -n ufw allow "$PORT_APP/tcp" >/dev/null 2>&1; then
      info "Pare-feu (ufw) ouvert sur le port $PORT_APP."
    else
      souci "Pare-feu ufw actif. Lancez :  sudo ufw allow $PORT_APP/tcp"
    fi
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if sudo -n firewall-cmd --permanent --add-port="$PORT_APP/tcp" >/dev/null 2>&1 &&
      sudo -n firewall-cmd --reload >/dev/null 2>&1; then
      info "Pare-feu (firewalld) ouvert sur le port $PORT_APP."
    else
      souci "Pare-feu firewalld actif. Lancez :"
      souci "  sudo firewall-cmd --permanent --add-port=$PORT_APP/tcp && sudo firewall-cmd --reload"
    fi
  else
    info "Aucun pare-feu détecté à configurer."
  fi
fi

# ── 4. vérification ───────────────────────────────────────────────────────────

info "Vérification de l'installation…"
"$NODE" --test >/dev/null 2>&1 && info "Contrôles internes passés." ||
  souci "Certains contrôles internes n'ont pas abouti — l'application démarre quand même."

# ── 5. lancement ──────────────────────────────────────────────────────────────

titre "Installation terminée."
info "Le serveur démarre, le navigateur va s'ouvrir sur http://localhost:3000"
info "Pour arrêter : Ctrl+C dans cette fenêtre."
info "Pour redémarrer plus tard : ./demarrer.sh"

cat > demarrer.sh <<'START'
#!/usr/bin/env bash
# Démarre le Bureau du Courrier. Écrit par l'installateur.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
NODE="./runtime/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
OPEN_BROWSER=1 exec "$NODE" server/index.js
START
chmod +x demarrer.sh

OPEN_BROWSER=1 exec "$NODE" server/index.js
