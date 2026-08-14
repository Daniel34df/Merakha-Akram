#!/usr/bin/env node
/* Bureau du Courrier — tirer un code de reprise propre au bureau.
 *
 * Pourquoi cet outil existe.
 *
 * Le code de reprise livré avec l'application est écrit dans le code source :
 * qui lit le dépôt le connaît. Il ouvre pourtant le compte du responsable —
 * changer son adresse, son mot de passe, ou supprimer le compte, ce qui rouvre
 * l'installation et livre le registre. Tant qu'il n'est pas remplacé, le
 * serveur n'accepte la reprise que depuis la machine qui tient le registre :
 * une protection de secours, pas une solution.
 *
 * Les installateurs appellent ce fichier pour écrire un MASTER_CODE dans le
 * `.env` au moment de l'installation. Un seul générateur, en Node, plutôt qu'un
 * tirage recopié en Bash *et* en PowerShell — où il ne serait vérifiable ni
 * d'un côté ni de l'autre.
 *
 * Usage :
 *   node tools/code-maitre.js            le code groupé, à lire et à noter
 *   node tools/code-maitre.js --brut     sans espaces, pour le fichier .env
 */
'use strict';

const crypto = require('node:crypto');

/* Douze chiffres, et rien que des chiffres.
 *
 * Ce code se dicte au téléphone et se recopie sur un papier qu'on range dans un
 * tiroir. Les lettres se confondent à l'oral comme à l'écrit — le projet écarte
 * déjà « I » et « O » des identifiants d'agent pour cette raison ; ici on
 * supprime la question. Douze chiffres, c'est mille milliards de possibilités,
 * et la route de reprise est freinée en tentatives : largement assez pour une
 * clé de coffre qu'on ne tape que dans un cas de force majeure.
 */
const CHIFFRES = 12;
const PAR_GROUPE = 4;

/** Le code brut : douze chiffres, sans séparateur. */
function tirer() {
  let code = '';
  // randomInt et non Math.random : c'est la règle du projet pour tout secret.
  for (let i = 0; i < CHIFFRES; i++) code += String(crypto.randomInt(0, 10));
  return code;
}

/** « 482190375164 » → « 4821 9037 5164 ». Lisible, dictable, recopiable. */
function grouper(code) {
  const propre = String(code || '').replace(/\D/g, '');
  const morceaux = [];
  for (let i = 0; i < propre.length; i += PAR_GROUPE) {
    morceaux.push(propre.slice(i, i + PAR_GROUPE));
  }
  return morceaux.join(' ');
}

/** Vrai pour un code de la forme attendue — groupé ou non. */
function valide(code) {
  return new RegExp('^\\d{' + CHIFFRES + '}$').test(String(code || '').replace(/\s/g, ''));
}

if (require.main === module) {
  const code = tirer();
  process.stdout.write(process.argv.includes('--brut') ? code : grouper(code));
}

module.exports = {
  CHIFFRES: CHIFFRES,
  PAR_GROUPE: PAR_GROUPE,
  tirer: tirer,
  grouper: grouper,
  valide: valide
};
