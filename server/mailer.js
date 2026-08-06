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
        sent.push(message);
        console.log('[mail:essai] ' + message.to + ' — ' + message.subject);
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
      return transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text
      });
    }
  };
}

module.exports = { createMailer: createMailer, readConfig: readConfig };
