# Bureau du Courrier

Petite application de réception : quand une lettre arrive, on inscrit le nom du
destinataire, l'application le retrouve dans le registre et lui envoie un
courriel l'invitant à venir chercher son courrier.

L'application fonctionne à trois niveaux, du plus simple au plus complet — on
choisit selon le besoin, sans rien réécrire :

| Usage | Ce qu'il faut | Stockage | Envoi du courriel |
|---|---|---|---|
| **Poste unique** | ouvrir `index.html` dans un navigateur | navigateur (localStorage) | ouvre le logiciel de courriel, message déjà rédigé |
| **Réception partagée** | `npm start` | fichier `data/db.json` sur le serveur | idem |
| **Envoi automatique** | `npm install` + compte SMTP dans `.env` | fichier `data/db.json` | le serveur envoie le courriel directement |

L'interface affiche en haut à droite le mode actif (*Ce poste*, *Registre
partagé*, *Session seulement*) : personne n'a à deviner où vont les données.

---

## Démarrage

### 1. Le plus simple — sans rien installer

Ouvrez `index.html` dans un navigateur. Le registre est conservé dans le
navigateur de ce poste. « Envoyer la notification » ouvre le logiciel de
courriel avec le message pré-rempli ; il ne reste qu'à cliquer sur *Envoyer*.

### 2. Registre partagé entre plusieurs postes

```bash
npm start                 # puis http://localhost:3000
PORT=8080 npm start       # sur un autre port
```

Le serveur n'a **aucune dépendance obligatoire** : Node.js 20.12 ou plus suffit.
Le registre est écrit dans `data/db.json` (emplacement modifiable via `DB_FILE`).

### 3. Envoi entièrement automatique

```bash
npm install               # installe nodemailer
cp .env.example .env      # puis renseignez SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM
npm start
```

Le courriel part alors du serveur, sans ouvrir de logiciel de courriel. Un
bouton **Envoyer un courriel de test** apparaît dans l'onglet *Réglages* pour
vérifier la configuration.

Pour une démonstration sans rien envoyer pour de vrai :

```bash
MAIL_DRY_RUN=true npm start   # les messages sont affichés dans la console
```

Si SMTP tombe en panne, l'application ne bloque pas : elle retombe sur le
logiciel de courriel et note l'incident dans l'historique.

---

## Utilisation

**Guichet** — on tape le nom inscrit sur la lettre. La recherche ignore les
accents, la casse et l'ordre des mots (« tremblay elodie » trouve « Élodie
Tremblay ») et propose les correspondances dès deux caractères. Si le nom est
inconnu, on peut l'ajouter au registre et le notifier dans la foulée.
Raccourcis : `Entrée` valide, `↑` `↓` parcourent les suggestions, `/` ramène au
champ de recherche.

**Registre** — ajout, modification et suppression des destinataires, filtre,
import et export CSV. Un courriel déjà présent est refusé, avec le nom sous
lequel il est enregistré.

Le CSV d'import accepte un en-tête (`nom,courriel` ou `name,email`) ou, à
défaut, deux colonnes dans l'ordre nom puis courriel. Les lignes fautives sont
signalées une par une, les doublons ignorés, et le reste est importé.

**Historique** — toutes les notifications, filtrables par texte et par date,
exportables en CSV. Chaque entrée indique la voie utilisée : *Automatique*
(parti du serveur) ou *Logiciel de courriel* (préparé pour l'employé·e).

**Réglages** — l'expéditeur (**De**), les copies **Cc** et **Cci** par défaut, le
sujet et le corps du message, avec aperçu en direct. Variables disponibles :
`{nom}`, `{courriel}`, `{date}`, `{bureau}`.

Les copies s'appliquent à tous les envois. Pour n'en changer que le temps d'une
lettre, dépliez **Copies pour cet envoi** au guichet : les champs partent des
valeurs par défaut, et le bouton *Revenir aux copies par défaut* les rétablit.
Plusieurs adresses se séparent par des virgules ; une adresse fautive bloque
l'envoi et est signalée telle quelle.

Deux limites à connaître sur le **De** :

- il ne s'applique qu'à l'envoi automatique — `mailto:` ne permet pas d'imposer
  un expéditeur, celui-ci reste celui du logiciel de courriel de l'employé·e ;
- beaucoup de fournisseurs SMTP refusent un expéditeur qui ne correspond pas au
  compte authentifié. En cas de refus, laissez le champ vide : c'est alors
  `MAIL_FROM` qui s'applique.

Le **Cci** est invisible pour les destinataires, mais reste affiché au guichet
et dans l'historique : c'est la trace interne de l'envoi.

---

## Configuration

Toutes les variables sont facultatives ; voir `.env.example`.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | port d'écoute |
| `HOST` | `0.0.0.0` | interface d'écoute |
| `DB_FILE` | `./data/db.json` | fichier du registre |
| `SMTP_HOST` | — | serveur d'envoi ; sans lui, envoi automatique inactif |
| `SMTP_PORT` | `587` | port SMTP (`465` active TLS implicite) |
| `SMTP_SECURE` | `false` | forcer TLS implicite |
| `SMTP_USER` / `SMTP_PASS` | — | identifiants SMTP |
| `MAIL_FROM` | `SMTP_USER` | expéditeur affiché |
| `MAIL_DRY_RUN` | `false` | simule l'envoi, sans rien expédier |

---

## API

Le serveur expose une petite API JSON sous `/api` — utile pour brancher une
autre interface ou un import automatisé.

| Méthode | Route | Effet |
|---|---|---|
| `GET` | `/api/health` | état de l'application et du courriel |
| `GET` | `/api/state` | registre + historique + réglages |
| `GET` `POST` | `/api/contacts` | lister / ajouter un destinataire |
| `PUT` `DELETE` | `/api/contacts/:id` | modifier / supprimer |
| `GET` `POST` `DELETE` | `/api/history` | historique : lire, ajouter, vider |
| `GET` `PUT` | `/api/settings` | gabarit du message |
| `POST` | `/api/notify` | envoyer un courriel et le consigner |

`/api/notify` accepte `from`, `cc` et `bcc` : fournis, ils l'emportent sur les
réglages ; absents, ce sont les réglages qui s'appliquent ; une chaîne vide
retire la copie pour cet envoi.

Les erreurs sont renvoyées en JSON (`{"error": "…"}`) avec un code parlant :
`400` donnée invalide, `404` introuvable, `409` courriel déjà au registre,
`502` refus du serveur de courriel, `503` envoi automatique non configuré.

---

## Développement

```
index.html            interface
assets/css/style.css  feuille de style
assets/css/fonts.css  déclarations des polices embarquées
assets/fonts/         polices (woff2, sous-ensembles latin) — 216 Ko
assets/js/util.js     fonctions partagées navigateur + serveur (recherche, CSV, gabarits)
assets/js/store.js    persistance : serveur → localStorage → mémoire
assets/js/notify.js   composition du message, mailto, presse-papiers
assets/js/app.js      interface (onglets, registre, historique, réglages)
server/app.js         serveur HTTP et API JSON
server/db.js          fichier JSON, écritures atomiques et sérialisées
server/mailer.js      envoi SMTP (nodemailer, optionnel) et mode essai
test/                 tests (node:test), sans dépendance
.github/workflows/    intégration continue : npm test sur Node 20.12 et 22
```

```bash
npm test     # 30 tests : utilitaires + API de bout en bout
npm run dev  # rechargement automatique, mode essai pour le courriel
```

Les polices sont versionnées dans le dépôt : l'application s'affiche telle
quelle sur un poste sans accès à Internet, et aucune requête ne part vers un
service externe.

Aucune étape de compilation : le navigateur charge les fichiers tels quels, et
`assets/js/util.js` est le même fichier des deux côtés — les règles de recherche
et de validation ne peuvent donc pas diverger entre l'interface et le serveur.
