'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { Db, sauvegarder } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createVault } = require('../server/secrets.js');
const { createServer } = require('../server/app.js');
const reminders = require('../server/reminders.js');

const JOUR = 24 * 60 * 60 * 1000;

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-suivi-'));
  const db = new Db(path.join(dir, 'db.json'));
  await db.load();
  const mailer = createMailer({ MAIL_DRY_RUN: 'true' });
  const server = createServer({
    db: db,
    mailer: mailer,
    vault: createVault({ secret: 'clé-de-test' }),
    verifyEmail: false,
    rootDir: path.join(__dirname, '..')
  });
  await new Promise(function (r) {
    server.listen(0, '127.0.0.1', r);
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
    const sc = res.headers.get('set-cookie');
    if (sc) jar.cookie = sc.split(';')[0];
    const texte = await res.text();
    let json;
    try {
      json = JSON.parse(texte);
    } catch (e) {
      json = texte;
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  try {
    await run({ call: call, db: db, mailer: mailer, base: base, dir: dir });
  } finally {
    await new Promise(function (r) {
      server.close(r);
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- calcul des relances ---------- */

const maintenant = Date.now();
const courrier = function (jours, extra) {
  return Object.assign(
    { id: 'c' + jours, name: 'X', email: 'x@ex.com', date: new Date(maintenant - jours * JOUR).toISOString(), status: 'envoyé' },
    extra || {}
  );
};

test('aRelancer ne retient que les courriers dus', function () {
  const history = [
    courrier(10),
    courrier(2), // trop récent
    courrier(9, { pickedUpAt: new Date().toISOString() }), // déjà retiré
    courrier(8, { status: 'échec' }) // jamais parti
  ];
  const dus = reminders.aRelancer(history, { delaiJours: 7, now: maintenant });
  assert.deepEqual(dus.map(function (d) { return d.id; }), ['c10']);
});

test('aRelancer respecte l’intervalle entre deux relances', function () {
  const recent = courrier(20, { remindedAt: new Date(maintenant - 2 * JOUR).toISOString(), reminderCount: 1 });
  const ancien = courrier(21, { remindedAt: new Date(maintenant - 9 * JOUR).toISOString(), reminderCount: 1 });
  ancien.id = 'ancien';
  const dus = reminders.aRelancer([recent, ancien], { delaiJours: 7, intervalleJours: 7, now: maintenant });
  assert.deepEqual(dus.map(function (d) { return d.id; }), ['ancien']);
});

test('aRelancer cesse d’insister après le nombre maximal', function () {
  const acharne = courrier(30, { reminderCount: 3 });
  assert.equal(reminders.aRelancer([acharne], { delaiJours: 7, maxRelances: 3, now: maintenant }).length, 0);
  assert.equal(reminders.aRelancer([acharne], { delaiJours: 7, maxRelances: 5, now: maintenant }).length, 1);
});

test('un délai nul désactive complètement les relances', function () {
  assert.deepEqual(reminders.aRelancer([courrier(90)], { delaiJours: 0, now: maintenant }), []);
  assert.deepEqual(reminders.aRelancer([courrier(90)], {}), []);
});

test('resume compte l’attente et le plus ancien', function () {
  const r = reminders.resume([courrier(3), courrier(12), courrier(5, { pickedUpAt: 'x' })], maintenant);
  assert.equal(r.enAttente, 2);
  assert.equal(r.recuperes, 1);
  assert.equal(r.plusAncienJours, 12);
});

/* ---------- suivi par l'API ---------- */

test('un courrier se marque récupéré, puis se remet en attente', function () {
  return withServer(async function (t) {
    const contact = (await t.call('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com', box: 'B-1' })).body;
    const envoi = await t.call('POST', '/api/notify', { contactId: contact.id, name: 'Ana', email: 'ana@ex.com' });
    const id = envoi.body.record.id;
    assert.equal(envoi.body.record.pickedUpAt, null, 'un courrier neuf est en attente');

    const retire = await t.call('POST', '/api/history/' + id + '/pickup');
    assert.equal(retire.status, 200);
    assert.ok(retire.body.record.pickedUpAt);
    assert.equal((await t.call('GET', '/api/state')).body.suivi.enAttente, 0);

    const annule = await t.call('DELETE', '/api/history/' + id + '/pickup');
    assert.equal(annule.body.record.pickedUpAt, null);
    assert.equal((await t.call('GET', '/api/state')).body.suivi.enAttente, 1);
  });
});

test('une relance renvoie le message et incrémente le compteur', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const id = envoi.body.record.id;
    assert.equal(t.mailer.sent.length, 1);

    const relance = await t.call('POST', '/api/history/' + id + '/remind');
    assert.equal(relance.status, 200);
    assert.equal(relance.body.record.reminderCount, 1);
    assert.ok(relance.body.record.remindedAt);

    assert.equal(t.mailer.sent.length, 2);
    assert.match(t.mailer.sent[1].subject, /^Rappel — /);
    assert.match(t.mailer.sent[1].text, /vous attend depuis/);
  });
});

test('relancer un courrier inconnu renvoie 404', function () {
  return withServer(async function (t) {
    assert.equal((await t.call('POST', '/api/history/inexistant/remind')).status, 404);
    assert.equal((await t.call('POST', '/api/history/inexistant/pickup')).status, 404);
  });
});

/* ---------- sauvegarde ---------- */

test('la sauvegarde téléchargée ne contient aucun secret', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com' });
    await t.call('POST', '/api/auth/signup', {
      name: 'Marie',
      email: 'marie@bureau.org',
      password: 'courrier-2026-bureau'
    });

    const res = await fetch(t.base + '/api/backup', { headers: { Cookie: t.db.data.sessions.length ? 'bdc_session=' + t.db.data.sessions[0].token : '' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="registre-\d{4}-\d{2}-\d{2}\.json"/);

    const texte = await res.text();
    assert.ok(texte.includes('ana@ex.com'), 'le registre est bien là');
    assert.ok(!texte.includes('scrypt$'), 'aucune empreinte de mot de passe');
    assert.ok(!texte.includes('courrier-2026-bureau'), 'aucun mot de passe');
    assert.ok(!texte.includes('bdc_session'), 'aucun jeton de session');
    assert.ok(JSON.parse(texte).comptes.length === 1, 'les comptes sont listés, sans leurs secrets');
  });
});

test('la sauvegarde sur le serveur tourne et conserve un nombre fixe de copies', function () {
  return withServer(async function (t) {
    const dossier = path.join(t.dir, 'sauvegardes');
    // Trois jours différents, alors qu'on n'en garde que deux.
    for (const jour of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      await sauvegarder(t.db, { dossier: dossier, garder: 2, now: jour + 'T10:00:00Z' });
    }
    const fichiers = (await fs.readdir(dossier)).sort();
    assert.deepEqual(fichiers, ['registre-2026-01-02.json', 'registre-2026-01-03.json'], 'la plus ancienne est effacée');

    // Deux sauvegardes le même jour ne créent qu'un fichier.
    await sauvegarder(t.db, { dossier: dossier, garder: 2, now: '2026-01-03T18:00:00Z' });
    assert.equal((await fs.readdir(dossier)).length, 2);

    const stat = await fs.stat(path.join(dossier, 'registre-2026-01-03.json'));
    assert.equal(stat.mode & 0o077, 0, 'la copie est aussi protégée que l’original');
  });
});

/* ---------- gestion des comptes ---------- */

const COMPTE = { name: 'Marie Accueil', email: 'marie@bureau.org', password: 'courrier-2026-bureau' };

test('changer son mot de passe ferme les autres sessions', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    // Une seconde session, comme depuis un autre poste.
    const autre = await fetch(t.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: COMPTE.email, password: COMPTE.password })
    });
    const cookieAutre = autre.headers.get('set-cookie').split(';')[0];
    assert.equal(t.db.data.sessions.length, 2);

    const change = await t.call('PUT', '/api/auth/password', { current: COMPTE.password, next: 'nouveau-mot-de-passe-2026' });
    assert.equal(change.status, 200);
    assert.equal(t.db.data.sessions.length, 1, 'seule la session courante survit');

    const refus = await fetch(t.base + '/api/contacts', { headers: { Cookie: cookieAutre } });
    assert.equal(refus.status, 401, 'l’autre poste est déconnecté');

    // L'ancien mot de passe ne fonctionne plus.
    assert.equal((await t.call('POST', '/api/auth/login', { email: COMPTE.email, password: COMPTE.password })).status, 401);
  });
});

test('un mot de passe actuel faux ou un nouveau trop faible sont refusés', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    assert.equal((await t.call('PUT', '/api/auth/password', { current: 'faux', next: 'assez-long-pourtant' })).status, 401);
    assert.equal((await t.call('PUT', '/api/auth/password', { current: COMPTE.password, next: 'court' })).status, 400);
  });
});

test('seul le compte responsable peut retirer un accès', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const second = await t.call('POST', '/api/auth/signup', {
      name: 'Luc Second',
      email: 'luc@bureau.org',
      password: 'un-autre-mot-de-passe'
    });
    const idSecond = second.body.user.id;
    const idResponsable = t.db.data.users[0].id;

    // Le cookie courant est maintenant celui de Luc, qui n'est pas responsable.
    const refus = await t.call('DELETE', '/api/auth/users/' + idResponsable);
    assert.equal(refus.status, 403);
    assert.match(refus.body.error, /responsable/);

    // Le responsable se reconnecte et retire l'accès de Luc.
    await t.call('POST', '/api/auth/login', { email: COMPTE.email, password: COMPTE.password });
    const retrait = await t.call('DELETE', '/api/auth/users/' + idSecond);
    assert.equal(retrait.status, 200);
    assert.equal(t.db.data.users.length, 1);
    assert.equal(
      t.db.data.sessions.filter(function (s) {
        return s.userId === idSecond;
      }).length,
      0,
      'ses sessions sont fermées'
    );
  });
});

test('le responsable ne peut pas se retirer lui-même', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const soi = t.db.data.users[0].id;
    const refus = await t.call('DELETE', '/api/auth/users/' + soi);
    assert.equal(refus.status, 400);
    assert.equal(t.db.data.users.length, 1);
  });
});

test('la liste des comptes ne divulgue aucun secret', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const liste = await t.call('GET', '/api/auth/users');
    assert.equal(liste.status, 200);
    assert.equal(liste.body.users.length, 1);
    assert.equal(liste.body.users[0].password, undefined);
    assert.ok(!JSON.stringify(liste.body).includes('scrypt$'));
    assert.equal(liste.body.responsableId, t.db.data.users[0].id);
  });
});
