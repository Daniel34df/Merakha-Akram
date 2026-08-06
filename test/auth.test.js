'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createVault } = require('../server/secrets.js');
const { createGoogleOAuth } = require('../server/google.js');
const { createServer } = require('../server/app.js');
const auth = require('../server/auth.js');

/** Serveur jetable, avec suivi manuel du cookie de session. */
async function withServer(run, options) {
  const opts = options || {};
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-auth-'));
  const db = new Db(path.join(dir, 'db.json'));
  await db.load();
  const mailer = createMailer({ MAIL_DRY_RUN: 'true' });
  const vault = createVault({ secret: 'clé-de-test-très-secrète' });
  const google = createGoogleOAuth(opts.googleEnv || {}, opts.googleDeps);
  const server = createServer({
    db: db,
    mailer: mailer,
    vault: vault,
    google: google,
    signupOpen: opts.signupOpen !== false,
    // La vérification par code a sa propre suite (verification.test.js) : ici on
    // éprouve les comptes eux-mêmes, sans l'étape intermédiaire.
    verifyEmail: opts.verifyEmail === true,
    rootDir: path.join(__dirname, '..')
  });

  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const jar = { cookie: '' };
  const call = async function (method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (jar.cookie) headers.Cookie = jar.cookie;
    const res = await fetch(base + url, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) jar.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  };

  try {
    await run({ call: call, base: base, db: db, mailer: mailer, vault: vault, jar: jar, google: google });
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const COMPTE = { name: 'Marie Accueil', email: 'marie@bureau.org', password: 'courrier-2026-bureau' };

/* ---------- mots de passe ---------- */

test('un mot de passe haché ne se relit pas, mais se vérifie', function () {
  const hash = auth.hashPassword('correct-cheval-batterie');
  assert.ok(!hash.includes('correct-cheval-batterie'), 'le mot de passe n’apparaît pas en clair');
  assert.ok(auth.verifyPassword('correct-cheval-batterie', hash));
  assert.ok(!auth.verifyPassword('mauvais mot de passe', hash));
  assert.notEqual(hash, auth.hashPassword('correct-cheval-batterie'), 'sel différent à chaque fois');
});

test('les mots de passe trop faibles sont refusés avec une raison', function () {
  assert.match(auth.checkPasswordStrength('court'), /10 caractères/);
  assert.match(auth.checkPasswordStrength('12345678901'), /chiffres/);
  assert.match(auth.checkPasswordStrength('motdepasse'), /trop courant/);
  assert.equal(auth.checkPasswordStrength('un-mot-de-passe-correct'), null);
});

/* ---------- coffre ---------- */

test('le coffre chiffre et déchiffre, et détecte l’altération', function () {
  const vault = createVault({ secret: 'clé-1' });
  const sealed = vault.seal('mot-de-passe-application');
  assert.ok(!sealed.includes('mot-de-passe'), 'le secret n’apparaît pas en clair');
  assert.equal(vault.open(sealed), 'mot-de-passe-application');

  assert.equal(vault.open(sealed.slice(0, -4) + 'AAAA'), null, 'contenu altéré');
  assert.equal(createVault({ secret: 'clé-2' }).open(sealed), null, 'mauvaise clé');
  assert.equal(vault.seal(''), '');
});

/* ---------- inscription et connexion ---------- */

test('inscription puis connexion, avec cookie de session', function () {
  return withServer(async function (t) {
    const before = await t.call('GET', '/api/auth/me');
    assert.equal(before.body.accountsExist, false);
    assert.equal(before.body.user, null);

    const created = await t.call('POST', '/api/auth/signup', COMPTE);
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, COMPTE.email);
    assert.equal(created.body.user.mailbox, null);
    assert.match(created.headers.get('set-cookie'), /HttpOnly/, 'le cookie est inaccessible au JavaScript');
    assert.match(created.headers.get('set-cookie'), /SameSite=Lax/);

    const me = await t.call('GET', '/api/auth/me');
    assert.equal(me.body.user.name, COMPTE.name);
    assert.equal(me.body.accountsExist, true);

    await t.call('POST', '/api/auth/logout');
    assert.equal((await t.call('GET', '/api/auth/me')).body.user, null);

    const back = await t.call('POST', '/api/auth/login', { email: COMPTE.email, password: COMPTE.password });
    assert.equal(back.status, 200);
    assert.equal(back.body.user.email, COMPTE.email);
  });
});

test('le mot de passe n’est jamais renvoyé au client', function () {
  return withServer(async function (t) {
    const created = await t.call('POST', '/api/auth/signup', COMPTE);
    assert.equal(created.body.user.password, undefined);
    assert.equal(created.body.user.mailboxSecret, undefined);
    assert.ok(!JSON.stringify(created.body).includes(COMPTE.password));

    const me = await t.call('GET', '/api/auth/me');
    assert.ok(!JSON.stringify(me.body).includes(COMPTE.password));
  });
});

test('un mauvais mot de passe est refusé sans révéler l’existence du compte', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.call('POST', '/api/auth/logout');

    const faux = await t.call('POST', '/api/auth/login', { email: COMPTE.email, password: 'mauvais-mot-de-passe' });
    const inconnu = await t.call('POST', '/api/auth/login', { email: 'personne@bureau.org', password: 'peu-importe-vraiment' });
    assert.equal(faux.status, 401);
    assert.equal(inconnu.status, 401);
    assert.equal(faux.body.error, inconnu.body.error, 'même message dans les deux cas');
  });
});

test('un courriel déjà inscrit est refusé (409)', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const dup = await t.call('POST', '/api/auth/signup', Object.assign({}, COMPTE, { email: 'MARIE@Bureau.org' }));
    assert.equal(dup.status, 409);
  });
});

test('les tentatives répétées sont freinées (429)', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.call('POST', '/api/auth/logout');

    let last;
    for (let i = 0; i < 10; i++) {
      last = await t.call('POST', '/api/auth/login', { email: COMPTE.email, password: 'faux-mot-de-passe' });
    }
    assert.equal(last.status, 429);
    assert.match(last.body.error, /Trop de tentatives/);
  });
});

test('inscriptions fermées : le premier compte passe, le second non', function () {
  return withServer(
    async function (t) {
      assert.equal((await t.call('POST', '/api/auth/signup', COMPTE)).status, 201);
      const second = await t.call('POST', '/api/auth/signup', {
        name: 'Autre',
        email: 'autre@bureau.org',
        password: 'un-autre-mot-de-passe'
      });
      assert.equal(second.status, 403);
    },
    { signupOpen: false }
  );
});

/* ---------- protection du registre ---------- */

test('le registre est ouvert tant qu’aucun compte n’existe, protégé ensuite', function () {
  return withServer(async function (t) {
    assert.equal((await t.call('GET', '/api/contacts')).status, 200, 'premier démarrage : ouvert');

    await t.call('POST', '/api/auth/signup', COMPTE);
    assert.equal((await t.call('GET', '/api/contacts')).status, 200, 'connecté : accessible');

    await t.call('POST', '/api/auth/logout');
    const ferme = await t.call('GET', '/api/contacts');
    assert.equal(ferme.status, 401);
    assert.match(ferme.body.error, /Connexion requise/);

    assert.equal((await t.call('POST', '/api/contacts', { name: 'X', email: 'x@y.com' })).status, 401);
    assert.equal((await t.call('GET', '/api/state')).status, 401);
    assert.equal((await t.call('GET', '/api/health')).status, 200, 'health reste public');
  });
});

test('/api/state ne divulgue ni comptes ni sessions', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const state = await t.call('GET', '/api/state');
    assert.deepEqual(Object.keys(state.body).sort(), ['contacts', 'history', 'settings']);
  });
});

/* ---------- boîte d'envoi personnelle ---------- */

test('une boîte SMTP personnelle est enregistrée chiffrée et sert à l’envoi', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);

    const connecte = await t.call('PUT', '/api/auth/mailbox/smtp', {
      address: 'marie@exemple.com',
      host: 'smtp.exemple.com',
      port: 587,
      password: 'abcd efgh ijkl mnop'
    });
    assert.equal(connecte.status, 200);
    assert.equal(connecte.body.user.mailbox.address, 'marie@exemple.com');
    assert.equal(connecte.body.user.mailbox.method, 'smtp');

    // Le secret est chiffré dans le fichier, et illisible tel quel.
    const stored = t.db.data.users[0];
    assert.ok(stored.mailboxSecret.startsWith('v1.'));
    assert.ok(!stored.mailboxSecret.includes('abcd'));
    assert.equal(t.vault.open(stored.mailboxSecret), 'abcd efgh ijkl mnop');

    // L'envoi part de la boîte de l'employé·e, pas du compte du serveur.
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@exemple.com' });
    assert.equal(envoi.status, 200);
    assert.equal(envoi.body.record.sentBy, 'marie@exemple.com');
    assert.equal(envoi.body.record.operator, COMPTE.name);

    const deconnecte = await t.call('DELETE', '/api/auth/mailbox');
    assert.equal(deconnecte.body.user.mailbox, null);
    assert.equal(t.db.data.users[0].mailboxSecret, '');
  });
});

test('une boîte incomplète est refusée', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    assert.equal((await t.call('PUT', '/api/auth/mailbox/smtp', { address: 'pas-une-adresse' })).status, 400);
    assert.equal(
      (await t.call('PUT', '/api/auth/mailbox/smtp', { address: 'a@b.com', host: '', password: 'x' })).status,
      400
    );
    assert.equal(
      (await t.call('PUT', '/api/auth/mailbox/smtp', { address: 'a@b.com', host: 'smtp.b.com', password: '' })).status,
      400
    );
  });
});

test('connecter une boîte exige une session', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.call('POST', '/api/auth/logout');
    const refus = await t.call('PUT', '/api/auth/mailbox/smtp', {
      address: 'a@b.com',
      host: 'smtp.b.com',
      password: 'x'
    });
    assert.equal(refus.status, 401);
  });
});

/* ---------- OAuth Google ---------- */

test('sans configuration Google, la connexion Gmail est annoncée indisponible', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    assert.equal((await t.call('GET', '/api/auth/me')).body.googleOAuth, false);
    assert.equal((await t.call('GET', '/api/auth/google/start')).status, 503);
  });
});

test('l’URL de consentement Google demande le strict nécessaire', function () {
  const google = createGoogleOAuth({ GOOGLE_CLIENT_ID: 'id-test', GOOGLE_CLIENT_SECRET: 'secret-test' });
  const url = new URL(google.authUrl('etat-123', 'http://localhost:3000/api/auth/google/callback'));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('state'), 'etat-123');
  assert.equal(url.searchParams.get('access_type'), 'offline', 'nécessaire pour obtenir un jeton durable');
  const scopes = url.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.send'));
  assert.ok(
    !scopes.some(function (s) {
      return s.includes('readonly') || s.includes('gmail.modify') || s.includes('drive');
    }),
    'aucune autorisation de lecture'
  );
});

test('le retour Google est refusé si l’état ne correspond pas à la session', function () {
  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      await t.call('GET', '/api/auth/google/start');

      const retour = await t.call('GET', '/api/auth/google/callback?code=peu-importe&state=etat-forge');
      assert.equal(retour.status, 302);
      assert.match(retour.headers.get('location'), /boite=etat/);
      assert.equal(t.db.data.users[0].mailbox, null, 'aucune boîte connectée');
    },
    { googleEnv: { GOOGLE_CLIENT_ID: 'id-test', GOOGLE_CLIENT_SECRET: 'secret-test' } }
  );
});

test('un retour Google valide enregistre la boîte et chiffre le jeton', function () {
  // fetch simulé : on ne contacte évidemment pas Google depuis les tests.
  const fauxFetch = async function (url) {
    if (String(url).includes('/token')) {
      return {
        ok: true,
        json: async function () {
          return { access_token: 'jeton-acces', refresh_token: 'jeton-durable-secret' };
        }
      };
    }
    return {
      ok: true,
      json: async function () {
        return { email: 'marie@gmail.com' };
      }
    };
  };

  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      await t.call('GET', '/api/auth/google/start');
      const etat = t.db.data.sessions[t.db.data.sessions.length - 1].oauthState;
      assert.ok(etat, 'un état a été associé à la session');

      const retour = await t.call('GET', '/api/auth/google/callback?code=code-valide&state=' + etat);
      assert.equal(retour.status, 302);
      assert.match(retour.headers.get('location'), /boite=ok/);

      const stored = t.db.data.users[0];
      assert.equal(stored.mailbox.method, 'oauth2');
      assert.equal(stored.mailbox.address, 'marie@gmail.com');
      assert.ok(!stored.mailboxSecret.includes('jeton-durable-secret'), 'le jeton est chiffré');
      assert.equal(t.vault.open(stored.mailboxSecret), 'jeton-durable-secret');
      assert.equal(t.db.data.sessions[t.db.data.sessions.length - 1].oauthState, undefined, 'état consommé');
    },
    {
      googleEnv: { GOOGLE_CLIENT_ID: 'id-test', GOOGLE_CLIENT_SECRET: 'secret-test' },
      googleDeps: { fetch: fauxFetch }
    }
  );
});

test('Google sans jeton durable donne une erreur explicite', function () {
  const sansRefresh = async function () {
    return {
      ok: true,
      json: async function () {
        return { access_token: 'jeton-acces' };
      }
    };
  };
  const google = createGoogleOAuth(
    { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
    { fetch: sansRefresh }
  );
  return assert.rejects(
    function () {
      return google.exchangeCode('code', 'http://localhost/callback');
    },
    /jeton durable/
  );
});
