#!/usr/bin/env node
/* Bureau du Courrier — point d'entrée du serveur.
   Usage :  npm start        (ou  node server/index.js  ·  PORT=8080 npm start) */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { Db, purger } = require('./db.js');
const { createMailer } = require('./mailer.js');
const { createVault } = require('./secrets.js');
const auth = require('./auth.js');
const { createGoogleOAuth } = require('./google.js');
const { createServer, VERSION, envoyerRelance } = require('./app.js');
const reminders = require('./reminders.js');
const reseau = require('./reseau.js');

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

  /* Code maître : empreinte écrite une fois, jamais le code en clair. Il se
     change par MASTER_CODE — indispensable, puisque la valeur par défaut est
     publiée avec le code source. */
  const codeMaitreVoulu = process.env.MASTER_CODE || '';
  if (!db.data.masterCodeHash || codeMaitreVoulu) {
    const doitEcrire =
      !db.data.masterCodeHash ||
      (codeMaitreVoulu && !auth.verifierCodeMaitre(db, codeMaitreVoulu));
    if (doitEcrire) {
      await db.write(function (data) {
        data.masterCodeHash = auth.empreinteCodeMaitre(codeMaitreVoulu);
      });
    }
  }

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
    domiciliationMois: Number(process.env.DOMICILIATION_MOIS || 0) || undefined,
    domiciliationAbsenceMois: Number(process.env.DOMICILIATION_ABSENCE_MOIS || 0) || undefined,
    rootDir: ROOT
  });

  /* HTTPS : indispensable dès que l'application sort du poste local — sans lui,
     mot de passe et cookie circulent en clair, et les navigateurs refusent
     d'installer l'application. Voir docs/mise-en-service-https.md. */
  let ecoute = server;
  let protocole = 'http';
  if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
    try {
      ecoute = https.createServer(
        {
          key: fs.readFileSync(process.env.HTTPS_KEY),
          cert: fs.readFileSync(process.env.HTTPS_CERT)
        },
        server.listeners('request')[0]
      );
      protocole = 'https';
    } catch (err) {
      console.error('Certificat illisible (' + err.message + ') — démarrage en http.');
    }
  }

  // /api/reseau doit annoncer l'adresse réellement servie, pas une supposition.
  server.ctx.port = port;
  server.ctx.protocole = protocole;

  ecoute.listen(port, host, async function () {
    const vue = reseau.resume({ port: port, protocole: protocole });

    console.log('Bureau du Courrier v' + VERSION);
    console.log('  sur ce poste  ' + protocole + '://localhost:' + port);

    /* L'adresse à taper sur les autres postes du bureau. Sans elle, il faut
       ouvrir une invite de commandes pour savoir quoi écrire sur le poste d'à
       côté — et personne à l'accueil n'a à faire ça. */
    if (vue.aucuneAdresse) {
      console.log('  autres postes aucune adresse réseau — câble débranché ou wifi coupé ?');
    } else {
      console.log('  autres postes ' + vue.recommandee);
      vue.adresses.forEach(function (a) {
        console.log('                ' + a.url + '  (' + a.type + ')' + (a.privee ? '' : '  ← hors réseau local'));
      });
      if (protocole === 'http') {
        console.log('                en http : mot de passe en clair, et pas d’installation');
        console.log('                possible sur les autres postes. Voir docs/plusieurs-postes.md');
      }
    }

    /* Le wifi redistribue les adresses au redémarrage : si celle-ci a bougé,
       les autres postes ne trouvent plus rien et personne ne sait pourquoi. On
       le note, pour que Réglages puisse le dire au responsable. */
    const connu = db.data.reseau || null;
    const aBouge = !!connu && !vue.aucuneAdresse && reseau.aChange(connu.adresses, vue.adresses);
    if (aBouge) {
      console.log('  ⚠ l’adresse de ce poste a changé depuis le dernier démarrage.');
      console.log('    Les autres postes doivent être remis à jour (Réglages → Postes du bureau).');
    }
    const maintenant = new Date().toISOString();
    try {
      await db.write(function (data) {
        data.reseau = {
          nomPoste: vue.nomPoste,
          adresses: vue.adresses.map(function (a) {
            return { adresse: a.adresse, carte: a.carte, type: a.type, famille: a.famille };
          }),
          // Ce qu'il fallait taper avant : de quoi comprendre ce qui a changé.
          precedentes: aBouge ? connu.adresses || [] : (connu && connu.precedentes) || [],
          changeAu: aBouge ? maintenant : (connu && connu.changeAu) || null,
          vuLe: maintenant
        };
      });
    } catch (err) {
      // Ne pas empêcher le démarrage pour une note d'information.
      console.error('  (adresse réseau non mémorisée : ' + err.message + ')');
    }

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
    const agents = db.data.users.filter(function (u) {
      return u.role === 'agent';
    }).length;
    console.log(
      '  accès agents ' +
        (agents === 0
          ? 'aucun — le responsable en crée depuis Réglages'
          : agents + ' identifiant(s) d’agent')
    );
    console.log(
      '  code maître ' +
        (process.env.MASTER_CODE
          ? 'défini par MASTER_CODE'
          : 'valeur par défaut — à changer par MASTER_CODE (voir README)')
    );
    if (String(process.env.OPEN_BROWSER || '') === '1') {
      openBrowser(protocole + '://localhost:' + port);
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

  /* Purge des courriers terminés au-delà de la durée de conservation. Passe
     avec la boucle de relance : une fois par tour suffit largement, et cela
     évite un second minuteur. */
  const purgerAncien = async function () {
    const mois = Number(db.data.settings.conservationMois || 0);
    if (mois <= 0) return;
    const bilan = await purger(db, { mois: mois });
    if (bilan.supprimes > 0) {
      console.log('[conservation] ' + bilan.supprimes + ' courrier(s) au-delà de ' + mois + ' mois effacé(s)');
    }
  };

  const arreterRelances = reminders.startReminderLoop(ctx, {
    recapitulatif: async function () {
      await envoyerRecap();
      await purgerAncien();
    },
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
    /* Les flux d'événements des autres postes ne se terminent jamais d'eux-mêmes.
       Sans cela, l'arrêt attendrait le délai de secours à chaque fois qu'un
       poste est relié — c'est-à-dire toujours, dans un bureau à quatre postes. */
    if (typeof ecoute.closeAllConnections === 'function') ecoute.closeAllConnections();
    ecoute.close(function () {
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
