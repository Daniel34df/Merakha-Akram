'use strict';

/* Les casiers, côté serveur.

   Le module `assets/js/boites.js` calcule ; ces tests-ci vérifient ce que le
   serveur en fait — les droits, l'antenne, l'écriture, et surtout les deux
   promesses qui ne tiennent qu'ici :

     · **deux postes ne peuvent pas obtenir le même numéro** (§5). C'est la
       raison d'être de l'attribution côté serveur, et ça ne se voit que sur un
       vrai serveur, avec deux requêtes parties ensemble ;
     · **le miroir est tenu** : le titulaire courant d'une boîte porte le
       numéro de cette boîte sur sa fiche, toujours. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const B = require('../assets/js/boites.js');
const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createServer } = require('../server/app.js');

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-casiers-'));
  const fichier = path.join(dir, 'db.json');
  const db = new Db(fichier);
  await db.load();
  const server = createServer({
    db: db, mailer: createMailer({ MAIL_DRY_RUN: 'true' }),
    rootDir: path.join(__dirname, '..'), verifyEmail: false
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const jar = { cookie: '' };
  const call = async function (method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (jar.cookie) headers.Cookie = jar.cookie;
    const res = await fetch(base + url, {
      method: method, headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const b = res.headers.get('set-cookie');
    if (b) jar.cookie = b.split(';')[0];
    const texte = await res.text();
    let json = null;
    try { json = JSON.parse(texte); } catch (e) { json = texte; }
    return { status: res.status, body: json };
  };
  try {
    await run({ call: call, db: db, fichier: fichier, base: base, jar: jar });
  } finally {
    await new Promise(function (r) { server.close(r); });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const RESP = { name: 'Akram', email: 'responsable@bureau.org', password: 'mot-de-passe-du-bureau' };

/* ── la numérotation par le serveur ── */

test('le serveur attribue le prochain numéro libre', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    assert.equal((await t.call('POST', '/api/boites', {})).body.numero, 'B-001');
    assert.equal((await t.call('POST', '/api/boites', {})).body.numero, 'B-002');
    assert.equal((await t.call('POST', '/api/boites', {})).body.numero, 'B-003');
  });
});

test('deux postes qui demandent un casier en même temps n’obtiennent pas le même', function () {
  /* Le cœur du §5. Les deux requêtes partent sans `await` entre elles : si le
     numéro était calculé hors de l'écriture sérialisée, elles liraient le même
     plan et repartiraient toutes deux avec « B-001 ». */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const [a, b, c, d] = await Promise.all([
      t.call('POST', '/api/boites', {}),
      t.call('POST', '/api/boites', {}),
      t.call('POST', '/api/boites', {}),
      t.call('POST', '/api/boites', {})
    ]);
    const numeros = [a, b, c, d].map(function (r) { return r.body.numero; });
    assert.equal(new Set(numeros).size, 4, 'quatre numéros distincts, obtenus : ' + numeros.join(', '));
    assert.deepEqual(numeros.slice().sort(), ['B-001', 'B-002', 'B-003', 'B-004']);
  });
});

test('une série équipe le local d’un coup, et se rejoue sans doublon', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/boites/serie', { debut: 1, fin: 20, zone: 'Couloir A' });
    assert.equal(r.status, 201);
    assert.equal(r.body.creees, 20);

    // Rejouée, elle complète les trous plutôt que d'empiler des doublons.
    const encore = await t.call('POST', '/api/boites/serie', { debut: 1, fin: 25 });
    assert.equal(encore.body.creees, 5);
    assert.equal((await t.call('GET', '/api/boites')).body.length, 25);
  });
});

test('une série démesurée est refusée : c’est une faute de frappe, pas un local', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    assert.equal((await t.call('POST', '/api/boites/serie', { debut: 1, fin: 99999 })).status, 400);
  });
});

test('la plage épuisée le dit, au lieu d’inventer un casier', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    await t.call('PUT', '/api/settings', {
      subject: 'x', body: 'y', numerotation: { prefixe: 'B-', chiffres: 3, debut: 1, fin: 2 }
    });
    await t.call('POST', '/api/boites', {});
    await t.call('POST', '/api/boites', {});
    const trop = await t.call('POST', '/api/boites', {});
    assert.equal(trop.status, 409);
    assert.equal(trop.body.code, 'plage-epuisee');
  });
});

/* ── le miroir ── */

test('inscrire quelqu’un avec un numéro fait entrer le casier au plan', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const c = await t.call('POST', '/api/contacts', {
      name: 'Amina Diallo', telephone: '06 12 34 56 78', box: 'B-12'
    });
    assert.equal(c.status, 201);
    assert.equal(c.body.box, 'B-12', 'l’écriture de l’agent est respectée');

    const plan = (await t.call('GET', '/api/boites')).body;
    assert.equal(plan.length, 1);
    assert.equal(plan[0].numero, 'B-12');
    assert.equal(plan[0].statut, 'occupee');
    assert.equal(B.titulaireCourant(plan[0]).nom, 'Amina Diallo');
  });
});

test('deux écritures du même numéro ne font qu’un casier', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    await t.call('POST', '/api/contacts', { name: 'Amina', telephone: '06 00 00 00 01', box: 'B-012' });
    const y = await t.call('POST', '/api/contacts', { name: 'Yannick', telephone: '06 00 00 00 02', box: 'b12' });

    const plan = (await t.call('GET', '/api/boites')).body;
    assert.equal(plan.length, 1, '« B-012 » et « b12 » sont la même porte');
    assert.equal(B.titulaireCourant(plan[0]).nom, 'Yannick', 'le dernier arrivé occupe');
    assert.equal(y.body.box, 'B-012', 'et sa fiche prend l’orthographe du casier');
    assert.equal(plan[0].periodes.length, 2, 'le passage d’Amina reste au casier');
  });
});

test('changer le numéro sur une fiche libère l’ancien casier', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const c = (await t.call('POST', '/api/contacts', {
      name: 'Amina Diallo', telephone: '06 12 34 56 78', box: 'B-12'
    })).body;
    await t.call('PUT', '/api/contacts/' + c.id, {
      name: 'Amina Diallo', telephone: '06 12 34 56 78', box: 'B-20'
    });
    const plan = (await t.call('GET', '/api/boites')).body;
    const ancienne = plan.find(function (b) { return b.numero === 'B-12'; });
    const neuve = plan.find(function (b) { return b.numero === 'B-20'; });
    assert.equal(ancienne.statut, 'libre', 'sinon deux casiers restaient à son nom');
    assert.equal(B.titulaireCourant(neuve).contactId, c.id);
  });
});

test('le miroir tient : aucune incohérence après un parcours ordinaire', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const a = (await t.call('POST', '/api/contacts', { name: 'Amina', telephone: '06 00 00 00 01', box: 'B-12' })).body;
    await t.call('POST', '/api/contacts', { name: 'Yannick', telephone: '06 00 00 00 02', box: 'A-03' });
    await t.call('POST', '/api/contacts', { name: 'Sans casier', telephone: '06 00 00 00 03' });
    await t.call('PUT', '/api/contacts/' + a.id, { name: 'Amina', telephone: '06 00 00 00 01', box: 'C-01' });

    const plan = (await t.call('GET', '/api/boites')).body;
    const fiches = (await t.call('GET', '/api/contacts')).body;
    assert.deepEqual(B.incoherences(plan, fiches), []);
  });
});

/* ── attribuer, libérer ── */

test('attribuer met à jour le casier et la fiche dans le même geste', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const boite = (await t.call('POST', '/api/boites', {})).body;
    const c = (await t.call('POST', '/api/contacts', { name: 'Amina', telephone: '06 00 00 00 01' })).body;

    const r = await t.call('POST', '/api/boites/' + boite.id + '/attribuer', { contactId: c.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.contact.box, 'B-001');
    assert.equal(B.titulaireCourant(r.body.boite).contactId, c.id);
  });
});

test('libérer rend le casier et retire le numéro de la fiche', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const c = (await t.call('POST', '/api/contacts', {
      name: 'Amina', telephone: '06 00 00 00 01', box: 'B-12'
    })).body;
    const boite = (await t.call('GET', '/api/boites')).body[0];

    const r = await t.call('POST', '/api/boites/' + boite.id + '/liberer', { motif: 'relogée' });
    assert.equal(r.status, 200);
    assert.equal(r.body.statut, 'libre');
    assert.equal(r.body.periodes[0].nom, 'Amina', 'son passage reste au casier');
    assert.equal(r.body.periodes[0].motif, 'relogée');

    const fiche = (await t.call('GET', '/api/contacts')).body.find(function (x) { return x.id === c.id; });
    assert.equal(fiche.box, '', 'la fiche ne garde pas un numéro qu’elle n’occupe plus');
  });
});

test('sortir quelqu’un du registre rend son casier', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const c = (await t.call('POST', '/api/contacts', {
      name: 'Amina', telephone: '06 00 00 00 01', box: 'B-12'
    })).body;
    await t.call('DELETE', '/api/contacts/' + c.id);

    const plan = (await t.call('GET', '/api/boites')).body;
    assert.equal(plan[0].statut, 'libre', 'sinon le casier restait pris par une fiche disparue');
    assert.equal(plan[0].periodes[0].nom, 'Amina');
  });
});

test('un effacement complet ne laisse pas le nom dans l’historique du casier', function () {
  /* §46 : effacer ne doit rien laisser. Un nom oublié dans une période de
     boîte suffirait à retrouver quelqu'un qui a demandé à disparaître. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const c = (await t.call('POST', '/api/contacts', {
      name: 'Amina Diallo', telephone: '06 12 34 56 78', box: 'B-12'
    })).body;
    await t.call('DELETE', '/api/contacts/' + c.id + '?effacer=complet');

    const plan = (await t.call('GET', '/api/boites')).body;
    assert.ok(!JSON.stringify(plan).includes('Amina'), 'le nom ne doit rester nulle part');
    assert.equal(plan[0].periodes[0].nom, 'personne effacée');
    assert.equal(plan[0].statut, 'libre');
  });
});

/* ── les statuts, et ce qui ne se supprime pas ── */

test('un casier se met hors service avec son motif', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const b = (await t.call('POST', '/api/boites', {})).body;
    const r = await t.call('PUT', '/api/boites/' + b.id, { statut: 'horsservice', motif: 'serrure cassée' });
    assert.equal(r.body.statut, 'horsservice');
    assert.equal(r.body.motif, 'serrure cassée');
    assert.equal(B.estLibre(r.body), false, 'hors service n’est pas libre');
  });
});

test('un casier occupé ne se déclare pas « libre » d’un trait de plume', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    await t.call('POST', '/api/contacts', { name: 'Amina', telephone: '06 00 00 00 01', box: 'B-12' });
    const b = (await t.call('GET', '/api/boites')).body[0];
    const r = await t.call('PUT', '/api/boites/' + b.id, { statut: 'libre' });
    assert.equal(r.body.statut, 'occupee', 'il faut le libérer, ce qui clôt la période');
  });
});

test('un casier qui a un passé ne se supprime pas', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const c = (await t.call('POST', '/api/contacts', {
      name: 'Amina', telephone: '06 00 00 00 01', box: 'B-12'
    })).body;
    const b = (await t.call('GET', '/api/boites')).body[0];
    await t.call('POST', '/api/boites/' + b.id + '/liberer', {});

    const r = await t.call('DELETE', '/api/boites/' + b.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'casier-occupe');
  });
});

test('un casier neuf et libre se retire du plan', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const b = (await t.call('POST', '/api/boites', {})).body;
    assert.equal((await t.call('DELETE', '/api/boites/' + b.id)).status, 200);
    assert.equal((await t.call('GET', '/api/boites')).body.length, 0);
  });
});

/* ── les droits ── */

test('sans le droit « casiers », on ne touche pas au plan', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const agent = (await t.call('POST', '/api/auth/agents', {
      name: 'Agent sans casiers',
      permissions: { guichet: true, remise: true, casiers: false, registre: false }
    })).body;
    await t.call('POST', '/api/auth/logout');
    await t.call('POST', '/api/auth/login-code', {
      identifiant: agent.identifiant || agent.agent && agent.agent.identifiant,
      code: agent.code || (agent.agent && agent.agent.code)
    });
    const r = await t.call('POST', '/api/boites', {});
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'droit');
  });
});

/* ── les réglages ── */

test('le schéma de numérotation survit à un enregistrement des réglages', function () {
  /* Le piège : la sauvegarde des réglages reconstruit l'objet depuis les
     valeurs d'usine. Sans une ligne pour le reporter, un bureau qui numérote
     « A-01 » retrouvait « B-001 » après avoir corrigé une virgule ailleurs. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    await t.call('PUT', '/api/settings', {
      subject: 'x', body: 'y',
      numerotation: { prefixe: 'A-', chiffres: 2, debut: 1, fin: 60, reutiliser: false }
    });
    // Un enregistrement qui ne parle pas de numérotation ne doit pas l'effacer.
    await t.call('PUT', '/api/settings', { subject: 'autre chose', body: 'z' });

    const s = (await t.call('GET', '/api/settings')).body;
    assert.equal(s.numerotation.prefixe, 'A-');
    assert.equal(s.numerotation.chiffres, 2);
    assert.equal(s.numerotation.reutiliser, false);
    assert.equal((await t.call('POST', '/api/boites', {})).body.numero, 'A-01');
  });
});

/* ── la migration ── */

test('un registre d’avant les casiers retrouve son plan au chargement', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    await t.call('POST', '/api/contacts', { name: 'Amina', telephone: '06 00 00 00 01', box: 'B-12' });
    await t.call('POST', '/api/contacts', { name: 'Yannick', telephone: '06 00 00 00 02', box: 'A-03' });
    await t.call('POST', '/api/contacts', { name: 'Sans casier', telephone: '06 00 00 00 03' });

    /* On efface le plan du fichier, comme s'il venait d'une version
       antérieure, et on relit. */
    const brut = JSON.parse(await fs.readFile(t.fichier, 'utf8'));
    delete brut.boites;
    await fs.writeFile(t.fichier, JSON.stringify(brut));

    const relu = new Db(t.fichier);
    await relu.load();
    assert.equal(relu.data.boites.length, 2, 'deux numéros distincts, la fiche sans boîte n’en crée pas');
    assert.deepEqual(relu.data.boites.map(function (b) { return b.numero; }), ['A-03', 'B-12']);
    assert.equal(B.titulaireCourant(relu.data.boites[1]).nom, 'Amina');
    assert.deepEqual(B.incoherences(relu.data.boites, relu.data.contacts), [],
      'et le miroir est cohérent dès la migration');
  });
});
