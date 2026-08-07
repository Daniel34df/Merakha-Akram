'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { Db, sauvegarder } = require('../server/db.js');
const db = require('../server/db.js');
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

test('aSignaler retient les courriers non retirés après la relance', function () {
  const relanceAncienne = courrier(40, {
    remindedAt: new Date(maintenant - 16 * JOUR).toISOString(),
    reminderCount: 1
  });
  relanceAncienne.id = 'a-signaler';
  const relanceRecente = courrier(20, {
    remindedAt: new Date(maintenant - 3 * JOUR).toISOString(),
    reminderCount: 1
  });
  const dejaSignale = courrier(60, {
    remindedAt: new Date(maintenant - 40 * JOUR).toISOString(),
    flaggedAt: new Date().toISOString()
  });
  const retire = courrier(60, {
    remindedAt: new Date(maintenant - 40 * JOUR).toISOString(),
    pickedUpAt: new Date().toISOString()
  });

  const dus = reminders.aSignaler([relanceAncienne, relanceRecente, dejaSignale, retire], {
    delaiJours: 15,
    escaladeJours: 15,
    now: maintenant
  });
  assert.deepEqual(dus.map(function (d) { return d.id; }), ['a-signaler']);
});

test('un courrier jamais relancé finit quand même par être signalé', function () {
  // Sans SMTP, aucune relance ne part : le courrier ne doit pas rester invisible.
  const orphelin = courrier(31);
  const jeune = courrier(20);
  const dus = reminders.aSignaler([orphelin, jeune], { delaiJours: 15, escaladeJours: 15, now: maintenant });
  assert.deepEqual(dus.map(function (d) { return d.id; }), ['c31'], '15 + 15 jours après réception');
});

test('etat classe chaque courrier dans un seul état', function () {
  assert.equal(reminders.etat(courrier(1)), 'attente');
  assert.equal(reminders.etat(courrier(20, { reminderCount: 1 })), 'relance');
  assert.equal(reminders.etat(courrier(40, { reminderCount: 1, flaggedAt: 'x' })), 'signale');
  assert.equal(reminders.etat(courrier(40, { flaggedAt: 'x', pickedUpAt: 'y' })), 'recupere');
  assert.equal(reminders.etat(courrier(40, { closedAt: 'z' })), 'clos');
  assert.equal(reminders.etat(courrier(2, { status: 'échec' })), 'echec');
});

test('le bilan des relances distingue récupérés et non récupérés', function () {
  const r = reminders.resume(
    [
      courrier(20, { reminderCount: 1, pickedUpAt: 'x' }),
      courrier(21, { reminderCount: 2 }),
      courrier(40, { reminderCount: 1, flaggedAt: 'x' }),
      courrier(2)
    ],
    maintenant
  );
  assert.equal(r.relances, 3);
  assert.equal(r.recuperesApresRelance, 1);
  assert.equal(r.signales, 1);
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

test('un courrier se signale, puis se classe avec un motif', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const id = envoi.body.record.id;

    const signale = await t.call('POST', '/api/history/' + id + '/flag');
    assert.equal(signale.status, 200);
    assert.ok(signale.body.record.flaggedAt);
    assert.equal((await t.call('GET', '/api/state')).body.suivi.signales, 1);

    // Classer sans motif est refusé : la trace doit dire ce qui a été fait.
    assert.equal((await t.call('POST', '/api/history/' + id + '/close', { reason: '  ' })).status, 400);

    const clos = await t.call('POST', '/api/history/' + id + '/close', { reason: 'Retourné à l’expéditeur' });
    assert.equal(clos.body.record.closeReason, 'Retourné à l’expéditeur');
    assert.ok(clos.body.record.closedAt);

    const etat = (await t.call('GET', '/api/state')).body.suivi;
    assert.equal(etat.enAttente, 0, 'un courrier classé ne compte plus en attente');
    assert.equal(etat.signales, 0);

    const rouvert = await t.call('DELETE', '/api/history/' + id + '/close');
    assert.equal(rouvert.body.record.closedAt, null);
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

    /* 403 et non 401 : la session reste valide. Un 401 est réservé à
       « votre session a expiré » — le client s'en sert pour renvoyer à l'écran
       de connexion, et une faute de frappe ne doit pas déconnecter. */
    const faux = await t.call('PUT', '/api/auth/password', { current: 'faux', next: 'assez-long-pourtant' });
    assert.equal(faux.status, 403);
    assert.equal(faux.body.code, undefined, 'aucun code de session : le client garde la session');
    assert.equal((await t.call('PUT', '/api/auth/password', { current: COMPTE.password, next: 'court' })).status, 400);

    // La session survit : on peut enchaîner avec le bon mot de passe.
    assert.equal((await t.call('GET', '/api/contacts')).status, 200);
    assert.equal(
      (await t.call('PUT', '/api/auth/password', { current: COMPTE.password, next: 'le-bon-cette-fois' })).status,
      200
    );
  });
});

test('une session absente répond 401 avec le code « session »', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', COMPTE);
    const res = await fetch(t.base + '/api/contacts', { headers: { Cookie: 'bdc_session=invente' } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'session');
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

/* ---------- types de courrier ---------- */

test('chaque type a son propre délai de relance', function () {
  const util = require('../assets/js/util.js');
  assert.equal(util.typeCourrier('colis').relanceJours, 5);
  assert.equal(util.typeCourrier('recommande').relanceJours, 7);
  assert.equal(util.typeCourrier('lettre').relanceJours, null, 'la lettre suit le délai général');
  assert.equal(util.typeCourrier('inconnu').id, 'lettre', 'un type inconnu retombe sur la lettre');

  assert.equal(reminders.delaiPour({ type: 'colis' }, 15), 5);
  assert.equal(reminders.delaiPour({ type: 'lettre' }, 15), 15);
  assert.equal(reminders.delaiPour({}, 15), 15);
});

test('un colis est relancé avant une lettre', function () {
  const colis = courrier(6, { type: 'colis' });
  colis.id = 'colis';
  const lettre = courrier(6, { type: 'lettre' });
  const dus = reminders.aRelancer([colis, lettre], { delaiJours: 15, now: maintenant });
  assert.deepEqual(dus.map(function (d) { return d.id; }), ['colis']);
});

/* ---------- code de retrait ---------- */

test('chaque notification reçoit un code de retrait unique, transmis au destinataire', function () {
  return withServer(async function (t) {
    const a = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const b = await t.call('POST', '/api/notify', { name: 'Bo', email: 'bo@ex.com' });

    assert.match(a.body.record.pickupCode, /^\d{4}$/);
    assert.notEqual(a.body.record.pickupCode, b.body.record.pickupCode);
    assert.match(t.mailer.sent[0].text, new RegExp('Code de retrait : ' + a.body.record.pickupCode));
  });
});

test('le code présenté au guichet marque le bon courrier récupéré', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com', type: 'colis' });
    const code = envoi.body.record.pickupCode;
    assert.equal(envoi.body.record.type, 'colis');

    const remise = await t.call('POST', '/api/history/pickup-by-code', { code: code });
    assert.equal(remise.status, 200);
    assert.ok(remise.body.record.pickedUpAt);
    assert.equal(remise.body.record.pickedUpByCode, true);

    // Le même code ne sert pas deux fois : le courrier n'est plus en attente.
    assert.equal((await t.call('POST', '/api/history/pickup-by-code', { code: code })).status, 404);
    assert.equal((await t.call('POST', '/api/history/pickup-by-code', { code: '12' })).status, 400);
  });
});

test('la consultation par code renseigne l’agent sans rien modifier', function () {
  return withServer(async function (t) {
    const contact = (
      await t.call('POST', '/api/contacts', { name: 'Ana Blin', email: 'ana@ex.com', box: 'B-12' })
    ).body;
    const envoi = await t.call('POST', '/api/notify', {
      contactId: contact.id,
      name: 'Ana Blin',
      email: 'ana@ex.com',
      type: 'colis'
    });
    const code = envoi.body.record.pickupCode;
    // Un second courrier pour la même personne : il doit apparaître comme « autre ».
    await t.call('POST', '/api/notify', {
      contactId: contact.id,
      name: 'Ana Blin',
      email: 'ana@ex.com',
      type: 'recommande'
    });
    // Et un courrier d'une autre personne, qui n'a rien à faire dans la fiche.
    await t.call('POST', '/api/notify', { name: 'Bo', email: 'bo@ex.com' });

    const fiche = await t.call('GET', '/api/history/by-code/' + code);
    assert.equal(fiche.status, 200);
    assert.equal(fiche.body.record.pickupCode, code);
    assert.equal(fiche.body.record.type, 'colis');
    assert.equal(fiche.body.record.name, 'Ana Blin');
    assert.equal(fiche.body.contact.box, 'B-12', 'le numéro de boîte accompagne la fiche');
    assert.equal(fiche.body.autres.length, 1, 'seuls les courriers en attente de la même personne');
    assert.equal(fiche.body.autres[0].type, 'recommande');

    // Consulter n'est pas remettre : le courrier reste en attente.
    const enBase = t.db.data.history.find(function (h) {
      return h.pickupCode === code;
    });
    assert.ok(!enBase.pickedUpAt, 'le courrier reste en attente après une simple consultation');
    const journal = await t.call('GET', '/api/journal');
    assert.equal(
      journal.body.entrees.filter(function (e) {
        return e.action === 'courrier remis';
      }).length,
      0
    );

    // Un code sans courrier en attente : 404, et un code mal formé n'atteint pas la route.
    const utilises = new Set(
      t.db.data.history.map(function (h) {
        return h.pickupCode;
      })
    );
    let libre = '0000';
    for (let i = 0; utilises.has(libre); i++) libre = String(i).padStart(4, '0');
    assert.equal((await t.call('GET', '/api/history/by-code/' + libre)).status, 404);
    assert.equal((await t.call('GET', '/api/history/by-code/12')).status, 404);

    // Une fois le courrier remis, son code ne renvoie plus de fiche.
    await t.call('POST', '/api/history/pickup-by-code', { code: code });
    assert.equal((await t.call('GET', '/api/history/by-code/' + code)).status, 404);
  });
});

test('deux courriers portant le même code arrêtent la remise plutôt que d’en deviner un', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const code = envoi.body.record.pickupCode;
    await t.db.write(function (data) {
      data.history.push({
        id: 'doublon',
        name: 'Bo',
        email: 'bo@ex.com',
        date: new Date().toISOString(),
        status: 'envoyé',
        pickupCode: code
      });
    });

    assert.equal((await t.call('GET', '/api/history/by-code/' + code)).status, 409);
    assert.equal((await t.call('POST', '/api/history/pickup-by-code', { code: code })).status, 409);
  });
});

/* ---------- récapitulatif ---------- */

test('le récapitulatif compte la période et liste les plus anciens', function () {
  const semaine = 7 * JOUR;
  const history = [
    courrier(2),
    courrier(3, { pickedUpAt: new Date(maintenant - 1 * JOUR).toISOString() }),
    courrier(40, { flaggedAt: 'x', reminderCount: 2 }),
    courrier(20, { closedAt: 'x' })
  ];
  history[2].name = 'Vieux Courrier';

  const recap = reminders.construireRecap(history, [], { depuis: maintenant - semaine, jusqua: maintenant });
  assert.equal(recap.recus, 2, 'seuls ceux de la semaine');
  assert.equal(recap.retires, 1);
  assert.equal(recap.enAttente, 2, 'le classé ne compte pas');
  assert.equal(recap.signales, 1);
  assert.equal(recap.plusAnciens[0].nom, 'Vieux Courrier');
  assert.equal(recap.plusAnciens[0].relances, 2);

  const texte = reminders.recapEnTexte(recap, 'Réception A');
  assert.match(texte, /Réception A/);
  assert.match(texte, /Vieux Courrier/);
  assert.match(texte, /En attente aujourd’hui\s+: 2/);
});

test('le récapitulatif ne part que le bon jour, une seule fois', function () {
  const lundi8h = new Date(2026, 7, 3, 8, 30); // 3 août 2026 = lundi
  const lundi7h = new Date(2026, 7, 3, 7, 0);
  const mardi = new Date(2026, 7, 4, 9, 0);

  assert.equal(reminders.recapDu({ jour: 1, heure: 8, now: lundi8h }), true);
  assert.equal(reminders.recapDu({ jour: 1, heure: 8, now: lundi7h }), false, 'trop tôt dans la journée');
  assert.equal(reminders.recapDu({ jour: 1, heure: 8, now: mardi }), false, 'pas le bon jour');
  assert.equal(
    reminders.recapDu({ jour: 1, heure: 8, now: lundi8h, dernier: new Date(2026, 7, 3, 8, 0).toISOString() }),
    false,
    'déjà envoyé aujourd’hui'
  );
});

/* ---------- recherche tolérante ---------- */

test('suggestionsProches retrouve un nom mal orthographié', function () {
  const util = require('../assets/js/util.js');
  const contacts = [
    { name: 'Élodie Tremblay' },
    { name: 'Jean-François Roy' },
    { name: 'Ana Silva' }
  ];
  assert.deepEqual(
    util.suggestionsProches(contacts, 'Tremblet').map(function (c) { return c.name; }),
    ['Élodie Tremblay']
  );
  assert.deepEqual(
    util.suggestionsProches(contacts, 'silvia').map(function (c) { return c.name; }),
    ['Ana Silva']
  );
  assert.deepEqual(util.suggestionsProches(contacts, 'Dupont'), [], 'aucun rapprochement abusif');
  assert.deepEqual(util.suggestionsProches(contacts, 'ab'), [], 'trop court pour comparer');
});

/* ---------- absences ---------- */

test('presence distingue présent, absent et parti', function () {
  const util = require('../assets/js/util.js');
  const aujourdhui = new Date(2026, 7, 7);
  assert.equal(util.presence({}, aujourdhui).etat, 'present');
  assert.equal(util.presence({ absentUntil: '2026-08-20' }, aujourdhui).etat, 'absent');
  assert.equal(util.presence({ absentUntil: '2026-08-01' }, aujourdhui).etat, 'present', 'absence terminée');
  assert.equal(util.presence({ departed: true }, aujourdhui).etat, 'parti');
  assert.match(util.presence({ absentUntil: '2026-08-20' }, aujourdhui).message, /20 août 2026/);
});

test('les champs d’absence sont enregistrés et validés', function () {
  return withServer(async function (t) {
    const remplacant = (await t.call('POST', '/api/contacts', { name: 'Luc', email: 'luc@ex.com' })).body;
    const absent = await t.call('POST', '/api/contacts', {
      name: 'Ana',
      email: 'ana@ex.com',
      absentUntil: '2026-12-31',
      substituteId: remplacant.id
    });
    assert.equal(absent.status, 201);
    assert.equal(absent.body.absentUntil, '2026-12-31');
    assert.equal(absent.body.substituteId, remplacant.id);

    const mauvaise = await t.call('POST', '/api/contacts', {
      name: 'X',
      email: 'x@ex.com',
      absentUntil: '31/12/2026'
    });
    assert.equal(mauvaise.status, 400);
    assert.match(mauvaise.body.error, /AAAA-MM-JJ/);
  });
});

/* ---------- signature ---------- */

test('la signature est enregistrée avec la remise, et validée', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const id = envoi.body.record.id;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

    const remise = await t.call('POST', '/api/history/' + id + '/pickup', { signature: png });
    assert.equal(remise.status, 200);
    assert.equal(remise.body.record.signature, png);

    // Annuler la remise efface la signature : elle ne vaut plus rien.
    const annule = await t.call('DELETE', '/api/history/' + id + '/pickup');
    assert.equal(annule.body.record.signature, null);

    const fausse = await t.call('POST', '/api/history/' + id + '/pickup', { signature: 'javascript:alert(1)' });
    assert.equal(fausse.status, 400);

    const enorme = await t.call('POST', '/api/history/' + id + '/pickup', {
      signature: 'data:image/png;base64,' + 'A'.repeat(90000)
    });
    assert.equal(enorme.status, 413);
  });
});

/* ---------- journal ---------- */

test('le journal consigne les actions, du plus récent au plus ancien', function () {
  return withServer(async function (t) {
    const c = (await t.call('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com', box: 'B-1' })).body;
    await t.call('PUT', '/api/contacts/' + c.id, { name: 'Ana Silva', email: 'ana@ex.com' });
    await t.call('DELETE', '/api/contacts/' + c.id);

    const journal = await t.call('GET', '/api/journal');
    assert.equal(journal.status, 200);
    const actions = journal.body.entrees.map(function (e) {
      return e.action;
    });
    assert.deepEqual(actions.slice(0, 3), [
      'destinataire supprimé',
      'destinataire modifié',
      'destinataire ajouté'
    ]);
    assert.equal(journal.body.entrees[2].details, 'boîte B-1');
  });
});

test('une remise par code est consignée', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    await t.call('POST', '/api/history/pickup-by-code', { code: envoi.body.record.pickupCode });

    const journal = await t.call('GET', '/api/journal');
    const remise = journal.body.entrees.find(function (e) {
      return e.action === 'courrier remis';
    });
    assert.ok(remise, 'la remise figure au journal');
    assert.match(remise.details, /par code/);
  });
});

/* ---------- statistiques ---------- */

test('les statistiques comptent par période et par boîte', function () {
  const contacts = [
    { id: 'c1', box: 'B-1' },
    { id: 'c2', box: 'A-2' }
  ];
  const history = [
    courrier(1, { contactId: 'c1', pickedUpAt: new Date(maintenant).toISOString(), type: 'colis' }),
    courrier(3, { contactId: 'c1' }),
    courrier(200, { contactId: 'c2', pickedUpAt: new Date(maintenant).toISOString() })
  ];
  const st = reminders.statistiques(history, contacts, { now: maintenant });

  assert.equal(st.total, 3);
  assert.equal(st.semaine.recus, 2);
  assert.equal(st.semaine.retires, 1);
  assert.equal(st.semaine.taux, 50);
  assert.equal(st.annee.recus, 3);
  assert.equal(st.boitesActives[0].boite, 'B-1');
  assert.equal(st.boitesActives[0].courriers, 2);
  assert.equal(st.parType.Colis, 1);
});

test('un taux ne se calcule pas sur un échantillon vide', function () {
  const st = reminders.statistiques([], [], { now: maintenant });
  assert.equal(st.semaine.taux, null);
  assert.equal(st.delaiMoyenJours, null);
});

/* ---------- gabarits par type de courrier ---------- */

test('un colis reçoit son propre message, une lettre garde le général', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'Un courrier vous attend',
      body: 'Bonjour {nom}, passez à la réception.',
      templates: {
        colis: {
          subject: 'Un colis vous attend',
          body: 'Bonjour {nom}, un colis encombre le casier — merci de passer vite.'
        }
      }
    });

    await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com', type: 'colis' });
    assert.equal(t.mailer.sent[0].subject, 'Un colis vous attend');
    assert.match(t.mailer.sent[0].text, /un colis encombre le casier/);

    await t.call('POST', '/api/notify', { name: 'Bo', email: 'bo@ex.com', type: 'lettre' });
    assert.equal(t.mailer.sent[1].subject, 'Un courrier vous attend');
    assert.match(t.mailer.sent[1].text, /passez à la réception/);
  });
});

test('les variables {type}, {article} et {code} sont remplacées', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: '{type} en attente',
      body: '{article} vous attend. Code : {code}.'
    });
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com', type: 'recommande' });

    assert.equal(t.mailer.sent[0].subject, 'Recommandé en attente');
    assert.match(
      t.mailer.sent[0].text,
      new RegExp('Un courrier recommandé vous attend\\. Code : ' + envoi.body.record.pickupCode + '\\.')
    );
  });
});

test('la relance emploie aussi le gabarit du type', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'Général',
      body: 'Corps général.',
      templates: { colis: { subject: 'Colis', body: 'Votre colis attend toujours.' } }
    });
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com', type: 'colis' });
    t.mailer.sent.length = 0;

    await t.call('POST', '/api/history/' + envoi.body.record.id + '/remind');
    assert.equal(t.mailer.sent[0].subject, 'Rappel — Colis');
    assert.match(t.mailer.sent[0].text, /Votre colis attend toujours/);
  });
});

test('un gabarit incomplet ou d’un type inconnu n’est pas conservé', function () {
  return withServer(async function (t) {
    const res = await t.call('PUT', '/api/settings', {
      subject: 'S',
      body: 'B',
      templates: {
        colis: { subject: 'Colis', body: 'Corps colis' },
        recommande: { subject: 'Sujet seul', body: '' },
        inconnu: { subject: 'X', body: 'Y' }
      }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(t.db.data.settings.templates), ['colis']);
  });
});

test('enregistrer des réglages sans parler des gabarits ne les efface pas', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'S',
      body: 'B',
      templates: { colis: { subject: 'Colis', body: 'Corps colis' } }
    });
    // Un client ancien, qui ignore les gabarits, ne doit pas les emporter.
    await t.call('PUT', '/api/settings', { subject: 'S2', body: 'B2' });
    assert.deepEqual(Object.keys(t.db.data.settings.templates), ['colis']);

    // Un objet vide, lui, est un effacement explicite.
    await t.call('PUT', '/api/settings', { subject: 'S3', body: 'B3', templates: {} });
    assert.deepEqual(t.db.data.settings.templates, {});
  });
});

/* ---------- retrait par un tiers ---------- */

test('le nom de la personne qui retire est enregistré et consigné', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana Blin', email: 'ana@ex.com' });
    const code = envoi.body.record.pickupCode;

    const remise = await t.call('POST', '/api/history/pickup-by-code', {
      code: code,
      porteur: 'Jean Roy, voisin'
    });
    assert.equal(remise.status, 200);
    assert.equal(remise.body.record.remisA, 'Jean Roy, voisin');
    assert.equal(remise.body.record.name, 'Ana Blin', 'le destinataire reste celui du courrier');

    const journal = await t.call('GET', '/api/journal');
    const ligne = journal.body.entrees.find(function (e) {
      return e.action === 'courrier remis';
    });
    assert.match(ligne.details, /retiré par Jean Roy, voisin/);
  });
});

test('sans tiers, le champ reste vide — le destinataire est venu lui-même', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const remise = await t.call('POST', '/api/history/pickup-by-code', {
      code: envoi.body.record.pickupCode
    });
    assert.equal(remise.body.record.remisA, null);
  });
});

test('la remise depuis la liste accepte aussi un porteur', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const id = envoi.body.record.id;

    const remise = await t.call('POST', '/api/history/' + id + '/pickup', { porteur: '  Luc Tiers  ' });
    assert.equal(remise.body.record.remisA, 'Luc Tiers', 'les espaces sont rognés');

    // Annuler la remise efface le porteur : plus personne n'a retiré ce courrier.
    const annule = await t.call('DELETE', '/api/history/' + id + '/pickup');
    assert.equal(annule.body.record.remisA, null);
    assert.equal(annule.body.record.pickedUpAt, null);
  });
});

test('un nom de porteur démesuré est refusé', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const res = await t.call('POST', '/api/history/pickup-by-code', {
      code: envoi.body.record.pickupCode,
      porteur: 'x'.repeat(200)
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /trop long/);
    // Le courrier n'a pas été remis au passage.
    assert.ok(!t.db.data.history[0].pickedUpAt);
  });
});

/* ---------- domiciliation ---------- */

const JOURS = 24 * 60 * 60 * 1000;
const jourIso = function (decalage) {
  return new Date(Date.now() + decalage * JOURS).toISOString().slice(0, 10);
};

test('l’échéance de l’attestation est calculée si on ne la donne pas', function () {
  return withServer(async function (t) {
    const c = await t.call('POST', '/api/contacts', {
      name: 'Ana Blin',
      email: 'ana@ex.com',
      domicilie: true,
      domicilieDepuis: '2026-03-15'
    });
    assert.equal(c.status, 201);
    assert.equal(c.body.domicilie, true);
    assert.equal(c.body.domicilieJusqua, '2027-03-15', 'douze mois plus tard');
  });
});

test('une échéance fournie l’emporte sur le calcul', function () {
  return withServer(async function (t) {
    const c = await t.call('POST', '/api/contacts', {
      name: 'Ana',
      email: 'ana@ex.com',
      domicilie: true,
      domicilieDepuis: '2026-03-15',
      domicilieJusqua: '2026-09-15'
    });
    assert.equal(c.body.domicilieJusqua, '2026-09-15');
  });
});

test('les dates de domiciliation incohérentes sont refusées', function () {
  return withServer(async function (t) {
    assert.equal(
      (await t.call('POST', '/api/contacts', {
        name: 'Ana', email: 'ana@ex.com', domicilie: true, domicilieDepuis: '15/03/2026'
      })).status,
      400
    );
    const inverse = await t.call('POST', '/api/contacts', {
      name: 'Bo', email: 'bo@ex.com', domicilie: true,
      domicilieDepuis: '2026-06-01', domicilieJusqua: '2026-01-01'
    });
    assert.equal(inverse.status, 400);
    assert.match(inverse.body.error, /précède/);
  });
});

test('un destinataire non domicilié ne garde aucune date de domiciliation', function () {
  return withServer(async function (t) {
    const c = await t.call('POST', '/api/contacts', {
      name: 'Ana', email: 'ana@ex.com', domicilieDepuis: '2026-03-15', domiciliationMotif: 'x'
    });
    assert.equal(c.body.domicilie, false);
    assert.equal(c.body.domicilieDepuis, '');
    assert.equal(c.body.domiciliationMotif, '');
  });
});

test('un passage sans courrier est enregistré et consigné', function () {
  return withServer(async function (t) {
    const c = (await t.call('POST', '/api/contacts', {
      name: 'Ana', email: 'ana@ex.com', domicilie: true, domicilieDepuis: jourIso(-200)
    })).body;

    const passage = await t.call('POST', '/api/contacts/' + c.id + '/passage', { note: 'rien pour elle' });
    assert.equal(passage.status, 200);
    assert.equal(passage.body.contact.passages.length, 1);
    assert.equal(passage.body.contact.passages[0].note, 'rien pour elle');
    assert.ok(Date.parse(passage.body.contact.passages[0].at));

    const journal = await t.call('GET', '/api/journal');
    assert.ok(
      journal.body.entrees.some(function (e) {
        return e.action === 'passage enregistré' && e.cible === 'Ana';
      })
    );

    assert.equal((await t.call('POST', '/api/contacts/inconnu/passage', {})).status, 404);
  });
});

test('la modification d’un destinataire ne perd pas ses passages', function () {
  return withServer(async function (t) {
    const c = (await t.call('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com' })).body;
    await t.call('POST', '/api/contacts/' + c.id + '/passage', {});
    await t.call('PUT', '/api/contacts/' + c.id, { name: 'Ana Blin', email: 'ana@ex.com' });

    const relu = (await t.call('GET', '/api/contacts')).body[0];
    assert.equal(relu.name, 'Ana Blin');
    assert.equal(relu.passages.length, 1, 'les passages survivent à une modification de fiche');
  });
});

test('/api/domiciliation dresse les deux listes de travail', function () {
  return withServer(async function (t) {
    // Attestation qui arrive à terme, mais personne assidue : elle est passée
    // récemment, elle ne doit donc figurer que sur la liste des renouvellements.
    const proche = (await t.call('POST', '/api/contacts', {
      name: 'Échéance Proche', email: 'e@ex.com', box: 'A-01',
      domicilie: true, domicilieDepuis: jourIso(-345)
    })).body;
    await t.call('POST', '/api/contacts/' + proche.id + '/passage', {});
    // Attestation valable, mais plus aucun signe de vie.
    await t.call('POST', '/api/contacts', {
      name: 'Disparu', email: 'd@ex.com', box: 'A-02',
      domicilie: true, domicilieDepuis: jourIso(-120)
    });
    // Dossier sain.
    const sain = (await t.call('POST', '/api/contacts', {
      name: 'À Jour', email: 'j@ex.com', domicilie: true, domicilieDepuis: jourIso(-20)
    })).body;
    await t.call('POST', '/api/contacts/' + sain.id + '/passage', {});

    const res = await t.call('GET', '/api/domiciliation');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.aRenouveler.map(function (d) { return d.name; }), ['Échéance Proche']);
    assert.deepEqual(res.body.sansPassage.map(function (d) { return d.name; }), ['Disparu']);
    assert.equal(res.body.aRenouveler[0].box, 'A-01', 'la boîte accompagne la ligne');
    assert.equal(res.body.reglages.validiteMois, 12);
    assert.equal(res.body.reglages.absenceMois, 3);
  });
});

test('le rapport annuel est servi par l’API', function () {
  return withServer(async function (t) {
    const annee = new Date().getFullYear();
    await t.call('POST', '/api/contacts', {
      name: 'Ouverte', email: 'o@ex.com', domicilie: true, domicilieDepuis: annee + '-02-10'
    });
    await t.call('POST', '/api/contacts', {
      name: 'Close', email: 'c@ex.com', domicilie: true,
      domicilieDepuis: annee + '-01-05',
      domiciliationCloseLe: annee + '-06-30',
      domiciliationMotif: 'déménagement'
    });

    const res = await t.call('GET', '/api/domiciliation?annee=' + annee);
    assert.equal(res.body.rapport.annee, annee);
    assert.equal(res.body.rapport.ouvertesDansLAnnee, 2);
    assert.equal(res.body.rapport.closesDansLAnnee, 1);
    assert.equal(res.body.rapport.actives, 1);
    assert.deepEqual(res.body.rapport.motifs, { 'déménagement': 1 });
  });
});

test('un dossier peut figurer à la fois en renouvellement et en risque de radiation', function () {
  return withServer(async function (t) {
    // Attestation bientôt échue ET plus aucun signe de vie : les deux listes
    // le montrent, parce que ce sont deux problèmes distincts.
    await t.call('POST', '/api/contacts', {
      name: 'Doublement en peine', email: 'x@ex.com',
      domicilie: true, domicilieDepuis: jourIso(-345)
    });
    const res = await t.call('GET', '/api/domiciliation');
    assert.equal(res.body.aRenouveler.length, 1);
    assert.equal(res.body.sansPassage.length, 1);
  });
});

/* ---------- courrier urgent ---------- */

test('un courrier urgent est relancé sous deux jours', function () {
  const urgent = courrier(3, { urgent: true });
  const ordinaire = courrier(3);
  ordinaire.id = 'ordinaire';

  const dus = reminders.aRelancer([urgent, ordinaire], { delaiJours: 15, now: maintenant });
  assert.deepEqual(dus.map(function (d) { return d.id; }), ['c3'], 'seul l’urgent est dû');
  assert.equal(reminders.delaiPour(urgent, 15), reminders.DELAI_URGENT);
});

test('l’urgence l’emporte sur le délai propre au type', function () {
  // Un colis a déjà un délai court (5 jours) ; urgent, il tombe à deux.
  const colisUrgent = courrier(3, { type: 'colis', urgent: true });
  assert.equal(reminders.delaiPour(colisUrgent, 15), reminders.DELAI_URGENT);
  assert.equal(reminders.delaiPour(courrier(3, { type: 'colis' }), 15), 5);
});

test('l’urgence déclarée à la réception est enregistrée', function () {
  return withServer(async function (t) {
    const normal = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    assert.equal(normal.body.record.urgent, false);

    const presse = await t.call('POST', '/api/notify', { name: 'Bo', email: 'bo@ex.com', urgent: true });
    assert.equal(presse.body.record.urgent, true);
  });
});

/* ---------- restauration d'une sauvegarde ---------- */

test('les sauvegardes se listent avec un aperçu de leur contenu', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com' });
    await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    await t.call('POST', '/api/backup');

    const liste = await t.call('GET', '/api/backup/list');
    assert.equal(liste.status, 200);
    assert.equal(liste.body.sauvegardes.length, 1);
    assert.equal(liste.body.sauvegardes[0].destinataires, 1);
    assert.equal(liste.body.sauvegardes[0].courriers, 1);
    assert.match(liste.body.sauvegardes[0].fichier, /^registre-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

test('restaurer ramène le registre à l’état de la copie', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com' });
    const sauvegarde = (await t.call('POST', '/api/backup')).body.fichier;

    // On abîme le registre après la copie.
    await t.call('POST', '/api/contacts', { name: 'Erreur', email: 'erreur@ex.com' });
    await t.call('DELETE', '/api/history');
    assert.equal(t.db.data.contacts.length, 2);

    const r = await t.call('POST', '/api/backup/restore', { fichier: sauvegarde });
    assert.equal(r.status, 200);
    assert.equal(r.body.avant.destinataires, 2);
    assert.equal(r.body.apres.destinataires, 1);
    assert.equal(t.db.data.contacts.length, 1);
    assert.equal(t.db.data.contacts[0].name, 'Ana');

    const journal = await t.call('GET', '/api/journal');
    assert.ok(
      journal.body.entrees.some(function (e) {
        return e.action === 'registre restauré';
      })
    );
  });
});

test('la restauration ne fait pas perdre l’accès à l’application', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', {
      name: 'Marie', email: 'marie@bureau.org', password: 'mot-de-passe-long'
    });
    const sauvegarde = (await t.call('POST', '/api/backup')).body.fichier;
    await t.call('POST', '/api/backup/restore', { fichier: sauvegarde });

    // Comptes et sessions survivent : une copie du registre n'est pas une purge.
    assert.equal(t.db.data.users.length, 1);
    assert.equal((await t.call('GET', '/api/contacts')).status, 200, 'la session tient toujours');
  });
});

test('un nom de sauvegarde inventé ou hors du dossier est refusé', function () {
  return withServer(async function (t) {
    assert.equal((await t.call('POST', '/api/backup/restore', { fichier: '../../etc/passwd' })).status, 400);
    assert.equal((await t.call('POST', '/api/backup/restore', { fichier: 'registre-2020-01-01.json' })).status, 404);
    assert.equal((await t.call('POST', '/api/backup/restore', {})).status, 400);
  });
});

/* ---------- durée de conservation ---------- */

test('la purge n’efface que les courriers terminés et anciens', function () {
  const now = Date.now();
  // Retiré il y a 780 jours : au-delà des 24 mois (≈730 j) de conservation.
  const vieuxRetire = courrier(800, { pickedUpAt: new Date(now - 780 * JOUR).toISOString() });
  vieuxRetire.id = 'vieux-retire';
  const vieuxClos = courrier(900, { closedAt: new Date(now - 800 * JOUR).toISOString() });
  vieuxClos.id = 'vieux-clos';
  const vieuxEnAttente = courrier(900);
  vieuxEnAttente.id = 'vieux-attente';
  // Retiré il y a 700 jours : encore dans la fenêtre, il reste.
  const bordure = courrier(760, { pickedUpAt: new Date(now - 700 * JOUR).toISOString() });
  bordure.id = 'bordure';
  const recentRetire = courrier(30, { pickedUpAt: new Date(now - 20 * JOUR).toISOString() });
  recentRetire.id = 'recent';

  const aPurger = db.courriersAPurger([vieuxRetire, vieuxClos, vieuxEnAttente, bordure, recentRetire], {
    mois: 24,
    now: now
  });
  assert.deepEqual(
    aPurger.map(function (h) { return h.id; }).sort(),
    ['vieux-clos', 'vieux-retire'],
    'un courrier jamais retiré reste, quel que soit son âge'
  );
});

test('une durée nulle ne purge rien', function () {
  const vieux = courrier(3000, { pickedUpAt: new Date(Date.now() - 3000 * JOUR).toISOString() });
  assert.deepEqual(db.courriersAPurger([vieux], { mois: 0 }), []);
  assert.deepEqual(db.courriersAPurger([vieux], {}), []);
});

test('la durée de conservation s’enregistre et se borne', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', { subject: 'S', body: 'B', conservationMois: 24 });
    assert.equal(t.db.data.settings.conservationMois, 24);

    // Enregistrer sans la mentionner ne l'efface pas.
    await t.call('PUT', '/api/settings', { subject: 'S2', body: 'B2' });
    assert.equal(t.db.data.settings.conservationMois, 24);

    await t.call('PUT', '/api/settings', { subject: 'S', body: 'B', conservationMois: 9999 });
    assert.equal(t.db.data.settings.conservationMois, 120, 'borné à dix ans');

    await t.call('PUT', '/api/settings', { subject: 'S', body: 'B', conservationMois: -5 });
    assert.equal(t.db.data.settings.conservationMois, 0);
  });
});

test('purger applique la durée au registre', function () {
  return withServer(async function (t) {
    const envoi = await t.call('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    await t.call('POST', '/api/history/' + envoi.body.record.id + '/pickup');
    // On vieillit artificiellement le retrait.
    await t.db.write(function (data) {
      data.history[0].pickedUpAt = new Date(Date.now() - 900 * JOUR).toISOString();
    });

    const bilan = await db.purger(t.db, { mois: 12 });
    assert.equal(bilan.supprimes, 1);
    assert.equal(t.db.data.history.length, 0);
  });
});

/* ---------- messages en plusieurs langues ---------- */

test('le destinataire reçoit le message dans sa langue', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'Un courrier vous attend',
      body: 'Bonjour {nom}.',
      langues: {
        ar: { subject: 'لديك بريد', body: 'مرحباً {nom}.' },
        en: { subject: 'You have mail', body: 'Hello {nom}.' }
      }
    });
    const yasmine = (await t.call('POST', '/api/contacts', {
      name: 'Yasmine', email: 'yasmine@ex.com', langue: 'ar'
    })).body;
    assert.equal(yasmine.langue, 'ar');

    await t.call('POST', '/api/notify', { contactId: yasmine.id, name: 'Yasmine', email: 'yasmine@ex.com' });
    assert.equal(t.mailer.sent[0].subject, 'لديك بريد');
    assert.match(t.mailer.sent[0].text, /مرحباً Yasmine\./);

    // Un francophone garde le modèle de référence.
    const marc = (await t.call('POST', '/api/contacts', { name: 'Marc', email: 'marc@ex.com' })).body;
    assert.equal(marc.langue, 'fr', 'français par défaut');
    await t.call('POST', '/api/notify', { contactId: marc.id, name: 'Marc', email: 'marc@ex.com' });
    assert.equal(t.mailer.sent[1].subject, 'Un courrier vous attend');
  });
});

test('une langue sans texte propre retombe sur le français', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'Un courrier vous attend',
      body: 'Bonjour {nom}.',
      langues: { ar: { subject: 'لديك بريد', body: 'مرحباً {nom}.' } }
    });
    const c = (await t.call('POST', '/api/contacts', { name: 'Sofía', email: 's@ex.com', langue: 'es' })).body;
    await t.call('POST', '/api/notify', { contactId: c.id, name: 'Sofía', email: 's@ex.com' });
    assert.equal(t.mailer.sent[0].subject, 'Un courrier vous attend', 'mieux que rien envoyer');
  });
});

test('le gabarit d’un type dans une langue l’emporte sur les deux', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'Général FR',
      body: 'Corps FR',
      templates: { colis: { subject: 'Colis FR', body: 'Corps colis FR' } },
      langues: {
        en: {
          subject: 'General EN',
          body: 'Body EN',
          templates: { colis: { subject: 'A parcel is waiting', body: 'Hello {nom}, a parcel.' } }
        }
      }
    });
    const c = (await t.call('POST', '/api/contacts', { name: 'John', email: 'j@ex.com', langue: 'en' })).body;

    await t.call('POST', '/api/notify', { contactId: c.id, name: 'John', email: 'j@ex.com', type: 'colis' });
    assert.equal(t.mailer.sent[0].subject, 'A parcel is waiting');

    // Un type sans texte anglais retombe sur le message anglais courant.
    await t.call('POST', '/api/notify', { contactId: c.id, name: 'John', email: 'j@ex.com', type: 'lettre' });
    assert.equal(t.mailer.sent[1].subject, 'General EN');
  });
});

test('la relance suit aussi la langue du destinataire', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'FR', body: 'Corps FR',
      langues: { en: { subject: 'Mail waiting', body: 'Hello {nom}.' } }
    });
    const c = (await t.call('POST', '/api/contacts', { name: 'John', email: 'j@ex.com', langue: 'en' })).body;
    const envoi = await t.call('POST', '/api/notify', { contactId: c.id, name: 'John', email: 'j@ex.com' });
    t.mailer.sent.length = 0;

    await t.call('POST', '/api/history/' + envoi.body.record.id + '/remind');
    assert.equal(t.mailer.sent[0].subject, 'Rappel — Mail waiting');
  });
});

test('une langue inconnue ou un gabarit incomplet sont écartés', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      langues: {
        en: { subject: 'EN', body: 'Body' },
        ar: { subject: 'Sujet seul', body: '' },
        klingon: { subject: 'X', body: 'Y' }
      }
    });
    assert.deepEqual(Object.keys(t.db.data.settings.langues), ['en']);

    // Une langue inconnue sur un destinataire retombe sur le français.
    const c = (await t.call('POST', '/api/contacts', { name: 'X', email: 'x@ex.com', langue: 'klingon' })).body;
    assert.equal(c.langue, 'fr');
  });
});

/* ---------- plusieurs antennes ---------- */

test('sans antenne déclarée, rien ne change', function () {
  return withServer(async function (t) {
    const c = (await t.call('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com' })).body;
    assert.equal(c.antenneId, '');
    assert.deepEqual(t.db.data.settings.antennes, []);
    assert.equal((await t.call('GET', '/api/state')).body.contacts.length, 1);
  });
});

test('les antennes se déclarent dans les réglages, sans doublon', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      antennes: [
        { id: 'nord', nom: 'Antenne Nord', adresse: '12 rue des Lilas' },
        { id: 'sud', nom: 'Antenne Sud' },
        { id: 'nord', nom: 'Doublon' },
        { id: '', nom: 'Sans identifiant' },
        { id: 'vide', nom: '' }
      ]
    });
    assert.deepEqual(
      t.db.data.settings.antennes.map(function (a) { return a.id; }),
      ['nord', 'sud'],
      'doublons et entrées incomplètes écartés'
    );
    assert.equal(t.db.data.settings.antennes[0].adresse, '12 rue des Lilas');
  });
});

test('un courrier hérite de l’antenne de son destinataire', function () {
  return withServer(async function (t) {
    await t.call('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      antennes: [{ id: 'nord', nom: 'Nord' }, { id: 'sud', nom: 'Sud' }]
    });
    const ana = (await t.call('POST', '/api/contacts', {
      name: 'Ana', email: 'ana@ex.com', antenneId: 'sud'
    })).body;
    assert.equal(ana.antenneId, 'sud');

    const envoi = await t.call('POST', '/api/notify', {
      contactId: ana.id, name: 'Ana', email: 'ana@ex.com'
    });
    assert.equal(envoi.body.record.antenneId, 'sud', 'le courrier suit la boîte, pas le poste');
  });
});

test('un accès limité à une antenne ne reçoit rien des autres', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', {
      name: 'Akram', email: 'akram@bureau.org', password: 'mot-de-passe-long'
    });
    await t.call('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      antennes: [{ id: 'nord', nom: 'Nord' }, { id: 'sud', nom: 'Sud' }]
    });
    const nord = (await t.call('POST', '/api/contacts', { name: 'Nordiste', email: 'n@ex.com', antenneId: 'nord' })).body;
    const sud = (await t.call('POST', '/api/contacts', { name: 'Sudiste', email: 's@ex.com', antenneId: 'sud' })).body;
    await t.call('POST', '/api/notify', { contactId: nord.id, name: 'Nordiste', email: 'n@ex.com' });
    await t.call('POST', '/api/notify', { contactId: sud.id, name: 'Sudiste', email: 's@ex.com' });

    // Le responsable voit tout.
    const tout = await t.call('GET', '/api/state');
    assert.equal(tout.body.contacts.length, 2);
    assert.equal(tout.body.history.length, 2);

    // Un agent rattaché au sud ne voit que le sud.
    const acces = (await t.call('POST', '/api/auth/agents', { name: 'Sud', antenneId: 'sud' })).body;
    assert.equal(acces.agent.identifiant.length, 7);

    const jarAgent = { cookie: '' };
    const commeAgent = async function (method, url, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (jarAgent.cookie) headers.Cookie = jarAgent.cookie;
      const res = await fetch(t.base + url, {
        method: method, headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const sc = res.headers.get('set-cookie');
      if (sc) jarAgent.cookie = sc.split(';')[0];
      return { status: res.status, body: await res.json().catch(function () { return null; }) };
    };
    await commeAgent('POST', '/api/auth/login-code', {
      identifiant: acces.agent.identifiant, code: acces.code
    });

    const vu = await commeAgent('GET', '/api/state');
    assert.equal(vu.body.contacts.length, 1);
    assert.equal(vu.body.contacts[0].name, 'Sudiste');
    assert.equal(vu.body.history.length, 1);
    assert.ok(!JSON.stringify(vu.body).includes('Nordiste'), 'rien du nord ne transite par ce poste');
  });
});
