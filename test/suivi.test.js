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
