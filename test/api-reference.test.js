'use strict';

/* La référence de courrier, côté serveur.

   `assets/js/reference.js` calcule ; ces tests-ci vérifient ce que le serveur
   en fait. Une promesse ne tient qu'ici, et c'est la seule qui compte
   vraiment : **deux postes qui inscrivent un courrier au même instant
   n'obtiennent pas la même référence.** Elle ne se voit pas dans un test
   unitaire — il faut un vrai serveur et deux requêtes parties ensemble.

   Si elle tombe, deux courriers de deux personnes portent COUR-2026-000017, et
   la référence ne veut plus rien dire au moment précis où on s'en sert : au
   téléphone, six mois plus tard. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const R = require('../assets/js/reference.js');
const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createServer } = require('../server/app.js');

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-reference-'));
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
    await run({ call: call, db: db, fichier: fichier });
  } finally {
    await new Promise(function (r) { server.close(r); });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const RESP = { name: 'Akram', email: 'responsable@bureau.org', password: 'mot-de-passe-du-bureau' };

test('un courrier inscrit repart avec sa référence', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/history', { name: 'Jean Dupont' });
    assert.equal(r.status, 201);
    assert.equal(r.body.reference, 'COUR-' + new Date().getFullYear() + '-000001');
    assert.ok(R.estReference(r.body.reference));
  });
});

test('les références se suivent, et l’année en cours fait foi', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const a = await t.call('POST', '/api/history', { name: 'Un' });
    const b = await t.call('POST', '/api/history', { name: 'Deux' });
    const c = await t.call('POST', '/api/history', { name: 'Trois' });
    assert.deepEqual(
      [a, b, c].map(function (x) { return R.lire(x.body.reference).numero; }),
      [1, 2, 3]
    );
    assert.equal(R.lire(a.body.reference).annee, new Date().getFullYear());
  });
});

test('deux postes qui inscrivent en même temps n’obtiennent pas la même référence', function () {
  /* C'est **la** raison pour laquelle la référence se calcule dans le mutateur
     de `db.write` et pas trois lignes plus haut. Déplacer ce calcul hors du
     mutateur fait tomber ce test, et lui seul. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const envois = [];
    for (let i = 0; i < 8; i++) {
      /* Sans `await` entre les envois : les huit requêtes sont en vol
         ensemble, comme huit postes du bureau un lundi matin. */
      envois.push(t.call('POST', '/api/history', { name: 'Personne ' + i }));
    }
    const reponses = await Promise.all(envois);
    const refs = reponses.map(function (r) { return r.body.reference; });
    assert.equal(new Set(refs).size, 8, 'huit courriers, huit références : ' + refs.join(' '));
    assert.deepEqual(
      refs.map(function (x) { return R.lire(x).numero; }).sort(function (a, b) { return a - b; }),
      [1, 2, 3, 4, 5, 6, 7, 8]
    );
  });
});

test('un courrier à annoncer par téléphone porte une référence, comme les autres', function () {
  /* Les trois sorties de `/api/notify` inscrivent le courrier. Celle-ci est la
     plus facile à oublier — et c'est celle du public sans courriel, qui est
     précisément le public de ce bureau. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/notify', { name: 'Sans Courriel', email: '' });
    assert.equal(r.status, 200);
    assert.equal(r.body.aPrevenir, true);
    assert.ok(R.estReference(r.body.record.reference), 'référence : ' + r.body.record.reference);
  });
});

test('la référence est écrite sur disque et survit à un redémarrage', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/history', { name: 'Jean Dupont' });
    const relu = new Db(t.fichier);
    await relu.load();
    assert.equal(relu.data.history[0].reference, r.body.reference);
  });
});

test('le préfixe choisi par le bureau tient, et n’est pas remis à COUR au premier réglage sauvé', function () {
  /* Les réglages se reconstruisent depuis les valeurs d'usine à chaque
     enregistrement. Un champ oublié là repart au défaut sans que personne ne
     s'en aperçoive — et les courriers du lendemain ne portent plus le même
     préfixe que ceux de la veille. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    /* Le sujet et le corps sont obligatoires sur cette route : les réglages
       s'enregistrent d'un bloc, gabarit compris. */
    const base = { subject: 'Un courrier vous attend', body: 'Bonjour {{nom}},' };
    const s = await t.call('PUT', '/api/settings', Object.assign({}, base, { referencePrefixe: 'créteil' }));
    assert.equal(s.body.referencePrefixe, 'CRETEI', 'accents ôtés, six lettres au plus');

    const r = await t.call('POST', '/api/history', { name: 'Jean Dupont' });
    assert.equal(R.lire(r.body.reference).prefixe, 'CRETEI');

    /* Un deuxième enregistrement qui ne parle pas du préfixe ne doit pas le
       perdre. */
    const encore = await t.call('PUT', '/api/settings', Object.assign({}, base, { officeName: 'Bureau de Créteil' }));
    assert.equal(encore.body.referencePrefixe, 'CRETEI');
  });
});

/* ── le colis ── */

test('les détails d’un colis survivent à l’aller-retour et au redémarrage', function () {
  /* Un colis encombrant dont l'emplacement se perd en route reste au registre
     avec son code de retrait, et devient introuvable pour tout le monde sauf
     pour celui qui l'a posé. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/history', {
      name: 'Jean Dupont',
      type: 'colis',
      colis: {
        poids: '12,5', longueur: 60, largeur: 40, hauteur: 30,
        suivi: '6a 1234 5678 9fr', emplacement: '  étagère du fond  '
      }
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.colis.poids, 12.5, 'la virgule décimale est lue');
    assert.equal(r.body.colis.suivi, '6A123456789FR', 'le numéro est normalisé');
    assert.equal(r.body.colis.transporteur, 'colissimo', 'deviné du numéro');
    assert.equal(r.body.colis.emplacement, 'étagère du fond');

    const relu = new Db(t.fichier);
    await relu.load();
    assert.deepEqual(relu.data.history[0].colis, r.body.colis);
  });
});

test('un courrier ordinaire ne porte pas de colis vide', function () {
  /* Un objet vide laisserait croire que quelqu'un a rempli quelque chose. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/history', { name: 'Jean Dupont' });
    assert.equal(r.body.colis, null);
    const vide = await t.call('POST', '/api/history', {
      name: 'Jean Dupont', type: 'colis', colis: { poids: '', suivi: '  ' }
    });
    assert.equal(vide.body.colis, null);
  });
});

/* ── ce qu'un courrier inscrit directement ne doit pas perdre ── */

test('l’urgence et l’antenne survivent à une inscription directe', function () {
  /* `/api/notify` les gardait ; `POST /api/history` les perdait. Un courrier
     saisi sans notification — ou rejoué depuis la file hors ligne — repartait
     donc sans son urgence, et l'urgence n'est pas décorative : elle raccourcit
     le délai de relance. Un recommandé signalé urgent redevenait une lettre
     ordinaire, sans que personne s'en aperçoive. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/history', {
      name: 'Jean Dupont', urgent: true, telephone: '06 12 34 56 78'
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.urgent, true);
    assert.equal(r.body.telephone, '06 12 34 56 78',
      'le numéro doit être sous les yeux de l’agent au moment d’appeler');

    const relu = new Db(t.fichier);
    await relu.load();
    assert.equal(relu.data.history[0].urgent, true);
  });
});

test('un courrier ordinaire n’est pas urgent par accident', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/history', { name: 'Jean Dupont' });
    assert.equal(r.body.urgent, false);
  });
});

/* ── les étiquettes ── */

test('les étiquettes sont normalisées par le serveur, pas seulement à l’écran', function () {
  /* Deux postes qui écrivent « Tutelle » et « tutelle » doivent aboutir à la
     même étiquette. Sinon le filtre en trouve deux et l'agent croit à deux
     situations différentes — ce qui est pire que pas d'étiquettes du tout,
     parce qu'il croira avoir cherché. Un import de fichier passe aussi par là,
     et lui ne passe par aucun écran. */
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/contacts', {
      name: 'Amina Diallo', telephone: '06 12 34 56 78',
      etiquettes: 'Tutelle, Suivi Social, tutelle'
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.etiquettes, ['tutelle', 'suivi-social'],
      'normalisées et dédoublonnées');

    const relu = new Db(t.fichier);
    await relu.load();
    assert.deepEqual(relu.data.contacts[0].etiquettes, ['tutelle', 'suivi-social']);
  });
});

test('une fiche sans étiquette en porte une liste vide, pas un champ absent', function () {
  return withServer(async function (t) {
    await t.call('POST', '/api/auth/signup', RESP);
    const r = await t.call('POST', '/api/contacts', { name: 'Marc Petit', telephone: '0700000000' });
    assert.deepEqual(r.body.etiquettes, []);
  });
});
