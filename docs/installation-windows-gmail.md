# Envoi automatique avec Gmail, sur un PC Windows

Objectif : que l'application expédie elle-même les courriels, sans passer par
un logiciel de courriel. Comptez une quinzaine de minutes la première fois.

Tant que cette configuration n'est pas faite, l'application fonctionne — mais
chaque notification est seulement *préparée*, et il faut cliquer sur *Envoyer*
dans votre logiciel de courriel.

---

## 1. Installer Node.js

Node.js est le moteur qui fait tourner l'application. Une seule installation,
une fois pour toutes.

1. Ouvrez <https://nodejs.org/fr> et téléchargez la version **LTS**.
2. Lancez le fichier téléchargé et acceptez les options par défaut.
3. Redémarrez le PC si l'installateur le demande.

Pour vérifier : ouvrez le menu Démarrer, tapez `powershell`, ouvrez
**Windows PowerShell**, tapez `node --version` puis Entrée. Un numéro de version
doit s'afficher (par exemple `v22.11.0`).

---

## 2. Créer un mot de passe d'application Google

Google refuse le mot de passe habituel du compte pour ce genre d'usage. Il faut
un **mot de passe d'application**, propre à cette application et révocable à
tout moment.

1. La **validation en deux étapes** doit être active sur le compte :
   <https://myaccount.google.com/security> → *Validation en deux étapes*.
   Sans elle, l'étape suivante n'est pas proposée.
2. Ouvrez <https://myaccount.google.com/apppasswords>.
3. Donnez un nom parlant — par exemple `Bureau du Courrier` — puis validez.
4. Google affiche **16 lettres** en quatre groupes. Copiez-les. Elles ne seront
   plus affichées ensuite.

Ce mot de passe ne donne accès qu'à l'envoi de courriel, pas au compte Google.
Si le poste est perdu ou l'application retirée, révoquez-le sur cette même page.

> **Compte Google professionnel (Workspace)** : si la page des mots de passe
> d'application est inaccessible, c'est que votre administrateur l'a désactivée.
> Demandez-lui soit de l'autoriser, soit les paramètres SMTP internes de
> l'organisation — l'application accepte n'importe quel serveur SMTP.

---

## 3. Renseigner le fichier `.env`

Ce fichier contient les identifiants d'envoi. Il n'est jamais partagé ni envoyé
sur GitHub.

Ouvrez PowerShell **dans le dossier de l'application** : ouvrez le dossier dans
l'Explorateur, cliquez dans la barre d'adresse, tapez `powershell` et Entrée.

Puis, une commande à la fois :

```powershell
copy .env.example .env
notepad .env
```

> Passez par cette commande plutôt que par l'Explorateur : Windows ne permet pas
> de créer facilement un fichier dont le nom commence par un point.

Dans le Bloc-notes, remplacez les lignes SMTP par celles-ci, avec **votre**
adresse et le mot de passe d'application de l'étape 2 (gardez les espaces entre
les groupes ou retirez-les, les deux fonctionnent) :

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre.adresse@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
MAIL_FROM=Bureau du Courrier <votre.adresse@gmail.com>
MAIL_DRY_RUN=false
```

Enregistrez (Ctrl+S) et fermez le Bloc-notes.

`MAIL_FROM` doit reprendre l'adresse de `SMTP_USER` : Gmail refuse d'expédier au
nom d'une autre adresse. Seul le libellé devant les chevrons est libre.

---

## 4. Installer le module d'envoi et démarrer

Toujours dans PowerShell, dans le dossier de l'application :

```powershell
npm install
npm start
```

Le démarrage doit afficher :

```
  courriel    SMTP smtp.gmail.com:587 (de : Bureau du Courrier <votre.adresse@gmail.com>)
```

Si vous lisez `courriel    inactif`, la cause est indiquée juste après sur la
même ligne.

Ouvrez ensuite <http://localhost:3000>.

**Les fois suivantes**, double-cliquez simplement sur **`demarrer.cmd`** : il
lance le serveur et ouvre l'application. Laissez la fenêtre noire ouverte tant
que vous utilisez l'application ; fermez-la pour arrêter.

---

## 5. Vérifier

Dans l'application, onglet **Réglages** → **Envoyer un courriel de test**.
Indiquez votre propre adresse : le courriel doit arriver en quelques secondes.

Ensuite, au Guichet, une notification affiche « Courriel envoyé
automatiquement » et l'historique la marque **Envoyé** — et non plus
« À envoyer ».

---

## En cas de refus

| Message | Cause | Solution |
|---|---|---|
| `Invalid login` / `Username and Password not accepted` | Mot de passe habituel utilisé à la place du mot de passe d'application | Refaites l'étape 2 |
| `Missing credentials` | `SMTP_USER` ou `SMTP_PASS` vide dans `.env` | Vérifiez le fichier, sans guillemets autour des valeurs |
| `self signed certificate` / délai dépassé | Pare-feu ou proxy de l'organisation qui bloque le port 587 | Voyez avec le service informatique, ou utilisez le SMTP interne |
| `Mail from must equal authorized user` | `MAIL_FROM` diffère de `SMTP_USER` | Reprenez la même adresse dans les deux |
| L'application ignore le fichier | `.env` enregistré en `.env.txt` par le Bloc-notes | Dans l'Explorateur, activez *Affichage → Extensions de noms de fichiers* et corrigez le nom |

**Limites d'envoi Gmail** : environ 500 destinataires par jour pour un compte
gratuit, 2 000 pour un compte Workspace. Largement suffisant pour un bureau du
courrier, mais à connaître.

---

## Sécurité

- `.env` contient un identifiant d'envoi : ne le copiez pas dans un courriel,
  une clé USB partagée ou un dépôt public. Le `.gitignore` du projet l'exclut
  déjà.
- Le mot de passe d'application se révoque en un clic sur
  <https://myaccount.google.com/apppasswords>, sans toucher au compte.
- Les destinataires reçoivent un courriel provenant de votre adresse : c'est
  elle qui sera visible, et qui recevra les réponses.
