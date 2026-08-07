/* Bureau du Courrier — serveur HTTP (aucune dépendance obligatoire).
   Sert l'interface statique et l'API JSON sous /api. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const util = require('../assets/js/util.js');
const { DEFAULT_SETTINGS } = require('./db.js');
const auth = require('./auth.js');
const { createUserMailer } = require('./mailer.js');

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
  return { name: name, email: email, box: box };
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
        // Une nouvelle demande remplace la précédente pour la même adresse.
        data.pending = data.pending.filter(function (p) {
          return util.normalize(p.email) !== util.normalize(email);
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

    const pending = (db.data.pending || []).find(function (p) {
      return util.normalize(p.email) === util.normalize(email);
    });
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
    const pending = (db.data.pending || []).find(function (p) {
      return util.normalize(p.email) === util.normalize(email);
    });
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

  /* --- boîte d'envoi personnelle --- */

  if (pathname === '/api/auth/mailbox' && method === 'DELETE') {
    const user = auth.userFromRequest(db, req);
    if (!user) throw Object.assign(new Error('Connexion requise'), { status: 401 });
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
    if (!user) throw Object.assign(new Error('Connexion requise'), { status: 401 });
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
    if (!user) throw Object.assign(new Error('Connexion requise'), { status: 401 });
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
    throw Object.assign(new Error('Connexion requise'), { status: 401 });
  }

  if (pathname === '/api/state' && method === 'GET') {
    // Ni comptes ni sessions : le registre partagé n'a pas à transporter les
    // secrets des autres employé·es.
    return sendJson(res, 200, {
      contacts: db.data.contacts,
      history: db.data.history,
      settings: db.data.settings
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
      const contact = {
        id: crypto.randomUUID(),
        name: input.name,
        email: input.email,
        box: input.box,
        createdAt: new Date().toISOString()
      };
      await db.write(function (data) {
        data.contacts.push(contact);
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
      return sendJson(res, 200, updated);
    }
    if (method === 'DELETE') {
      await db.write(function (data) {
        data.contacts = data.contacts.filter(function (c) {
          return c.id !== id;
        });
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
        status: ['envoyé', 'préparé', 'échec'].includes(body.status) ? body.status : 'préparé'
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
        bcc: util.formatAddressList(bcc.entries)
      });
      await db.write(function (data) {
        data.settings = settings;
      });
      return sendJson(res, 200, settings);
    }
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
    const subject = body.subject ? String(body.subject) : util.renderTemplate(settings.subject, vars);
    const text = body.body ? String(body.body) : util.renderTemplate(settings.body, vars);

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
      operator: currentUser ? currentUser.name : null
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
        sendJson(res, status, { error: err.message, record: err.record || undefined });
      }
    }
  });
}

module.exports = { createServer: createServer, VERSION: VERSION };
