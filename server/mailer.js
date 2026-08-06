/* Bureau du Courrier — envoi de courriel.

   nodemailer est une dépendance *optionnelle* : sans elle (ou sans compte SMTP
   configuré), le serveur démarre quand même, annonce `smtp:false` au client, et
   l'interface retombe proprement sur le lien mailto. */
'use strict';

function readConfig(env) {
  const e = env || process.env;
  return {
    host: e.SMTP_HOST || '',
    port: Number(e.SMTP_PORT || 587),
    secure: String(e.SMTP_SECURE || '').toLowerCase() === 'true' || Number(e.SMTP_PORT) === 465,
    user: e.SMTP_USER || '',
    pass: e.SMTP_PASS || '',
    from: e.MAIL_FROM || e.SMTP_USER || '',
    dryRun: String(e.MAIL_DRY_RUN || '').toLowerCase() === 'true'
  };
}

/* Un champ vide et un champ absent doivent donner le même courriel : on ramène
   les deux à `undefined` avant l'envoi, quel que soit le mode. */
function normalizeMessage(message, defaultFrom) {
  const blank = function (v) {
    return v && String(v).trim() ? String(v).trim() : undefined;
  };
  return {
    from: blank(message.from) || defaultFrom,
    to: message.to,
    cc: blank(message.cc),
    bcc: blank(message.bcc),
    subject: message.subject,
    text: message.text
  };
}

function createMailer(env) {
  const config = readConfig(env);

  // Mode d'essai : rien ne part sur le réseau, les messages sont conservés en mémoire.
  if (config.dryRun) {
    const sent = [];
    return {
      enabled: true,
      mode: 'essai',
      sent: sent,
      async send(message) {
        const prepared = normalizeMessage(message, config.from || undefined);
        sent.push(prepared);
        console.log(
          '[mail:essai] ' +
            prepared.to +
            (prepared.cc ? ' (cc ' + prepared.cc + ')' : '') +
            (prepared.bcc ? ' (cci ' + prepared.bcc + ')' : '') +
            ' — ' +
            prepared.subject
        );
        return { messageId: 'dry-run-' + sent.length };
      }
    };
  }

  if (!config.host || !config.from) {
    return {
      enabled: false,
      mode: 'inactif',
      reason: 'SMTP non configuré (SMTP_HOST / MAIL_FROM manquants)',
      async send() {
        throw new Error('SMTP non configuré');
      }
    };
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    return {
      enabled: false,
      mode: 'inactif',
      reason: 'Module nodemailer absent — exécutez « npm install »',
      async send() {
        throw new Error('nodemailer non installé');
      }
    };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined
  });

  return {
    enabled: true,
    mode: 'smtp',
    config: { host: config.host, port: config.port, from: config.from },
    async send(message) {
      // L'expéditeur des réglages l'emporte, mais bien des fournisseurs SMTP
      // refusent un « De » qui ne correspond pas au compte authentifié : en cas
      // de doute, laissez le champ vide pour retomber sur MAIL_FROM.
      return transport.sendMail(normalizeMessage(message, config.from));
    }
  };
}

/* Envoi depuis la boîte personnelle d'un compte.

   Deux voies, choisies à la connexion de la boîte :
     - 'oauth2' : jeton Google, l'application n'a jamais vu le mot de passe ;
     - 'smtp'   : identifiants SMTP fournis par l'employé·e (mot de passe
                  d'application, jamais le mot de passe du compte).

   Le secret arrive déjà déchiffré : c'est l'appelant qui ouvre le coffre, pour
   que la clé ne circule pas jusqu'ici. */
function createUserMailer(mailbox, secret, options) {
  const opts = options || {};

  if (opts.dryRun) {
    const sent = [];
    return {
      mode: 'essai',
      sent: sent,
      async send(message) {
        const prepared = normalizeMessage(message, mailbox.address);
        sent.push(prepared);
        console.log('[mail:essai:' + mailbox.method + '] ' + prepared.to + ' — ' + prepared.subject);
        return { messageId: 'dry-run-user-' + sent.length };
      }
    };
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    throw Object.assign(new Error('Module nodemailer absent — exécutez « npm install »'), { status: 503 });
  }

  let transport;
  if (mailbox.method === 'oauth2') {
    if (!opts.clientId || !opts.clientSecret) {
      throw Object.assign(new Error('Connexion Google non configurée sur ce serveur'), { status: 503 });
    }
    // nodemailer renouvelle lui-même le jeton d'accès à partir du jeton durable.
    transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: mailbox.address,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        refreshToken: secret
      }
    });
  } else {
    transport = nodemailer.createTransport({
      host: mailbox.host,
      port: mailbox.port || 587,
      secure: mailbox.port === 465,
      auth: { user: mailbox.username || mailbox.address, pass: secret }
    });
  }

  return {
    mode: mailbox.method,
    async send(message) {
      return transport.sendMail(normalizeMessage(message, mailbox.address));
    }
  };
}

module.exports = {
  createMailer: createMailer,
  createUserMailer: createUserMailer,
  readConfig: readConfig,
  normalizeMessage: normalizeMessage
};
