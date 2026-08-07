/* Bureau du Courrier — serveur HTTP (aucune dépendance obligatoire).
   Sert l'interface statique et l'API JSON sous /api. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const util = require('../assets/js/util.js');
const { DEFAULT_SETTINGS, sauvegarder, consigner } = require('./db.js');
const auth = require('./auth.js');
const { createUserMailer } = require('./mailer.js');
const reminders = require('./reminders.js');

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
  return {
    name: name,
    email: email,
    box: box,
    absentUntil: absentUntil,
    departed: !!(input && input.departed),
    substituteId: String((input && input.substituteId) || '').trim() || null
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

function createUserRecord(name, email, passwordHash) {
  return {
    id: crypto.randomUUID(),
    name: name,
    email: email,
    password: passwordHash,
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

  const gabarit = util.gabaritPour(settings, type.id);
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

  if (pathname === '/api/state' && method === 'GET') {
    // Ni comptes ni sessions : le registre partagé n'a pas à transporter les
    // secrets des autres employé·es.
    return sendJson(res, 200, {
      contacts: db.data.contacts,
      history: db.data.history,
      settings: db.data.settings,
      suivi: reminders.resume(db.data.history)
    });
  }

  /* --- destinataires --- */

  if (pathname === '/api/contacts') {
    if (method === 'GET') return sendJson(res, 200, db.data.contacts);
    if (method === 'POST') {
      const input = cleanContact(await readBody(req));
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

  const contactMatch = pathname.match(/^\/api\/contacts\/([^/]+)$/);
  if (contactMatch) {
    const id = decodeURIComponent(contactMatch[1]);
    const existing = db.data.contacts.find(function (c) {
      return c.id === id;
    });
    if (!existing) throw Object.assign(new Error('Destinataire introuvable'), { status: 404 });

    if (method === 'PUT') {
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
    if (method === 'GET') return sendJson(res, 200, db.data.history);
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
    /* Consultation seule : l'agent doit voir ce qu'il s'apprête à remettre —
       à qui, quelle boîte, depuis combien de temps — avant de valider. */
    const code = codeMatch[1];
    const candidats = (db.data.history || []).filter(function (h) {
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
    const body = await readBody(req);
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 4) throw Object.assign(new Error('Le code compte quatre chiffres'), { status: 400 });

    const candidats = (db.data.history || []).filter(function (h) {
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

  /* --- réglages --- */

  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJson(res, 200, db.data.settings);
    if (method === 'PUT') {
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
        from: from,
        cc: util.formatAddressList(cc.entries),
        bcc: util.formatAddressList(bcc.entries),
        /* Un gabarit incomplet est écarté silencieusement plutôt que refusé :
           vider les deux champs est la façon naturelle de revenir au modèle
           général pour ce type. */
        templates: util.nettoyerGabarits(
          body.templates !== undefined ? body.templates : db.data.settings.templates
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

  /* --- envoi --- */

  if (pathname === '/api/notify' && method === 'POST') {
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
    const gabarit = util.gabaritPour(settings, type.id);
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
    verifyEmail: options.verifyEmail !== undefined ? options.verifyEmail : !!(options.mailer && options.mailer.enabled)
  });

  return http.createServer(async function (req, res) {
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
}

module.exports = { createServer: createServer, VERSION: VERSION, envoyerRelance: envoyerRelance };
