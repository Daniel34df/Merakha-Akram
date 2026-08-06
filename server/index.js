#!/usr/bin/env node
/* Bureau du Courrier — point d'entrée du serveur.
   Usage :  npm start        (ou  node server/index.js  ·  PORT=8080 npm start) */
'use strict';

const path = require('node:path');
const { Db } = require('./db.js');
const { createMailer } = require('./mailer.js');
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

async function main() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');

  const db = new Db(dbFile);
  await db.load();

  const mailer = createMailer(process.env);
  const server = createServer({ db: db, mailer: mailer, rootDir: ROOT });

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
