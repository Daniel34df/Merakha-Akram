# Mettre l'application en https

Tant que l'application ne sert que le poste sur lequel elle tourne,
`http://localhost` suffit : les navigateurs traitent `localhost` comme une
adresse sûre. **Dès qu'un autre poste s'y connecte, il faut https.** Sans lui :

- le mot de passe et le cookie de session circulent en clair sur le réseau ;
- le cookie ne peut pas porter l'attribut `Secure` ;
- les navigateurs refusent d'installer l'application.

---

## 1. Obtenir un certificat

### Vous avez un nom de domaine — la bonne solution

Demandez un certificat à votre service informatique, ou utilisez
[Let's Encrypt](https://letsencrypt.org/fr/) (gratuit, renouvellement
automatique). Vous obtiendrez deux fichiers : une **clé privée** et un
**certificat**.

### Réseau interne, sans nom de domaine — certificat auto-signé

Sur le poste qui héberge l'application, avec OpenSSL (fourni avec Git pour
Windows, présent sur macOS et Linux) :

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout data/cle.pem -out data/certificat.pem \
  -subj "/CN=bureau-du-courrier" \
  -addext "subjectAltName=DNS:localhost,IP:192.168.1.10"
```

Remplacez `192.168.1.10` par l'adresse du poste sur le réseau. Sans cette
ligne, les navigateurs récents refuseront le certificat.

> Un certificat auto-signé chiffre la connexion, mais ne prouve pas
> l'identité du serveur : chaque navigateur affichera un avertissement à la
> première visite. Pour l'éviter, faites installer le certificat comme
> **autorité de confiance** sur les postes — votre service informatique sait
> le faire, ou l'outil [mkcert](https://github.com/FiloSottile/mkcert) s'en
> charge en une commande.

---

## 2. Indiquer les fichiers à l'application

Dans `.env` :

```
HTTPS_KEY=./data/cle.pem
HTTPS_CERT=./data/certificat.pem
PORT=3000
```

Redémarrez. Le démarrage affiche alors :

```
  interface   https://localhost:3000
```

Si le certificat est illisible, l'application le dit et **démarre quand même en
http** plutôt que de refuser de fonctionner.

---

## 3. Protéger la clé

La clé privée vaut le mot de passe du serveur.

- Elle doit rester lisible du seul compte qui lance l'application.
- Le `.gitignore` exclut déjà `data/` : ne la déplacez pas ailleurs dans le
  projet.
- Sauvegardez-la avec le registre — sans elle, il faut refaire un certificat et
  réinstaller la confiance sur les postes.

---

## 4. Vérifier

1. Depuis un autre poste, ouvrez `https://adresse-du-serveur:3000`.
2. Le cadenas doit apparaître (après avoir accepté le certificat interne, le
   cas échéant).
3. Dans l'application, onglet *Réglages*, la ligne **Application** doit indiquer
   qu'elle est installable — c'est le signe que le contexte est reconnu comme
   sûr.

Un renouvellement de certificat se fait en remplaçant les deux fichiers et en
redémarrant l'application. Un certificat auto-signé de 825 jours couvre plus de
deux ans.
