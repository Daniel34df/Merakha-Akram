#!/usr/bin/env node
/* Bureau du Courrier — rejouer les vérifications de navigateur.
 *
 *   npm run verifier                 tout, en série
 *   npm run verifier -- rappel       un seul, par son nom
 *   CHROME=/chemin/vers/chromium npm run verifier
 *
 * Ce que `node --test` ne peut pas faire : ouvrir un écran. La suite ordinaire
 * couvre tout ce qui est pur — et c'est là que va l'essentiel, parce que c'est
 * là que ça se vérifie vite et partout. Restent ces neuf parcours, qui cliquent
 * pour de vrai.
 *
 * Chacun tourne sur **son** serveur et **sa** base : les faire partager un
 * registre les a déjà fait échouer l'un sur l'autre, le second trouvant le
 * compte créé par le premier. Les bases sont effacées avant et après.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RACINE = path.join(__dirname, '..', '..');

/* Ce que chaque script garde fermé. La phrase n'est pas décorative : elle dit
   quel défaut reviendrait si le script disparaissait. */
const SCRIPTS = [
  ['corriger', 'corriger une fiche sans perdre le téléphone ni annuler un renouvellement'],
  ['effacer', 'sortir du registre et effacer sont deux gestes distincts'],
  ['onglets', 'aucune erreur JS sur les six onglets, et les cinq documents s’impriment'],
  ['maitre', 'le code de reprise publié ne s’utilise que depuis le poste du serveur'],
  ['rappel', 'une personne sans courriel qui n’est pas venue revient dans la liste'],
  ['appel-entrant', 'un appel de la personne compte comme manifestation'],
  ['gabarits', 'le numéro de boîte dans les messages, et la seconde langue'],
  ['avis', 'prévenir une personne au sujet de sa domiciliation, sans créer de courrier'],
  ['apparence', 'le thème se retient, le soulignement suit, et le papier ne suit pas l’écran'],
  ['casiers', 'le plan du local : l’état s’écrit, et le miroir tient d’un écran à l’autre'],
  ['scanner', 'la douchette au centre, la caméra en plus, et jamais de choix fait à notre place'],
  ['doublons', 'l’avertissement paraît pendant la saisie, prévient sans bloquer, et la référence suit'],
  ['bord', 'le relevé du jour : calme quand c’est calme, et chaque chiffre mène à son dossier'],
  ['colis', 'l’emplacement demandé quand le colis ne rentre pas, et rien qui sorte chez le transporteur'],
  ['pilotage', 'la passation du soir, et un diagnostic qui ne dit jamais « tout va bien » sans avoir regardé'],
  ['echeances', 'le calendrier qui fait voir les paquets, et un PDF qu’un lecteur accepte vraiment'],
  ['etiquettes', 'la consigne sous les yeux au moment de la remise, et qui ne part jamais dans un message']
];

const PORT_BASE = Number(process.env.PORT_BASE || 5490);

function attendre(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

/** Le serveur répond-il ? On tâte plutôt que d'attendre une durée fixe. */
async function attendreServeur(base, essais) {
  for (let i = 0; i < (essais || 40); i++) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return true;
    } catch (e) {
      /* pas encore debout */
    }
    await attendre(250);
  }
  return false;
}

async function jouer(nom, quoi, port) {
  const base = 'http://127.0.0.1:' + port;
  const dbFile = path.join(os.tmpdir(), 'bdc-verif-' + nom + '-' + process.pid + '.json');
  fs.rmSync(dbFile, { force: true });

  const serveur = spawn(process.execPath, [path.join(RACINE, 'server', 'index.js')], {
    cwd: RACINE,
    stdio: 'ignore',
    env: Object.assign({}, process.env, {
      DB_FILE: dbFile,
      PORT: String(port),
      HOST: '127.0.0.1',
      VERIFY_EMAIL: 'false',
      MAIL_DRY_RUN: 'true'
    })
  });

  let code = 1;
  try {
    if (!(await attendreServeur(base))) {
      console.log('  RATÉ le serveur d’essai n’a pas démarré sur ' + base);
      return 1;
    }
    console.log('\n[1m── ' + nom + ' [0m— ' + quoi);
    code = await new Promise(function (resolve) {
      const p = spawn(process.execPath, [path.join(__dirname, nom + '.js')], {
        cwd: RACINE,
        stdio: 'inherit',
        env: Object.assign({}, process.env, { BASE: base })
      });
      p.on('exit', function (c) {
        resolve(c === null ? 1 : c);
      });
    });
  } finally {
    serveur.kill();
    fs.rmSync(dbFile, { force: true });
  }
  return code;
}

async function main() {
  const demandes = process.argv.slice(2).filter(function (a) {
    return !a.startsWith('-');
  });
  const liste = demandes.length
    ? SCRIPTS.filter(function (s) {
        return demandes.includes(s[0]);
      })
    : SCRIPTS;

  if (!liste.length) {
    console.error('Aucun script de ce nom. Disponibles : ' + SCRIPTS.map(function (s) { return s[0]; }).join(', '));
    process.exit(2);
  }

  const rates = [];
  for (let i = 0; i < liste.length; i++) {
    const code = await jouer(liste[i][0], liste[i][1], PORT_BASE + i);
    if (code !== 0) rates.push(liste[i][0]);
  }

  console.log('\n' + '─'.repeat(70));
  if (rates.length) {
    console.log('[31m' + rates.length + ' vérification(s) en défaut : ' + rates.join(', ') + '[0m\n');
    process.exit(1);
  }
  console.log('[32mLes ' + liste.length + ' vérifications de navigateur sont passées.[0m\n');
}

main().catch(function (err) {
  console.error('\nLes vérifications se sont interrompues :', err.message, '\n');
  process.exit(1);
});
