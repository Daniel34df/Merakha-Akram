#!/usr/bin/env node
/* Sceller une version au nom du créateur.
 *
 *   node tools/signer.js --cle chemin/vers/cle-privee.pem
 *   node tools/signer.js --creer-cles dossier/      (une seule fois)
 *
 * Produit `signature.json` : la liste des fichiers livrés, leur empreinte
 * SHA-256, et un sceau Ed25519. Le sceau se vérifie avec la clé publique
 * embarquée dans `server/signature.js` ; la clé privée ne quitte jamais la
 * machine du créateur et **ne doit jamais entrer dans le dépôt**.
 *
 * Ce qui entre dans le manifeste : ce qui est livré et exécuté. Pas les
 * données du bureau (`data/`), pas les sauvegardes, pas `.env`, pas les
 * dépendances installées sur le poste — sinon toute installation serait
 * aussitôt « compromise », et l'alerte ne voudrait plus rien dire.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../server/signature.js');

const RACINE = path.resolve(__dirname, '..');

/* Ce qui est livré. Tout le reste — données, sauvegardes, secrets, runtime
   téléchargé, node_modules — vit sur le poste et change légitimement. */
const INCLUS = [/^assets\//, /^server\//, /^tools\//, /^docs\//];
const EXCLUS = [
  /^node_modules\//, /^data\//, /^runtime\//, /^\.git\//, /^sauvegardes\//,
  /^\.env/, /^signature\.json$/, /^revocations\.json$/,
  /\.pem$/, /\.key$/, /\.crt$/, /\.png$/, /\.log$/
];
const RACINE_FICHIERS = [
  'index.html', 'sw.js', 'manifest.webmanifest', 'package.json', 'LICENSE'
];

function parcourir(dossier, base) {
  const out = [];
  for (const e of fs.readdirSync(path.join(RACINE, dossier), { withFileTypes: true })) {
    const rel = path.posix.join(base, e.name);
    if (EXCLUS.some((r) => r.test(rel))) continue;
    if (e.isDirectory()) out.push(...parcourir(path.join(dossier, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function fichiersLivres() {
  const out = [];
  for (const f of RACINE_FICHIERS) {
    if (fs.existsSync(path.join(RACINE, f))) out.push(f);
  }
  for (const d of ['assets', 'server', 'tools', 'docs']) {
    if (fs.existsSync(path.join(RACINE, d))) out.push(...parcourir(d, d));
  }
  return out
    .filter((f) => INCLUS.some((r) => r.test(f)) || RACINE_FICHIERS.includes(f))
    .filter((f) => !EXCLUS.some((r) => r.test(f)))
    .sort();
}

function creerCles(dossier) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(dossier, { recursive: true });
  const priv = path.join(dossier, 'cle-privee.pem');
  const pub = path.join(dossier, 'cle-publique.pem');
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('Clés créées :');
  console.log('  privée   ' + priv + '   ← À GARDER HORS DU DÉPÔT, ET SAUVEGARDÉE');
  console.log('  publique ' + pub);
  console.log('');
  console.log('Recopiez le contenu de la clé publique dans CLE_PUBLIQUE,');
  console.log('dans server/signature.js. Sans elle, rien n’est vérifié.');
  console.log('');
  console.log('La clé privée perdue = plus aucune version signable. La clé');
  console.log('privée divulguée = n’importe qui signe à votre nom.');
}

function main() {
  const args = process.argv.slice(2);
  const creer = args.indexOf('--creer-cles');
  if (creer !== -1) return creerCles(path.resolve(args[creer + 1] || 'cles'));

  const i = args.indexOf('--cle');
  if (i === -1 || !args[i + 1]) {
    console.error('Usage : node tools/signer.js --cle chemin/vers/cle-privee.pem');
    console.error('        node tools/signer.js --creer-cles dossier/');
    process.exit(2);
  }
  const clePrivee = fs.readFileSync(path.resolve(args[i + 1]), 'utf8');

  const liste = fichiersLivres();
  const contenus = {};
  for (const f of liste) contenus[f] = fs.readFileSync(path.join(RACINE, f));

  const version = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8')).version;
  const manifeste = S.sceller(S.construire({ version: version, fichiers: contenus }), clePrivee);

  fs.writeFileSync(
    path.join(RACINE, 'signature.json'),
    JSON.stringify(manifeste, null, 2) + '\n'
  );

  console.log('Version scellée au nom de ' + S.CREATEUR);
  console.log('  application  ' + manifeste.application + ' ' + manifeste.version);
  console.log('  fichiers     ' + liste.length);
  console.log('  identifiant  ' + manifeste.identifiant);
  console.log('  empreinte    ' + manifeste.empreinte);
  console.log('  écrit dans   signature.json');
}

main();
