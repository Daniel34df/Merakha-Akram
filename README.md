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

**Pas à pas pour Windows + Gmail** — installation de Node.js, mot de passe
d'application Google, fichier `.env`, vérification et pannes courantes :
[`docs/installation-windows-gmail.md`](docs/installation-windows-gmail.md).

Les mêmes étapes en images : ouvrez `tools/guide-nodejs.html` dans un
navigateur — un guide animé de cinq étapes, qui se rejoue à volonté. Pour en
tirer une vidéo :

```bash
npm i --no-save playwright && npx playwright install chromium
node tools/enregistrer-guide.js
```

Sur Windows, une fois la configuration faite, double-cliquez **`demarrer.cmd`** :
il démarre le serveur et ouvre l'application. Aucune commande à retenir.

Pour une démonstration sans rien envoyer pour de vrai :

```bash
MAIL_DRY_RUN=true npm start   # les messages sont affichés dans la console
```

Si SMTP tombe en panne, l'application ne bloque pas : elle retombe sur le
logiciel de courriel et note l'incident dans l'historique.

**À savoir** : sans envoi automatique, une notification est *préparée*, pas
expédiée — le message s'ouvre dans le logiciel de courriel de l'employé·e, qui
doit encore cliquer sur *Envoyer*. L'historique la marque alors « À envoyer ».
Si aucun logiciel de courriel n'est configuré sur le poste (cas courant quand on
utilise Gmail ou Outlook dans le navigateur), rien ne s'ouvre : copiez le
message depuis l'application, ou configurez l'envoi automatique.

---

## Installer l'application

L'application est installable : elle s'ouvre dans sa propre fenêtre, avec son
icône, et fonctionne sans réseau.

1. Démarrez le serveur (`npm start`) et ouvrez `http://localhost:3000`.
2. Cliquez sur **Installer l'application**, en haut à droite. Le bouton
   n'apparaît que si le navigateur propose l'installation ; sinon, passez par le
   menu du navigateur (Chrome et Edge : *Installer…* dans le menu ⋮ ou l'icône
   dans la barre d'adresse ; Safari sur iPad ou iPhone : *Partager → Sur l'écran
   d'accueil*).

Deux conditions imposées par les navigateurs, pas par l'application :

- l'installation exige `http://localhost` ou une adresse **https** — une
  ouverture directe du fichier (`file://`) ne peut pas être installée, et un
  serveur exposé en `http://` sur le réseau non plus. Pour plusieurs postes,
  prévoyez un certificat, ou installez depuis chaque poste via un tunnel local ;
- Firefox n'installe pas les applications web sur ordinateur : l'application y
  reste parfaitement utilisable dans un onglet.

Une fois installée, l'interface, les polices et les icônes sont conservées sur
le poste : elle s'ouvre même sans réseau. Les données, elles, suivent le mode de
stockage — hors ligne, un poste relié au registre partagé bascule
automatiquement sur son stockage local, et l'indicateur en haut à droite le
signale.

### Le logo

Le logo est un fichier unique : `assets/icons/logo.svg`. Remplacez-le par le
vôtre — en-tête et favicon le reprennent immédiatement. Pour les icônes de
l'application installée :

```bash
npm i --no-save playwright && npx playwright install chromium
node tools/make-icons.js
```

Le script régénère les cinq PNG (dont les variantes *maskable* d'Android) depuis
`logo.svg`. Playwright n'est utilisé que pour cette génération : ni le serveur ni
l'interface n'en dépendent, et les PNG sont versionnés.

Le visuel fourni par défaut est neutre et propre au projet. **Aucun logo
d'organisation n'est inclus** : utilisez le fichier officiel remis par votre
service communication, seul habilité à en autoriser l'usage.

---

## Registre partagé ou registre de poste

L'onglet *Réglages* propose le choix, par poste :

- **Registre partagé** — conservé sur le serveur, vu par tous les postes, avec
  envoi automatique possible ;
- **Ce poste seulement** — conservé dans ce navigateur ; rien ne quitte le
  poste, mais les autres postes ne voient pas ce registre.

Le choix est propre au navigateur, pas au serveur : deux postes peuvent faire
des choix différents. Changer d'option recharge la page — les données de l'autre
support ne sont pas effacées, elles cessent seulement d'être affichées.

---

## Comptes et boîte d'envoi personnelle

À l'inscription, un **code de confirmation à six chiffres** est envoyé à
l'adresse indiquée : le compte n'est créé qu'une fois ce code saisi. Cela évite
qu'on s'inscrive avec le courriel d'un collègue. La vérification est active dès
que le serveur sait envoyer un courriel ; sinon l'écran d'inscription le
signale.

L'adresse une fois confirmée, l'application propose de l'**associer comme boîte
d'envoi** dans la foulée : le serveur SMTP est deviné d'après le domaine, et
pour une adresse Google l'autorisation OAuth est proposée en premier. L'étape se
saute d'un clic.

Au premier démarrage du serveur, l'application propose de créer le **compte du
bureau**. Dès qu'un compte existe, le registre n'est plus accessible sans
connexion. On peut aussi continuer sans compte : l'application fonctionne alors
comme avant, ouverte à qui connaît l'adresse.

Chaque personne connectée peut relier **sa propre boîte** pour que les
notifications partent de son adresse — les destinataires lui répondent
directement, et l'envoi ne dépend plus d'un compte partagé. Deux voies :

- **Connexion Gmail** : autorisation donnée sur l'écran de Google, sans jamais
  communiquer son mot de passe, révocable à tout moment. Demande une
  configuration préalable par l'administrateur ;
- **Mot de passe d'application** : fonctionne immédiatement, sans configuration
  serveur.

Les jetons et mots de passe d'application sont chiffrés (AES-256-GCM) avant
d'être enregistrés, et ne sont jamais renvoyés au navigateur. Les mots de passe
des comptes sont hachés en scrypt.

Marche à suivre complète : [`docs/connexion-boite-mail.md`](docs/connexion-boite-mail.md).

---

## Utilisation

**Guichet** — on tape le nom inscrit sur la lettre. La recherche ignore les
accents, la casse et l'ordre des mots (« tremblay elodie » trouve « Élodie
Tremblay ») et propose les correspondances dès deux caractères. Si le nom est
inconnu, on peut l'ajouter au registre et le notifier dans la foulée.
Raccourcis : `Entrée` valide, `↑` `↓` parcourent les suggestions, `/` ramène au
champ de recherche.

**Guichet, deux façons de chercher** — un sélecteur au-dessus du champ bascule
entre **Par nom** et **Par n° de boîte**. En mode boîte, seul le numéro répond :
« B 12 », « b-12 » et « B12 » trouvent la même boîte.

**Registre** — ajout, modification et suppression des destinataires (avec leur
numéro de boîte), filtre, import et export. Un courriel déjà présent est refusé, avec le nom sous
lequel il est enregistré.

**Exports** — le bouton **Exporter Excel** produit un vrai classeur `.xlsx` :
colonnes nommées et dimensionnées, en-tête figé, filtres actifs, dates
reconnues comme des dates. C'est le format à préférer.

Le bouton **CSV** reste disponible pour les échanges avec d'autres logiciels. Il
est écrit avec des points-virgules et une ligne `sep=;` : sans cela, un Excel
français ouvre le fichier **en une seule colonne**, puisqu'il attend le
point-virgule et non la virgule.

Le CSV d'import accepte un en-tête (`nom,courriel,boite` ou `name,email`) ou, à
défaut, les colonnes dans l'ordre nom, courriel, boîte, avec la virgule ou le
point-virgule comme séparateur. Les lignes fautives sont
signalées une par une, les doublons ignorés, et le reste est importé.

**Suivi des courriers** — chaque notification reste **en attente** tant que
personne n'a marqué la lettre comme retirée. Le guichet affiche les plus anciens
en tête, en rouge au-delà d'une semaine ; l'historique se filtre sur *En
attente* ou *Récupérés*.

Le bouton **Relancer** renvoie le message, avec la mention du nombre de jours
d'attente. `REMINDER_DAYS=7` dans `.env` fait relancer le serveur tout seul, au
plus trois fois par courrier et pas plus d'une fois par semaine.

**Pile de courrier** — au guichet, *Traiter une pile de courrier* accepte une
liste de noms ou de numéros de boîte, un par ligne. L'application les retrouve,
signale les introuvables et les ambigus, puis notifie tout le monde en un clic.

**Historique** — toutes les notifications, filtrables par texte, date et état,
exportables en CSV. Chaque entrée indique la voie utilisée : *Automatique*
(parti du serveur) ou *Logiciel de courriel* (préparé pour l'employé·e).

L'interface suit le **thème du système** : claire par défaut, sombre si votre
poste l'est. Aucune manipulation, aucun réglage à choisir.

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

## Sauvegarde

Le registre tient dans un seul fichier. L'onglet *Réglages* propose :

- **Télécharger une sauvegarde** — un fichier JSON à ranger ailleurs que sur le
  poste. Il contient le registre, l'historique et les réglages, mais **aucun
  secret** : ni mot de passe, ni jeton de boîte reliée ;
- **Copie sur le serveur** — une copie datée dans `data/sauvegardes/`, à raison
  d'une par jour, les quatorze dernières étant conservées.

Pour restaurer : arrêtez le serveur, remplacez `data/db.json` par la copie
choisie, redémarrez. La manœuvre est volontairement manuelle — un bouton
« restaurer » écrase le travail en cours d'un clic malheureux.

---

## Comptes du bureau

Le **premier compte créé** est celui du responsable : lui seul peut retirer un
accès. Chacun peut changer son mot de passe depuis *Réglages → Comptes* ; le
changement ferme toutes les autres sessions ouvertes, ce qui est précisément ce
qu'on veut quand on soupçonne un accès indésirable.

Retirer un accès ferme immédiatement les sessions de la personne. Le registre et
l'historique ne sont pas touchés.

---

## Sécurité

Ce que le serveur applique de lui-même, sans configuration :

- **Politique de contenu stricte** : aucun script, aucune police, aucune image
  ne peut venir d'ailleurs que du serveur, et rien ne part vers un tiers. La
  page ne peut pas non plus être encadrée par un autre site.
- **Mots de passe** hachés en scrypt avec sel aléatoire ; la connexion coûte le
  même temps qu'un compte existe ou non, pour ne pas révéler quelles adresses
  sont inscrites.
- **Sessions** par jeton aléatoire dans un cookie `HttpOnly`, `SameSite=Lax`,
  `Secure` dès que la connexion est en https. Les sessions et codes périmés sont
  effacés à chaque écriture.
- **Requêtes forgées** : toute requête modifiante venue d'un autre site est
  refusée, en plus de la protection du cookie.
- **Frein sur les tentatives** : connexion (8 essais / 10 min), code de
  confirmation (5 essais), demandes d'inscription (3 / heure et par adresse,
  pour que la route d'envoi de code ne serve pas à inonder une boîte).
- **Secrets** (jetons Google, mots de passe d'application) chiffrés en
  AES-256-GCM ; le registre est écrit en accès restreint au propriétaire.

Deux choses restent à votre charge : servir l'application en **https** dès
qu'elle sort du poste local, et sauvegarder `data/secret.key` avec le registre.

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
| `GET` | `/api/auth/me` | compte connecté, s'il y en a un |
| `POST` | `/api/auth/signup` `/login` `/logout` | comptes et sessions |
| `POST` | `/api/auth/verify` · `/resend` | code de confirmation de l'adresse |
| `PUT` `DELETE` | `/api/auth/mailbox/smtp` · `/api/auth/mailbox` | relier ou retirer sa boîte |
| `GET` | `/api/auth/google/start` · `/callback` | autorisation Gmail |
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
manifest.webmanifest  déclaration de l'application installable
sw.js                 service worker : coquille en cache, /api toujours en direct
assets/icons/         logo.svg (à remplacer) et icônes générées
tools/make-icons.js   régénère les icônes depuis logo.svg
tools/guide-nodejs.html      guide animé : installer Node.js sur Windows
tools/enregistrer-guide.js   filme ce guide et produit une vidéo
demarrer.cmd          lanceur Windows : démarre le serveur et ouvre l'application
docs/                 pas à pas d'installation (Windows + Gmail)
assets/css/style.css  feuille de style
assets/css/fonts.css  déclarations des polices embarquées
assets/fonts/         polices (woff2, sous-ensembles latin) — 216 Ko
assets/js/util.js     fonctions partagées navigateur + serveur (recherche, CSV, gabarits)
assets/js/xlsx.js     écriture de classeurs Excel, sans dépendance
assets/js/store.js    persistance : serveur → localStorage → mémoire
assets/js/notify.js   composition du message, mailto, presse-papiers
assets/js/app.js      interface (onglets, registre, historique, réglages)
server/app.js         serveur HTTP et API JSON
server/db.js          fichier JSON, écritures atomiques et sérialisées
server/mailer.js      envoi SMTP (nodemailer, optionnel) et mode essai
server/auth.js        mots de passe scrypt, sessions, limitation des tentatives
server/secrets.js     chiffrement des identifiants au repos (AES-256-GCM)
server/google.js      autorisation Gmail (OAuth 2.0)
server/reminders.js   courriers en attente et relances automatiques
test/                 tests (node:test), sans dépendance
.github/workflows/    intégration continue : npm test sur Node 20.12 et 22
```

```bash
npm test     # 102 tests : utilitaires, API, comptes, vérification, boîtes d'envoi
npm run dev  # rechargement automatique, mode essai pour le courriel
```

Les polices sont versionnées dans le dépôt : l'application s'affiche telle
quelle sur un poste sans accès à Internet, et aucune requête ne part vers un
service externe.

Aucune étape de compilation : le navigateur charge les fichiers tels quels, et
`assets/js/util.js` est le même fichier des deux côtés — les règles de recherche
et de validation ne peuvent donc pas diverger entre l'interface et le serveur.
