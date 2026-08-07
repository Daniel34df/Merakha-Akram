/* Bureau du Courrier — comptes et sessions.

   Mots de passe : scrypt avec sel aléatoire, comparaison à temps constant.
   Aucune dépendance : tout vient de node:crypto.

   Sessions : jeton aléatoire de 32 octets, conservé côté serveur, transmis dans
   un cookie HttpOnly. Le cookie ne contient donc aucune donnée exploitable s'il
   est intercepté ailleurs que sur ce serveur. */
'use strict';

const crypto = require('node:crypto');
const util = require('../assets/js/util.js');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_COOKIE = 'bdc_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;

/* ---------- mots de passe ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const derived = crypto.scryptSync(password, Buffer.from(parts[4], 'base64'), Buffer.from(parts[5], 'base64').length, {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3])
    });
    const expected = Buffer.from(parts[5], 'base64');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch (e) {
    return false;
  }
}

/* Empreinte d'un mot de passe factice, calculée une fois au démarrage.
   Vérifier un mot de passe contre elle coûte le même temps qu'une vérification
   réelle : sans cela, la rapidité de la réponse trahirait qu'aucun compte
   n'existe pour l'adresse essayée. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

function equalizeTiming(password) {
  verifyPassword(String(password || ''), DUMMY_HASH);
}

/** Refus explicites plutôt qu'un score opaque : l'employé·e doit savoir quoi corriger. */
function checkPasswordStrength(password) {
  const pwd = String(password || '');
  if (pwd.length < MIN_PASSWORD) {
    return 'Le mot de passe doit compter au moins ' + MIN_PASSWORD + ' caractères.';
  }
  if (/^\d+$/.test(pwd)) return 'Le mot de passe ne peut pas être uniquement des chiffres.';
  if (['motdepasse', 'password', 'azertyuiop', 'qwertyuiop', '1234567890'].includes(pwd.toLowerCase())) {
    return 'Ce mot de passe est trop courant.';
  }
  return null;
}

/* ---------- codes de confirmation ---------- */

const CODE_LENGTH = 6;
const CODE_MINUTES = 15;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;

/** Six chiffres tirés au sort de façon non prévisible (jamais Math.random). */
function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += String(crypto.randomInt(0, 10));
  return code;
}

function newPendingSignup(input, code) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    // Deux sortes d'attentes partagent la même liste : la création d'un compte
    // et la réinitialisation d'un mot de passe oublié. Les entrées antérieures
    // à cette distinction n'ont pas de champ « kind » : ce sont des inscriptions.
    kind: 'signup',
    name: input.name,
    email: input.email,
    password: input.password, // déjà haché par l'appelant
    // Le code n'est pas conservé en clair : une lecture du registre ne doit pas
    // permettre de valider une adresse à la place de son propriétaire.
    codeHash: hashPassword(code),
    attempts: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CODE_MINUTES * 60 * 1000).toISOString(),
    lastSentAt: new Date(now).toISOString()
  };
}

/* Demande de réinitialisation. Le code vaut moins longtemps qu'un code
   d'inscription : il ouvre l'accès à un compte existant, pas à un compte vide. */
const RESET_MINUTES = 30;

function newPendingReset(userId, email, code) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    kind: 'reset',
    userId: userId,
    email: email,
    codeHash: hashPassword(code),
    attempts: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RESET_MINUTES * 60 * 1000).toISOString(),
    lastSentAt: new Date(now).toISOString()
  };
}

function pendingKind(pending) {
  return (pending && pending.kind) || 'signup';
}

/** Retrouve l'attente en cours pour une adresse, d'une sorte donnée. */
function findPending(db, email, kind) {
  const wanted = util.normalize(email);
  return (
    (db.data.pending || []).find(function (p) {
      return util.normalize(p.email) === wanted && pendingKind(p) === (kind || 'signup');
    }) || null
  );
}

function pendingExpired(pending) {
  return !pending || new Date(pending.expiresAt).getTime() < Date.now();
}

function secondsBeforeResend(pending) {
  const elapsed = (Date.now() - new Date(pending.lastSentAt).getTime()) / 1000;
  return Math.max(0, Math.ceil(RESEND_SECONDS - elapsed));
}

/* ---------- code maître ---------- */

/* Le code maître sert d'ultime recours sur le compte responsable : en changer
   l'adresse, le mot de passe, ou le supprimer. Il n'est jamais conservé en
   clair — seule son empreinte est écrite dans le registre, au premier
   démarrage. Le connaître ne suffit donc pas à le lire dans le fichier, et le
   changer se fait par la variable MASTER_CODE.

   Il vaut ce que vaut sa confidentialité : c'est une clé de coffre, pas un
   mécanisme d'authentification. Le freinage des tentatives s'y applique. */
const MASTER_CODE_DEFAUT = '26366686806';

function empreinteCodeMaitre(code) {
  return hashPassword(String(code || MASTER_CODE_DEFAUT));
}

function verifierCodeMaitre(db, code) {
  const stocke = db.data.masterCodeHash;
  if (!stocke) {
    // Registre antérieur au code maître : on compare au code par défaut.
    equalizeTiming(code);
    return String(code || '') === MASTER_CODE_DEFAUT;
  }
  return verifyPassword(String(code || ''), stocke);
}

/* ---------- cookies ---------- */

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach(function (pair) {
      const index = pair.indexOf('=');
      if (index === -1) return;
      const name = pair.slice(0, index).trim();
      if (name) out[name] = decodeURIComponent(pair.slice(index + 1).trim());
    });
  return out;
}

function sessionCookie(token, options) {
  const opts = options || {};
  const parts = [
    SESSION_COOKIE + '=' + encodeURIComponent(token || ''),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  parts.push('Max-Age=' + (token ? SESSION_DAYS * 24 * 3600 : 0));
  // Secure casserait l'usage en http://localhost, qui est le cas nominal ici.
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/* ---------- sessions ---------- */

function newSession(userId) {
  const now = Date.now();
  return {
    token: crypto.randomBytes(32).toString('base64url'),
    userId: userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_DAYS * 24 * 3600 * 1000).toISOString()
  };
}

function findSession(db, token) {
  if (!token) return null;
  const session = (db.data.sessions || []).find(function (s) {
    return s.token === token;
  });
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

function userFromRequest(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = findSession(db, token);
  if (!session) return null;
  return (
    (db.data.users || []).find(function (u) {
      return u.id === session.userId;
    }) || null
  );
}

/** Vue d'un compte destinée au client : ni mot de passe, ni secret de boîte. */
function publicUser(user) {
  if (!user) return null;
  const mailbox = user.mailbox || null;
  const roles = require('../assets/js/roles.js');
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    // Le rôle et les droits voyagent : l'interface s'en sert pour n'afficher
    // que ce qui est ouvert. Le serveur, lui, refait le contrôle à chaque appel.
    role: user.role || 'responsable',
    permissions:
      (user.role || 'responsable') === 'responsable'
        ? roles.toutesLesPermissions(true)
        : roles.nettoyerPermissions(user.permissions),
    identifiant: user.identifiant || '',
    // L'antenne d'un accès limité : l'interface s'en sert pour figer le sélecteur.
    antenneId: user.antenneId || '',
    createdAt: user.createdAt,
    mailbox: mailbox
      ? {
          method: mailbox.method,
          address: mailbox.address,
          connectedAt: mailbox.connectedAt,
          host: mailbox.host || null
        }
      : null
  };
}

function findUserByEmail(db, email) {
  const wanted = util.normalize(email);
  return (
    (db.data.users || []).find(function (u) {
      return util.normalize(u.email) === wanted;
    }) || null
  );
}

/* ---------- limitation des tentatives ---------- */

/* Mémoire seulement : redémarrer le serveur remet les compteurs à zéro, ce qui
   est acceptable ici — l'objectif est de ralentir une attaque, pas de tenir un
   registre. */
function createThrottle(options) {
  const opts = Object.assign({ max: 8, windowMs: 10 * 60 * 1000 }, options || {});
  const attempts = new Map();

  return {
    check: function (key) {
      const entry = attempts.get(key);
      if (!entry) return { blocked: false };
      if (Date.now() - entry.first > opts.windowMs) {
        attempts.delete(key);
        return { blocked: false };
      }
      if (entry.count >= opts.max) {
        return {
          blocked: true,
          retryInSeconds: Math.ceil((opts.windowMs - (Date.now() - entry.first)) / 1000)
        };
      }
      return { blocked: false };
    },
    fail: function (key) {
      const entry = attempts.get(key);
      if (!entry || Date.now() - entry.first > opts.windowMs) {
        attempts.set(key, { first: Date.now(), count: 1 });
      } else {
        entry.count++;
      }
    },
    succeed: function (key) {
      attempts.delete(key);
    }
  };
}

module.exports = {
  SESSION_COOKIE: SESSION_COOKIE,
  MIN_PASSWORD: MIN_PASSWORD,
  CODE_LENGTH: CODE_LENGTH,
  CODE_MINUTES: CODE_MINUTES,
  CODE_MAX_ATTEMPTS: CODE_MAX_ATTEMPTS,
  RESEND_SECONDS: RESEND_SECONDS,
  RESET_MINUTES: RESET_MINUTES,
  MASTER_CODE_DEFAUT: MASTER_CODE_DEFAUT,
  empreinteCodeMaitre: empreinteCodeMaitre,
  verifierCodeMaitre: verifierCodeMaitre,
  generateCode: generateCode,
  newPendingSignup: newPendingSignup,
  newPendingReset: newPendingReset,
  pendingKind: pendingKind,
  findPending: findPending,
  pendingExpired: pendingExpired,
  secondsBeforeResend: secondsBeforeResend,
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  checkPasswordStrength: checkPasswordStrength,
  equalizeTiming: equalizeTiming,
  parseCookies: parseCookies,
  sessionCookie: sessionCookie,
  newSession: newSession,
  findSession: findSession,
  userFromRequest: userFromRequest,
  publicUser: publicUser,
  findUserByEmail: findUserByEmail,
  createThrottle: createThrottle
};
