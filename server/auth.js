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
  return {
    id: user.id,
    name: user.name,
    email: user.email,
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
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  checkPasswordStrength: checkPasswordStrength,
  parseCookies: parseCookies,
  sessionCookie: sessionCookie,
  newSession: newSession,
  findSession: findSession,
  userFromRequest: userFromRequest,
  publicUser: publicUser,
  findUserByEmail: findUserByEmail,
  createThrottle: createThrottle
};
