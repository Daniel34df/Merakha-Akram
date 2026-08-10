'use strict';

/* La signature du créateur, et ce qu'elle tient.

   Ces tests disent trois choses. Que le sceau ne se forge pas sans la clé
   privée — c'est tout l'intérêt d'Ed25519 sur une simple somme de contrôle.
   Qu'un fichier modifié se voit. Et surtout : qu'une compromission **ne
   détruit rien** et **ne ferme pas le guichet**.

   Ce dernier point est le plus important du fichier. Une protection de
   logiciel qui empêche de remettre son courrier à quelqu'un qui n'a pas de
   logement a coûté plus qu'elle n'a protégé. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('../server/signature.js');

/* Une paire de clés jetable : la vraie clé privée du créateur ne se trouve pas
   dans un dépôt, et surtout pas dans un fichier de test. */
const paire = crypto.generateKeyPairSync('ed25519');
const PRIVEE = paire.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIQUE = paire.publicKey.export({ type: 'spki', format: 'pem' });

const FICHIERS = {
  'server/app.js': 'const x = 1;',
  'assets/js/app.js': 'const y = 2;',
  'index.html': '<!doctype html>'
};

function manifeste(fichiers) {
  return S.sceller(
    S.construire({ version: '1.2.0', cree: '2026-08-10T00:00:00.000Z', fichiers: fichiers || FICHIERS }),
    PRIVEE
  );
}

function empreintes(fichiers) {
  const out = {};
  Object.keys(fichiers).forEach(function (c) { out[c] = S.empreinte(fichiers[c]); });
  return out;
}

/* ── le créateur ── */

test('le nom du créateur est porté par le module', function () {
  assert.equal(S.CREATEUR, 'AKRAM MERAKHA');
  assert.equal(S.construire({ version: '1.0.0', fichiers: {} }).createur, 'AKRAM MERAKHA');
});

test('une version a un identifiant lisible, dictable au téléphone', function () {
  const m = manifeste();
  assert.match(m.identifiant, /^BDC-1\.2\.0-[0-9a-f]{8}$/);
  assert.match(m.empreinte, /^[0-9a-f]{64}$/);
});

/* ── le sceau ── */

test('un manifeste scellé se vérifie avec la clé publique', function () {
  assert.equal(S.verifierSceau(manifeste(), PUBLIQUE), true);
});

test('le sceau ne se forge pas sans la clé privée', function () {
  /* C'est ce qui distingue cette signature d'une somme de contrôle : qui
     modifie un fichier peut recalculer une empreinte, il ne peut pas
     recalculer un sceau. */
  const autre = crypto.generateKeyPairSync('ed25519');
  const forge = S.sceller(
    S.construire({ version: '1.2.0', cree: '2026-08-10T00:00:00.000Z', fichiers: FICHIERS }),
    autre.privateKey.export({ type: 'pkcs8', format: 'pem' })
  );
  assert.equal(S.verifierSceau(forge, PUBLIQUE), false, 'une autre clé ne doit pas passer');
});

test('modifier le manifeste invalide son sceau', function () {
  const m = manifeste();
  const trafique = Object.assign({}, m, {
    fichiers: Object.assign({}, m.fichiers, { 'server/app.js': S.empreinte('const x = 666;') })
  });
  assert.equal(S.verifierSceau(trafique, PUBLIQUE), false);
});

test('l’ordre des clés ne change pas le sceau', function () {
  /* Un manifeste relu et réécrit par un autre outil ne doit pas devenir
     invalide pour une raison de mise en forme. */
  const m = manifeste();
  const remue = { sceau: m.sceau, fichiers: {}, version: m.version, cree: m.cree,
    algorithme: m.algorithme, application: m.application, createur: m.createur };
  Object.keys(m.fichiers).reverse().forEach(function (c) { remue.fichiers[c] = m.fichiers[c]; });
  assert.equal(S.verifierSceau(remue, PUBLIQUE), true);
});

test('un sceau absent, vide ou illisible rend faux, il ne jette pas', function () {
  /* Un fichier de signature abîmé ne doit pas empêcher le serveur de démarrer :
     le bureau ouvre à neuf heures. */
  assert.equal(S.verifierSceau(null, PUBLIQUE), false);
  assert.equal(S.verifierSceau({ sceau: 'pas du base64 !!' }, PUBLIQUE), false);
  assert.equal(S.verifierSceau(manifeste(), 'pas une clé'), false);
  assert.equal(S.verifierSceau(manifeste(), ''), false);
});

/* ── les fichiers ── */

test('des fichiers conformes sont dits conformes', function () {
  const v = S.verifierFichiers(manifeste(), empreintes(FICHIERS));
  assert.equal(v.intact, true);
  assert.deepEqual(v.ecarts, []);
});

test('un fichier modifié, disparu ou ajouté ne racontent pas la même histoire', function () {
  const m = manifeste();
  const lues = empreintes(FICHIERS);
  lues['server/app.js'] = S.empreinte('const x = 666;');
  delete lues['index.html'];
  lues['assets/js/porte-derobee.js'] = S.empreinte('// ...');

  const v = S.verifierFichiers(m, lues);
  assert.equal(v.intact, false);
  const par = {};
  v.ecarts.forEach(function (e) { par[e.quoi] = (par[e.quoi] || []).concat(e.chemin); });
  assert.deepEqual(par.modifie, ['server/app.js']);
  assert.deepEqual(par.disparu, ['index.html']);
  assert.deepEqual(par.ajoute, ['assets/js/porte-derobee.js'],
    'un fichier ajouté compte : c’est comme ça qu’on glisse du code');
});

/* ── le verdict ── */

test('tout en ordre : vérifiée, et rien de verrouillé', function () {
  const e = S.etat({ manifeste: manifeste(), clePublique: PUBLIQUE, lues: empreintes(FICHIERS) });
  assert.equal(e.etat, S.ETATS.ok);
  assert.equal(e.code, null);
  assert.equal(e.verrouille, false);
  assert.equal(e.createur, 'AKRAM MERAKHA');
});

test('sans manifeste, l’application marche et le dit', function () {
  /* Un dépôt cloné n'est pas une version publiée. Refuser de démarrer y
     rendrait le développement impossible, et ne protégerait personne. */
  const e = S.etat({ manifeste: null, clePublique: PUBLIQUE, version: '1.2.0' });
  assert.equal(e.etat, S.ETATS.nonSignee);
  assert.equal(e.code, 'SIGNATURE-002');
  assert.equal(e.verrouille, false);
});

test('sans clé publique embarquée, on ne prétend pas vérifier', function () {
  const e = S.etat({ manifeste: manifeste(), clePublique: '', lues: empreintes(FICHIERS) });
  assert.equal(e.etat, S.ETATS.nonSignee);
  assert.equal(e.code, 'SIGNATURE-000');
  assert.equal(e.verrouille, false);
});

test('un sceau invalide verrouille, avec le code du cahier des charges', function () {
  const autre = crypto.generateKeyPairSync('ed25519');
  const e = S.etat({
    manifeste: manifeste(), clePublique: autre.publicKey.export({ type: 'spki', format: 'pem' }),
    lues: empreintes(FICHIERS)
  });
  assert.equal(e.etat, S.ETATS.compromise);
  assert.equal(e.code, 'SECURITY-001');
  assert.equal(e.verrouille, true);
});

test('des fichiers modifiés verrouillent, et disent lesquels', function () {
  const lues = empreintes(FICHIERS);
  lues['assets/js/app.js'] = S.empreinte('// remplacé');
  const e = S.etat({ manifeste: manifeste(), clePublique: PUBLIQUE, lues: lues });
  assert.equal(e.etat, S.ETATS.compromise);
  assert.equal(e.code, 'INTEGRITY-001');
  assert.equal(e.verrouille, true);
  assert.deepEqual(e.ecarts, [{ chemin: 'assets/js/app.js', quoi: 'modifie' }]);
});

/* ── la révocation ── */

test('une révocation non signée ne révoque rien', function () {
  /* Sans cette règle, n'importe qui fermerait un bureau en déposant un
     fichier de trois lignes dans le dossier de l'application. */
  const r = S.verifierRevocation({ versions: ['1.2.0'], emise: '2026-08-10' }, PUBLIQUE);
  assert.equal(r.valide, false);
  assert.deepEqual(r.versions, []);
  assert.equal(S.estRevoquee(r, manifeste()), false);
});

test('une révocation signée par le créateur révoque bien la version visée', function () {
  const corps = JSON.stringify({ versions: ['1.2.0'], emise: '2026-08-10' });
  const liste = {
    versions: ['1.2.0'], emise: '2026-08-10',
    sceau: crypto.sign(null, Buffer.from(corps, 'utf8'), PRIVEE).toString('base64')
  };
  const r = S.verifierRevocation(liste, PUBLIQUE);
  assert.equal(r.valide, true);

  const e = S.etat({ manifeste: manifeste(), clePublique: PUBLIQUE, lues: empreintes(FICHIERS), revocation: r });
  assert.equal(e.etat, S.ETATS.revoquee);
  assert.equal(e.code, 'LICENCE-001');
  assert.equal(e.verrouille, true);
  assert.match(e.message, /données ne sont pas supprimées/);
});

test('une révocation qui ne vise pas cette version la laisse tranquille', function () {
  const corps = JSON.stringify({ versions: ['0.9.0'], emise: '2026-08-10' });
  const liste = {
    versions: ['0.9.0'], emise: '2026-08-10',
    sceau: crypto.sign(null, Buffer.from(corps, 'utf8'), PRIVEE).toString('base64')
  };
  const r = S.verifierRevocation(liste, PUBLIQUE);
  assert.equal(S.estRevoquee(r, manifeste()), false);
});

test('l’absence de liste de révocation ne révoque rien', function () {
  /* La liste est locale, jamais réclamée à un serveur. Une vérification en
     ligne ferait d'une panne de box une révocation, et fermerait le guichet un
     lundi matin pour une raison qui n'a rien à voir. */
  const e = S.etat({ manifeste: manifeste(), clePublique: PUBLIQUE, lues: empreintes(FICHIERS) });
  assert.equal(e.verrouille, false);
  assert.equal(S.estRevoquee(null, manifeste()), false);
  assert.equal(S.estRevoquee(undefined, manifeste()), false);
});

/* ── ce qui se ferme, et ce qui reste ouvert ──

   La partie du fichier qui compte le plus. */

test('le verrouillage ferme la configuration, les comptes, les exports et la restauration', function () {
  assert.equal(S.estSensible('PUT', '/api/settings'), true);
  assert.equal(S.estSensible('POST', '/api/auth/agents'), true);
  assert.equal(S.estSensible('DELETE', '/api/auth/users/u1'), true);
  assert.equal(S.estSensible('POST', '/api/backup/restore'), true);
  assert.equal(S.estSensible('GET', '/api/backup'), true, 'un export emporte tout le registre');
  assert.equal(S.estSensible('DELETE', '/api/contacts/c1'), true);
  assert.equal(S.estSensible('POST', '/api/auth/master'), true);
});

test('le guichet et la remise restent ouverts, même compromis', function () {
  /* Une intégrité compromise est une affaire entre le créateur et
     l'administrateur. Ce n'est pas une raison pour qu'une personne sans
     logement reparte sans le courrier qui lui ouvre la CAF. */
  assert.equal(S.estSensible('POST', '/api/history'), false, 'inscrire un courrier reçu');
  assert.equal(S.estSensible('POST', '/api/history/h1/pickup'), false, 'remettre un courrier');
  assert.equal(S.estSensible('POST', '/api/notify'), false, 'prévenir quelqu’un');
  assert.equal(S.estSensible('GET', '/api/state'), false, 'lire le registre');
  assert.equal(S.estSensible('GET', '/api/contacts'), false);
  assert.equal(S.estSensible('POST', '/api/contacts'), false, 'inscrire quelqu’un qui se présente');
  assert.equal(S.estSensible('POST', '/api/contacts/c1/passage'), false, 'noter un passage');
});

test('la sauvegarde reste possible : c’est par où commence une récupération', function () {
  /* Le §11 demande de diagnostiquer puis restaurer. Mettre les données à
     l'abri est la première étape, pas une fonction sensible. */
  assert.equal(S.estSensible('POST', '/api/backup'), false);
});

/* ════════════ le serveur verrouillé, pour de vrai ════════════

   Le module dit ce qui *devrait* se fermer ; ces tests-ci vérifient ce qui se
   ferme réellement, sur un serveur monté avec une intégrité compromise. */

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { Db } = require('../server/db.js');
const { createMailer } = require('../server/mailer.js');
const { createServer } = require('../server/app.js');

async function avecServeurCompromis(run, integrite) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bdc-sig-'));
  const db = new Db(path.join(dir, 'db.json'));
  await db.load();
  const server = createServer({
    db: db,
    mailer: createMailer({ MAIL_DRY_RUN: 'true' }),
    rootDir: path.join(__dirname, '..'),
    verifyEmail: false,
    integrite: integrite || {
      etat: 'compromise', code: 'INTEGRITY-001', verrouille: true,
      createur: 'AKRAM MERAKHA', application: 'Bureau du Courrier', version: '1.2.0',
      message: '1 fichier(s) ne correspondent plus à la version signée.',
      ecarts: [{ chemin: 'assets/js/app.js', quoi: 'modifie' }]
    }
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
    const biscuit = res.headers.get('set-cookie');
    if (biscuit) jar.cookie = biscuit.split(';')[0];
    const texte = await res.text();
    let json = null;
    try { json = JSON.parse(texte); } catch (e) { json = texte; }
    return { status: res.status, body: json };
  };
  try {
    await run({ call: call, db: db });
  } finally {
    await new Promise(function (r) { server.close(r); });
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('compromise, l’application dit qui l’a écrite et ce qui ne va pas', function () {
  return avecServeurCompromis(async function (t) {
    const s = await t.call('GET', '/api/signature');
    assert.equal(s.status, 200);
    assert.equal(s.body.createur, 'AKRAM MERAKHA');
    assert.equal(s.body.etat, 'compromise');
    assert.equal(s.body.code, 'INTEGRITY-001');
    assert.equal(s.body.verrouille, true);
  });
});

test('la liste des fichiers modifiés ne sort pas sans compte responsable', function () {
  /* Elle dit exactement où le contrôle a mordu : c'est un plan pour qui
     voudrait recommencer proprement. */
  return avecServeurCompromis(async function (t) {
    assert.equal((await t.call('GET', '/api/signature')).body.ecarts, undefined);
  });
});

test('compromise, le guichet continue de fonctionner', function () {
  /* Le test qui compte le plus de tout ce fichier. Une protection de logiciel
     qui empêche de remettre son courrier à quelqu'un sans logement a coûté
     plus qu'elle n'a protégé. */
  return avecServeurCompromis(async function (t) {
    await t.call('POST', '/api/auth/signup', { name: 'Akram', email: 'a@b.org', password: 'mot-de-passe-du-bureau' });

    const c = await t.call('POST', '/api/contacts', { name: 'Amina Diallo', telephone: '06 12 34 56 78' });
    assert.equal(c.status, 201, 'inscrire quelqu’un qui se présente');

    const h = await t.call('POST', '/api/history', { contactId: c.body.id, name: 'Amina Diallo', subject: 'Un courrier' });
    assert.ok(h.status < 300, 'inscrire un courrier reçu (' + h.status + ')');

    const idCourrier = h.body.id || (h.body.record && h.body.record.id);
    const remise = await t.call('POST', '/api/history/' + idCourrier + '/pickup', { porteur: '' });
    assert.ok(remise.status < 300, 'remettre le courrier (' + remise.status + ')');

    assert.equal((await t.call('GET', '/api/state')).status, 200, 'lire le registre');
  });
});

test('compromise, la configuration et les comptes se ferment', function () {
  return avecServeurCompromis(async function (t) {
    await t.call('POST', '/api/auth/signup', { name: 'Akram', email: 'a@b.org', password: 'mot-de-passe-du-bureau' });

    const reglages = await t.call('PUT', '/api/settings', { subject: 'x', body: 'y' });
    assert.equal(reglages.status, 423);
    assert.equal(reglages.body.code, 'integrite');
    assert.equal(reglages.body.incident, 'INTEGRITY-001', 'le code se dicte au téléphone');

    assert.equal((await t.call('POST', '/api/auth/agents', { name: 'Agent' })).status, 423);
    assert.equal((await t.call('GET', '/api/backup')).status, 423, 'un export emporte tout le registre');
  });
});

test('compromise, rien n’est détruit : le registre est intact', function () {
  /* §10 et §13. Une compromission de la signature ne doit jamais entraîner la
     destruction des données — celles-ci portent les noms et les adresses de
     gens qui n'ont pas de logement. */
  return avecServeurCompromis(async function (t) {
    await t.call('POST', '/api/auth/signup', { name: 'Akram', email: 'a@b.org', password: 'mot-de-passe-du-bureau' });
    await t.call('POST', '/api/contacts', { name: 'Amina Diallo', telephone: '06 12 34 56 78' });
    await t.call('POST', '/api/contacts', { name: 'Yannick Mbala', telephone: '07 00 00 00 00' });

    assert.equal(t.db.data.contacts.length, 2);
    assert.equal((await t.call('GET', '/api/contacts')).body.length, 2);
    assert.ok(Array.isArray(t.db.data.journal), 'le journal existe toujours');
    assert.equal((await t.call('POST', '/api/backup')).status < 400, true,
      'et une sauvegarde reste possible : c’est par là que commence une récupération');
  });
});

test('un refus de fonction sensible laisse une trace au journal', function () {
  return avecServeurCompromis(async function (t) {
    await t.call('POST', '/api/auth/signup', { name: 'Akram', email: 'a@b.org', password: 'mot-de-passe-du-bureau' });
    await t.call('PUT', '/api/settings', { subject: 'x', body: 'y' });
    const lignes = (await t.call('GET', '/api/journal')).body.entrees || [];
    assert.ok(
      lignes.some(function (l) { return /intégrité/.test(l.action || ''); }),
      'le journal de sécurité doit garder la tentative'
    );
  });
});

test('une intégrité vérifiée ne ferme rien', function () {
  return avecServeurCompromis(async function (t) {
    await t.call('POST', '/api/auth/signup', { name: 'Akram', email: 'a@b.org', password: 'mot-de-passe-du-bureau' });
    const r = await t.call('PUT', '/api/settings', { subject: 'Un courrier vous attend', body: 'Bonjour' });
    assert.notEqual(r.status, 423);
  }, {
    etat: 'verifiee', code: null, verrouille: false,
    createur: 'AKRAM MERAKHA', application: 'Bureau du Courrier', version: '1.2.0',
    message: 'Signature vérifiée, fichiers conformes.', ecarts: []
  });
});
