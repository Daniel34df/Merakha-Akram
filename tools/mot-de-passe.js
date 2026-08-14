#!/usr/bin/env node
/* Bureau du Courrier — reprise en main d'un compte depuis le poste serveur.

   À quoi ça sert : quelqu'un a oublié son mot de passe et le bureau n'a pas de
   serveur de courriel, ou la boîte de réception n'est plus accessible. Le code
   envoyé par courriel ne peut alors pas arriver. Cet outil est la porte de
   service : il s'exécute sur la machine qui héberge le registre, donc il
   n'exige rien d'autre que d'avoir la main sur cette machine — ce qui est déjà
   le pouvoir absolu sur les données.

   Usage :
     npm run motdepasse                       liste les comptes
     npm run motdepasse -- courriel@ex.com    tire un mot de passe et l'affiche
     npm run motdepasse -- courriel@ex.com "mon nouveau mot de passe"

   Le serveur peut tourner pendant l'opération : l'écriture est atomique et le
   registre est relu à chaque appel. */
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { Db } = require('../server/db.js');
const auth = require('../server/auth.js');
const util = require('../assets/js/util.js');

const ROOT = path.join(__dirname, '..');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch (e) {
    /* pas de .env : les variables d'environnement suffisent */
  }
}

/* Mot de passe lisible et transmissible de vive voix : quatre groupes de
   quatre caractères sans les lettres qu'on confond (l/1/I, O/0). Tirage
   cryptographique, jamais Math.random. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function motDePasseLisible() {
  const groupes = [];
  for (let g = 0; g < 4; g++) {
    let bloc = '';
    for (let i = 0; i < 4; i++) bloc += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    groupes.push(bloc);
  }
  return groupes.join('-');
}

async function main() {
  const dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
  const db = new Db(dbFile);
  await db.load();

  const comptes = db.data.users || [];
  const courriel = (process.argv[2] || '').trim();

  if (comptes.length === 0) {
    console.log('Aucun compte dans ' + dbFile + '.');
    console.log('Ouvrez l’application : le premier compte créé protégera le registre.');
    return;
  }

  if (!courriel) {
    console.log('Comptes du registre ' + dbFile + ' :\n');
    comptes.forEach(function (u, i) {
      console.log(
        '  ' + String(i + 1).padStart(2) + '. ' + u.email +
          '  (' + u.name + (i === 0 ? ', responsable' : '') + ')'
      );
    });
    console.log('\nPour redonner l’accès à quelqu’un :');
    console.log('  npm run motdepasse -- ' + comptes[0].email);
    return;
  }

  const user = comptes.find(function (u) {
    return util.normalize(u.email) === util.normalize(courriel);
  });
  if (!user) {
    console.error('Aucun compte avec l’adresse « ' + courriel +' ».');
    console.error('Lancez « npm run motdepasse » sans argument pour voir la liste.');
    process.exitCode = 1;
    return;
  }

  const choisi = (process.argv[3] || '').trim();
  const nouveau = choisi || motDePasseLisible();
  const faible = auth.checkPasswordStrength(nouveau);
  if (faible) {
    console.error(faible);
    process.exitCode = 1;
    return;
  }

  await db.write(function (data) {
    const cible = data.users.find(function (u) {
      return u.id === user.id;
    });
    cible.password = auth.hashPassword(nouveau);
    /* Toutes les sessions de ce compte tombent, y compris celles ouvertes sur
       d'autres postes : on ne sait pas pourquoi le mot de passe a été perdu. */
    data.sessions = (data.sessions || []).filter(function (s) {
      return s.userId !== user.id;
    });
    // Une demande de réinitialisation en cours n'a plus lieu d'être.
    data.pending = (data.pending || []).filter(function (p) {
      return auth.pendingKind(p) !== 'reset' || p.userId !== user.id;
    });
  });

  await require('../server/db.js').consigner(db, {
    qui: 'console',
    action: 'mot de passe réinitialisé',
    cible: user.email,
    details: 'depuis le poste serveur'
  });

  console.log('\nCompte    ' + user.name + ' <' + user.email + '>');
  console.log('Nouveau   ' + nouveau);
  console.log('\nSessions ouvertes fermées. Communiquez ce mot de passe à la personne,');
  console.log('et invitez-la à le changer depuis Réglages › Comptes.');
}

main().catch(function (err) {
  console.error('Échec :', err.message);
  process.exit(1);
});
