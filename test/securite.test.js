'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createVault } = require('../server/secrets.js');
const { createServer } = require('../server/app.js');
const auth = require('../server/auth.js');

async function withServer(run, options) {
  const opts = options || {};
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-secu-'));
  const db = new Db(path.join(dir, 'db.json'));
  await db.load();
  const mailer = createMailer({ MAIL_DRY_RUN: 'true' });
  const server = createServer({
    db: db,
    mailer: mailer,
    vault: createVault({ secret: 'clé-de-test' }),
    verifyEmail: opts.verifyEmail === true,
    rootDir: path.join(__dirname, '..')
  });
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const jar = { cookie: '' };

  const call = async function (method, url, body, extraHeaders) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    if (jar.cookie) headers.Cookie = jar.cookie;
    const res = await fetch(base + url, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) jar.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  };

  try {
    await run({ call: call, base: base, db: db, mailer: mailer });
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const COMPTE = { name: 'Marie Accueil', email: 'marie@bureau.org', password: 'courrier-2026-bureau' };

test('les en-têtes de sécurité accompagnent pages et API', function () {
  return withServer(async function (t) {
    for (const url of ['/', '/api/health']) {
      const res = await fetch(t.base + url);
      const csp = res.headers.get('content-security-policy');
      assert.ok(csp, url + ' : politique de contenu présente');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/, 'la page ne peut pas être encadrée');
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'aucun script inline autorisé');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    }
  });
});

test('une requête modifiante venue d’un autre site est refusée', function () {
  return withServer(async function (t) {
    const etranger = await t.call('POST', '/api/auth/signup', COMPTE, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(etranger.status, 403);
    assert.match(etranger.body.error, /origine étrangère/);
    assert.equal(t.db.data.users.length, 0);

    const autreOrigine = await t.call('POST', '/api/auth/signup', COMPTE, { Origin: 'https://site-malveillant.example' });
    assert.equal(autreOrigine.status, 403);

    // La même requête, émise par l'application, passe.
    assert.equal((await t.call('POST', '/api/auth/signup', COMPTE, { 'Sec-Fetch-Site': 'same-origin' })).status, 201);
  });
});

test('la lecture n’est pas bloquée par le contrôle d’origine', function () {
  return withServer(async function (t) {
    const res = await fetch(t.base + '/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 200, 'un GET reste servi : il ne modifie rien');
  });
});

test('le cookie de session n’est pas lisible par le JavaScript', function () {
  return withServer(async function (t) {
    const created = await t.call('POST', '/api/auth/signup', COMPTE);
    const cookie = created.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.ok(!/Secure/.test(cookie), 'pas de Secure en http://localhost, sinon la session serait perdue');
  });
});

test('un jeton de session inventé ne donne aucun accès', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const vrai = t.db.data.sessions[0].token;

    const res = await fetch(t.base + '/api/contacts', {
      headers: { Cookie: 'bdc_session=' + vrai.slice(0, -3) + 'aaa' }
    });
    assert.equal(res.status, 401);
  });
});

test('une session expirée est refusée puis effacée', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.db.write(function (data) {
      data.sessions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    assert.equal((await t.call('GET', '/api/contacts')).status, 401);

    // La purge intervient à la première écriture qui suit.
    await t.db.write(function () {});
    assert.equal(t.db.data.sessions.length, 0);
  });
});

test('le fichier du registre n’est lisible que par son propriétaire', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const stat = await fs.stat(t.db.file);
    assert.equal(stat.mode & 0o077, 0, 'aucun droit pour le groupe ni pour les autres');
  });
});

test('la connexion coûte le même temps que le compte existe ou non', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.call('POST', '/api/auth/logout');

    const mesure = async function (email) {
      const debut = process.hrtime.bigint();
      await t.call('POST', '/api/auth/login', { email: email, password: 'un-mauvais-mot-de-passe' });
      return Number(process.hrtime.bigint() - debut) / 1e6;
    };

    // Compte existant : scrypt tourne. Compte inconnu : scrypt doit tourner aussi.
    const connu = await mesure(COMPTE.email);
    const inconnu = await mesure('inconnu@bureau.org');
    const ecart = Math.abs(connu - inconnu) / Math.max(connu, inconnu);
    assert.ok(ecart < 0.75, 'écart relatif ' + ecart.toFixed(2) + ' : pas d’oracle de temps flagrant');
  });
});

test('les demandes d’inscription répétées sur une adresse sont freinées', function () {
  return withServer(
    async function (t) {
      let dernier;
      for (let i = 0; i < 5; i++) {
        dernier = await t.call('POST', '/api/auth/signup', COMPTE);
      }
      assert.equal(dernier.status, 429);
      assert.match(dernier.body.error, /Trop de demandes/);
      assert.ok(t.mailer.sent.length <= 3, 'au plus trois courriels envoyés, pas cinq');
    },
    { verifyEmail: true }
  );
});

test('les secrets ne quittent jamais le serveur', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.call('PUT', '/api/auth/mailbox/smtp', {
      address: 'marie@exemple.com',
      host: 'smtp.exemple.com',
      password: 'secret-de-boite'
    });

    for (const url of ['/api/auth/me', '/api/state', '/api/health']) {
      const texte = JSON.stringify((await t.call('GET', url)).body);
      assert.ok(!texte.includes('secret-de-boite'), url + ' : pas de secret de boîte');
      assert.ok(!texte.includes('scrypt$'), url + ' : pas d’empreinte de mot de passe');
      assert.ok(!texte.includes('bdc_session'), url + ' : pas de jeton de session');
    }
  });
});

test('les codes de confirmation ne sont pas prévisibles', function () {
  const vus = new Set();
  for (let i = 0; i < 200; i++) vus.add(auth.generateCode());
  assert.ok(vus.size > 190, 'aucune répétition notable sur 200 tirages');
});
