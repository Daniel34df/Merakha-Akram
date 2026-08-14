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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-verif-'));
  const db = new Db(path.join(dir, 'db.json'));
  await db.load();
  // Mode essai : les courriels sont conservés en mémoire, donc lisibles ici.
  const mailer = createMailer(opts.mailerEnv || { MAIL_DRY_RUN: 'true' });
  const server = createServer({
    db: db,
    mailer: mailer,
    vault: createVault({ secret: 'clé-de-test' }),
    verifyEmail: opts.verifyEmail !== undefined ? opts.verifyEmail : true,
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

  /** Retrouve le code dans le courriel de confirmation capté par le mode essai. */
  const dernierCode = function () {
    const last = mailer.sent[mailer.sent.length - 1];
    const match = last && last.text.match(/\b(\d{6})\b/);
    return match ? match[1] : null;
  };

  try {
    await run({ call: call, db: db, mailer: mailer, dernierCode: dernierCode });
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const COMPTE = { name: 'Marie Accueil', email: 'marie@bureau.org', password: 'courrier-2026-bureau' };

test('generateCode produit six chiffres, et varie', function () {
  const codes = new Set();
  for (let i = 0; i < 50; i++) {
    const code = auth.generateCode();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 40, 'les codes ne se répètent pas');
});

test('l’inscription n’ouvre pas de compte tant que le code n’est pas confirmé', function () {
  return withServer(async function (t) {
    const demande = await t.call('POST', '/api/auth/signup', COMPTE);
    assert.equal(demande.status, 202);
    assert.equal(demande.body.pending, true);
    assert.equal(demande.body.email, COMPTE.email);

    assert.equal(t.db.data.users.length, 0, 'aucun compte créé à ce stade');
    assert.equal(t.db.data.pending.length, 1);
    assert.equal((await t.call('GET', '/api/auth/me')).body.user, null);

    // Le courriel est bien parti à la bonne adresse, avec un code à six chiffres.
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0].to, COMPTE.email);
    assert.match(t.mailer.sent[0].text, /\d{6}/);
  });
});

test('le code n’est renvoyé ni par l’API ni en clair dans le registre', function () {
  return withServer(async function (t) {
    const demande = await t.call('POST', '/api/auth/signup', COMPTE);
    const code = t.dernierCode();

    assert.ok(!JSON.stringify(demande.body).includes(code), 'le code ne transite pas par la réponse');
    const pending = t.db.data.pending[0];
    assert.equal(pending.code, undefined);
    assert.ok(pending.codeHash.startsWith('scrypt$'));
    assert.ok(!JSON.stringify(pending).includes(code), 'le code n’est pas stocké en clair');
    assert.ok(!JSON.stringify(pending).includes(COMPTE.password), 'le mot de passe non plus');
  });
});

test('le bon code crée le compte et ouvre la session', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const confirme = await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: t.dernierCode() });

    assert.equal(confirme.status, 201);
    assert.equal(confirme.body.user.email, COMPTE.email);
    assert.match(confirme.headers.get('set-cookie'), /HttpOnly/);

    assert.equal(t.db.data.users.length, 1);
    assert.ok(t.db.data.users[0].emailVerifiedAt, 'la date de vérification est consignée');
    assert.equal(t.db.data.pending.length, 0, 'la demande en attente est consommée');

    assert.equal((await t.call('GET', '/api/auth/me')).body.user.name, COMPTE.name);
    assert.equal((await t.call('GET', '/api/contacts')).status, 200);
  });
});

test('un code erroné est refusé et décompte les essais', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const faux = await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: '000000' });

    assert.equal(faux.status, 401);
    assert.match(faux.body.error, /Code incorrect/);
    assert.match(faux.body.error, /reste 4 essai/);
    assert.equal(t.db.data.users.length, 0);

    // Le bon code fonctionne toujours après une erreur.
    const bon = await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: t.dernierCode() });
    assert.equal(bon.status, 201);
  });
});

test('après cinq codes erronés, la demande est bloquée', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const vrai = t.dernierCode();

    for (let i = 0; i < 5; i++) {
      await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: '000000' });
    }
    const bloque = await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: vrai });
    assert.equal(bloque.status, 429);
    assert.match(bloque.body.error, /Trop de codes erronés/);
    assert.equal(t.db.data.users.length, 0, 'le bon code ne passe plus après épuisement des essais');
  });
});

test('un code expiré est refusé', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const code = t.dernierCode();

    await t.db.write(function (data) {
      data.pending[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    const perime = await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: code });
    assert.equal(perime.status, 410);
    assert.match(perime.body.error, /expiré/);
  });
});

test('renvoyer un code remplace l’ancien et remet les essais à zéro', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const premier = t.dernierCode();
    await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: '000000' });
    assert.equal(t.db.data.pending[0].attempts, 1);

    // Le délai anti-rafale interdit un renvoi immédiat.
    const tropTot = await t.call('POST', '/api/auth/resend', { email: COMPTE.email });
    assert.equal(tropTot.status, 429);
    assert.match(tropTot.body.error, /Patientez/);

    await t.db.write(function (data) {
      data.pending[0].lastSentAt = new Date(Date.now() - 120000).toISOString();
    });
    const renvoi = await t.call('POST', '/api/auth/resend', { email: COMPTE.email });
    assert.equal(renvoi.status, 200);
    assert.equal(t.mailer.sent.length, 2);
    assert.equal(t.db.data.pending[0].attempts, 0, 'les essais repartent à zéro');

    const second = t.dernierCode();
    assert.notEqual(second, premier, 'un nouveau code est tiré');
    assert.equal((await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: premier })).status, 401);
    assert.equal((await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: second })).status, 201);
  });
});

test('une seconde demande pour la même adresse remplace la première', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.call('POST', '/api/auth/signup', Object.assign({}, COMPTE, { name: 'Marie Corrigée' }));

    assert.equal(t.db.data.pending.length, 1, 'une seule demande en attente');
    assert.equal(t.db.data.pending[0].name, 'Marie Corrigée');
    assert.equal((await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: t.dernierCode() })).status, 201);
  });
});

test('confirmer sans demande en attente est refusé', function () {
  return withServer(async function (t) {
    const orphelin = await t.call('POST', '/api/auth/verify', { email: 'personne@bureau.org', code: '123456' });
    assert.equal(orphelin.status, 410);
    assert.equal((await t.call('POST', '/api/auth/resend', { email: 'personne@bureau.org' })).status, 410);
  });
});

test('sans vérification, l’inscription crée le compte directement', function () {
  return withServer(
    async function (t) {
      const created = await t.call('POST', '/api/auth/signup', COMPTE);
      assert.equal(created.status, 201);
      assert.equal(t.db.data.users.length, 1);
      assert.equal(t.mailer.sent.length, 0, 'aucun code envoyé');
    },
    { verifyEmail: false }
  );
});

test('vérification exigée mais serveur incapable d’envoyer : refus explicite', function () {
  return withServer(
    async function (t) {
      const refus = await t.call('POST', '/api/auth/signup', COMPTE);
      assert.equal(refus.status, 503);
      assert.match(refus.body.error, /ne peut pas envoyer de courriel/);
      assert.equal(t.db.data.users.length, 0);
      assert.equal(t.db.data.pending.length, 0);
    },
    { verifyEmail: true, mailerEnv: { MAIL_DRY_RUN: 'false' } }
  );
});

test('/api/health annonce si la vérification est active', function () {
  return withServer(async function (t) {
    assert.equal((await t.call('GET', '/api/health')).body.verifyEmail, true);
    assert.equal((await t.call('GET', '/api/auth/me')).body.verifyEmail, true);
  });
});

/* ---------- mot de passe oublié ---------- */

test('un mot de passe oublié se réinitialise par code reçu par courriel', function () {
  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      await t.call('POST', '/api/auth/logout');
      t.mailer.sent.length = 0;

      const demande = await t.call('POST', '/api/auth/forgot', { email: COMPTE.email });
      assert.equal(demande.status, 202);
      assert.equal(demande.body.expiresInMinutes, auth.RESET_MINUTES);
      assert.equal(t.mailer.sent.length, 1);
      assert.equal(t.mailer.sent[0].to, COMPTE.email);
      assert.match(t.mailer.sent[0].text, /rien n’a changé/, 'le message rassure sur le compte actuel');

      const code = t.dernierCode();
      assert.match(code, /^\d{6}$/);

      // Tant que le code n'est pas utilisé, l'ancien mot de passe reste valable.
      assert.equal((await t.call('POST', '/api/auth/login', COMPTE)).status, 200);
      await t.call('POST', '/api/auth/logout');

      const reset = await t.call('POST', '/api/auth/reset', {
        email: COMPTE.email,
        code: code,
        password: 'un-tout-nouveau-mot-de-passe'
      });
      assert.equal(reset.status, 200);
      assert.equal(reset.body.user.email, COMPTE.email);
      assert.match(reset.headers.get('set-cookie') || '', /bdc_session=/, 'on est connecté dans la foulée');

      // Le nouveau fonctionne, l'ancien non, et le code est consommé.
      await t.call('POST', '/api/auth/logout');
      assert.equal(
        (await t.call('POST', '/api/auth/login', { email: COMPTE.email, password: 'un-tout-nouveau-mot-de-passe' })).status,
        200
      );
      await t.call('POST', '/api/auth/logout');
      assert.equal((await t.call('POST', '/api/auth/login', COMPTE)).status, 401);
      assert.equal(t.db.data.pending.length, 0);
    },
    { verifyEmail: false }
  );
});

test('la demande d’oubli ne dit pas si l’adresse a un compte', function () {
  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      t.mailer.sent.length = 0;

      const inconnue = await t.call('POST', '/api/auth/forgot', { email: 'personne@bureau.org' });
      assert.equal(inconnue.status, 202, 'même réponse que pour une adresse connue');
      assert.equal(t.mailer.sent.length, 0, 'mais aucun courriel ne part');
      assert.equal(t.db.data.pending.length, 0);

      assert.equal((await t.call('POST', '/api/auth/forgot', { email: 'pas-une-adresse' })).status, 400);
    },
    { verifyEmail: false }
  );
});

test('un code de réinitialisation faux, périmé ou trop essayé est refusé', function () {
  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      await t.call('POST', '/api/auth/forgot', { email: COMPTE.email });
      const code = t.dernierCode();

      const faux = String((Number(code) + 1) % 1000000).padStart(6, '0');
      for (let i = 0; i < auth.CODE_MAX_ATTEMPTS; i++) {
        const res = await t.call('POST', '/api/auth/reset', {
          email: COMPTE.email,
          code: faux,
          password: 'un-tout-nouveau-mot-de-passe'
        });
        assert.equal(res.status, 401);
      }
      // Au-delà du quota, même le bon code ne passe plus.
      const bloque = await t.call('POST', '/api/auth/reset', {
        email: COMPTE.email,
        code: code,
        password: 'un-tout-nouveau-mot-de-passe'
      });
      assert.equal(bloque.status, 429);
      assert.equal((await t.call('POST', '/api/auth/login', COMPTE)).status, 200, 'le compte est intact');
    },
    { verifyEmail: false }
  );
});

test('un mot de passe faible est refusé même avec le bon code', function () {
  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      await t.call('POST', '/api/auth/forgot', { email: COMPTE.email });
      const code = t.dernierCode();

      const court = await t.call('POST', '/api/auth/reset', { email: COMPTE.email, code: code, password: 'court' });
      assert.equal(court.status, 400);
      // Le code n'est pas consommé : on peut réessayer avec un mot de passe correct.
      assert.equal(
        (await t.call('POST', '/api/auth/reset', { email: COMPTE.email, code: code, password: 'assez-long-celui-ci' }))
          .status,
        200
      );
    },
    { verifyEmail: false }
  );
});

test('la réinitialisation ferme les sessions ouvertes ailleurs', function () {
  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      const cookieAutrePoste = t.db.data.sessions[0].token;

      await t.call('POST', '/api/auth/forgot', { email: COMPTE.email });
      await t.call('POST', '/api/auth/reset', {
        email: COMPTE.email,
        code: t.dernierCode(),
        password: 'un-tout-nouveau-mot-de-passe'
      });

      const restees = t.db.data.sessions.filter(function (s) {
        return s.token === cookieAutrePoste;
      });
      assert.equal(restees.length, 0, 'l’ancienne session ne survit pas');

      const journal = t.db.data.journal.find(function (e) {
        return e.action === 'mot de passe réinitialisé';
      });
      assert.ok(journal, 'la réinitialisation figure au journal');
    },
    { verifyEmail: false }
  );
});

test('sans serveur de courriel, l’oubli renvoie vers l’outil en ligne de commande', function () {
  return withServer(
    async function (t) {
      await t.call('POST', '/api/auth/signup', COMPTE);
      const res = await t.call('POST', '/api/auth/forgot', { email: COMPTE.email });
      assert.equal(res.status, 503);
      assert.match(res.body.error, /npm run motdepasse/);
    },
    { verifyEmail: false, mailerEnv: { MAIL_DRY_RUN: 'false' } }
  );
});

test('une inscription en attente et un oubli coexistent sur la même adresse', function () {
  return withServer(async function (t) {
    // Inscription en attente de code (verifyEmail actif par défaut ici).
    await t.call('POST', '/api/auth/signup', { name: 'Nouveau', email: 'nouveau@bureau.org', password: 'mot-de-passe-long' });
    assert.equal(t.db.data.pending.length, 1);

    // Un compte existant demande une réinitialisation : l'inscription en attente
    // d'une autre adresse ne doit pas être emportée.
    await t.call('POST', '/api/auth/signup', COMPTE);
    await t.call('POST', '/api/auth/verify', { email: COMPTE.email, code: t.dernierCode() });
    await t.call('POST', '/api/auth/forgot', { email: COMPTE.email });

    const sortes = t.db.data.pending.map(function (p) {
      return auth.pendingKind(p) + ':' + p.email;
    });
    assert.deepEqual(sortes.sort(), ['reset:marie@bureau.org', 'signup:nouveau@bureau.org']);
  });
});
