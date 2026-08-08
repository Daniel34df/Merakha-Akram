/* Bureau du Courrier — serveur HTTP (aucune dépendance obligatoire).
   Sert l'interface statique et l'API JSON sous /api. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const util = require('../assets/js/util.js');
const { DEFAULT_SETTINGS, sauvegarder, consigner, listerSauvegardes, restaurer, purger } = require('./db.js');
const auth = require('./auth.js');
const { createUserMailer } = require('./mailer.js');
const reminders = require('./reminders.js');
const domiciliation = require('../assets/js/domiciliation.js');
const roles = require('../assets/js/roles.js');
const reseau = require('./reseau.js');

const VERSION = '1.0.0';
const MAX_BODY = 1024 * 1024; // 1 Mo : largement de quoi importer un gros registre

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* En-têtes de sécurité appliqués à toutes les réponses.

   La politique de contenu n'autorise que les ressources du serveur lui-même :
   aucun script, aucune police, aucune image ne peut être chargé depuis
   l'extérieur, et rien ne part vers un tiers. 'unsafe-inline' n'est concédé
   qu'aux styles, l'interface plaçant quelques attributs style=""; les scripts,
   eux, sont tous des fichiers séparés. */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function withSecurityHeaders(headers) {
  return Object.assign({}, SECURITY_HEADERS, headers);
}

/** Vrai si la requête arrive bien de l'application elle-même. */
function isSameOriginRequest(req) {
  // Sec-Fetch-Site est posé par le navigateur et ne peut pas être falsifié par
  // une page tierce ; l'en-tête Origin sert de repli aux navigateurs anciens.
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true; // clients non navigateurs (curl, scripts) : pas de risque CSRF
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

/* Absence de session valide — le seul 401 qui doit renvoyer le client derrière
   l'écran de connexion. Les autres refus (mot de passe actuel erroné, droits
   insuffisants) portent un autre code : sans cette distinction, une faute de
   frappe dans un formulaire déconnecterait l'employé·e. */
function sessionExpiree() {
  return Object.assign(new Error('Connexion requise'), { status: 401, code: 'session' });
}

/* Retrait par un tiers : le nom de la personne qui se présente quand ce n'est
   pas le destinataire. À ne pas confondre avec `pickedUpBy`, qui est l'agent du
   guichet. Vide = le destinataire est venu lui-même, le cas courant. */
/* Gabarits par langue : { ar: { subject, body, templates: { colis: {…} } } }.
   On ne garde que les langues connues et les textes complets — un sujet sans
   corps donnerait un courriel vide, ce qui est pire que le message français. */
function nettoyerLangues(langues) {
  const out = {};
  if (!langues || typeof langues !== 'object') return out;
  util.LANGUES.forEach(function (l) {
    if (l.id === 'fr') return; // le français est le modèle général
    const entree = langues[l.id];
    if (!entree) return;
    const subject = String(entree.subject || '').trim();
    const body = String(entree.body || '').trim();
    const templates = util.nettoyerGabarits(entree.templates);
    if (!subject && !body && Object.keys(templates).length === 0) return;
    const propre = {};
    if (subject && body) {
      propre.subject = subject;
      propre.body = body;
    }
    if (Object.keys(templates).length) propre.templates = templates;
    if (Object.keys(propre).length) out[l.id] = propre;
  });
  return out;
}

function lirePorteur(corps) {
  const nom = String((corps && corps.porteur) || '').trim();
  if (!nom) return null;
  if (nom.length > 120) {
    throw Object.assign(new Error('Nom du porteur trop long'), { status: 400 });
  }
  return nom;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(
    status,
    withSecurityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    })
  );
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('JSON invalide'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanContact(input) {
  const name = String((input && input.name) || '').trim();
  const email = String((input && input.email) || '').trim();
  // Le numéro de boîte est libre et facultatif : « B-12 », « 142 », « Casier 7 ».
  const box = String((input && input.box) || '').trim().slice(0, 40);
  if (!name) throw Object.assign(new Error('Nom manquant'), { status: 400 });
  if (!util.isValidEmail(email)) throw Object.assign(new Error('Courriel invalide'), { status: 400 });

  const absentUntil = String((input && input.absentUntil) || '').trim();
  if (absentUntil && !/^\d{4}-\d{2}-\d{2}$/.test(absentUntil)) {
    throw Object.assign(new Error('Date d’absence invalide (attendu AAAA-MM-JJ)'), { status: 400 });
  }

  /* Élection de domicile. L'attestation a une échéance : si elle n'est pas
     fournie, on la calcule à partir de la date d'élection, ce qui évite de la
     saisir deux fois — et de la saisir faux. */
  const jourValide = function (valeur, quoi) {
    const v = String(valeur || '').trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw Object.assign(new Error(quoi + ' invalide (attendu AAAA-MM-JJ)'), { status: 400 });
    }
    return v;
  };
  const domicilie = !!(input && input.domicilie);
  const domicilieDepuis = jourValide(input && input.domicilieDepuis, 'Date d’élection de domicile');
  let domicilieJusqua = jourValide(input && input.domicilieJusqua, 'Échéance de l’attestation');
  if (domicilie && domicilieDepuis && !domicilieJusqua) {
    domicilieJusqua = domiciliation.echeance(domicilieDepuis);
  }
  if (domicilieDepuis && domicilieJusqua && domicilieJusqua < domicilieDepuis) {
    throw Object.assign(new Error('L’échéance précède la date d’élection de domicile'), { status: 400 });
  }
  const closeLe = jourValide(input && input.domiciliationCloseLe, 'Date de clôture');

  return {
    name: name,
    email: email,
    box: box,
    absentUntil: absentUntil,
    departed: !!(input && input.departed),
    substituteId: String((input && input.substituteId) || '').trim() || null,
    // Langue de notification. 'fr' par défaut : un destinataire existant n'en a pas.
    langue: util.langue(input && input.langue).id,
    // Antenne de rattachement. Vide = la première déclarée, s'il y en a.
    antenneId: String((input && input.antenneId) || '').trim().slice(0, 40),
    /* Renseignements du formulaire de domiciliation. Le téléphone compte
       autant que le courriel : une partie du public n'a pas d'adresse. */
    telephone: String((input && input.telephone) || '').trim().slice(0, 40),
    naissance: jourValide(input && input.naissance, 'Date de naissance'),
    notes: String((input && input.notes) || '').trim().slice(0, 300),
    domicilie: domicilie,
    domicilieDepuis: domicilie ? domicilieDepuis : '',
    domicilieJusqua: domicilie ? domicilieJusqua : '',
    domiciliationCloseLe: domicilie ? closeLe : '',
    domiciliationMotif: domicilie ? String((input && input.domiciliationMotif) || '').trim().slice(0, 200) : ''
  };
}

function findDuplicate(contacts, email, exceptId) {
  return (
    contacts.find(function (c) {
      return util.normalize(c.email) === util.normalize(email) && c.id !== exceptId;
    }) || null
  );
}

/* ---------- fichiers statiques ---------- */

async function serveStatic(req, res, rootDir) {
  const parsed = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(parsed.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(rootDir, path.normalize(rel));
  // Empêche toute sortie de l'arborescence servie (« /../server/.env »).
  if (!target.startsWith(rootDir + path.sep) && target !== rootDir) {
    res.writeHead(403).end('Interdit');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404).end('Introuvable');
    return;
  }

  const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }

  const headers = withSecurityHeaders({
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': 'no-cache'
  });
  // Un service worker figé dans le cache HTTP bloquerait toute mise à jour de
  // l'application installée : celui-ci doit toujours être revalidé.
  if (rel === '/sw.js') {
    headers['Cache-Control'] = 'no-cache, must-revalidate';
    headers['Service-Worker-Allowed'] = '/';
  }
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}

/* ---------- comptes ---------- */

function sendJsonWithCookie(res, status, payload, cookie) {
  const body = JSON.stringify(payload);
  res.writeHead(
    status,
    withSecurityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Set-Cookie': cookie
    })
  );
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, withSecurityHeaders({ Location: location, 'Cache-Control': 'no-store' }));
  res.end();
}

/* Code de retrait : quatre chiffres, communiqués au destinataire et présentés
   au guichet. Ce n'est pas un secret — il ne protège rien — mais il doit être
   unique parmi les courriers en attente, sans quoi le guichet ne saurait pas
   lequel marquer. */
function genererCodeRetrait(history) {
  const pris = new Set(
    (history || [])
      .filter(function (h) {
        return !h.pickedUpAt && !h.closedAt && h.pickupCode;
      })
      .map(function (h) {
        return h.pickupCode;
      })
  );
  for (let essai = 0; essai < 200; essai++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!pris.has(code)) return code;
  }
  return String(crypto.randomInt(1000, 10000));
}

/* Refus faute d'autorisation. Distinct du 401 « session expirée » : la session
   est parfaitement valable, c'est le droit qui manque. */
function droitManquant(droit) {
  return Object.assign(new Error('Cette action n’est pas ouverte à votre accès'), {
    status: 403,
    code: 'droit',
    droit: droit
  });
}

/* Un champ de texte des réglages : absent de la requête = inchangé, présent =
   nettoyé et borné. Sans la borne, un copier-coller malheureux ferait grossir
   le registre sans que personne ne s'en aperçoive. */
function champTexte(valeur, actuelle, maxi) {
  if (valeur === undefined) return String(actuelle || '');
  return String(valeur || '').replace(/\s+/g, ' ').trim().slice(0, maxi || 200);
}

function exigerDroit(user, droit) {
  /* `user` n'est nul que sur un serveur sans aucun compte : le garde-fou
     précédent a déjà renvoyé 401 dès qu'un compte existe. Ce cas est le
     registre volontairement ouvert du premier démarrage — on ne lui applique
     pas d'autorisations, il n'y a personne à autoriser. */
  if (!user) return;
  if (!roles.peut(user, droit)) throw droitManquant(droit);
}

/* Un des droits suffit. Sert là où deux métiers différents mènent à la même
   écriture : ouvrir une domiciliation crée un destinataire, mais c'est le
   travail de l'accueil, pas une modification du registre. */
function exigerUnDesDroits(user, droits) {
  if (!user) return;
  const ouvert = droits.some(function (d) {
    return roles.peut(user, d);
  });
  if (!ouvert) throw droitManquant(droits[0]);
}

function createUserRecord(name, email, passwordHash, options) {
  const opts = options || {};
  return {
    id: crypto.randomUUID(),
    name: name,
    email: email,
    password: passwordHash,
    /* Le premier compte créé est le responsable du bureau : il ouvre
       l'application, distribue les accès et garde le contrôle. Les comptes
       ajoutés ensuite depuis son écran sont ce qu'il décide. */
    role: opts.role || 'responsable',
    permissions: opts.role === 'agent' ? roles.nettoyerPermissions(opts.permissions) : null,
    identifiant: opts.identifiant || '',
    accessCodeHash: opts.accessCodeHash || '',
    /* Antenne d'un accès. Vide = toutes — le cas du responsable et d'un agent
       qui tourne sur plusieurs points d'accueil. */
    antenneId: String(opts.antenneId || '').trim().slice(0, 40),
    createdAt: new Date().toISOString(),
    emailVerifiedAt: new Date().toISOString(),
    mailbox: null,
    mailboxSecret: ''
  };
}

/* Le code part du compte du serveur : au moment de l'inscription, personne n'a
   encore de boîte reliée. */
async function sendVerificationCode(ctx, pending, code) {
  const bureau = (ctx.db.data.settings && ctx.db.data.settings.officeName) || 'Bureau du Courrier';
  await ctx.mailer.send({
    to: pending.email,
    subject: 'Votre code de confirmation : ' + code,
    text:
      'Bonjour ' +
      pending.name +
      ',\n\n' +
      'Voici le code de confirmation pour créer votre compte sur ' +
      bureau +
      ' :\n\n' +
      '    ' +
      code +
      '\n\n' +
      'Ce code est valable ' +
      auth.CODE_MINUTES +
      ' minutes.\n\n' +
      'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : ' +
      'aucun compte ne sera créé sans ce code.'
  });
}

/* Code de réinitialisation d'un mot de passe oublié. Le message dit clairement
   qu'aucun changement n'a encore eu lieu : quelqu'un qui reçoit ce courriel sans
   l'avoir demandé doit savoir que son compte est intact. */
async function sendResetCode(ctx, user, code) {
  const bureau = (ctx.db.data.settings && ctx.db.data.settings.officeName) || 'Bureau du Courrier';
  await ctx.mailer.send({
    to: user.email,
    subject: 'Votre code de réinitialisation : ' + code,
    text:
      'Bonjour ' +
      user.name +
      ',\n\n' +
      'Vous avez demandé à choisir un nouveau mot de passe sur ' +
      bureau +
      '.\n\n' +
      '    ' +
      code +
      '\n\n' +
      'Ce code est valable ' +
      auth.RESET_MINUTES +
      ' minutes.\n\n' +
      'Votre mot de passe actuel fonctionne toujours : rien n’a changé tant que ' +
      'ce code n’a pas été utilisé. Si vous n’êtes pas à l’origine de cette ' +
      'demande, ignorez ce message.'
  });
}

/* Relance : le même message, précédé d'un rappel. L'envoi passe par la boîte de
   la personne connectée si elle en a une, sinon par le compte du serveur — la
   boucle automatique, elle, n'a personne de connecté et utilise le serveur. */
async function envoyerRelance(ctx, entree, currentUser) {
  const settings = ctx.db.data.settings;
  const vars = {
    nom: entree.name,
    courriel: entree.email,
    date: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
    bureau: settings.officeName
  };
  const jours = Math.floor(reminders.joursEcoules(entree.date, Date.now()));
  const type = util.typeCourrier(entree.type);
  vars.type = type.label;
  vars.article = type.article;
  vars.article_min = type.article.toLowerCase();
  vars.code = entree.pickupCode || '';

  const destinataire = (ctx.db.data.contacts || []).find(function (c) {
    return c.id === entree.contactId || util.normalize(c.email) === util.normalize(entree.email);
  });
  const gabarit = util.gabaritPour(settings, type.id, destinataire && destinataire.langue);
  const subject = 'Rappel — ' + util.renderTemplate(gabarit.subject, vars);
  const text =
    util.renderTemplate(gabarit.body, vars) +
    '\n\n— Rappel : ' +
    type.article.toLowerCase() +
    ' vous attend depuis ' +
    jours +
    ' jour' +
    (jours > 1 ? 's' : '') +
    '.' +
    (entree.pickupCode ? '\nCode de retrait : ' + entree.pickupCode : '');

  let sender = ctx.mailer;
  let senderLabel = 'serveur';
  if (currentUser && currentUser.mailbox) {
    const secret = ctx.vault.open(currentUser.mailboxSecret);
    if (secret !== null) {
      sender = createUserMailer(currentUser.mailbox, secret, {
        dryRun: ctx.mailer.mode === 'essai',
        clientId: ctx.google.clientId,
        clientSecret: ctx.google.clientSecret
      });
      senderLabel = currentUser.mailbox.address;
    }
  }
  if (!sender.enabled && sender === ctx.mailer) {
    throw Object.assign(new Error(ctx.mailer.reason || 'Envoi automatique indisponible'), { status: 503 });
  }

  await sender.send({
    to: entree.email,
    cc: entree.cc || '',
    bcc: entree.bcc || '',
    subject: subject,
    text: text
  });

  await ctx.db.write(function (data) {
    const cible = data.history.find(function (h) {
      return h.id === entree.id;
    });
    if (!cible) return;
    cible.reminderCount = (cible.reminderCount || 0) + 1;
    cible.remindedAt = new Date().toISOString();
  });

  return {
    sent: true,
    sentBy: senderLabel,
    record: ctx.db.data.history.find(function (h) {
      return h.id === entree.id;
    })
  };
}

/** Renvoie true si la route a été traitée ici. */
async function handleAuth(req, res, ctx, pathname) {
  const { db, vault, google, throttle } = ctx;
  const method = req.method;
  const secureCookie =
    (req.headers['x-forwarded-proto'] || '') === 'https' || !!(req.socket && req.socket.encrypted);

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = auth.userFromRequest(db, req);
    sendJson(res, 200, {
      user: auth.publicUser(user),
      accountsExist: (db.data.users || []).length > 0,
      signupOpen: ctx.signupOpen,
      googleOAuth: google.enabled,
      verifyEmail: ctx.verifyEmail
    });
    return true;
  }

  if (pathname === '/api/auth/signup' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');

    if (!name) throw Object.assign(new Error('Nom manquant'), { status: 400 });
    if (!util.isValidEmail(email)) throw Object.assign(new Error('Courriel invalide'), { status: 400 });
    const weak = auth.checkPasswordStrength(password);
    if (weak) throw Object.assign(new Error(weak), { status: 400 });

    // Le tout premier compte est toujours autorisé : sans lui, personne ne
    // pourrait ouvrir l'application après avoir fermé les inscriptions.
    const first = (db.data.users || []).length === 0;
    if (!first && !ctx.signupOpen) {
      throw Object.assign(new Error('Les inscriptions sont fermées sur ce serveur'), { status: 403 });
    }
    if (auth.findUserByEmail(db, email)) {
      throw Object.assign(new Error('Un compte existe déjà avec ce courriel'), { status: 409 });
    }

    /* Vérification de l'adresse : sans elle, n'importe qui peut s'inscrire avec
       le courriel d'un collègue. Elle suppose que le serveur sache envoyer un
       courriel — sinon il n'y a aucun moyen d'acheminer le code. */
    if (ctx.verifyEmail && !ctx.mailer.enabled) {
      throw Object.assign(
        new Error(
          'Ce serveur ne peut pas envoyer de courriel : la vérification par code est impossible. ' +
            'Configurez SMTP, ou mettez VERIFY_EMAIL=false.'
        ),
        { status: 503 }
      );
    }

    if (ctx.verifyEmail) {
      /* Sans frein, cette route est un envoyeur de courriels à la demande :
         il suffirait de la rappeler avec l'adresse d'un tiers pour l'inonder. */
      const limite = ctx.signupThrottle.check(util.normalize(email));
      if (limite.blocked) {
        throw Object.assign(
          new Error('Trop de demandes pour cette adresse. Réessayez dans ' + Math.ceil(limite.retryInSeconds / 60) + ' minute(s).'),
          { status: 429 }
        );
      }

      const code = auth.generateCode();
      const pending = auth.newPendingSignup({ name: name, email: email, password: auth.hashPassword(password) }, code);
      try {
        await sendVerificationCode(ctx, pending, code);
      } catch (err) {
        // Un envoi qui échoue ne consomme pas le quota : l'adresse n'a rien reçu.
        console.error('[inscription] envoi du code impossible :', err.message);
        throw Object.assign(
          new Error(
            'Le code n’a pas pu être envoyé : ' + err.message +
              '. Vérifiez la configuration SMTP du serveur (voir docs/installation-windows-gmail.md).'
          ),
          { status: 502 }
        );
      }
      ctx.signupThrottle.fail(util.normalize(email));
      await db.write(function (data) {
        // Une nouvelle demande remplace la précédente pour la même adresse ;
        // une réinitialisation en cours sur la même adresse n'est pas touchée.
        data.pending = data.pending.filter(function (p) {
          return util.normalize(p.email) !== util.normalize(email) || auth.pendingKind(p) !== 'signup';
        });
        data.pending.push(pending);
      });
      sendJson(res, 202, {
        pending: true,
        email: email,
        codeLength: auth.CODE_LENGTH,
        expiresInMinutes: auth.CODE_MINUTES
      });
      return true;
    }

    const user = createUserRecord(name, email, auth.hashPassword(password));
    const session = auth.newSession(user.id);
    await db.write(function (data) {
      data.users.push(user);
      data.sessions.push(session);
    });

    sendJsonWithCookie(res, 201, { user: auth.publicUser(user) }, auth.sessionCookie(session.token, { secure: secureCookie }));
    return true;
  }

  if (pathname === '/api/auth/verify' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    const code = String(body.code || '').trim();

    const pending = auth.findPending(db, email, 'signup');
    if (!pending || auth.pendingExpired(pending)) {
      throw Object.assign(new Error('Code expiré ou inscription introuvable — recommencez l’inscription'), {
        status: 410
      });
    }
    if (pending.attempts >= auth.CODE_MAX_ATTEMPTS) {
      throw Object.assign(new Error('Trop de codes erronés — recommencez l’inscription'), { status: 429 });
    }

    if (!auth.verifyPassword(code, pending.codeHash)) {
      await db.write(function (data) {
        const target = data.pending.find(function (p) {
          return p.id === pending.id;
        });
        if (target) target.attempts++;
      });
      // `pending` désigne l'objet que db.write vient d'incrémenter : le compteur
      // est déjà à jour ici, l'ajouter une seconde fois fausserait le décompte.
      const left = auth.CODE_MAX_ATTEMPTS - pending.attempts;
      throw Object.assign(
        new Error('Code incorrect.' + (left > 0 ? ' Il reste ' + left + ' essai(s).' : ' Recommencez l’inscription.')),
        { status: 401 }
      );
    }

    // Une inscription a pu aboutir pendant l'attente du code.
    if (auth.findUserByEmail(db, pending.email)) {
      throw Object.assign(new Error('Un compte existe déjà avec ce courriel'), { status: 409 });
    }

    const user = createUserRecord(pending.name, pending.email, pending.password);
    const session = auth.newSession(user.id);
    await db.write(function (data) {
      data.users.push(user);
      data.sessions.push(session);
      data.pending = data.pending.filter(function (p) {
        return p.id !== pending.id;
      });
    });
    sendJsonWithCookie(res, 201, { user: auth.publicUser(user) }, auth.sessionCookie(session.token, { secure: secureCookie }));
    return true;
  }

  if (pathname === '/api/auth/resend' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    const pending = auth.findPending(db, email, 'signup');
    if (!pending || auth.pendingExpired(pending)) {
      throw Object.assign(new Error('Aucune inscription en attente pour cette adresse'), { status: 410 });
    }
    const wait = auth.secondsBeforeResend(pending);
    if (wait > 0) {
      throw Object.assign(new Error('Patientez ' + wait + ' seconde(s) avant de redemander un code'), { status: 429 });
    }

    const code = auth.generateCode();
    await sendVerificationCode(ctx, pending, code);
    await db.write(function (data) {
      const target = data.pending.find(function (p) {
        return p.id === pending.id;
      });
      if (target) {
        target.codeHash = auth.hashPassword(code);
        target.attempts = 0;
        target.lastSentAt = new Date().toISOString();
      }
    });
    sendJson(res, 200, { sent: true, email: pending.email });
    return true;
  }

  /* --- mot de passe oublié ---

     Sans cette route, un mot de passe perdu enferme dehors : le registre est
     là, le compte aussi, mais plus personne ne peut ouvrir. La reprise passe
     par l'adresse du compte, seule chose que le titulaire possède encore. */

  if (pathname === '/api/auth/forgot' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    if (!util.isValidEmail(email)) throw Object.assign(new Error('Courriel invalide'), { status: 400 });

    if (!ctx.mailer.enabled) {
      throw Object.assign(
        new Error(
          'Ce serveur ne peut pas envoyer de courriel : le code ne pourrait pas vous parvenir. ' +
            'Demandez à la personne qui administre le poste de lancer « npm run motdepasse ».'
        ),
        { status: 503 }
      );
    }

    // Même frein que pour l'inscription : cette route envoie un courriel.
    const cle = 'reset:' + util.normalize(email);
    const limite = ctx.signupThrottle.check(cle);
    if (limite.blocked) {
      throw Object.assign(
        new Error('Trop de demandes pour cette adresse. Réessayez dans ' + Math.ceil(limite.retryInSeconds / 60) + ' minute(s).'),
        { status: 429 }
      );
    }
    ctx.signupThrottle.fail(cle);

    const user = auth.findUserByEmail(db, email);
    /* Réponse identique que le compte existe ou non : sinon, cette route dirait
       à un inconnu quelles adresses ont un compte dans ce bureau. */
    if (user) {
      const code = auth.generateCode();
      const pending = auth.newPendingReset(user.id, user.email, code);
      try {
        await sendResetCode(ctx, user, code);
      } catch (err) {
        console.error('[oubli] envoi du code impossible :', err.message);
        throw Object.assign(new Error('Le code n’a pas pu être envoyé : ' + err.message), { status: 502 });
      }
      await db.write(function (data) {
        data.pending = data.pending.filter(function (p) {
          return util.normalize(p.email) !== util.normalize(email) || auth.pendingKind(p) !== 'reset';
        });
        data.pending.push(pending);
      });
    }

    sendJson(res, 202, {
      sent: true,
      email: email,
      codeLength: auth.CODE_LENGTH,
      expiresInMinutes: auth.RESET_MINUTES
    });
    return true;
  }

  if (pathname === '/api/auth/reset' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    const code = String(body.code || '').trim();

    const pending = auth.findPending(db, email, 'reset');
    if (!pending || auth.pendingExpired(pending)) {
      throw Object.assign(new Error('Code expiré ou demande introuvable — recommencez'), { status: 410 });
    }
    if (pending.attempts >= auth.CODE_MAX_ATTEMPTS) {
      throw Object.assign(new Error('Trop de codes erronés — recommencez la demande'), { status: 429 });
    }
    if (!auth.verifyPassword(code, pending.codeHash)) {
      await db.write(function (data) {
        const target = data.pending.find(function (p) {
          return p.id === pending.id;
        });
        if (target) target.attempts++;
      });
      const reste = auth.CODE_MAX_ATTEMPTS - pending.attempts;
      throw Object.assign(
        new Error('Code incorrect.' + (reste > 0 ? ' Il reste ' + reste + ' essai(s).' : ' Recommencez la demande.')),
        { status: 401 }
      );
    }

    // Le code est bon : le nouveau mot de passe doit tenir les mêmes exigences.
    const faible = auth.checkPasswordStrength(String(body.password || ''));
    if (faible) throw Object.assign(new Error(faible), { status: 400 });

    const user = (db.data.users || []).find(function (u) {
      return u.id === pending.userId;
    });
    if (!user) throw Object.assign(new Error('Ce compte n’existe plus'), { status: 410 });

    const session = auth.newSession(user.id);
    await db.write(function (data) {
      const cible = data.users.find(function (u) {
        return u.id === user.id;
      });
      cible.password = auth.hashPassword(String(body.password));
      /* Toutes les sessions tombent : si le mot de passe a été oublié parce
         qu'un tiers l'a changé, il ne doit pas rester connecté ailleurs. */
      data.sessions = data.sessions.filter(function (s) {
        return s.userId !== user.id;
      });
      data.sessions.push(session);
      data.pending = data.pending.filter(function (p) {
        return p.id !== pending.id;
      });
    });
    await consigner(db, {
      qui: user.name,
      action: 'mot de passe réinitialisé',
      cible: user.email,
      details: 'par code reçu par courriel'
    });

    sendJsonWithCookie(
      res,
      200,
      { user: auth.publicUser(user) },
      auth.sessionCookie(session.token, { secure: secureCookie })
    );
    return true;
  }

  /* --- accès agent par identifiant --- */

  /* Deuxième porte d'entrée. Un agent n'a pas de courriel à créer ni de mot de
     passe à retenir : le responsable lui remet un identifiant et un code à six
     chiffres, qu'il saisit sur le poste d'accueil. Même freinage que la
     connexion par mot de passe, et même message en cas d'échec — l'un ne doit
     pas révéler ce que l'autre cache. */
  if (pathname === '/api/auth/login-code' && method === 'POST') {
    const body = await readBody(req);
    const identifiant = roles.normaliserIdentifiant(body.identifiant);
    const cle = 'agent:' + (identifiant || 'inconnu');

    const frein = throttle.check(cle);
    if (frein.blocked) {
      throw Object.assign(
        new Error('Trop de tentatives. Réessayez dans ' + Math.ceil(frein.retryInSeconds / 60) + ' minute(s).'),
        { status: 429 }
      );
    }

    const agent = (db.data.users || []).find(function (u) {
      return u.role === 'agent' && roles.normaliserIdentifiant(u.identifiant) === identifiant;
    });
    let ok = false;
    if (agent && agent.accessCodeHash) {
      ok = auth.verifyPassword(String(body.code || ''), agent.accessCodeHash);
    } else {
      auth.equalizeTiming(body.code);
    }
    if (!ok) {
      throttle.fail(cle);
      throw Object.assign(new Error('Identifiant ou code d’accès incorrect'), { status: 401 });
    }
    if (agent.suspendu) {
      throw Object.assign(new Error('Cet accès a été suspendu par le responsable'), { status: 403 });
    }
    throttle.succeed(cle);

    const session = auth.newSession(agent.id);
    await db.write(function (data) {
      data.sessions.push(session);
      const cible = data.users.find(function (u) {
        return u.id === agent.id;
      });
      if (cible) cible.derniereConnexion = new Date().toISOString();
    });
    await consigner(db, { qui: agent.name, action: 'connexion agent', cible: agent.identifiant });

    return sendJsonWithCookie(
      res,
      200,
      { user: auth.publicUser(agent) },
      auth.sessionCookie(session.token, { secure: secureCookie })
    );
  }

  /* --- comptes secondaires, créés par le responsable --- */

  if (pathname === '/api/auth/agents' && (method === 'GET' || method === 'POST')) {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    if (!roles.estResponsable(user)) {
      throw Object.assign(new Error('Seul le compte responsable gère les accès'), { status: 403, code: 'droit' });
    }

    if (method === 'GET') {
      return sendJson(res, 200, {
        droits: roles.DROITS,
        agents: (db.data.users || [])
          .filter(function (u) {
            return u.role === 'agent';
          })
          .map(function (u) {
            return {
              id: u.id,
              name: u.name,
              identifiant: u.identifiant,
              permissions: roles.nettoyerPermissions(u.permissions),
              antenneId: u.antenneId || '',
              suspendu: !!u.suspendu,
              createdAt: u.createdAt,
              derniereConnexion: u.derniereConnexion || null
            };
          })
      });
    }

    const corps = await readBody(req);
    const nom = String(corps.name || '').trim();
    if (!nom) throw Object.assign(new Error('Donnez un nom à cet accès'), { status: 400 });

    /* L'identifiant est tiré au sort jusqu'à en trouver un libre : le
       responsable n'a pas à inventer un code unique. */
    let identifiant = '';
    for (let i = 0; i < 50 && !identifiant; i++) {
      const essai = roles.genererIdentifiant(function (n) {
        return crypto.randomInt(0, n);
      });
      const pris = (db.data.users || []).some(function (u) {
        return roles.normaliserIdentifiant(u.identifiant) === essai;
      });
      if (!pris) identifiant = essai;
    }
    if (!identifiant) throw Object.assign(new Error('Impossible de tirer un identifiant libre'), { status: 500 });

    const code = auth.generateCode();
    const agent = createUserRecord(nom, '', '', {
      role: 'agent',
      permissions: corps.permissions,
      identifiant: identifiant,
      antenneId: corps.antenneId,
      accessCodeHash: auth.hashPassword(code)
    });
    await db.write(function (data) {
      data.users.push(agent);
    });
    await consigner(db, {
      qui: user.name,
      action: 'accès agent créé',
      cible: nom,
      details: identifiant
    });

    /* Le code n'est renvoyé qu'ici, une seule fois : il n'est conservé que
       haché. Perdu, il se régénère — il ne se retrouve pas. */
    return sendJson(res, 201, {
      agent: {
        id: agent.id,
        name: agent.name,
        identifiant: identifiant,
        permissions: roles.nettoyerPermissions(agent.permissions),
        suspendu: false
      },
      code: code
    });
  }

  const agentMatch = pathname.match(/^\/api\/auth\/agents\/([^/]+)(\/code)?$/);
  if (agentMatch) {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    if (!roles.estResponsable(user)) {
      throw Object.assign(new Error('Seul le compte responsable gère les accès'), { status: 403, code: 'droit' });
    }
    const id = decodeURIComponent(agentMatch[1]);
    const agent = (db.data.users || []).find(function (u) {
      return u.id === id && u.role === 'agent';
    });
    if (!agent) throw Object.assign(new Error('Accès introuvable'), { status: 404 });

    // Nouveau code d'accès : l'ancien cesse aussitôt de fonctionner.
    if (agentMatch[2] && method === 'POST') {
      const code = auth.generateCode();
      await db.write(function (data) {
        const cible = data.users.find(function (u) {
          return u.id === id;
        });
        cible.accessCodeHash = auth.hashPassword(code);
        // Les sessions ouvertes avec l'ancien code tombent.
        data.sessions = data.sessions.filter(function (sess) {
          return sess.userId !== id;
        });
      });
      await consigner(db, { qui: user.name, action: 'code d’accès régénéré', cible: agent.name });
      return sendJson(res, 200, { code: code, identifiant: agent.identifiant });
    }

    if (method === 'PUT') {
      const corps = await readBody(req);
      await db.write(function (data) {
        const cible = data.users.find(function (u) {
          return u.id === id;
        });
        if (corps.name !== undefined) cible.name = String(corps.name).trim() || cible.name;
        if (corps.permissions !== undefined) {
          cible.permissions = roles.nettoyerPermissions(corps.permissions);
        }
        if (corps.antenneId !== undefined) {
          cible.antenneId = String(corps.antenneId || '').trim().slice(0, 40);
        }
        if (corps.suspendu !== undefined) {
          cible.suspendu = !!corps.suspendu;
          // Suspendre ferme les sessions en cours : sinon l'accès continue.
          if (cible.suspendu) {
            data.sessions = data.sessions.filter(function (sess) {
              return sess.userId !== id;
            });
          }
        }
      });
      const relu = db.data.users.find(function (u) {
        return u.id === id;
      });
      await consigner(db, { qui: user.name, action: 'accès agent modifié', cible: relu.name });
      return sendJson(res, 200, {
        agent: {
          id: relu.id,
          name: relu.name,
          identifiant: relu.identifiant,
          permissions: roles.nettoyerPermissions(relu.permissions),
          suspendu: !!relu.suspendu
        }
      });
    }

    if (method === 'DELETE') {
      await db.write(function (data) {
        data.users = data.users.filter(function (u) {
          return u.id !== id;
        });
        data.sessions = data.sessions.filter(function (sess) {
          return sess.userId !== id;
        });
      });
      await consigner(db, { qui: user.name, action: 'accès agent supprimé', cible: agent.name });
      return sendJson(res, 200, { supprime: true });
    }
  }

  /* --- code maître : reprise en main du compte responsable --- */

  if (pathname === '/api/auth/master' && method === 'POST') {
    const corps = await readBody(req);
    const cle = 'master';
    const frein = throttle.check(cle);
    if (frein.blocked) {
      throw Object.assign(
        new Error('Trop de tentatives. Réessayez dans ' + Math.ceil(frein.retryInSeconds / 60) + ' minute(s).'),
        { status: 429 }
      );
    }
    if (!auth.verifierCodeMaitre(db, corps.code)) {
      throttle.fail(cle);
      throw Object.assign(new Error('Code incorrect'), { status: 401 });
    }
    throttle.succeed(cle);

    const responsable = (db.data.users || []).find(function (u) {
      return (u.role || 'responsable') === 'responsable';
    });
    if (!responsable) throw Object.assign(new Error('Aucun compte responsable'), { status: 404 });

    const action = String(corps.action || 'voir');

    if (action === 'voir') {
      return sendJson(res, 200, {
        responsable: { id: responsable.id, name: responsable.name, email: responsable.email }
      });
    }

    if (action === 'email') {
      const email = String(corps.email || '').trim();
      if (!util.isValidEmail(email)) throw Object.assign(new Error('Courriel invalide'), { status: 400 });
      await db.write(function (data) {
        const cible = data.users.find(function (u) {
          return u.id === responsable.id;
        });
        cible.email = email;
      });
      await consigner(db, { qui: 'code maître', action: 'adresse du responsable modifiée', cible: email });
      return sendJson(res, 200, { ok: true, email: email });
    }

    if (action === 'password') {
      const faible = auth.checkPasswordStrength(String(corps.password || ''));
      if (faible) throw Object.assign(new Error(faible), { status: 400 });
      await db.write(function (data) {
        const cible = data.users.find(function (u) {
          return u.id === responsable.id;
        });
        cible.password = auth.hashPassword(String(corps.password));
        // Toutes les sessions du responsable tombent : on ne sait pas qui les tient.
        data.sessions = data.sessions.filter(function (sess) {
          return sess.userId !== responsable.id;
        });
      });
      await consigner(db, { qui: 'code maître', action: 'mot de passe du responsable changé', cible: responsable.email });
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'supprimer') {
      /* Supprimer le responsable rouvre l'installation : au prochain
         démarrage, l'application propose de créer le compte du bureau. Le
         registre, lui, n'est pas touché. */
      await db.write(function (data) {
        data.users = data.users.filter(function (u) {
          return u.id !== responsable.id;
        });
        data.sessions = data.sessions.filter(function (sess) {
          return sess.userId !== responsable.id;
        });
      });
      await consigner(db, { qui: 'code maître', action: 'compte responsable supprimé', cible: responsable.email });
      return sendJson(res, 200, { ok: true, supprime: true });
    }

    throw Object.assign(new Error('Action inconnue'), { status: 400 });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    const key = util.normalize(email) || 'inconnu';

    const state = throttle.check(key);
    if (state.blocked) {
      throw Object.assign(
        new Error('Trop de tentatives. Réessayez dans ' + Math.ceil(state.retryInSeconds / 60) + ' minute(s).'),
        { status: 429 }
      );
    }

    const user = auth.findUserByEmail(db, email);
    // Même message et même coût dans les deux cas : ne pas révéler quels
    // courriels ont un compte.
    let ok = false;
    if (user) {
      ok = auth.verifyPassword(String(body.password || ''), user.password);
    } else {
      auth.equalizeTiming(body.password);
    }
    if (!ok) {
      throttle.fail(key);
      throw Object.assign(new Error('Courriel ou mot de passe incorrect'), { status: 401 });
    }
    throttle.succeed(key);

    const session = auth.newSession(user.id);
    await db.write(function (data) {
      data.sessions.push(session);
    });
    sendJsonWithCookie(res, 200, { user: auth.publicUser(user) }, auth.sessionCookie(session.token, { secure: secureCookie }));
    return true;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    if (token) {
      await db.write(function (data) {
        data.sessions = data.sessions.filter(function (s) {
          return s.token !== token;
        });
      });
    }
    sendJsonWithCookie(res, 200, { ok: true }, auth.sessionCookie('', { secure: secureCookie }));
    return true;
  }

  /* --- gestion des comptes --- */

  if (pathname === '/api/auth/password' && method === 'PUT') {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    const body = await readBody(req);

    /* 403 et non 401 : la session est valide, c'est la valeur saisie qui est
       fausse. Un 401 ferait croire au client que la session a expiré et le
       renverrait à l'écran de connexion pour une simple faute de frappe. */
    if (!auth.verifyPassword(String(body.current || ''), user.password)) {
      throw Object.assign(new Error('Mot de passe actuel incorrect'), { status: 403 });
    }
    const faible = auth.checkPasswordStrength(String(body.next || ''));
    if (faible) throw Object.assign(new Error(faible), { status: 400 });

    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    await db.write(function (data) {
      const cible = data.users.find(function (u) {
        return u.id === user.id;
      });
      cible.password = auth.hashPassword(String(body.next));
      // Changer de mot de passe doit fermer les autres sessions : c'est
      // précisément ce qu'on fait quand on soupçonne un accès indésirable.
      data.sessions = data.sessions.filter(function (s) {
        return s.userId !== user.id || s.token === token;
      });
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/auth/users' && method === 'GET') {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    const responsable = (db.data.users || [])[0];
    sendJson(res, 200, {
      // Le premier compte créé est celui du bureau : lui seul peut retirer un accès.
      responsableId: responsable ? responsable.id : null,
      users: (db.data.users || []).map(function (u) {
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          createdAt: u.createdAt,
          mailbox: u.mailbox ? u.mailbox.address : null,
          sessions: (db.data.sessions || []).filter(function (s) {
            return s.userId === u.id;
          }).length
        };
      })
    });
    return true;
  }

  const userMatch = pathname.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (userMatch && method === 'DELETE') {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    const responsable = (db.data.users || [])[0];
    if (!responsable || responsable.id !== user.id) {
      throw Object.assign(new Error('Seul le compte responsable peut retirer un accès'), { status: 403 });
    }
    const id = decodeURIComponent(userMatch[1]);
    if (id === user.id) {
      throw Object.assign(
        new Error('Le compte responsable ne peut pas se retirer lui-même : il n’y aurait plus personne pour gérer les accès'),
        { status: 400 }
      );
    }
    if (!db.data.users.some(function (u) {
        return u.id === id;
      })) {
      throw Object.assign(new Error('Compte introuvable'), { status: 404 });
    }
    await db.write(function (data) {
      data.users = data.users.filter(function (u) {
        return u.id !== id;
      });
      data.sessions = data.sessions.filter(function (s) {
        return s.userId !== id;
      });
    });
    sendJson(res, 200, { deleted: id });
    return true;
  }

  /* --- boîte d'envoi personnelle --- */

  if (pathname === '/api/auth/mailbox' && method === 'DELETE') {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    await db.write(function (data) {
      const target = data.users.find(function (u) {
        return u.id === user.id;
      });
      target.mailbox = null;
      target.mailboxSecret = '';
    });
    sendJson(res, 200, { user: auth.publicUser(auth.userFromRequest(db, req)) });
    return true;
  }

  if (pathname === '/api/auth/mailbox/smtp' && method === 'PUT') {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    const body = await readBody(req);
    const address = String(body.address || '').trim();
    const host = String(body.host || '').trim();
    const password = String(body.password || '');
    const port = Number(body.port || 587);

    if (!util.isValidEmail(address)) throw Object.assign(new Error('Adresse invalide'), { status: 400 });
    if (!host) throw Object.assign(new Error('Serveur SMTP manquant'), { status: 400 });
    if (!password) throw Object.assign(new Error('Mot de passe manquant'), { status: 400 });

    const mailbox = {
      method: 'smtp',
      address: address,
      host: host,
      port: port,
      username: String(body.username || '').trim() || address,
      connectedAt: new Date().toISOString()
    };
    await db.write(function (data) {
      const target = data.users.find(function (u) {
        return u.id === user.id;
      });
      target.mailbox = mailbox;
      target.mailboxSecret = vault.seal(password);
    });
    sendJson(res, 200, { user: auth.publicUser(auth.userFromRequest(db, req)) });
    return true;
  }

  if (pathname === '/api/auth/google/start' && method === 'GET') {
    const user = auth.userFromRequest(db, req);
    if (!user) throw sessionExpiree();
    if (!google.enabled) {
      throw Object.assign(new Error('Connexion Google non configurée sur ce serveur'), { status: 503 });
    }
    // L'état lie la redirection à cette session : sans lui, un tiers pourrait
    // faire aboutir son propre consentement sur le compte de l'employé·e.
    const state = crypto.randomBytes(24).toString('base64url');
    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    await db.write(function (data) {
      const session = data.sessions.find(function (s) {
        return s.token === token;
      });
      if (session) session.oauthState = state;
    });
    redirect(res, google.authUrl(state, google.redirectUri(req)));
    return true;
  }

  if (pathname === '/api/auth/google/callback' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const user = auth.userFromRequest(db, req);
    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    const session = auth.findSession(db, token);

    const fail = function (reason) {
      redirect(res, '/#reglages?boite=' + encodeURIComponent(reason));
    };

    if (!user || !session) return fail('session'), true;
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error')), true;
    const state = url.searchParams.get('state');
    if (!state || state !== session.oauthState) return fail('etat'), true;

    try {
      const tokens = await google.exchangeCode(url.searchParams.get('code'), google.redirectUri(req));
      const address = await google.fetchEmail(tokens.access_token);
      await db.write(function (data) {
        const target = data.users.find(function (u) {
          return u.id === user.id;
        });
        target.mailbox = { method: 'oauth2', address: address, connectedAt: new Date().toISOString() };
        target.mailboxSecret = vault.seal(tokens.refresh_token);
        const s = data.sessions.find(function (x) {
          return x.token === token;
        });
        if (s) delete s.oauthState;
      });
      redirect(res, '/#reglages?boite=ok');
    } catch (err) {
      console.error('[google]', err.message);
      fail(err.message.slice(0, 120));
    }
    return true;
  }

  return false;
}

/* ---------- API ---------- */

async function handleApi(req, res, ctx, pathname) {
  const { db, mailer } = ctx;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      app: 'bureau-du-courrier',
      version: VERSION,
      smtp: mailer.enabled,
      mailMode: mailer.mode,
      mailReason: mailer.reason || null,
      storage: 'fichier',
      accountsExist: (db.data.users || []).length > 0,
      googleOAuth: ctx.google.enabled,
      verifyEmail: ctx.verifyEmail
    });
  }

  if (pathname.startsWith('/api/auth/')) {
    if (await handleAuth(req, res, ctx, pathname)) return;
    throw Object.assign(new Error('Route inconnue'), { status: 404 });
  }

  /* Tant qu'aucun compte n'existe, le serveur reste ouvert : c'est le premier
     démarrage, et exiger une connexion inexistante bloquerait l'installation.
     Dès qu'un compte est créé, tout le reste de l'API demande une session. */
  const currentUser = auth.userFromRequest(db, req);
  if ((db.data.users || []).length > 0 && !currentUser) {
    throw sessionExpiree();
  }

  /* Un accès limité à une antenne ne reçoit que ce qui la concerne. Le tri se
     fait ici, pas à l'affichage : le registre d'un autre point d'accueil n'a
     pas à transiter par ce poste. Toute route qui sert des fiches ou des
     courriers passe par là — en oublier une rouvrirait la porte de côté. */
  function pourSonAntenne(liste) {
    const limite = (currentUser && currentUser.antenneId) || '';
    if (!limite) return liste;
    const antennes = db.data.settings.antennes || [];
    return (liste || []).filter(function (o) {
      return util.dansAntenne(o, limite, antennes);
    });
  }

  /* --- le flux : les quatre postes du bureau en direct ---

     Quatre personnes à l'accueil autour d'un même registre : sans ce flux,
     chacune ne voit que ses propres écritures, et deux agents peuvent remettre
     le même courrier sans jamais le savoir.

     Le message ne transporte **aucune donnée** — seulement un numéro d'ordre.
     Chaque poste rappelle /api/state, qui lui applique déjà son filtrage
     d'antenne et le masquage des codes de retrait. Un agent privé du droit
     « codes » n'apprend donc rien du flux qu'il ne pourrait lire autrement. */
  if (pathname === '/api/flux' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Un proxy qui met en tampon un flux d'événements le fige.
      'X-Accel-Buffering': 'no'
    });
    // Reconnexion après cinq secondes si la connexion tombe.
    res.write('retry: 5000\n\n');
    res.write('event: bonjour\ndata: ' + JSON.stringify({ revision: db.revision }) + '\n\n');

    const desabonner = db.surEcriture(function (revision) {
      res.write('event: maj\ndata: ' + JSON.stringify({ revision: revision }) + '\n\n');
    });

    /* Un commentaire régulier : sans trafic, un pare-feu ou un routeur ferme
       une connexion inactive au bout de quelques minutes, et le poste se croit
       relié alors qu'il ne reçoit plus rien. */
    const battement = setInterval(function () {
      res.write(': ping\n\n');
    }, 25000);
    battement.unref();

    const poste = {
      id: crypto.randomUUID(),
      userId: (currentUser && currentUser.id) || null,
      nom: (currentUser && currentUser.name) || 'Poste',
      role: (currentUser && currentUser.role) || 'responsable',
      identifiant: (currentUser && currentUser.identifiant) || '',
      antenneId: (currentUser && currentUser.antenneId) || '',
      depuis: new Date().toISOString()
    };
    ctx.postes.set(poste.id, poste);

    const fermer = function () {
      clearInterval(battement);
      desabonner();
      ctx.postes.delete(poste.id);
    };
    req.on('close', fermer);
    req.on('error', fermer);
    return;
  }

  /* --- l'adresse de ce poste sur le réseau du bureau --- */

  if (pathname === '/api/reseau' && method === 'GET') {
    exigerDroit(currentUser, 'reglages');
    const memoire = db.data.reseau || null;
    const vue = reseau.resume({
      port: ctx.port || 0,
      protocole: ctx.protocole || 'http',
      nomPoste: memoire && memoire.nomPoste
    });
    /* Un changement d'adresse ne se signale pas éternellement : passé une
       semaine, soit les postes ont été remis à jour, soit le message est
       devenu du bruit. */
    const change =
      memoire && memoire.changeAu && Date.now() - new Date(memoire.changeAu).getTime() < 7 * 24 * 3600 * 1000;
    return sendJson(res, 200, {
      reseau: vue,
      adresseChangee: change ? { le: memoire.changeAu, precedentes: memoire.precedentes || [] } : null,
      // Qui est relié en ce moment, un par onglet ouvert.
      postes: Array.from(ctx.postes.values()).map(function (p) {
        return {
          nom: p.nom,
          role: p.role,
          identifiant: p.identifiant,
          antenneId: p.antenneId,
          depuis: p.depuis,
          moi: !!currentUser && p.userId === currentUser.id
        };
      })
    });
  }

  if (pathname === '/api/state' && method === 'GET') {
    // Ni comptes ni sessions : le registre partagé n'a pas à transporter les
    // secrets des autres employé·es.
    const contacts = pourSonAntenne(db.data.contacts);
    const history = pourSonAntenne(db.data.history);

    return sendJson(res, 200, {
      contacts: contacts,
      // Les codes sont retirés du contenu servi, pas seulement de l'affichage :
      // un onglet de développeur suffirait à lire ce que l'interface masque.
      history: roles.masquerCodes(history, currentUser),
      settings: db.data.settings,
      suivi: reminders.resume(history)
    });
  }

  /* --- destinataires --- */

  if (pathname === '/api/contacts') {
    if (method === 'GET') return sendJson(res, 200, db.data.contacts);
    if (method === 'POST') {
      const input = cleanContact(await readBody(req));
      /* Ouvrir une domiciliation, c'est inscrire quelqu'un : l'agent d'accueil
         le fait tous les jours. On ne lui demande donc pas le droit de
         modifier le registre — seulement celui de domicilier, et uniquement
         pour une fiche effectivement domiciliée. */
      if (input.domicilie) exigerUnDesDroits(currentUser, ['registre', 'domiciliation']);
      else exigerDroit(currentUser, 'registre');
      const clash = findDuplicate(db.data.contacts, input.email, null);
      if (clash) {
        throw Object.assign(new Error('Ce courriel est déjà au registre sous « ' + clash.name + ' »'), { status: 409 });
      }
      const contact = Object.assign({ id: crypto.randomUUID(), createdAt: new Date().toISOString() }, input);
      await db.write(function (data) {
        data.contacts.push(contact);
      });
      await consigner(db, {
        qui: currentUser && currentUser.name,
        action: 'destinataire ajouté',
        cible: contact.name,
        details: contact.box ? 'boîte ' + contact.box : ''
      });
      return sendJson(res, 201, contact);
    }
  }

  /* Passage sans courrier : la personne s'est présentée, il n'y avait rien pour
     elle. Sans cette trace, le registre la croirait absente depuis des mois et
     la ferait apparaître sur la liste des radiations à venir. */
  const passageMatch = pathname.match(/^\/api\/contacts\/([^/]+)\/passage$/);
  if (passageMatch && method === 'POST') {
    const id = decodeURIComponent(passageMatch[1]);
    const contact = (db.data.contacts || []).find(function (c) {
      return c.id === id;
    });
    if (!contact) throw Object.assign(new Error('Destinataire introuvable'), { status: 404 });

    const corps = await readBody(req);
    const note = String((corps && corps.note) || '').trim().slice(0, 200);
    await db.write(function (data) {
      const cible = data.contacts.find(function (c) {
        return c.id === id;
      });
      if (!Array.isArray(cible.passages)) cible.passages = [];
      cible.passages.unshift({
        at: new Date().toISOString(),
        par: currentUser ? currentUser.name : null,
        note: note
      });
      // Seuls les passages récents servent au calcul : on borne la liste.
      if (cible.passages.length > 50) cible.passages.length = 50;
    });
    await consigner(db, {
      qui: currentUser && currentUser.name,
      action: 'passage enregistré',
      cible: contact.name,
      details: note
    });
    return sendJson(res, 200, {
      contact: db.data.contacts.find(function (c) {
        return c.id === id;
      })
    });
  }

  const contactMatch = pathname.match(/^\/api\/contacts\/([^/]+)$/);
  if (contactMatch) {
    const id = decodeURIComponent(contactMatch[1]);
    const existing = db.data.contacts.find(function (c) {
      return c.id === id;
    });
    if (!existing) throw Object.assign(new Error('Destinataire introuvable'), { status: 404 });

    if (method === 'PUT') {
      exigerDroit(currentUser, 'registre');
      const input = cleanContact(await readBody(req));
      const clash = findDuplicate(db.data.contacts, input.email, id);
      if (clash) {
        throw Object.assign(new Error('Ce courriel est déjà au registre sous « ' + clash.name + ' »'), { status: 409 });
      }
      const updated = Object.assign({}, existing, input, { updatedAt: new Date().toISOString() });
      await db.write(function (data) {
        const i = data.contacts.findIndex(function (c) {
          return c.id === id;
        });
        data.contacts[i] = updated;
      });
      await consigner(db, {
        qui: currentUser && currentUser.name,
        action: 'destinataire modifié',
        cible: updated.name
      });
      return sendJson(res, 200, updated);
    }
    if (method === 'DELETE') {
      exigerDroit(currentUser, 'registre');
      await db.write(function (data) {
        data.contacts = data.contacts.filter(function (c) {
          return c.id !== id;
        });
      });
      await consigner(db, {
        qui: currentUser && currentUser.name,
        action: 'destinataire supprimé',
        cible: existing.name
      });
      return sendJson(res, 200, { deleted: id });
    }
  }

  /* --- historique --- */

  if (pathname === '/api/history') {
    if (method === 'GET') return sendJson(res, 200, roles.masquerCodes(db.data.history, currentUser));
    if (method === 'POST') {
      const body = await readBody(req);
      const record = {
        id: body.id || crypto.randomUUID(),
        contactId: body.contactId || null,
        name: String(body.name || '').trim(),
        email: String(body.email || '').trim(),
        subject: String(body.subject || '').trim(),
        cc: String(body.cc || '').trim(),
        bcc: String(body.bcc || '').trim(),
        date: body.date || new Date().toISOString(),
        method: body.method === 'auto' ? 'auto' : 'manuel',
        status: ['envoyé', 'préparé', 'échec'].includes(body.status) ? body.status : 'préparé',
        pickedUpAt: null,
        reminderCount: 0,
        flaggedAt: null,
        closedAt: null,
        type: util.typeCourrier(body.type).id,
        pickupCode: String(body.pickupCode || '') || genererCodeRetrait(db.data.history)
      };
      if (!record.name || !record.email) {
        throw Object.assign(new Error('Nom et courriel requis'), { status: 400 });
      }
      await db.write(function (data) {
        data.history.unshift(record);
      });
      return sendJson(res, 201, record);
    }
    if (method === 'DELETE') {
      await db.write(function (data) {
        data.history = [];
      });
      return sendJson(res, 200, { cleared: true });
    }
  }

  /* --- retrait par code --- */

  const codeMatch = pathname.match(/^\/api\/history\/by-code\/(\d{4})$/);
  if (codeMatch && method === 'GET') {
    /* Consulter par code suppose le droit de remettre. Un agent sans le droit
       « codes » peut malgré tout s'en servir : il saisit le code que la
       personne lui présente, il ne le découvre pas dans l'application. */
    exigerDroit(currentUser, 'remise');
    /* Consultation seule : l'agent doit voir ce qu'il s'apprête à remettre —
       à qui, quelle boîte, depuis combien de temps — avant de valider. */
    const code = codeMatch[1];
    /* Filtré par antenne comme le reste : sans cela, un code saisi au hasard
       livrerait le nom et la boîte de quelqu'un d'un autre point d'accueil. */
    const candidats = pourSonAntenne(db.data.history || []).filter(function (h) {
      return h.pickupCode === code && !h.pickedUpAt && !h.closedAt;
    });
    if (candidats.length === 0) {
      throw Object.assign(new Error('Aucun courrier en attente avec ce code'), { status: 404 });
    }
    if (candidats.length > 1) {
      throw Object.assign(new Error('Plusieurs courriers portent ce code — passez par la liste'), { status: 409 });
    }
    const record = candidats[0];
    const contact = (db.data.contacts || []).find(function (c) {
      return c.id === record.contactId || util.normalize(c.email) === util.normalize(record.email);
    });
    // Les autres courriers de la même personne : autant tout remettre d'un coup.
    const autres = (db.data.history || []).filter(function (h) {
      return (
        h.id !== record.id &&
        !h.pickedUpAt &&
        !h.closedAt &&
        util.normalize(h.email) === util.normalize(record.email)
      );
    });
    return sendJson(res, 200, { record: record, contact: contact || null, autres: autres });
  }

  if (pathname === '/api/history/pickup-by-code' && method === 'POST') {
    exigerDroit(currentUser, 'remise');
    const body = await readBody(req);
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 4) throw Object.assign(new Error('Le code compte quatre chiffres'), { status: 400 });

    // Même filtre que la consultation : on ne remet pas le courrier d'une autre antenne.
    const candidats = pourSonAntenne(db.data.history || []).filter(function (h) {
      return h.pickupCode === code && !h.pickedUpAt && !h.closedAt;
    });
    if (candidats.length === 0) {
      throw Object.assign(new Error('Aucun courrier en attente avec ce code'), { status: 404 });
    }
    // Les codes sont uniques parmi les courriers en attente : au-delà d'un
    // candidat, mieux vaut s'arrêter que de marquer le mauvais.
    if (candidats.length > 1) {
      throw Object.assign(new Error('Plusieurs courriers portent ce code — marquez-le depuis le dossier'), {
        status: 409
      });
    }

    let signature = String(body.signature || '');
    if (signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) {
      throw Object.assign(new Error('Signature illisible'), { status: 400 });
    }
    if (signature.length > 80000) throw Object.assign(new Error('Signature trop volumineuse'), { status: 413 });

    const porteur = lirePorteur(body);
    const cible = candidats[0];
    await db.write(function (data) {
      const h = data.history.find(function (x) {
        return x.id === cible.id;
      });
      h.pickedUpAt = new Date().toISOString();
      h.pickedUpBy = currentUser ? currentUser.name : null;
      h.pickedUpByCode = true;
      h.remisA = porteur;
      h.signature = signature || null;
    });
    await consigner(db, {
      qui: currentUser && currentUser.name,
      action: 'courrier remis',
      cible: cible.name,
      details:
        'par code' +
        (porteur ? ' — retiré par ' + porteur : '') +
        (signature ? ' avec signature' : '')
    });
    return sendJson(res, 200, {
      record: db.data.history.find(function (h) {
        return h.id === cible.id;
      })
    });
  }

  /* --- suivi des courriers --- */

  const suiviMatch = pathname.match(/^\/api\/history\/([^/]+)\/(pickup|remind|flag|close)$/);
  if (suiviMatch) {
    const id = decodeURIComponent(suiviMatch[1]);
    const entree = (db.data.history || []).find(function (h) {
      return h.id === id;
    });
    if (!entree) throw Object.assign(new Error('Courrier introuvable'), { status: 404 });

    if (suiviMatch[2] === 'pickup' && (method === 'POST' || method === 'DELETE')) {
      exigerDroit(currentUser, 'remise');
      const retire = method === 'POST';
      const corps = retire ? await readBody(req) : {};
      /* Signature manuscrite : une image PNG en ligne. On borne sa taille — une
         signature tient largement dans quelques dizaines de kilo-octets, et le
         registre ne doit pas enfler indéfiniment. */
      let signature = String((corps && corps.signature) || '');
      if (signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) {
        throw Object.assign(new Error('Signature illisible'), { status: 400 });
      }
      if (signature.length > 80000) {
        throw Object.assign(new Error('Signature trop volumineuse'), { status: 413 });
      }
      const porteur = retire ? lirePorteur(corps) : null;
      await db.write(function (data) {
        const cible = data.history.find(function (h) {
          return h.id === id;
        });
        cible.pickedUpAt = retire ? new Date().toISOString() : null;
        cible.pickedUpBy = retire && currentUser ? currentUser.name : null;
        cible.remisA = porteur;
        cible.signature = retire && signature ? signature : null;
      });
      await consigner(db, {
        qui: currentUser && currentUser.name,
        action: retire ? 'courrier remis' : 'remise annulée',
        cible: entree.name,
        details:
          (porteur ? 'retiré par ' + porteur : '') +
          (retire && signature ? (porteur ? ' avec signature' : 'avec signature') : '')
      });
      return sendJson(res, 200, {
        record: db.data.history.find(function (h) {
          return h.id === id;
        })
      });
    }

    if (suiviMatch[2] === 'remind' && method === 'POST') {
      const envoye = await envoyerRelance(ctx, entree, currentUser);
      return sendJson(res, 200, envoye);
    }

    if (suiviMatch[2] === 'flag' && (method === 'POST' || method === 'DELETE')) {
      const signale = method === 'POST';
      await db.write(function (data) {
        const cible = data.history.find(function (h) {
          return h.id === id;
        });
        cible.flaggedAt = signale ? new Date().toISOString() : null;
        cible.flagReason = signale ? 'manuel' : null;
      });
      return sendJson(res, 200, {
        record: db.data.history.find(function (h) {
          return h.id === id;
        })
      });
    }

    /* Clore : le courrier sort du dossier sans avoir été retiré — renvoyé à
       l'expéditeur, détruit, remis en main propre. On garde la raison. */
    if (suiviMatch[2] === 'close' && (method === 'POST' || method === 'DELETE')) {
      const clore = method === 'POST';
      const body = clore ? await readBody(req) : {};
      const raison = String((body && body.reason) || '').trim().slice(0, 200);
      if (clore && !raison) {
        throw Object.assign(new Error('Indiquez ce qui a été fait de ce courrier'), { status: 400 });
      }
      await db.write(function (data) {
        const cible = data.history.find(function (h) {
          return h.id === id;
        });
        cible.closedAt = clore ? new Date().toISOString() : null;
        cible.closeReason = clore ? raison : null;
        cible.closedBy = clore && currentUser ? currentUser.name : null;
      });
      return sendJson(res, 200, {
        record: db.data.history.find(function (h) {
          return h.id === id;
        })
      });
    }
  }

  /* --- domiciliation --- */

  if (pathname === '/api/domiciliation' && method === 'GET') {
    exigerDroit(currentUser, 'domiciliation');
    const parsed = new URL(req.url, 'http://localhost');
    const annee = Number(parsed.searchParams.get('annee')) || new Date().getFullYear();
    const options = {
      validiteMois: Number(ctx.domiciliationMois) || undefined,
      absenceMois: Number(ctx.domiciliationAbsenceMois) || undefined
    };
    const contacts = pourSonAntenne(db.data.contacts || []);
    const history = pourSonAntenne(db.data.history || []);

    /* On ne renvoie que ce qu'il faut pour afficher : nom, boîte, dates. Les
       listes de travail n'ont pas besoin de transporter tout le dossier. */
    const alleger = function (d) {
      return {
        id: d.contact.id,
        name: d.contact.name,
        box: d.contact.box || '',
        email: d.contact.email || '',
        etat: d.etat
      };
    };

    /* Les personnes domiciliées en ce moment. Les deux autres listes ne
       montrent que des exceptions — une attestation qui expire, une absence
       trop longue. Sans celle-ci, quelqu'un dont le dossier est en règle
       n'apparaît nulle part, et le bureau n'a aucun endroit où lire le
       registre des domiciliations qu'il est pourtant tenu de tenir. */
    const actives = (contacts || [])
      .filter(function (c) {
        return c.domicilie && !c.domiciliationCloseLe;
      })
      .map(function (c) {
        return alleger({ contact: c, etat: domiciliation.etat(c, history, options) });
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name, 'fr');
      });

    return sendJson(res, 200, {
      actives: actives,
      aRenouveler: domiciliation.aRenouveler(contacts, history, options).map(alleger),
      sansPassage: domiciliation.sansPassage(contacts, history, options).map(alleger),
      rapport: domiciliation.rapportAnnuel(contacts, history, { annee: annee }),
      reglages: {
        validiteMois: options.validiteMois || domiciliation.DEFAUTS.validiteMois,
        absenceMois: options.absenceMois || domiciliation.DEFAUTS.absenceMois
      }
    });
  }

  /* --- réglages --- */

  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJson(res, 200, db.data.settings);
    if (method === 'PUT') {
      exigerDroit(currentUser, 'reglages');
      const body = await readBody(req);
      const subject = String(body.subject || '').trim();
      const messageBody = String(body.body || '').trim();
      if (!subject || !messageBody) {
        throw Object.assign(new Error('Sujet et corps du message requis'), { status: 400 });
      }
      const from = String(body.from || '').trim();
      if (from && !util.isValidAddress(from)) {
        throw Object.assign(new Error('Expéditeur invalide'), { status: 400 });
      }
      const cc = util.parseAddressList(body.cc);
      const bcc = util.parseAddressList(body.bcc);
      if (cc.errors.length || bcc.errors.length) {
        throw Object.assign(
          new Error('Adresse en copie invalide : ' + cc.errors.concat(bcc.errors).join(', ')),
          { status: 400 }
        );
      }

      const settings = Object.assign({}, DEFAULT_SETTINGS, {
        subject: subject,
        body: messageBody,
        officeName: String(body.officeName || DEFAULT_SETTINGS.officeName).trim(),
        // Identité de l'organisme, portée par l'attestation d'élection de domicile.
        officeAdresse: champTexte(body.officeAdresse, db.data.settings.officeAdresse, 200),
        officeVille: champTexte(body.officeVille, db.data.settings.officeVille, 80),
        officeAgrement: champTexte(body.officeAgrement, db.data.settings.officeAgrement, 200),
        from: from,
        cc: util.formatAddressList(cc.entries),
        bcc: util.formatAddressList(bcc.entries),
        /* Un gabarit incomplet est écarté silencieusement plutôt que refusé :
           vider les deux champs est la façon naturelle de revenir au modèle
           général pour ce type. */
        templates: util.nettoyerGabarits(
          body.templates !== undefined ? body.templates : db.data.settings.templates
        ),
        // Antennes : plusieurs points d'accueil sur un même serveur.
        antennes: util.nettoyerAntennes(
          body.antennes !== undefined ? body.antennes : db.data.settings.antennes
        ),
        /* Gabarits par langue. Même règle que par type : incomplet = ignoré,
           absent de la requête = conservé tel quel. */
        langues: nettoyerLangues(
          body.langues !== undefined ? body.langues : db.data.settings.langues
        ),
        /* Durée de conservation des courriers terminés, en mois. 0 = illimitée.
           Bornée à dix ans : au-delà, ce n'est plus une durée de conservation,
           c'est un oubli de la fixer. */
        conservationMois: Math.max(
          0,
          Math.min(
            120,
            Math.round(
              Number(
                body.conservationMois !== undefined
                  ? body.conservationMois
                  : db.data.settings.conservationMois || 0
              ) || 0
            )
          )
        )
      });
      await db.write(function (data) {
        data.settings = settings;
      });
      return sendJson(res, 200, settings);
    }
  }

  /* --- journal et statistiques --- */

  if (pathname === '/api/stats' && method === 'GET') {
    return sendJson(res, 200, reminders.statistiques(db.data.history, db.data.contacts));
  }

  if (pathname === '/api/journal' && method === 'GET') {
    const limite = Math.min(Number(new URL(req.url, 'http://x').searchParams.get('limite') || 100), 500);
    return sendJson(res, 200, { entrees: (db.data.journal || []).slice(0, limite) });
  }

  /* --- sauvegarde --- */

  if (pathname === '/api/backup' && method === 'GET') {
    // Le registre complet, sans les secrets : une sauvegarde n'a pas à
    // transporter des mots de passe hachés ni des jetons chiffrés.
    const copie = {
      exportedAt: new Date().toISOString(),
      version: VERSION,
      contacts: db.data.contacts,
      history: db.data.history,
      settings: db.data.settings,
      comptes: (db.data.users || []).map(function (u) {
        return { name: u.name, email: u.email, createdAt: u.createdAt };
      })
    };
    const corps = JSON.stringify(copie, null, 2);
    res.writeHead(
      200,
      withSecurityHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(corps),
        'Content-Disposition':
          'attachment; filename="registre-' + new Date().toISOString().slice(0, 10) + '.json"',
        'Cache-Control': 'no-store'
      })
    );
    return res.end(corps);
  }

  if (pathname === '/api/backup' && method === 'POST') {
    const resultat = await sauvegarder(db);
    return sendJson(res, 200, {
      fichier: path.basename(resultat.fichier),
      conserves: resultat.conserves
    });
  }

  /* Sauvegardes disponibles, avec un aperçu de leur contenu : on ne restaure
     pas à l'aveugle un fichier dont on ignore s'il est plein ou presque vide. */
  if (pathname === '/api/backup/list' && method === 'GET') {
    return sendJson(res, 200, { sauvegardes: await listerSauvegardes(db) });
  }

  if (pathname === '/api/backup/restore' && method === 'POST') {
    exigerDroit(currentUser, 'reglages');
    const corps = await readBody(req);
    const resultat = await restaurer(db, String((corps && corps.fichier) || ''));
    await consigner(db, {
      qui: currentUser && currentUser.name,
      action: 'registre restauré',
      cible: resultat.fichier,
      details:
        resultat.avant.destinataires + ' → ' + resultat.apres.destinataires + ' destinataire(s), ' +
        resultat.avant.courriers + ' → ' + resultat.apres.courriers + ' courrier(s)'
    });
    return sendJson(res, 200, resultat);
  }

  /* --- envoi --- */

  if (pathname === '/api/notify' && method === 'POST') {
    exigerDroit(currentUser, 'guichet');
    const body = await readBody(req);
    const to = String(body.email || '').trim();
    const name = String(body.name || '').trim();
    if (!util.isValidEmail(to)) throw Object.assign(new Error('Courriel invalide'), { status: 400 });

    /* La boîte de la personne connectée passe avant le compte du serveur : si
       elle a autorisé l'application, le courriel part de son adresse, et les
       réponses lui reviennent. */
    let sender = mailer;
    let senderLabel = 'serveur';
    if (currentUser && currentUser.mailbox) {
      const secret = ctx.vault.open(currentUser.mailboxSecret);
      if (secret === null) {
        throw Object.assign(
          new Error('Les identifiants de votre boîte sont illisibles — reconnectez-la dans les Réglages'),
          { status: 503 }
        );
      }
      sender = createUserMailer(currentUser.mailbox, secret, {
        dryRun: mailer.mode === 'essai',
        clientId: ctx.google.clientId,
        clientSecret: ctx.google.clientSecret
      });
      senderLabel = currentUser.mailbox.address;
    } else if (!mailer.enabled) {
      throw Object.assign(new Error(mailer.reason || 'Envoi automatique indisponible'), { status: 503 });
    }

    const settings = db.data.settings;
    const vars = {
      nom: name,
      courriel: to,
      date: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
      bureau: settings.officeName
    };
    const type = util.typeCourrier(body.type);
    const code = genererCodeRetrait(db.data.history);
    vars.type = type.label;
    vars.article = type.article;
    vars.article_min = type.article.toLowerCase();
    vars.code = code;

    // Le gabarit du type l'emporte sur le modèle général ; ce que la requête
    // fournit explicitement l'emporte sur les deux.
    /* La langue vient du destinataire, pas de la requête : c'est une propriété
       de la personne, pas de l'envoi. */
    const contactVise = (db.data.contacts || []).find(function (c) {
      return c.id === body.contactId || util.normalize(c.email) === util.normalize(to);
    });
    const langueVisee = util.langue(body.langue || (contactVise && contactVise.langue)).id;
    const gabarit = util.gabaritPour(settings, type.id, langueVisee);
    const subject = body.subject ? String(body.subject) : util.renderTemplate(gabarit.subject, vars);
    const corpsBase = body.body ? String(body.body) : util.renderTemplate(gabarit.body, vars);
    // Le code voyage avec le message, quel que soit le gabarit choisi.
    const text = corpsBase + '\n\nCode de retrait : ' + code + '\nPrésentez-le au guichet.';

    // De / Cc / Cci : ce que la requête précise l'emporte, sinon les réglages.
    const from = String(body.from !== undefined ? body.from : settings.from || '').trim();
    if (from && !util.isValidAddress(from)) {
      throw Object.assign(new Error('Expéditeur invalide'), { status: 400 });
    }
    const cc = util.parseAddressList(body.cc !== undefined ? body.cc : settings.cc);
    const bcc = util.parseAddressList(body.bcc !== undefined ? body.bcc : settings.bcc);
    if (cc.errors.length || bcc.errors.length) {
      throw Object.assign(
        new Error('Adresse en copie invalide : ' + cc.errors.concat(bcc.errors).join(', ')),
        { status: 400 }
      );
    }
    const ccList = util.formatAddressList(cc.entries);
    const bccList = util.formatAddressList(bcc.entries);

    let record = {
      id: crypto.randomUUID(),
      contactId: body.contactId || null,
      // Urgence déclarée à la réception : elle raccourcit le délai de relance.
      urgent: !!body.urgent,
      /* Antenne où le courrier est arrivé. Elle vient du destinataire quand il
         en a une — un courrier suit la boîte, pas le poste qui l'a saisi. */
      antenneId: String(
        body.antenneId || (contactVise && contactVise.antenneId) || (currentUser && currentUser.antenneId) || ''
      ).trim(),
      name: name,
      email: to,
      subject: subject,
      cc: ccList,
      bcc: bccList,
      date: new Date().toISOString(),
      method: 'auto',
      status: 'envoyé',
      sentBy: senderLabel,
      operator: currentUser ? currentUser.name : null,
      // Suivi : le courrier reste dû tant que personne ne l'a marqué retiré.
      pickedUpAt: null,
      reminderCount: 0,
      flaggedAt: null,
      closedAt: null,
      type: type.id,
      pickupCode: code
    };

    try {
      await sender.send({ to: to, from: from, cc: ccList, bcc: bccList, subject: subject, text: text });
    } catch (err) {
      record.status = 'échec';
      await db.write(function (data) {
        data.history.unshift(record);
      });
      throw Object.assign(new Error('Envoi refusé par le serveur de courriel : ' + err.message), {
        status: 502,
        record: record
      });
    }

    await db.write(function (data) {
      data.history.unshift(record);
    });
    return sendJson(res, 200, { sent: true, record: record });
  }

  throw Object.assign(new Error('Route inconnue'), { status: 404 });
}

/* ---------- assemblage ---------- */

function createServer(options) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));

  // Valeurs de repli : le serveur doit pouvoir démarrer avec le seul couple
  // { db, mailer }, comme avant l'ajout des comptes.
  const ctx = Object.assign({}, options, {
    vault: options.vault || require('./secrets.js').createVault({ secret: crypto.randomBytes(32).toString('base64') }),
    google: options.google || require('./google.js').createGoogleOAuth({}),
    throttle: options.throttle || auth.createThrottle(),
    // Cinq demandes d'inscription par adresse et par heure : de quoi corriger
    // une faute de frappe ou renvoyer un code, pas de quoi noyer une boîte.
    signupThrottle: options.signupThrottle || auth.createThrottle({ max: 5, windowMs: 60 * 60 * 1000 }),
    signupOpen: options.signupOpen !== false,
    // Par défaut, on vérifie l'adresse dès que le serveur sait envoyer un courriel.
    verifyEmail: options.verifyEmail !== undefined ? options.verifyEmail : !!(options.mailer && options.mailer.enabled),
    /* Domiciliation : durée de validité de l'attestation et seuil d'absence.
       Les valeurs courantes sont dans le module ; ces réglages permettent de
       suivre une pratique locale sans toucher au code. */
    masterCodeHash: options.masterCodeHash,
    domiciliationMois: options.domiciliationMois,
    domiciliationAbsenceMois: options.domiciliationAbsenceMois,
    /* Les postes reliés en ce moment, un par flux ouvert. En mémoire seulement :
       une connexion ne survit pas au redémarrage, et un registre de connexions
       écrit sur disque ne dirait que des choses fausses. */
    postes: options.postes || new Map(),
    // Pour dire aux autres postes quoi taper : voir /api/reseau.
    port: options.port || 0,
    protocole: options.protocole || 'http'
  });

  const srv = http.createServer(async function (req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'Méthode non autorisée' });
      }
      try {
        return await serveStatic(req, res, rootDir);
      } catch (err) {
        console.error(err);
        if (!res.headersSent) res.writeHead(500).end('Erreur interne');
        return;
      }
    }

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOriginRequest(req)) {
        // Le cookie est déjà SameSite=Lax ; ce contrôle ferme le cas des
        // requêtes forgées qui contourneraient cette protection.
        throw Object.assign(new Error('Requête refusée : origine étrangère'), { status: 403 });
      }
      await handleApi(req, res, ctx, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500 && status !== 502 && status !== 503) console.error(err);
      if (!res.headersSent) {
        sendJson(res, status, { error: err.message, code: err.code || undefined, record: err.record || undefined });
      }
    }
  });

  /* Le port réel et le protocole ne sont connus qu'une fois l'écoute ouverte —
     et en https, c'est un autre serveur qui écoute. Le point d'entrée les
     renseigne ici pour que /api/reseau dise la bonne adresse. */
  srv.ctx = ctx;
  return srv;
}

module.exports = { createServer: createServer, VERSION: VERSION, envoyerRelance: envoyerRelance };
