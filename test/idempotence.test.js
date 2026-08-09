'use strict';

/* Rejouer sans refaire.

   Le guichet travaille hors ligne : chaque écriture est mise de côté et
   rejouée quand le réseau revient. Le rejeu suppose que le serveur n'a rien
   reçu — or il a pu recevoir la requête, l'exécuter, et voir sa réponse se
   perdre. Le poste rejoue alors une opération déjà faite.

   Ce que ça donne au bureau : un passage compté deux fois sur une fiche de
   domiciliation — donc une échéance de radiation repoussée sur une visite qui
   n'a pas eu lieu — ou le même destinataire deux fois au registre, avec deux
   boîtes. Rien ne plante. C'est pour ça qu'il faut un test. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const idem = require('../server/idempotence.js');
const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createServer } = require('../server/app.js');

/* ────────────────────── le calcul, hors serveur ────────────────────── */

test('une clé venue d’un poste est vérifiée avant d’être crue', function () {
  assert.equal(idem.estCle('local-a1b2c3d4'), true);
  assert.equal(idem.estCle('7f3c9d20-1a2b-4c5d-8e9f-0a1b2c3d4e5f'), true);
  assert.equal(idem.estCle(''), false);
  assert.equal(idem.estCle('abc'), false, 'trop court pour être un identifiant');
  assert.equal(idem.estCle('a'.repeat(201)), false);
  assert.equal(idem.estCle('local a1b2'), false, 'pas d’espace');
  assert.equal(idem.estCle('../../etc/passwd'), false);
  assert.equal(idem.estCle(42), false);
  assert.equal(idem.estCle(null), false);
});

test('une lecture n’a pas de clé, même si le poste en envoie une', function () {
  const entetes = { 'x-operation-id': 'local-a1b2c3d4' };
  assert.equal(idem.lireCle({ method: 'POST', headers: entetes }), 'local-a1b2c3d4');
  assert.equal(idem.lireCle({ method: 'GET', headers: entetes }), null);
  assert.equal(idem.lireCle({ method: 'HEAD', headers: entetes }), null);
  assert.equal(idem.lireCle({ method: 'POST', headers: {} }), null);
  // Un en-tête envoyé deux fois arrive en tableau : on ne devine pas lequel.
  assert.equal(idem.lireCle({ method: 'POST', headers: { 'x-operation-id': ['a', 'b'] } }), null);
});

test('seule une opération qui a abouti est retenue', function () {
  const r = [];
  assert.equal(idem.noter(r, 'local-aaaa1111', { status: 201, id: 'x' }), true);
  assert.equal(idem.noter(r, 'local-bbbb2222', { status: 400 }), false, 'un refus se reproduira tout seul');
  assert.equal(idem.noter(r, 'local-cccc3333', { status: 500 }), false, 'une panne n’a rien laissé à ne pas refaire');
  assert.equal(idem.noter(r, 'local-dddd4444', { status: 302 }), false);
  assert.equal(r.length, 1);
});

test('le premier résultat ne se laisse pas écraser par le second', function () {
  const r = [];
  idem.noter(r, 'local-aaaa1111', { status: 201, id: 'le-vrai' });
  idem.noter(r, 'local-aaaa1111', { status: 200, id: 'un-autre' });
  assert.equal(r.length, 1);
  assert.equal(idem.retrouver(r, 'local-aaaa1111').id, 'le-vrai');
});

test('une entrée ne retient rien de ce qu’il y avait dans la réponse', function () {
  /* Le registre s'écrit dans le fichier du bureau, qui part en sauvegarde et
     se copie sur une clé. Il contiendrait sinon les noms, les dates de
     naissance et les téléphones de gens sans logement — parfois de gens qui se
     cachent de quelqu'un. Une clé, une heure, un code, un identifiant. */
  const r = [];
  idem.noter(r, 'local-aaaa1111', { status: 201, id: idem.extraireId({ contact: { id: 'c1', name: 'Amina Diallo', telephone: '06 12 34 56 78' } }) });
  assert.deepEqual(Object.keys(r[0]).sort(), ['at', 'cle', 'id', 'status']);
  assert.ok(JSON.stringify(r).indexOf('Amina') < 0);
  assert.ok(JSON.stringify(r).indexOf('06 12') < 0);
});

test('l’identifiant se lit sous ses trois formes', function () {
  assert.equal(idem.extraireId({ contact: { id: 'c1' } }), 'c1');
  assert.equal(idem.extraireId({ record: { id: 'h1' } }), 'h1');
  assert.equal(idem.extraireId({ id: 'x1', name: 'X' }), 'x1');
  assert.equal(idem.extraireId({ ok: true }), null);
  assert.equal(idem.extraireId(null), null);
});

test('au-delà d’une semaine, une opération est oubliée', function () {
  const t = Date.parse('2026-08-09T12:00:00Z');
  const r = [];
  idem.noter(r, 'local-vieille1', { status: 200 }, t);
  idem.noter(r, 'local-recente1', { status: 200 }, t + 6 * 24 * 3600 * 1000);
  idem.purger(r, t + 8 * 24 * 3600 * 1000);
  assert.equal(idem.retrouver(r, 'local-vieille1'), null);
  assert.ok(idem.retrouver(r, 'local-recente1'));
});

test('le registre est borné : les plus anciennes partent d’abord', function () {
  const r = [];
  for (let i = 0; i < idem.MAX + 50; i++) idem.noter(r, 'local-' + String(i).padStart(6, '0'), { status: 200 });
  assert.equal(r.length, idem.MAX);
  assert.equal(idem.retrouver(r, 'local-000000'), null, 'la plus ancienne a cédé la place');
  assert.ok(idem.retrouver(r, 'local-002049'), 'la plus récente est là');
});

test('une entrée abîmée dans le fichier ne fait pas tomber la lecture', function () {
  const r = [null, { cle: 'x' }, { cle: 'local-bonne1', at: 'pas une date', status: 200 }, { cle: 'local-bonne2', at: new Date().toISOString(), status: 200 }];
  idem.purger(r, Date.now());
  assert.equal(r.length, 1);
  assert.equal(r[0].cle, 'local-bonne2');
});

test('le rejeu ne renvoie que ce qu’il faut pour recoller les identifiants', function () {
  assert.deepEqual(idem.reponseRejeu({ cle: 'k', status: 201, id: 'c1' }), { rejoue: true, id: 'c1' });
  assert.deepEqual(idem.reponseRejeu({ cle: 'k', status: 200, id: null }), { rejoue: true });
});

/* ────────────────────── le serveur, pour de vrai ────────────────────── */

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-idem-'));
  const fichier = path.join(dir, 'db.json');
  const db = new Db(fichier);
  await db.load();
  const server = createServer({
    db: db,
    mailer: createMailer({ MAIL_DRY_RUN: 'true' }),
    rootDir: path.join(__dirname, '..')
  });
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  /* `operation` est la seule différence avec le client des autres tests : le
     poste envoie l'identifiant de son intention, et ne le change pas au rejeu. */
  const call = async function (method, url, body, operation) {
    const headers = { 'Content-Type': 'application/json' };
    if (operation) headers['X-Operation-Id'] = operation;
    const res = await fetch(base + url, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const texte = await res.text();
    let json = null;
    try {
      json = JSON.parse(texte);
    } catch (e) {
      json = texte;
    }
    return { status: res.status, body: json };
  };

  try {
    await run({ call: call, db: db, fichier: fichier });
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('la même création rejouée ne crée qu’un destinataire', function () {
  return withServer(async function (t) {
    const un = await t.call('POST', '/api/contacts', { name: 'Amina Diallo', telephone: '06 12 34 56 78' }, 'local-a1b2c3d4');
    assert.equal(un.status, 201);
    assert.ok(un.body.id);

    const deux = await t.call('POST', '/api/contacts', { name: 'Amina Diallo', telephone: '06 12 34 56 78' }, 'local-a1b2c3d4');
    assert.equal(deux.status, 201, 'le rejeu rend le premier résultat, pas une erreur');
    assert.equal(deux.body.rejoue, true);
    assert.equal(deux.body.id, un.body.id, 'le même identifiant : c’est ce qui permet de recoller la file');

    const liste = (await t.call('GET', '/api/contacts')).body;
    assert.equal(liste.length, 1, 'une seule Amina Diallo au registre');
  });
});

test('la réponse d’un rejeu ne contient aucune donnée personnelle', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/contacts', { name: 'Amina Diallo', telephone: '06 12 34 56 78' }, 'local-a1b2c3d4');
    const rejeu = await t.call('POST', '/api/contacts', { name: 'Amina Diallo' }, 'local-a1b2c3d4');
    assert.deepEqual(Object.keys(rejeu.body).sort(), ['id', 'rejoue']);
  });
});

test('le même passage rejoué ne repousse pas deux fois la radiation', function () {
  return withServer(async function (t) {
    /* Un passage inscrit deux fois n'ajoute pas seulement une ligne : il fait
       croire que la personne s'est manifestée deux fois. Le décompte des
       absences est ce qui décide d'une radiation, donc de la perte de
       l'adresse qui ouvre la CAF et l'assurance maladie. */
    const c = (await t.call('POST', '/api/contacts', { name: 'Yannick Mbala', telephone: '07 00 00 00 00' })).body;
    await t.call('POST', '/api/contacts/' + c.id + '/passage', { moyen: 'place' }, 'local-p1p2p3p4');
    await t.call('POST', '/api/contacts/' + c.id + '/passage', { moyen: 'place' }, 'local-p1p2p3p4');

    const fiche = (await t.call('GET', '/api/contacts')).body.find(function (x) {
      return x.id === c.id;
    });
    assert.equal(fiche.passages.length, 1);
  });
});

test('le même courrier rejoué n’entre qu’une fois au registre', function () {
  return withServer(async function (t) {
    const c = (await t.call('POST', '/api/contacts', { name: 'Śarah', telephone: '07 11 11 11 11' })).body;
    const un = await t.call('POST', '/api/history', { contactId: c.id, name: 'Śarah', subject: 'Un courrier' }, 'local-h1h2h3h4');
    assert.ok(un.status < 300, 'la première fois passe (' + un.status + ')');
    const deux = await t.call('POST', '/api/history', { contactId: c.id, name: 'Śarah', subject: 'Un courrier' }, 'local-h1h2h3h4');
    assert.equal(deux.status, un.status);
    assert.equal(deux.body.rejoue, true);
    assert.equal((await t.call('GET', '/api/history')).body.length, 1);
  });
});

test('deux intentions distinctes restent deux écritures', function () {
  return withServer(async function (t) {
    /* Le garde-fou ne doit pas devenir un bouchon : deux courriers pour la
       même personne le même jour, c'est ordinaire. */
    const c = (await t.call('POST', '/api/contacts', { name: 'Deux Fois', telephone: '07 22 22 22 22' })).body;
    await t.call('POST', '/api/contacts/' + c.id + '/passage', {}, 'local-p0000001');
    await t.call('POST', '/api/contacts/' + c.id + '/passage', {}, 'local-p0000002');
    const fiche = (await t.call('GET', '/api/contacts')).body.find(function (x) {
      return x.id === c.id;
    });
    assert.equal(fiche.passages.length, 2);
  });
});

test('sans clé, rien ne change : l’application ordinaire n’est pas dédoublonnée', function () {
  return withServer(async function (t) {
    const c = (await t.call('POST', '/api/contacts', { name: 'Sans Clé', telephone: '07 33 33 33 33' })).body;
    await t.call('POST', '/api/contacts/' + c.id + '/passage', {});
    await t.call('POST', '/api/contacts/' + c.id + '/passage', {});
    const fiche = (await t.call('GET', '/api/contacts')).body.find(function (x) {
      return x.id === c.id;
    });
    assert.equal(fiche.passages.length, 2, 'deux passages saisis à la main sont deux passages');
  });
});

test('une clé brûlée par un refus reste utilisable', function () {
  return withServer(async function (t) {
    /* Le poste rejoue son intention ; le serveur la refuse pour une raison
       passagère — puis la même intention, corrigée, doit pouvoir aboutir. Si
       le refus avait été inscrit, cette écriture-là serait perdue pour de bon. */
    const refus = await t.call('POST', '/api/contacts', { name: '' }, 'local-r1r2r3r4');
    assert.equal(refus.status, 400);
    const bon = await t.call('POST', '/api/contacts', { name: 'Rattrapée', telephone: '07 44 44 44 44' }, 'local-r1r2r3r4');
    assert.equal(bon.status, 201);
    assert.ok(bon.body.id);
    assert.notEqual(bon.body.rejoue, true);
  });
});

test('inscrire une opération ne fait pas recharger les autres postes', function () {
  return withServer(async function (t) {
    /* Chaque écriture annoncée déclenche, sur chaque poste du bureau, un
       rechargement complet du registre par le flux. Le registre des opérations
       n'est affiché nulle part : l'annoncer ferait travailler quatre postes
       pour une ligne que personne ne regarde. */
    const compter = async function (cle) {
      let vus = 0;
      const stop = t.db.surEcriture(function () {
        vus++;
      });
      await t.call('POST', '/api/contacts', { name: 'Poste ' + (cle || 'sans clé'), telephone: '07 66 66 66 66' }, cle);
      await t.db.write(function () {}); // laisse passer l'écriture différée
      stop();
      return vus - 1; // l'écriture vide de la ligne précédente
    };
    const sans = await compter(null);
    const avec = await compter('local-n1n2n3n4');
    assert.equal(avec, sans, 'une écriture de plus sur le disque, pas une annonce de plus');
  });
});

test('le registre des opérations survit au redémarrage du serveur', function () {
  return withServer(async function (t) {
    /* C'est le cas qui compte le plus : la coupure réseau et le redémarrage du
       serveur arrivent ensemble, parce que c'est la même panne. */
    await t.call('POST', '/api/contacts', { name: 'Persistante', telephone: '07 55 55 55 55' }, 'local-s1s2s3s4');
    /* L'inscription au registre se fait au moment où la réponse part ; le
       fichier suit, dans la file d'écriture. Une écriture vide attend son
       tour derrière : quand elle a rendu la main, tout est sur le disque. */
    await t.db.write(function () {});
    const relu = new Db(t.fichier);
    await relu.load();
    assert.ok(idem.retrouver(relu.data.operations, 'local-s1s2s3s4'));
    assert.equal(relu.data.contacts.length, 1);
  });
});
