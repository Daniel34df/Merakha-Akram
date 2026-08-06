# Comptes et boîte d'envoi personnelle

Deux mécanismes distincts, qu'il vaut mieux ne pas confondre :

| | À quoi ça sert | Où |
|---|---|---|
| **Compte de l'application** | Ouvrir le registre : nom, courriel, mot de passe propres à cette application | Écran de connexion |
| **Boîte d'envoi** | Faire partir les notifications de **votre** adresse | Réglages → *Ma boîte d'envoi* |

On peut avoir un compte sans boîte connectée : les notifications repartent alors
du compte du serveur, ou sont préparées dans le logiciel de courriel.

---

## Comptes

Au premier démarrage du serveur, l'application propose de créer le **compte du
bureau**. Tant qu'aucun compte n'existe, le registre est accessible à toute
personne qui ouvre l'adresse — c'est pourquoi l'écran le propose d'emblée. Il
reste possible de continuer sans compte : l'application fonctionne comme avant.

**Dès qu'un compte existe, le registre est protégé** : l'API refuse toute
requête sans session valide.

### Vérification de l'adresse

À l'inscription, un **code à six chiffres** est envoyé à l'adresse indiquée, et
le compte n'est créé qu'une fois ce code saisi. Sans cela, n'importe qui
pourrait s'inscrire avec le courriel d'un collègue.

- Le code est valable **15 minutes** et n'est jamais conservé en clair : le
  registre n'en garde qu'une empreinte, comme pour un mot de passe.
- **5 essais** au maximum, puis il faut recommencer l'inscription.
- Un nouveau code peut être demandé après 60 secondes ; il annule le précédent
  et remet le compteur d'essais à zéro.
- Tant que le code n'est pas confirmé, **aucun compte n'existe** : une
  inscription abandonnée ne laisse qu'une demande en attente, effacée à
  expiration.

### Association de la boîte dans la foulée

Une fois le code confirmé, l'adresse est prouvée : l'application propose
aussitôt de l'**associer comme boîte d'envoi**, pour que les notifications en
partent. Le serveur d'envoi est pré-rempli d'après le domaine de l'adresse
(Gmail, Outlook, Orange, Free, Yahoo, iCloud…) ; un domaine professionnel se
renseigne à la main.

Pour une adresse Google, sur un serveur où l'autorisation OAuth est configurée,
le bouton **Associer avec Google** est proposé en premier : aucun mot de passe
n'est communiqué à l'application.

L'étape se saute d'un clic sur *Plus tard* — l'association reste possible à tout
moment depuis Réglages → *Ma boîte d'envoi*.

La vérification suppose que le serveur sache envoyer un courriel. Elle est donc
active dès que SMTP est configuré, et inactive sinon — l'écran d'inscription
l'indique. `VERIFY_EMAIL=true` l'impose (l'inscription est alors refusée tant
que SMTP manque) ; `VERIFY_EMAIL=false` la désactive.

- Mot de passe : 10 caractères minimum, haché en **scrypt** avec un sel
  aléatoire. Il n'est jamais stocké ni renvoyé en clair.
- Session : jeton aléatoire dans un cookie `HttpOnly`, valable 30 jours,
  révoqué à la déconnexion. Le cookie ne contient aucune donnée exploitable.
- Après 8 échecs de connexion sur 10 minutes, les tentatives sont freinées.
- `SIGNUP_CLOSED=true` dans `.env` ferme les inscriptions : plus personne ne
  peut créer de compte, sauf le tout premier.

> Ce mot de passe est **propre à l'application**. N'y remettez jamais celui de
> votre boîte mail.

---

## Connecter sa boîte Gmail (recommandé)

L'employé·e autorise l'application depuis l'écran de Google. **L'application ne
voit jamais le mot de passe**, et l'autorisation se retire à tout moment sur
<https://myaccount.google.com/permissions>.

L'application ne demande que deux autorisations :

- `gmail.send` — envoyer un courriel. **Aucun accès en lecture** à la boîte ;
- `userinfo.email` — connaître l'adresse connectée, pour l'afficher.

### Ce que l'administrateur doit préparer, une fois

1. Ouvrez <https://console.cloud.google.com/> et créez un projet
   (par exemple `bureau-du-courrier`).
2. **API et services → Bibliothèque** : activez **Gmail API**.
3. **Écran de consentement OAuth** : type *Externe*, renseignez le nom de
   l'application et un courriel de contact. Ajoutez la portée
   `https://www.googleapis.com/auth/gmail.send`.
4. **Identifiants → Créer des identifiants → ID client OAuth**, type
   *Application Web*. Dans **URI de redirection autorisés**, ajoutez très
   exactement :

   ```
   http://localhost:3000/api/auth/google/callback
   ```

   (adaptez le port ; en https, mettez l'adresse publique complète).
5. Copiez l'**ID client** et le **code secret** dans `.env` :

   ```
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxxxxx
   GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
   ```

6. Redémarrez le serveur. Le bouton **Connecter ma boîte Gmail** devient actif.

### Deux limites imposées par Google

- Tant que l'application n'est pas **vérifiée** par Google, elle reste en mode
  *Test* : seules les adresses ajoutées comme **utilisateurs tests** dans
  l'écran de consentement peuvent se connecter (100 au maximum). Pour un bureau,
  c'est généralement suffisant — sinon, demandez la vérification.
- L'écran affichera un avertissement « application non validée » tant que la
  vérification n'est pas faite. C'est attendu, et sans danger pour une
  application que vous hébergez vous-même.

---

## Sans configuration Google : mot de passe d'application

Chaque employé·e peut relier sa boîte avec un **mot de passe d'application** —
jamais le mot de passe de son compte. Réglages → *Ma boîte d'envoi* →
*Utiliser un mot de passe d'application*.

Pour Gmail, la création du mot de passe d'application est décrite dans
[`installation-windows-gmail.md`](installation-windows-gmail.md). Les réglages :

```
Adresse            vous@gmail.com
Serveur SMTP       smtp.gmail.com
Port               587
Mot de passe       les 16 lettres du mot de passe d'application
```

---

## Où vont les secrets

Les jetons Google et les mots de passe d'application sont **chiffrés**
(AES-256-GCM) avant d'être écrits dans `data/db.json`. Ils n'y apparaissent
jamais en clair, et l'API ne les renvoie jamais au navigateur.

La clé de chiffrement vient de `APP_SECRET` dans `.env`. À défaut, elle est
créée au premier démarrage dans `data/secret.key`, en accès restreint.

- **Sauvegardez cette clé** avec le registre : sans elle, les boîtes connectées
  devront être reliées à nouveau.
- Ne la mettez jamais dans un dépôt public. Le `.gitignore` exclut déjà `.env`,
  `data/*.json` et `data/secret.key`.

Perdre la clé n'expose rien : cela rend seulement les secrets illisibles, et
l'application demande de reconnecter les boîtes.

---

## Ce que voit l'historique

Chaque envoi automatique consigne l'adresse expéditrice (`sentBy`) et le nom de
la personne connectée qui a déclenché la notification. Deux employé·es reliant
chacun sa boîte restent ainsi distinguables dans le registre partagé.
