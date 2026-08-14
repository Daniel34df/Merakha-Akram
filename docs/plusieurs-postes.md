# Le bureau sur plusieurs ordinateurs

Quatre postes à l'accueil, reliés par le même wifi ou le même câble, et un seul
registre. Voici comment.

## Le principe, en une phrase

**L'application ne s'installe qu'une fois**, sur le poste du responsable. Les
autres ordinateurs n'installent rien : ils ouvrent une adresse dans leur
navigateur et travaillent sur le même registre, en même temps.

Installer quatre fois donnerait quatre registres séparés, donc quatre vérités
différentes sur le même courrier. C'est exactement ce qu'il faut éviter.

Conséquence à connaître : **le poste du responsable doit rester allumé** pendant
les heures d'ouverture. C'est lui, le bureau.

---

## Sur le poste du responsable

### 1. Installer

Double-cliquez sur **`installer-plusieurs-postes.cmd`** (Windows) ou lancez
`./installer.sh --plusieurs-postes` (macOS, Linux).

C'est le même installateur que d'habitude, avec deux différences :

- le serveur accepte les connexions des autres postes du réseau ;
- le pare-feu est ouvert sur le port de l'application.

> **Si vous avez déjà installé avec `installer.cmd`**, ne réinstallez pas. Ouvrez
> le fichier `.env` à côté de l'application et remplacez :
>
> ```
> HOST=127.0.0.1      ← ce seul ordinateur
> HOST=0.0.0.0        ← tous les postes du bureau
> ```
>
> puis redémarrez. Sans ce changement, les autres postes ne joindront rien,
> quelle que soit l'adresse qu'ils tapent — et **aucun message ne le dira** au
> poste qui essaie. L'application le signale dans *Réglages → Postes du bureau*.

Le pare-feu demande des droits administrateur. Sans eux, l'installation se fait
quand même et la commande exacte vous est affichée. Ne la sautez pas : sans
règle de pare-feu, les autres postes n'obtiennent qu'une page qui ne charge
jamais, sans erreur, et on cherche du côté du wifi pendant une heure.

### 2. Fabriquer le certificat

Double-cliquez sur **`certificat.cmd`** (Windows) ou lancez
`./tools/certificat.sh` (macOS, Linux). Rien à installer : Windows et OpenSSL
savent le faire seuls.

Pourquoi c'est nécessaire, et pas seulement recommandé :

- en http, **le mot de passe et le cookie de session circulent en clair** sur le
  wifi du bureau. Votre registre contient des noms, des dates de naissance et
  des téléphones de personnes domiciliées — parfois des gens qui ont de bonnes
  raisons de ne pas être retrouvés ;
- les navigateurs **refusent l'installation de l'application et le mode hors
  ligne** sur une adresse non sécurisée. Sans certificat, les trois autres
  postes n'auront qu'un onglet de navigateur, et rien ne fonctionnera pendant
  une coupure.

### 3. Relever l'adresse

Redémarrez l'application. Le démarrage affiche :

```
  sur ce poste  https://localhost:3000
  autres postes https://accueil-pc:3000
                https://192.168.1.10:3000  (câble)
```

On la retrouve aussi dans **Réglages → Postes du bureau**, avec un bouton
*Copier* et une **fiche imprimable** à scotcher sur chaque écran.

**Préférez le nom du poste** (`accueil-pc`) à l'adresse chiffrée : le nom ne
change pas, l'adresse si.

---

## Sur chacun des trois autres postes

Rien à installer. Trois gestes, une seule fois :

1. **Faire reconnaître le certificat.** Copiez `confiance.cmd` et
   `data\certificat.cer` depuis le poste du responsable (clé USB ou dossier
   partagé), puis clic droit sur `confiance.cmd` → *Exécuter en tant
   qu'administrateur*.

   Le script vous montre l'empreinte du certificat et demande confirmation.
   **Vérifiez que cette empreinte est celle affichée sur le poste du
   responsable.** Ajouter une autorité de confiance est un geste qui compte :
   cet ordinateur fera ensuite confiance à tout certificat signé par cette clé.
   Ne le faites qu'avec le certificat de votre propre bureau.

   Sur macOS : ouvrez `certificat.pem` avec Trousseaux d'accès, rangez-le dans
   *Système*, puis passez-le à *Toujours approuver*.

2. **Ouvrir l'adresse** dans le navigateur. Le cadenas doit apparaître.

3. **Installer l'application** depuis le navigateur (Chrome et Edge : l'icône
   d'installation dans la barre d'adresse). Elle obtient alors sa propre icône
   et fonctionne hors ligne.

Puis connectez-vous avec **l'identifiant et le code d'accès** remis par le
responsable — pas avec son courriel et son mot de passe. Voir la section
*Deux façons d'entrer* du README.

---

## Ce que vous verrez une fois relié

Un courrier signalé sur un poste apparaît sur les trois autres **sans
rechargement**, et une remise faite à un guichet disparaît aussitôt des autres.
Sans cela, deux agents pourraient remettre le même pli.

Une saisie en cours n'est jamais balayée par ce qu'écrit un autre poste : le
formulaire que vous remplissez reste tel quel.

*Réglages → Postes du bureau* montre **qui est relié en ce moment** — c'est la
réponse à « est-ce que mes quatre postes se parlent ? ».

---

## Quand ça ne marche pas

| Ce que vous voyez | Ce que c'est |
|---|---|
| La page ne charge jamais, sans erreur | Pare-feu fermé, ou `HOST=127.0.0.1` dans le `.env` |
| « Impossible de joindre ce site » | Le poste du responsable est éteint ou en veille |
| Ça marchait hier, plus aujourd'hui | L'adresse a changé — voir ci-dessous |
| Avertissement de sécurité | `confiance.cmd` n'a pas été lancé sur ce poste |
| Pas d'icône d'installation | Vous êtes encore en http : refaites l'étape 2 |

### L'adresse a changé

La box redistribue les adresses au redémarrage. L'application le signale
pendant une semaine dans *Réglages → Postes du bureau*, en rappelant
l'ancienne.

Deux remèdes :

- **utiliser le nom du poste** plutôt que l'adresse — il ne change pas ;
- **réserver une adresse fixe** au poste du responsable sur votre box
  (« bail statique », « réservation DHCP », selon les marques). C'est la
  solution durable, à demander à qui s'occupe de votre réseau.

### Mettre le poste du responsable en veille

Une mise en veille coupe le registre pour tout le monde. Dans les réglages
d'alimentation de Windows, passez la mise en veille sur *Jamais* pendant les
heures d'ouverture.

---

## Et si on veut vraiment quatre installations séparées ?

C'est possible — chaque poste garde alors son propre registre — mais ce n'est
plus le même outil : les quatre listes divergent dès le premier courrier, et
rien ne les réconcilie. À réserver au cas de quatre bureaux réellement
indépendants. Si vous avez plusieurs points d'accueil qui doivent partager un
registre, c'est la fonction **Antennes** qu'il vous faut, pas quatre
installations : voir le README.
