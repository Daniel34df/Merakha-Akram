'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const roles = require('../assets/js/roles.js');

const RESPONSABLE = { id: 'r1', role: 'responsable', name: 'Akram' };
const agent = p => ({ id: 'a1', role: 'agent', name: 'Agent', permissions: p });

test('le responsable peut tout, sans table d’autorisations', function () {
  assert.equal(roles.estResponsable(RESPONSABLE), true);
  roles.DROITS.forEach(function (d) {
    assert.equal(roles.peut(RESPONSABLE, d.id), true, d.id);
  });
});

test('un agent tout neuf tient le guichet, sans voir les codes', function () {
  const a = agent(undefined);
  assert.equal(roles.peut(a, 'guichet'), true);
  assert.equal(roles.peut(a, 'remise'), true);
  assert.equal(roles.peut(a, 'codes'), false, 'c’est la règle qui motive tout le module');
  assert.equal(roles.peut(a, 'registre'), false);
  assert.equal(roles.peut(a, 'reglages'), false);
});

test('les autorisations se règlent une par une', function () {
  const a = agent({ codes: true, registre: true, reglages: false });
  assert.equal(roles.peut(a, 'codes'), true);
  assert.equal(roles.peut(a, 'registre'), true);
  assert.equal(roles.peut(a, 'reglages'), false);
});

test('personne sans compte ne peut rien', function () {
  roles.DROITS.forEach(function (d) {
    assert.equal(roles.peut(null, d.id), false);
  });
});

test('un droit inventé n’ouvre rien', function () {
  assert.equal(roles.peut(agent({ toutPouvoir: true }), 'toutPouvoir'), false);
  assert.equal(roles.nettoyerPermissions({ toutPouvoir: true }).toutPouvoir, undefined);
});

test('nettoyerPermissions force les booléens et complète les manques', function () {
  const p = roles.nettoyerPermissions({ codes: 'oui', guichet: 0 });
  assert.equal(p.codes, true);
  assert.equal(p.guichet, false);
  assert.equal(p.reglages, false, 'les droits absents prennent la valeur par défaut');
  assert.deepEqual(Object.keys(p).sort(), roles.DROITS.map(function (d) { return d.id; }).sort());
});

/* ---------- masquage des codes de retrait ---------- */

const HISTORIQUE = [
  { id: 'h1', name: 'Ana', pickupCode: '4821' },
  { id: 'h2', name: 'Bo', pickupCode: '1234' },
  { id: 'h3', name: 'Cyd', pickupCode: null }
];

test('les codes sont retirés du contenu servi à un agent sans le droit', function () {
  const masque = roles.masquerCodes(HISTORIQUE, agent({ codes: false }));
  assert.equal(masque[0].pickupCode, '••••');
  assert.equal(masque[1].pickupCode, '••••');
  assert.equal(masque[0].codeMasque, true, 'on dit qu’un code existe, sans le donner');

  // Le chiffre lui-même ne doit apparaître nulle part dans la réponse.
  const texte = JSON.stringify(masque);
  assert.ok(!texte.includes('4821'), 'le code ne fuit pas dans la réponse');
  assert.ok(!texte.includes('1234'));
});

test('un courrier sans code reste sans code, pas masqué', function () {
  const masque = roles.masquerCodes(HISTORIQUE, agent({ codes: false }));
  assert.equal(masque[2].pickupCode, null);
  assert.equal(masque[2].codeMasque, false);
});

test('le responsable et l’agent autorisé voient les codes tels quels', function () {
  assert.equal(roles.masquerCodes(HISTORIQUE, RESPONSABLE), HISTORIQUE);
  assert.equal(roles.masquerCodes(HISTORIQUE, agent({ codes: true })), HISTORIQUE);
});

test('masquer ne modifie pas l’historique d’origine', function () {
  roles.masquerCodes(HISTORIQUE, agent({ codes: false }));
  assert.equal(HISTORIQUE[0].pickupCode, '4821', 'le registre du serveur est intact');
});

/* ---------- identifiants ---------- */

test('un identifiant est lisible et dictable', function () {
  const id = roles.genererIdentifiant();
  assert.match(id, /^[A-HJ-NP-Z]{2}-\d{4}$/);
  assert.ok(!/[IO]/.test(id.split('-')[0]), 'ni I ni O : on les confond avec 1 et 0');
  assert.equal(roles.identifiantValide(id), true);
});

test('les identifiants ne se répètent pas à l’usage', function () {
  const vus = new Set();
  for (let i = 0; i < 300; i++) vus.add(roles.genererIdentifiant());
  assert.ok(vus.size > 280, 'assez de variété pour un bureau');
});

test('la saisie d’un identifiant tolère la casse et les espaces', function () {
  assert.equal(roles.normaliserIdentifiant(' ab-1234 '), 'AB-1234');
  assert.equal(roles.identifiantValide('ab-1234'), true);
  assert.equal(roles.identifiantValide('AB1234'), false);
  assert.equal(roles.identifiantValide('AI-1234'), false, 'la lettre I est exclue');
  assert.equal(roles.identifiantValide(''), false);
});

test('un code d’accès compte six chiffres', function () {
  assert.equal(roles.codeAccesValide('123456'), true);
  assert.equal(roles.codeAccesValide('12345'), false);
  assert.equal(roles.codeAccesValide('12345a'), false);
  assert.equal(roles.codeAccesValide(''), false);
});

/* ---------- accès agents, par l'API ---------- */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createVault } = require('../server/secrets.js');
const { createServer } = require('../server/app.js');
const authSrv = require('../server/auth.js');

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-roles-'));
  const db = new Db(path.join(dir, 'db.json'));
  await db.load();
  await db.write(function (data) {
    data.masterCodeHash = authSrv.empreinteCodeMaitre();
  });
  const mailer = createMailer({ MAIL_DRY_RUN: 'true' });
  const server = createServer({
    db: db, mailer: mailer, vault: createVault({ secret: 'clé' }),
    verifyEmail: false, rootDir: path.join(__dirname, '..')
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + server.address().port;

  const session = function () {
    const jar = { cookie: '' };
    return async function (method, url, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (jar.cookie) headers.Cookie = jar.cookie;
      const res = await fetch(base + url, {
        method: method, headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const sc = res.headers.get('set-cookie');
      if (sc) jar.cookie = sc.split(';')[0];
      const texte = await res.text();
      let json;
      try { json = JSON.parse(texte); } catch (e) { json = texte; }
      return { status: res.status, body: json };
    };
  };

  try {
    await run({ patron: session(), agent: session(), db: db, base: base });
  } finally {
    await new Promise(function (r) { server.close(r); });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const PATRON = { name: 'Akram', email: 'akram@bureau.org', password: 'mot-de-passe-long' };

test('le premier compte créé est le responsable', function () {
  return withServer(async function (t) {
    const cree = await t.patron('POST', '/api/auth/signup', PATRON);
    assert.equal(cree.status, 201);
    assert.equal(cree.body.user.role, 'responsable');
    assert.equal(cree.body.user.permissions.codes, true, 'le responsable voit tout');
  });
});

test('le responsable crée un accès agent, avec identifiant et code', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = await t.patron('POST', '/api/auth/agents', { name: 'Accueil matin' });

    assert.equal(cree.status, 201);
    assert.match(cree.body.agent.identifiant, /^[A-HJ-NP-Z]{2}-\d{4}$/);
    assert.match(cree.body.code, /^\d{6}$/);
    assert.equal(cree.body.agent.permissions.codes, false, 'pas de codes de retrait par défaut');
    assert.equal(cree.body.agent.permissions.guichet, true);

    // Le code n'est conservé que haché : la liste ne le rend jamais.
    const liste = await t.patron('GET', '/api/auth/agents');
    assert.equal(liste.body.agents.length, 1);
    assert.equal(liste.body.agents[0].code, undefined);
    assert.ok(!JSON.stringify(t.db.data.users).includes(cree.body.code), 'le code n’est pas en clair au registre');
  });
});

test('l’agent entre avec son identifiant et son code', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;

    const entree = await t.agent('POST', '/api/auth/login-code', {
      identifiant: cree.agent.identifiant.toLowerCase(), // la casse est tolérée
      code: cree.code
    });
    assert.equal(entree.status, 200);
    assert.equal(entree.body.user.role, 'agent');
    assert.equal(entree.body.user.name, 'Accueil');

    const faux = await t.agent('POST', '/api/auth/login-code', {
      identifiant: cree.agent.identifiant, code: '000000'
    });
    assert.equal(faux.status, 401);
    assert.match(faux.body.error, /Identifiant ou code/);
  });
});

test('l’agent ne reçoit pas les codes de retrait', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const envoi = await t.patron('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const vraiCode = envoi.body.record.pickupCode;

    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', {
      identifiant: cree.agent.identifiant, code: cree.code
    });

    const etat = await t.agent('GET', '/api/state');
    assert.equal(etat.status, 200);
    assert.equal(etat.body.history[0].pickupCode, '••••');
    assert.equal(etat.body.history[0].codeMasque, true);
    assert.ok(!JSON.stringify(etat.body).includes(vraiCode), 'le code ne fuit nulle part dans la réponse');

    const hist = await t.agent('GET', '/api/history');
    assert.ok(!JSON.stringify(hist.body).includes(vraiCode));

    // Le responsable, lui, le voit.
    assert.equal((await t.patron('GET', '/api/state')).body.history[0].pickupCode, vraiCode);
  });
});

test('l’agent peut remettre un courrier avec le code présenté par la personne', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const code = (await t.patron('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' })).body.record.pickupCode;
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    // Il ne le découvre pas dans l'application, mais il peut s'en servir.
    const remise = await t.agent('POST', '/api/history/pickup-by-code', { code: code });
    assert.equal(remise.status, 200);
    assert.ok(remise.body.record.pickedUpAt);
  });
});

test('l’agent sans droit ne peut ni modifier le registre ni toucher aux réglages', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    const ajout = await t.agent('POST', '/api/contacts', { name: 'X', email: 'x@ex.com' });
    assert.equal(ajout.status, 403);
    assert.equal(ajout.body.code, 'droit', 'refus de droit, pas de session');

    assert.equal((await t.agent('PUT', '/api/settings', { subject: 'S', body: 'B' })).status, 403);
    assert.equal((await t.agent('GET', '/api/domiciliation')).status, 403);
    assert.equal((await t.agent('GET', '/api/auth/agents')).status, 403, 'un agent ne gère pas les accès');

    // Mais il tient le guichet.
    assert.equal((await t.agent('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' })).status, 200);
  });
});

test('le responsable ouvre ou ferme un droit à la volée', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });
    assert.equal((await t.agent('POST', '/api/contacts', { name: 'X', email: 'x@ex.com' })).status, 403);

    await t.patron('PUT', '/api/auth/agents/' + cree.agent.id, {
      permissions: { guichet: true, remise: true, registre: true, codes: true }
    });
    assert.equal((await t.agent('POST', '/api/contacts', { name: 'X', email: 'x@ex.com' })).status, 201);

    const envoi = await t.patron('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const etat = await t.agent('GET', '/api/state');
    assert.equal(etat.body.history[0].pickupCode, envoi.body.record.pickupCode, 'les codes sont désormais visibles');
  });
});

test('suspendre un accès ferme les sessions ouvertes', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });
    assert.equal((await t.agent('GET', '/api/state')).status, 200);

    await t.patron('PUT', '/api/auth/agents/' + cree.agent.id, { suspendu: true });
    assert.equal((await t.agent('GET', '/api/state')).status, 401, 'la session est tombée');

    const retour = await t.agent('POST', '/api/auth/login-code', {
      identifiant: cree.agent.identifiant, code: cree.code
    });
    assert.equal(retour.status, 403);
    assert.match(retour.body.error, /suspendu/);
  });
});

test('régénérer le code d’accès invalide l’ancien', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    const neuf = await t.patron('POST', '/api/auth/agents/' + cree.agent.id + '/code');
    assert.match(neuf.body.code, /^\d{6}$/);
    assert.notEqual(neuf.body.code, cree.code);
    assert.equal((await t.agent('GET', '/api/state')).status, 401, 'la session ouverte tombe');

    assert.equal(
      (await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code })).status,
      401,
      'l’ancien code ne vaut plus rien'
    );
    assert.equal(
      (await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: neuf.body.code })).status,
      200
    );
  });
});

test('supprimer un accès le ferme définitivement', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.patron('DELETE', '/api/auth/agents/' + cree.agent.id);

    assert.equal(
      (await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code })).status,
      401
    );
    assert.equal((await t.patron('GET', '/api/auth/agents')).body.agents.length, 0);
  });
});

/* ---------- code maître ---------- */

test('le code maître ouvre la reprise du compte responsable', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const anonyme = (function () {
      return async function (method, url, body) {
        const res = await fetch(t.base + url, {
          method: method, headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        const texte = await res.text();
        let json;
        try { json = JSON.parse(texte); } catch (e) { json = texte; }
        return { status: res.status, body: json };
      };
    })();

    // Sans le bon code, rien.
    assert.equal((await anonyme('POST', '/api/auth/master', { code: '000' })).status, 401);

    const vu = await anonyme('POST', '/api/auth/master', { code: authSrv.MASTER_CODE_DEFAUT, action: 'voir' });
    assert.equal(vu.status, 200);
    assert.equal(vu.body.responsable.email, PATRON.email);

    // Changer l'adresse.
    await anonyme('POST', '/api/auth/master', {
      code: authSrv.MASTER_CODE_DEFAUT, action: 'email', email: 'nouveau@bureau.org'
    });
    assert.equal(t.db.data.users[0].email, 'nouveau@bureau.org');

    // Changer le mot de passe : l'ancien ne vaut plus rien.
    await anonyme('POST', '/api/auth/master', {
      code: authSrv.MASTER_CODE_DEFAUT, action: 'password', password: 'un-tout-autre-mot-de-passe'
    });
    assert.equal(
      (await anonyme('POST', '/api/auth/login', { email: 'nouveau@bureau.org', password: PATRON.password })).status,
      401
    );
    assert.equal(
      (await anonyme('POST', '/api/auth/login', { email: 'nouveau@bureau.org', password: 'un-tout-autre-mot-de-passe' })).status,
      200
    );
  });
});

test('le code maître n’est jamais conservé en clair', function () {
  return withServer(async function (t) {
    const texte = JSON.stringify(t.db.data);
    assert.ok(!texte.includes(authSrv.MASTER_CODE_DEFAUT), 'seule l’empreinte est écrite');
    assert.match(t.db.data.masterCodeHash, /^scrypt\$/);
  });
});

test('supprimer le responsable rouvre l’installation sans toucher au registre', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await t.patron('POST', '/api/contacts', { name: 'Ana', email: 'ana@ex.com' });

    const res = await fetch(t.base + '/api/auth/master', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: authSrv.MASTER_CODE_DEFAUT, action: 'supprimer' })
    });
    assert.equal(res.status, 200);
    assert.equal(t.db.data.users.length, 0);
    assert.equal(t.db.data.contacts.length, 1, 'le registre n’est pas touché');
  });
});
