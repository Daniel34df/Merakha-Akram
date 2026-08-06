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
const { createServer, VERSION } = require('./app.js');

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

  const server = createServer({
    db: db,
    mailer: mailer,
    vault: vault,
    google: google,
    signupOpen: signupOpen,
    verifyEmail: verifyEmail,
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
    console.log('  boîte perso ' + (google.enabled ? 'connexion Google disponible' : 'Google non configuré — SMTP personnel seulement'));
    if (String(process.env.OPEN_BROWSER || '') === '1') {
      openBrowser('http://localhost:' + port);
    }
  });

  const shutdown = function () {
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
