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

## Installation en un clic

**Windows** — double-cliquez sur **`installer.cmd`**. C'est tout.

**macOS, Linux** — double-cliquez sur `installer.sh`, ou lancez `./installer.sh`.

L'installateur ne pose aucune question et ne demande aucun droit
administrateur. Il :

1. cherche un Node.js utilisable sur le poste ;
2. s'il n'y en a pas, télécharge la version LTS depuis `nodejs.org`, **vérifie
   son empreinte SHA-256** et la range dans `runtime/` — rien n'est installé sur
   le système, rien n'est ajouté au `PATH`, tout disparaît si l'on efface le
   dossier de l'application ;
3. écrit un fichier `.env` avec une clé de chiffrement **et un code de reprise**
   tirés au sort — le code s'affiche une fois, à noter sur papier ;
4. installe `nodemailer` si le réseau le permet, et poursuit sans lui sinon ;
5. lance les contrôles internes ;
6. pose un raccourci sur le Bureau (Windows) ;
7. démarre le serveur et ouvre le navigateur.

Relancer l'installateur est sans danger : ce qui est déjà en place est conservé,
`.env` compris. Les jours suivants, le raccourci du Bureau — ou `demarrer.cmd`,
ou `./demarrer.sh` — suffit.

L'envoi automatique des courriels reste à configurer une fois, si vous le
voulez : voir *Envoi entièrement automatique* ci-dessous. Sans lui,
l'application fonctionne et ouvre votre logiciel de courriel avec le message
déjà rédigé.

---

## Démarrage à la main

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

Sur Windows, une fois la configuration faite, double-cliquez **`demarrer.cmd`**
ou le raccourci posé sur le Bureau : le serveur démarre et l'application
s'ouvre. Aucune commande à retenir.

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
« B 12 », « b-12 » et « B12 » trouvent la même boîte. Si la saisie ne correspond
à aucune boîte mais à un nom, l'application le dit et propose le destinataire —
on tape ce qu'on lit sur l'enveloppe, sans penser au sélecteur.

**Remise** — un onglet à part, séparé du guichet : d'un côté le courrier qui
arrive, de l'autre celui qui repart. On y saisit le code de retrait — la fiche
du courrier s'affiche pour vérification avant de valider — ou on retrouve le
courrier dans la liste des courriers en attente, filtrable par nom ou par boîte.

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

**Types de courrier** — lettre, recommandé, colis, administratif. Le type choisi
au guichet change le message envoyé et **le délai de relance** : cinq jours pour
un colis qui encombre, sept pour un recommandé, le délai général pour une lettre
ordinaire.

**Code de retrait** — chaque notification contient un code à quatre chiffres.
Le destinataire le présente au guichet, l'agent le saisit dans *Remise d'un
courrier*, et le courrier est marqué récupéré automatiquement. Plus d'oubli de
cochage, et une trace exacte de ce qui a été remis. Les codes sont uniques parmi
les courriers en attente.

**Retrait par un tiers** — un voisin, un collègue, un proche se présente à la
place du destinataire. La fiche de remise propose de le nommer ; ce nom est
enregistré à côté du destinataire, apparaît dans l'historique et la fiche de la
personne, et le pavé de signature demande la signature de qui se présente
réellement. Sans cette trace, le registre affirmerait que le destinataire est
venu lui-même — ce qui est faux, et c'est justement ce qui manque en cas de
litige.

Le code **n'emporte pas la remise** : il ouvre d'abord une **fiche de
vérification** — destinataire, numéro de boîte, type de courrier, date de
réception et jours d'attente, adresse prévenue, nombre de relances, et l'absence
éventuelle de la personne. L'agent voit ce qu'il s'apprête à remettre avant de
valider ; c'est ce coup d'œil qui évite de donner l'enveloppe à la mauvaise
personne. Si le destinataire a **d'autres courriers en attente**, ils sont
listés et cochés d'avance : un seul passage au guichet suffit. *Confirmer la
remise* ouvre le pavé de signature ; *Annuler* n'a rien changé.

**Recherche tolérante** — quand aucun nom ne correspond exactement, l'application
propose les plus proches : « Tremblet » suggère « Élodie Tremblay ». Les noms
sur les enveloppes sont rarement exacts.

**Fiche d'un destinataire** — le bouton *Fiche* du registre montre tout son
historique : courriers reçus, retirés, en attente, délai moyen de retrait, et
les codes des courriers qui l'attendent encore.

**Récapitulatif hebdomadaire** — chaque lundi matin, le responsable reçoit par
courriel l'état du bureau : reçus, retirés, en attente, à traiter, et les dix
plus anciens. Réglé par `DIGEST_DAY`, `DIGEST_HOUR` et `DIGEST_TO`
(`DIGEST_DAY=0` le désactive).

**Suivi des courriers** — chaque notification reste **en attente** tant que
personne n'a marqué la lettre comme retirée. Le parcours se fait tout seul :

| Quand | Ce qui se passe |
|---|---|
| Réception | notification envoyée, courrier *en attente* |
| **15 jours** sans retrait | **relance automatique** au destinataire |
| **15 jours de plus** | le courrier passe au **dossier à traiter** |

Les deux délais se règlent par `REMINDER_DAYS` et `ESCALATION_DAYS` ;
`REMINDER_DAYS=0` désactive l'automatisme, le bouton **Relancer** restant
disponible. Un courrier est relancé au plus trois fois.

L'onglet **Dossier** répond à la question « qui a récupéré, qui n'a pas » :
combien de courriers ont été relancés, combien ont été retirés à la suite de la
relance, combien attendent toujours. Pour chacun, on peut le marquer récupéré,
le relancer encore, ou le **classer** avec un motif — retourné à l'expéditeur,
remis en main propre, détruit. Le motif et la personne qui a classé sont
conservés, et un courrier classé se rouvre si besoin.

Le signalement ne dépend pas du courriel : même sans SMTP, les courriers trop
anciens apparaissent au dossier.

**Pile de courrier** — au guichet, *Traiter une pile de courrier* accepte une
liste de noms ou de numéros de boîte, un par ligne. L'application les retrouve,
signale les introuvables et les ambigus, puis notifie tout le monde en un clic.

**Historique** — toutes les notifications, filtrables par texte, date et état,
exportables en CSV. Chaque entrée indique la voie utilisée : *Automatique*
(parti du serveur) ou *Logiciel de courriel* (préparé pour l'employé·e).

L'interface suit le **thème du système** : claire par défaut, sombre si votre
poste l'est. Aucune manipulation, aucun réglage à choisir.

**Réglages** — l'expéditeur (**De**), les copies **Cc** et **Cci** par défaut, le
sujet et le corps du message, avec aperçu en direct. Variables disponibles : `{nom}`, `{courriel}`, `{date}`, `{bureau}`, `{type}`,
`{article}` (« Un colis », « Un courrier recommandé »…) et `{code}`. Le code de
retrait est de toute façon ajouté au message, quel que soit le gabarit.

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

## Absences et remplaçants

Un destinataire peut être marqué **absent jusqu'à une date**, ou **parti de
l'organisme**, avec un **remplaçant** désigné. Le guichet prévient alors avant
d'envoyer et propose de notifier le remplaçant à sa place — le message précise
qu'il assure le relais. Sans cela, l'application notifierait quelqu'un qui ne
viendra pas.

## Signature de remise

À chaque remise, un pavé de signature s'ouvre : la personne signe du doigt ou à
la souris, et la signature est attachée au courrier. Elle peut être passée d'un
clic quand elle n'est pas nécessaire. C'est la seule preuve réelle de remise —
le code de retrait, lui, ne prouve rien : il évite les erreurs de marquage.

## Journal et statistiques

L'onglet *Réglages* tient le **journal d'activité** : qui a ajouté, modifié ou
supprimé un destinataire, qui a remis ou classé quel courrier. Les cent
dernières actions, bornées à deux mille en tout.

L'onglet *Dossier* affiche les **statistiques** : volumes sur sept jours, trente
jours et douze mois, taux de retrait, délai moyen, boîtes les plus actives.

## Feuille de casier

Le bouton **Feuille de casier** imprime la liste des courriers en attente triée
par numéro de boîte, avec une case à cocher pour le retrait — utile quand tout
le monde n'a pas accès à l'application.

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

## Domiciliation

Une association agréée peut servir d'adresse administrative à des personnes sans
domicile stable : c'est cette adresse qui leur permet de recevoir les courriers
de la CAF, de France Travail, de la préfecture, de l'assurance maladie. Deux
échéances pèsent sur ce dispositif, et aucune ne se surveille de tête sur trois
cents dossiers. L'onglet **Domiciliation** les tient à jour tout seul.

**Ouvrir un dossier.** Le bouton *Ouvrir un dossier* déplie le formulaire
d'élection de domicile : identité, date de naissance, langue de correspondance,
courriel, téléphone, date d'élection, numéro de boîte, observations. L'échéance
de l'attestation s'affiche pendant la saisie. Ce qui est saisi **entre
directement au registre** : la personne reçoit dès lors ses avis de courrier,
sans double saisie ni recopie. *Imprimer la fiche* sort la même chose sur papier,
à faire signer et à classer.

Le formulaire réclame au moins un courriel **ou** un téléphone : sans l'un des
deux, personne ne pourra prévenir la personne le jour où un courrier arrive, et
mieux vaut le dire à la saisie que le découvrir ce jour-là.

C'est un geste d'accueil, pas d'administration du registre : **un agent peut
ouvrir un dossier** sans avoir le droit de modifier le registre — il ne pourra
pour autant ni corriger ni supprimer la fiche ensuite.

**Personnes domiciliées.** Le registre des élections de domicile en cours, avec
son échéance et son état, filtrable par nom ou par boîte, exportable en Excel et
imprimable. Les deux listes suivantes ne montrent que ce qui cloche ; celle-ci
montre tout le monde. Un agent rattaché à une antenne n'y voit que la sienne.

**Imprimer l'attestation.** C'est le document que la personne présente au
guichet de la CAF, de France Travail ou de la préfecture. Il s'imprime depuis
trois endroits : le message de confirmation, juste après l'ouverture du dossier
— c'est là que la personne est devant vous ; le bouton *Attestation* de chaque
ligne du registre ; et la fiche du destinataire.

L'attestation reprend l'en-tête de l'organisme, l'identité de la personne, la
date d'élection de domicile, l'adresse à laquelle son courrier lui est adressé,
et la date jusqu'à laquelle elle vaut. Renseignez une fois *Réglages →
Organisme domiciliataire* : adresse, ville, agrément préfectoral. Avec plusieurs
antennes, l'adresse de l'antenne du dossier est utilisée si elle est renseignée.

Les mentions manquantes deviennent des traits à compléter à la main : mieux vaut
une attestation à finir au stylo qu'un refus d'imprimer un jour d'affluence.

**Ce qui ne s'imprime pas.** Une attestation n'est jamais délivrée pour une
domiciliation **close**, ni pour une attestation **échue** — l'application le
dit et ne sort rien. Un papier qui contredirait le registre enverrait quelqu'un
se faire refuser à un guichet, avec un document de notre main à l'appui.

L'application n'imite aucun formulaire officiel : c'est l'attestation de
l'organisme, sous son propre en-tête.

**Attestations à renouveler.** Une attestation d'élection de domicile a une
durée de validité — un an par défaut. Périmée, elle coupe l'accès aux droits,
souvent sans que personne ne s'en aperçoive avant le refus d'un guichet. On
inscrit la date d'élection de domicile ; l'échéance est calculée, affichée sous
les yeux pendant la saisie, et le dossier remonte dans la liste un mois avant le
terme, puis y reste s'il est dépassé.

**Sans passage depuis longtemps.** La domiciliation peut prendre fin après trois
mois sans que la personne se soit présentée ni manifestée. Le registre sait déjà
quand chacun est venu chercher son courrier : la liste se calcule sans rien
saisir de plus. Une visite sans courrier compte tout autant — le bouton **Noter
un passage**, sur la fiche comme dans la liste, l'enregistre en un clic. Sans ce
geste, quelqu'un qui vient régulièrement mais n'a jamais de courrier
apparaîtrait comme disparu.

**Un appel de la personne compte aussi.** La règle dit « présentée **ou
manifestée** » : téléphoner pour savoir si on a du courrier en est une. La carte
**La personne appelle**, dans l'onglet Remise, note cet appel — il repart le
décompte des trois mois, exactement comme une venue, et marque au passage son
courrier comme annoncé puisqu'elle vient de l'apprendre. Sans cela, quelqu'un
qui téléphone tous les mois sans pouvoir se déplacer — parce qu'il travaille,
parce qu'il est hospitalisé, parce qu'il n'a pas de quoi payer le transport —
arrivait sur la liste des radiations.

Le registre garde la distinction : la fiche dit « passage », « appel de sa
part » ou « courrier retiré ». Le décompte ne fait pas la différence ;
l'équipe, elle, doit pouvoir la faire.

Une attestation valable n'empêche pas d'être menacé de radiation, et
inversement : ce sont deux problèmes distincts, et un dossier peut figurer sur
les deux listes.

**Rapport annuel.** Domiciliations actives, ouvertes et closes dans l'année,
motifs de clôture, volume de courrier reçu et retiré. À l'écran, en classeur
Excel, ou imprimé.

Les durées se règlent, pour suivre une pratique locale :

```bash
DOMICILIATION_MOIS=12          # validité de l'attestation
DOMICILIATION_ABSENCE_MOIS=3   # seuil d'absence
```

L'application calcule des dates ; elle ne dit pas le droit. L'appréciation de
chaque situation reste à l'équipe.

---

## Restaurer une sauvegarde

Les copies datées écrites sur le serveur se relisent depuis l'écran :
*Réglages → Sauvegarde du registre → Restaurer une copie*. Chaque ligne annonce
sa date et ce qu'elle contient — nombre de destinataires et de courriers —
parce qu'on ne restaure pas à l'aveugle un fichier dont on ignore s'il est plein
ou presque vide.

Avant d'écraser quoi que ce soit, l'état présent est copié sous
`avant-restauration-…json` : restaurer est une opération qu'on peut regretter,
et l'annuler doit rester possible. **Les comptes et les sessions ne sont jamais
touchés** — remettre le registre d'hier ne doit pas faire perdre l'accès à
l'application.

## Durée de conservation

*Réglages → Durée de conservation.* Au-delà du délai choisi, les courriers
**déjà retirés ou classés** sont effacés du registre. Ceux qui attendent encore
ne sont jamais touchés, quel que soit leur âge : un courrier non remis reste un
courrier non remis.

Illimitée par défaut, pour ne rien effacer sans décision explicite. Un registre
qui garde tout indéfiniment expose bien plus qu'il ne devrait le jour d'une
fuite, et la durée de conservation est aussi une obligation.

---

## Messages en plusieurs langues

Une notification qu'on ne peut pas lire ne notifie rien. Chaque destinataire
porte une **langue**, choisie à l'inscription — huit sont proposées, dont
l'arabe, l'ukrainien et le roumain.

*Réglages → Message → Langue du message* : on choisit une langue, puis on écrit
le texte. Les champs passent en écriture de droite à gauche quand la langue le
demande. Les onglets par type (lettre, colis, recommandé, administratif)
fonctionnent à l'intérieur de chaque langue.

Le message envoyé suit cet ordre, du plus précis au plus général :

1. le texte de **la langue pour ce type** — « colis » en arabe ;
2. le texte **de la langue** — message courant en arabe ;
3. le texte **du type** en français ;
4. le **modèle français général**.

Une langue sans texte propre retombe donc sur le français, plutôt que de ne rien
envoyer. Les relances suivent la même règle.

**L'application ne traduit rien** : chaque texte est écrit par le bureau. C'est
volontaire — une traduction automatique d'un courrier administratif ferait plus
de dégâts qu'un message en français.

---

## Les personnes sans adresse électronique

Une bonne partie du public d'un bureau de domiciliation n'a pas de courriel —
c'est souvent la raison même pour laquelle ces personnes viennent. **Une fiche
est valable avec un courriel *ou* un téléphone.**

Ce qui change dans le parcours :

- le courrier s'enregistre normalement, avec son **code de retrait**, même
  quand aucun message ne peut partir ;
- il apparaît dans **Remise → À prévenir par téléphone**, avec le numéro en
  gros, la boîte et depuis combien de temps il attend ;
- l'agent note l'appel : **Prévenue** si la personne a répondu, **Sans réponse**
  sinon. Une tentative n'est pas une notification : le courrier reste à
  annoncer tant que personne n'a été joint ;
- le **téléphone s'affiche sur la fiche de remise**, à la place du courriel —
  c'est là que l'agent en a besoin ;
- les **relances automatiques ignorent** ces courriers : il n'y a pas d'adresse
  où écrire. Ils se suivent à la main, par la liste des appels.

> Avant, le serveur refusait toute fiche sans courriel valide. La fiche était
> rejetée, donc le courrier ne pouvait pas être enregistré, donc personne ne
> pouvait le remettre. Le formulaire de domiciliation, lui, promettait
> « courriel **ou** téléphone » — il promettait ce que l'application refusait.

## Vérifier le parcours complet

```bash
npm install -D playwright
node tools/parcours.js              # sur http://localhost:3000
PORT=8080 node tools/parcours.js    # ailleurs
CAPTURES=./captures node tools/parcours.js
```

Le script joue tout le chemin dans un vrai navigateur : installation, identité
du bureau, accès agent, **deux domiciliations — l'une avec courriel, l'autre
avec seulement un téléphone**, arrivée du courrier, appel, retrait, passage
sans courrier, attestation, rapport annuel.

Sa sortie est numérotée et se lit sans connaître le code : **imprimez-la et
affichez-la au guichet**, elle forme une remplaçante. Il rend un code d'erreur
non nul si une étape casse, ce qui permet de l'enchaîner après les tests.

---

## Plusieurs postes dans le bureau

Quatre ordinateurs à l'accueil, reliés par le même wifi ou le même câble.
L'application **ne s'installe pas quatre fois** : quatre registres séparés
donneraient quatre vérités différentes sur le même courrier. Elle s'installe sur
**un** poste — celui du responsable — et les autres l'ouvrent dans leur
navigateur.

**Marche à suivre complète : [docs/plusieurs-postes.md](docs/plusieurs-postes.md).**
Sur le poste du responsable, `installer-plusieurs-postes.cmd` puis
`certificat.cmd` ; sur les trois autres, `confiance.cmd` une fois, et c'est tout.

**Quelle adresse taper.** Au démarrage, le serveur l'affiche :

```
  sur ce poste  http://localhost:3000
  autres postes http://accueil-pc:3000
                http://192.168.1.10:3000  (câble)
```

On la retrouve à l'écran dans *Réglages → Postes du bureau*, avec un bouton
**Copier** et une **fiche imprimable** à scotcher sur chacun des autres écrans.
Tapez le **nom du poste** de préférence à l'adresse : le nom ne change pas
quand la box redistribue les adresses. Si l'adresse a tout de même bougé,
l'application le signale pendant une semaine, en rappelant l'ancienne.

**Les quatre écrans en direct.** Un courrier signalé sur un poste apparaît sur
les trois autres **sans rechargement**, et une remise faite à un guichet
disparaît aussitôt des autres. Sans cela, deux agents pourraient remettre le
même pli. Une saisie en cours n'est jamais balayée par ce qu'écrit un autre
poste : le formulaire que vous remplissez reste tel quel.

*Réglages → Postes du bureau* montre aussi **qui est relié en ce moment** —
c'est la réponse à « est-ce que mes quatre postes se parlent ? ».

**Ce qui circule.** Le message envoyé aux autres postes ne contient qu'un
numéro d'ordre : chacun redemande alors son état, filtré selon ses droits et
son antenne. Un agent sans le droit *voir les codes* n'apprend donc rien de
plus par ce canal.

**Deux pièges à connaître.**

L'installation ordinaire écrit `HOST=127.0.0.1` : le serveur n'écoute alors que
sur son propre poste, et **les autres ne joindront rien, quelle que soit
l'adresse tapée**. Aucun message ne le dit au poste qui essaie — l'application
le signale donc du côté du responsable, dans *Réglages → Postes du bureau*.
`installer-plusieurs-postes.cmd` s'en charge d'emblée.

De même, sans règle de pare-feu, les autres postes n'obtiennent qu'une page qui
ne charge jamais, sans erreur. L'installateur pose la règle quand il a les
droits administrateur, et affiche la commande exacte sinon.

**En http, sur le réseau local**, le mot de passe circule en clair et les trois
autres postes ne peuvent ni installer l'application ni travailler hors ligne —
les navigateurs réservent cela aux adresses reconnues sûres. `certificat.cmd`
(ou `tools/certificat.sh`) fabrique le certificat sans rien installer ;
`confiance.cmd` le fait reconnaître sur chacun des autres postes.

Le poste qui tient le registre doit rester allumé : c'est lui le bureau.

---

## Plusieurs antennes

Un même organisme peut tenir plusieurs points d'accueil. *Réglages → Antennes*
en déclare autant qu'il en faut, avec leur adresse. **Tant que la liste est
vide, l'application n'en montre rien** : un bureau unique n'a pas à porter le
vocabulaire d'un réseau.

Dès qu'une antenne existe, un sélecteur apparaît en en-tête. Il filtre le
registre, l'historique et les domiciliations — le choix est retenu d'un
rechargement à l'autre. Chaque destinataire, chaque courrier et chaque accès
d'agent peut être rattaché à une antenne.

Un accès d'agent rattaché à une antenne y est **enfermé** : son sélecteur est
figé, et le serveur ne lui envoie que ce qui la concerne. Le tri se fait avant
l'envoi, pas à l'affichage — le registre des autres points d'accueil ne transite
jamais par ce poste.

---

## Deux façons d'entrer : responsable et agents

L'application a **deux portes d'entrée**, pour deux usages différents.

**Le responsable** entre avec un courriel et un mot de passe. C'est le compte
créé au tout premier démarrage, celui du bureau. Il voit tout, règle tout, et
c'est lui qui distribue les accès.

**Un agent** entre avec un **identifiant** (`AB-1234`) et un **code d'accès** à
six chiffres, remis par le responsable. Pas de courriel à créer, pas de mot de
passe à retenir : un poste d'accueil tenu par plusieurs personnes n'a pas à
gérer des boîtes mail. Il ouvre l'application depuis n'importe quel poste.

### Créer un accès

*Réglages → Accès des agents → Créer un accès.* On donne un nom — « Accueil du
matin », « poste 2 » — et l'on coche ce que la personne pourra faire.
L'identifiant est tiré au sort, le code aussi.

**Le code n'est montré qu'une fois.** Il n'est conservé que haché : perdu, il
se régénère, il ne se retrouve pas.

### Ce qu'un agent peut faire

Par défaut, il tient le guichet et remet le courrier — **sans voir les codes de
retrait** et sans pouvoir modifier le registre. Sept droits se cochent un par
un : guichet, remise, voir les codes, modifier le registre, domiciliation,
exporter et imprimer, réglages.

Le masquage n'est pas cosmétique : les codes sont **retirés du contenu envoyé
par le serveur**, remplacés par `••••`. Un onglet de développeur ne les
retrouverait pas. L'agent peut malgré tout remettre un courrier : il saisit le
code que la personne lui présente, il ne le découvre pas dans l'application.

Le responsable modifie les autorisations à tout moment ; le changement prend
effet au rechargement suivant. **Suspendre** ferme aussitôt la session ouverte ;
**régénérer le code** invalide l'ancien sur-le-champ ; **supprimer** ferme
l'accès définitivement.

### Code de reprise du compte responsable

Sous le formulaire de connexion, le lien **Code de reprise** ouvre la dernière
porte. Avec ce code, et sans être connecté, on peut changer l'adresse du compte
responsable, changer son mot de passe, ou le supprimer — ce qui rouvre
l'installation au prochain démarrage, sans toucher au registre ni aux accès des
agents. Le code ne donne aucun accès aux données.

Il n'est **jamais conservé en clair** : seule son empreinte est écrite au
registre, au premier démarrage.

> **L'installateur s'en charge.** Il tire un code propre à votre bureau, l'écrit
> dans `.env` et l'affiche **une seule fois**, groupé par quatre pour se dicter
> et se recopier :
>
> ```
>       4821 9037 5164
> ```
>
> Notez-le sur papier et rangez-le : seule son empreinte est conservée, il ne se
> retrouve pas. Un bureau installé avant cette version le reçoit au prochain
> passage de l'installateur, qui ajoute la ligne sans toucher au reste du
> fichier.
>
> Pour une installation à la main, ou pour en changer, tirez-en un et écrivez-le
> vous-même :
>
> ```bash
> node tools/code-maitre.js        # un code à recopier dans .env
> ```
>
> Tant que la valeur d'origine — publiée avec le code source — reste en place,
> le serveur n'accepte la reprise que **depuis la machine qui tient le
> registre**, et le responsable voit un avertissement dans Réglages.
>
> C'est une clé de coffre, pas un mécanisme d'authentification : elle ne vaut
> que ce que vaut sa confidentialité. Les tentatives sont freinées, et chaque
> usage est inscrit au journal.

**Tant que le code n'a pas été changé, la reprise n'est acceptée que depuis le
poste qui fait tourner le serveur.** Les autres postes du bureau reçoivent un
refus expliquant quoi faire. C'est le garde-fou qui rend le code d'origine
inoffensif sur le réseau local : le freinage des tentatives ne protège de rien
quand le code est publié — il n'y a rien à deviner. Dès que `MASTER_CODE` porte
une valeur à vous, la reprise redevient possible depuis n'importe quel poste.

Le responsable voit un avertissement dans **Réglages → Les accès** tant que le
code d'origine est en place. Les agents ne le voient pas : le signaler
reviendrait à indiquer la porte.

---

## Comptes du bureau

Le **premier compte créé** est celui du responsable : lui seul peut retirer un
accès. Chacun peut changer son mot de passe depuis *Réglages → Comptes* ; le
changement ferme toutes les autres sessions ouvertes, ce qui est précisément ce
qu'on veut quand on soupçonne un accès indésirable.

Retirer un accès ferme immédiatement les sessions de la personne. Le registre et
l'historique ne sont pas touchés.

### Mot de passe oublié

Le lien **Mot de passe oublié ?** figure sous le formulaire de connexion. Il
demande l'adresse du compte et y envoie un code à six chiffres, valable trente
minutes. Tant que le code n'a pas servi, l'ancien mot de passe continue de
fonctionner — recevoir ce courriel sans l'avoir demandé n'a donc aucune
conséquence. Une fois le nouveau mot de passe choisi, toutes les sessions
ouvertes sont fermées et la personne est connectée dans la foulée.

La réponse est la même que l'adresse ait un compte ou non : ce formulaire ne
peut pas servir à découvrir qui est inscrit dans ce bureau.

**Si le bureau n'a pas de serveur de courriel**, le code ne peut arriver nulle
part. La reprise se fait alors depuis la machine qui héberge le registre :

```bash
npm run motdepasse                          # liste les comptes
npm run motdepasse -- marie@bureau.org      # tire un mot de passe et l'affiche
npm run motdepasse -- marie@bureau.org "le mot de passe choisi"
```

La commande ferme les sessions du compte concerné et inscrit l'opération au
journal. Elle n'exige aucun mot de passe : avoir la main sur cette machine, c'est
déjà avoir accès au fichier du registre. Le serveur peut tourner pendant
l'opération.

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

Le serveur écoute en **https** dès que `HTTPS_KEY` et `HTTPS_CERT` sont
renseignés — marche à suivre complète dans
[`docs/mise-en-service-https.md`](docs/mise-en-service-https.md). Reste à votre
charge : obtenir le certificat et sauvegarder `data/secret.key` avec le
registre.

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
| `POST` | `/api/auth/forgot` · `/reset` | mot de passe oublié : code puis nouveau mot de passe |
| `POST` | `/api/auth/login-code` | entrée d'un agent par identifiant |
| `GET` `POST` | `/api/auth/agents` | lister / créer un accès agent |
| `PUT` `DELETE` | `/api/auth/agents/:id` | autorisations, suspension, suppression |
| `POST` | `/api/auth/agents/:id/code` | régénérer le code d'accès |
| `POST` | `/api/auth/master` | code de reprise du compte responsable |
| `PUT` `DELETE` | `/api/auth/mailbox/smtp` · `/api/auth/mailbox` | relier ou retirer sa boîte |
| `GET` | `/api/auth/google/start` · `/callback` | autorisation Gmail |
| `GET` | `/api/state` | registre + historique + réglages |
| `GET` | `/api/flux` | flux d'événements : prévient les autres postes d'une écriture |
| `GET` | `/api/reseau` | adresse de ce serveur, postes reliés en ce moment |
| `GET` `POST` | `/api/contacts` | lister / ajouter un destinataire |
| `PUT` `DELETE` | `/api/contacts/:id` | modifier / supprimer |
| `POST` | `/api/contacts/:id/passage` | la personne s'est manifestée — sur place, ou par téléphone (`moyen`) |
| `POST` | `/api/history/:id/appel` | appel passé à une personne sans courriel |
| `GET` | `/api/domiciliation` | échéances, absences, rapport annuel |
| `GET` `POST` `DELETE` | `/api/history` | historique : lire, ajouter, vider |
| `GET` | `/api/history/by-code/:code` | fiche du courrier, sans rien modifier |
| `POST` | `/api/history/pickup-by-code` | remise après vérification |
| `GET` `PUT` | `/api/settings` | gabarit du message |
| `POST` | `/api/notify` | envoyer un courriel et le consigner |

`/api/notify` accepte `from`, `cc` et `bcc` : fournis, ils l'emportent sur les
réglages ; absents, ce sont les réglages qui s'appliquent ; une chaîne vide
retire la copie pour cet envoi.

Les erreurs sont renvoyées en JSON (`{"error": "…"}`) avec un code parlant :
`400` donnée invalide, `404` introuvable, `409` courriel déjà au registre,
`502` refus du serveur de courriel, `503` envoi automatique non configuré.

Un `401` accompagné de `{"code": "session"}` — et lui seul — signifie que la
session a expiré ; l'interface renvoie alors à l'écran de connexion. Un refus
portant sur la valeur envoyée (mot de passe actuel erroné, par exemple) répond
`403` : la session reste ouverte, une faute de frappe ne déconnecte personne.

---

## Modifier les scripts PowerShell

Deux règles, et elles ne sont pas cosmétiques : les enfreindre empêche le
script de **s'analyser**, donc de démarrer du tout, avec une avalanche
d'erreurs rouges qui ne désigne jamais la vraie cause.

1. **Enregistrez les `.ps1` en UTF-8 avec BOM.** Sans BOM, Windows PowerShell
   5.1 — celui livré avec Windows — lit le fichier en Windows-1252. Le tiret
   cadratin `—` s'y termine par l'octet `0x94`, qui vaut `”` : un guillemet,
   qui ferme une chaîne en plein milieu.
2. **Pas d'apostrophe typographique `’` dans le code.** PowerShell la traite
   comme un délimiteur de chaîne, BOM ou pas. Écrivez une apostrophe droite,
   doublée à l'intérieur d'une chaîne simple : `'s''ouvrir'`.

Les `.cmd`, eux, ne prennent **pas** de BOM : `cmd.exe` l'afficherait à
l'écran. Ils déclarent déjà `chcp 65001`.

`test/powershell.test.js` vérifie les deux points sur chaque script, sans
avoir besoin de Windows ni de PowerShell.

---

## Développement

```
index.html            interface
manifest.webmanifest  déclaration de l'application installable
sw.js                 service worker : coquille en cache, /api toujours en direct
assets/icons/         logo.svg (à remplacer) et icônes générées
installer.cmd         installation en un clic (Windows)
installer.sh          installation en un clic (macOS, Linux)
tools/installer.ps1   le travail de l'installateur Windows
tools/make-icons.js   régénère les icônes et favicon.ico depuis logo.svg
tools/mot-de-passe.js rend l'accès à un compte depuis le poste serveur
tools/guide-nodejs.html      guide animé : installer Node.js sur Windows
tools/enregistrer-guide.js   filme ce guide et produit une vidéo
demarrer.cmd          lanceur Windows : démarre le serveur et ouvre l'application
docs/                 installation Windows + Gmail, boîtes reliées, mise en https
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
tools/verifier/       vérifications de navigateur, une par défaut corrigé
.github/workflows/    intégration continue : npm test sur Node 20.12 et 22
```

```bash
npm test     # 334 tests : utilitaires, API, comptes, domiciliation, appels, socle
npm run dev  # rechargement automatique, mode essai pour le courriel
```

### Deux niveaux de vérification

`npm test` **n'a besoin d'aucune dépendance** : c'est la propriété à préserver,
et elle se vérifie en lançant la commande dans un dépôt sans `node_modules`.
Tout ce qui est calculable — règles de domiciliation, listes d'appels, bornes
d'affichage, droits, filtrage par antenne — vit dans des modules chargeables des
deux côtés et se teste là, vite et partout.

Reste ce qui exige un écran. Sept parcours cliquent pour de vrai :

```bash
npm i                    # installe Playwright (outillage seulement)
npx playwright install chromium
npm run verifier         # les sept, chacun sur son serveur et sa base
npm run verifier -- rappel   # un seul
npm run parcours         # le parcours complet, qui s'imprime comme procédure
```

Chacun garde fermé un défaut qui a réellement existé : un téléphone corrigé qui
repartait inchangé, une suppression qu'on croyait être un effacement, un code de
reprise utilisable depuis tout le réseau, une personne appelée une seule fois et
jamais relancée, un appel qui ne comptait pas comme manifestation. Ce ne sont
pas des démonstrations — ce sont des verrous.

Playwright est une dépendance de **développement** : ni le serveur ni
l'interface ne la chargent. Un poste de réception n'installe rien de tout cela.

Les polices sont versionnées dans le dépôt : l'application s'affiche telle
quelle sur un poste sans accès à Internet, et aucune requête ne part vers un
service externe.

Aucune étape de compilation : le navigateur charge les fichiers tels quels, et
`assets/js/util.js` est le même fichier des deux côtés — les règles de recherche
et de validation ne peuvent donc pas diverger entre l'interface et le serveur.
