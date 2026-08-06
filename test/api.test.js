'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createServer } = require('../server/app.js');

/** Démarre un serveur sur un port libre, avec une base neuve dans un dossier temporaire. */
async function withServer(run, env) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-test-'));
  const db = new Db(path.join(dir, 'db.json'));
  await db.load();
  const mailer = createMailer(Object.assign({ MAIL_DRY_RUN: 'true' }, env || {}));
  const server = createServer({ db: db, mailer: mailer, rootDir: path.join(__dirname, '..') });

  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const call = async function (method, url, body) {
    const res = await fetch(base + url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
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
    await run({ call: call, base: base, db: db, mailer: mailer });
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('GET /api/health annonce l’application et l’état du courriel', function () {
  return withServer(async function (t) {
    const res = await t.call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.app, 'bureau-du-courrier');
    assert.equal(res.body.smtp, true);
    assert.equal(res.body.mailMode, 'essai');
  });
});

test('cycle de vie complet d’un destinataire', function () {
  return withServer(async function (t) {
    const created = await t.call('POST', '/api/contacts', { name: 'Marie Tremblay', email: 'marie@exemple.com' });
    assert.equal(created.status, 201);
    assert.ok(created.body.id);

    const list = await t.call('GET', '/api/contacts');
    assert.equal(list.body.length, 1);

    const updated = await t.call('PUT', '/api/contacts/' + created.body.id, {
      name: 'Marie Tremblay-Roy',
      email: 'marie.roy@exemple.com'
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Marie Tremblay-Roy');

    const removed = await t.call('DELETE', '/api/contacts/' + created.body.id);
    assert.equal(removed.status, 200);
    assert.equal((await t.call('GET', '/api/contacts')).body.length, 0);
  });
});

test('les doublons de courriel sont refusés (409), casse et accents ignorés', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/contacts', { name: 'Marie', email: 'marie@exemple.com' });
    const dup = await t.call('POST', '/api/contacts', { name: 'Autre Marie', email: 'MARIE@Exemple.com' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /déjà au registre/);
  });
});

test('les entrées invalides sont refusées (400)', function () {
  return withServer(async function (t) {
    assert.equal((await t.call('POST', '/api/contacts', { name: '', email: 'a@b.com' })).status, 400);
    assert.equal((await t.call('POST', '/api/contacts', { name: 'X', email: 'pas-une-adresse' })).status, 400);
    assert.equal((await t.call('PUT', '/api/contacts/inconnu', { name: 'X', email: 'a@b.com' })).status, 404);
  });
});

test('POST /api/notify envoie le courriel et consigne l’envoi', function () {
  return withServer(async function (t) {
    const contact = (await t.call('POST', '/api/contacts', { name: 'Jean Roy', email: 'jean@exemple.com' })).body;
    const res = await t.call('POST', '/api/notify', { contactId: contact.id, name: contact.name, email: contact.email });

    assert.equal(res.status, 200);
    assert.equal(res.body.sent, true);
    assert.equal(res.body.record.method, 'auto');
    assert.equal(res.body.record.status, 'envoyé');

    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0].to, 'jean@exemple.com');
    assert.match(t.mailer.sent[0].text, /Bonjour Jean Roy/, 'le gabarit est appliqué');

    const history = await t.call('GET', '/api/history');
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].email, 'jean@exemple.com');
  });
});

test('POST /api/notify renvoie 503 quand SMTP n’est pas configuré', function () {
  return withServer(
    async function (t) {
      const res = await t.call('POST', '/api/notify', { name: 'Jean', email: 'jean@exemple.com' });
      assert.equal(res.status, 503);
      assert.match(res.body.error, /SMTP non configuré/);
    },
    { MAIL_DRY_RUN: 'false', SMTP_HOST: '', MAIL_FROM: '' }
  );
});

test('le gabarit enregistré dans les réglages est utilisé par /api/notify', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'Courrier au {bureau}',
      body: 'Salut {nom}, ton courriel est {courriel}.',
      officeName: 'Réception B'
    });
    await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@exemple.com' });

    assert.equal(t.mailer.sent[0].subject, 'Courrier au Réception B');
    assert.equal(t.mailer.sent[0].text, 'Salut Ana, ton courriel est ana@exemple.com.');
  });
});

test('De, Cc et Cci des réglages sont appliqués à l’envoi et consignés', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'Un courrier vous attend',
      body: 'Bonjour {nom}.',
      from: 'Bureau du Courrier <courrier@exemple.com>',
      cc: 'archives@exemple.com, chef@exemple.com',
      bcc: 'registre@exemple.com'
    });
    const res = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@exemple.com' });

    assert.equal(res.status, 200);
    const envoye = t.mailer.sent[0];
    assert.equal(envoye.from, 'Bureau du Courrier <courrier@exemple.com>');
    assert.equal(envoye.cc, 'archives@exemple.com, chef@exemple.com');
    assert.equal(envoye.bcc, 'registre@exemple.com');

    assert.equal(res.body.record.cc, 'archives@exemple.com, chef@exemple.com');
    assert.equal(res.body.record.bcc, 'registre@exemple.com');
  });
});

test('les copies passées à /api/notify l’emportent sur les réglages', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'S',
      body: 'B',
      cc: 'defaut@exemple.com',
      bcc: 'defaut-cci@exemple.com'
    });
    await t.call('POST', '/api/notify', {
      name: 'Ana',
      email: 'ana@exemple.com',
      cc: 'ponctuel@exemple.com',
      bcc: ''
    });

    assert.equal(t.mailer.sent[0].cc, 'ponctuel@exemple.com');
    assert.equal(t.mailer.sent[0].bcc, undefined, 'une chaîne vide retire la copie invisible');
  });
});

test('une adresse en copie ou un expéditeur invalides sont refusés (400)', function () {
  return withServer(async function (t) {
    const bad = await t.call('POST', '/api/notify', {
      name: 'Ana',
      email: 'ana@exemple.com',
      cc: 'bon@exemple.com, pas-une-adresse'
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Adresse en copie invalide/);
    assert.equal(t.mailer.sent.length, 0, 'rien n’est parti');

    assert.equal(
      (await t.call('PUT', '/api/settings', { subject: 'S', body: 'B', from: 'Nom <cassé>' })).status,
      400
    );
    assert.equal((await t.call('PUT', '/api/settings', { subject: 'S', body: 'B', cc: 'x' })).status, 400);
  });
});

test('des réglages vides sont refusés', function () {
  return withServer(async function (t) {
    assert.equal((await t.call('PUT', '/api/settings', { subject: '', body: 'x' })).status, 400);
  });
});

test('historique : ajout manuel puis vidage', function () {
  return withServer(async function (t) {
    const added = await t.call('POST', '/api/history', {
      name: 'Luc',
      email: 'luc@exemple.com',
      method: 'manuel',
      status: 'préparé'
    });
    assert.equal(added.status, 201);
    assert.equal((await t.call('GET', '/api/history')).body.length, 1);

    assert.equal((await t.call('DELETE', '/api/history')).status, 200);
    assert.equal((await t.call('GET', '/api/history')).body.length, 0);
  });
});

test('les données survivent à un redémarrage du serveur', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/contacts', { name: 'Persistante', email: 'p@exemple.com' });

    const relu = new Db(t.db.file);
    await relu.load();
    assert.equal(relu.data.contacts.length, 1);
    assert.equal(relu.data.contacts[0].name, 'Persistante');
  });
});

test('l’interface statique est servie et le parcours de répertoire bloqué', function () {
  return withServer(async function (t) {
    const page = await fetch(t.base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Bureau du Courrier/);

    const css = await fetch(t.base + '/assets/css/style.css');
    assert.equal(css.status, 200);

    const font = await fetch(t.base + '/assets/fonts/source-serif-4-latin.woff2');
    assert.equal(font.status, 200, 'les polices embarquées sont servies');
    assert.equal(font.headers.get('content-type'), 'font/woff2');

    const escape = await fetch(t.base + '/../../etc/passwd');
    assert.ok([403, 404].includes(escape.status), 'sortie d’arborescence refusée');

    assert.equal((await fetch(t.base + '/inconnu.html')).status, 404);
  });
});

test('une route API inconnue renvoie 404 JSON', function () {
  return withServer(async function (t) {
    const res = await t.call('GET', '/api/inconnu');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Route inconnue');
  });
});
