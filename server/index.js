#!/usr/bin/env node
/* Bureau du Courrier — point d'entrée du serveur.
   Usage :  npm start        (ou  node server/index.js  ·  PORT=8080 npm start) */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { Db } = require('./db.js');
const { createMailer } = require('./mailer.js');
const { createVault } = require('./secrets.js');
const { createGoogleOAuth } = require('./google.js');
const { createServer, VERSION, envoyerRelance } = require('./app.js');
const reminders = require('./reminders.js');

const ROOT = path.join(__dirname, '..');

// Charge un éventuel .env à la racine du projet (facultatif).
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch (e) {
    /* pas de .env : on s'en tient aux variables d'environnement */
  }
}

/* Ouvre le navigateur une fois le serveur en écoute (OPEN_BROWSER=1).
   Utilisé par demarrer.cmd : lancer le navigateur avant l'écoute donnerait une
   page d'erreur. Un échec ici n'empêche jamais le serveur de tourner. */
function openBrowser(url) {
  const commands = {
    win32: ['cmd', ['/c', 'start', '', url]],
    darwin: ['open', [url]]
  };
  const [command, args] = commands[process.platform] || ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', function () {
      console.log('  (ouvrez ' + url + ' dans votre navigateur)');
    });
    child.unref();
  } catch (e) {
    console.log('  (ouvrez ' + url + ' dans votre navigateur)');
  }
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');

  const db = new Db(dbFile);
  await db.load();

  const mailer = createMailer(process.env);
  const vault = createVault({
    secret: process.env.APP_SECRET || '',
    keyFile: process.env.APP_SECRET_FILE || path.join(path.dirname(dbFile), 'secret.key')
  });
  const google = createGoogleOAuth(process.env);
  const signupOpen = String(process.env.SIGNUP_CLOSED || '').toLowerCase() !== 'true';
  // VERIFY_EMAIL absent : on vérifie si le serveur sait envoyer un courriel.
  const verifyRaw = String(process.env.VERIFY_EMAIL || '').toLowerCase();
  const verifyEmail = verifyRaw === '' ? mailer.enabled : verifyRaw === 'true';

  /* Relances et signalement : quinze jours pour la relance, quinze de plus
     avant que le courrier passe au dossier à traiter. REMINDER_DAYS=0 désactive
     l'ensemble. */
  const relanceJours = process.env.REMINDER_DAYS === undefined ? 15 : Number(process.env.REMINDER_DAYS || 0);
  const escaladeJours = process.env.ESCALATION_DAYS === undefined ? 15 : Number(process.env.ESCALATION_DAYS || 0);

  const server = createServer({
    db: db,
    mailer: mailer,
    vault: vault,
    google: google,
    signupOpen: signupOpen,
    verifyEmail: verifyEmail,
    reminderDays: relanceJours,
    rootDir: ROOT
  });

  server.listen(port, host, function () {
    console.log('Bureau du Courrier v' + VERSION);
    console.log('  interface   http://localhost:' + port);
    console.log('  registre    ' + dbFile + ' (' + db.data.contacts.length + ' destinataire(s))');
    console.log(
      '  courriel    ' +
        (mailer.enabled
          ? mailer.mode === 'essai'
            ? 'mode essai — aucun envoi réel'
            : 'SMTP ' + mailer.config.host + ':' + mailer.config.port + ' (de : ' + mailer.config.from + ')'
          : 'inactif — ' + mailer.reason)
    );
    console.log(
      '  comptes     ' +
        (db.data.users.length === 0
          ? 'aucun — le premier compte créé protégera l’application'
          : db.data.users.length + ' compte(s)' + (signupOpen ? '' : ', inscriptions fermées'))
    );
    console.log(
      '  inscription ' +
        (verifyEmail
          ? 'code de confirmation envoyé par courriel'
          : 'sans vérification d’adresse' + (mailer.enabled ? ' (VERIFY_EMAIL=false)' : ' — aucun envoi possible'))
    );
    console.log(
      '  relances    ' +
        (relanceJours > 0
          ? 'après ' + relanceJours + ' jour(s), signalement ' + escaladeJours + ' jour(s) plus tard'
          : 'manuelles seulement (REMINDER_DAYS pour les automatiser)')
    );
    console.log('  boîte perso ' + (google.enabled ? 'connexion Google disponible' : 'Google non configuré — SMTP personnel seulement'));
    if (String(process.env.OPEN_BROWSER || '') === '1') {
      openBrowser('http://localhost:' + port);
    }
  });

  const ctx = { db: db, mailer: mailer, vault: vault, google: google };
  /* Récapitulatif périodique au responsable : DIGEST_TO fixe le destinataire,
     à défaut le premier compte créé. DIGEST_DAY=0 le désactive. */
  const recapJour = process.env.DIGEST_DAY === undefined ? 1 : Number(process.env.DIGEST_DAY);
  const recapHeure = Number(process.env.DIGEST_HOUR || 8);

  const envoyerRecap = async function () {
    if (!(recapJour >= 1 && recapJour <= 6)) return;
    if (!mailer.enabled) return;
    const destinataire = process.env.DIGEST_TO || (db.data.users[0] && db.data.users[0].email);
    if (!destinataire) return;
    if (!reminders.recapDu({ jour: recapJour, heure: recapHeure, dernier: db.data.lastDigestAt })) return;

    const depuis = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recap = reminders.construireRecap(db.data.history, db.data.contacts, { depuis: depuis });
    await mailer.send({
      to: destinataire,
      subject:
        'Bureau du Courrier — ' + recap.enAttente + ' en attente, ' + recap.signales + ' à traiter',
      text: reminders.recapEnTexte(recap, db.data.settings.officeName)
    });
    await db.write(function (data) {
      data.lastDigestAt = new Date().toISOString();
    });
    console.log('[récap] envoyé à ' + destinataire);
  };

  const arreterRelances = reminders.startReminderLoop(ctx, {
    recapitulatif: envoyerRecap,
    delaiJours: relanceJours,
    escaladeJours: escaladeJours,
    envoyer: function (entree) {
      return envoyerRelance(ctx, entree, null);
    },
    signaler: function (entrees) {
      const ids = new Set(
        entrees.map(function (e) {
          return e.id;
        })
      );
      return db.write(function (data) {
        data.history.forEach(function (h) {
          if (!ids.has(h.id)) return;
          h.flaggedAt = new Date().toISOString();
          h.flagReason = 'sans retrait après relance';
        });
      });
    }
  });

  const shutdown = function () {
    arreterRelances();
    console.log('\nArrêt du serveur…');
    server.close(function () {
      process.exit(0);
    });
    setTimeout(function () {
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(function (err) {
  console.error('Démarrage impossible :', err);
  process.exit(1);
});
