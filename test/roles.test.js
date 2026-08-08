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
  /* La domiciliation est ouverte : c'est le travail d'accueil lui-même. */
  assert.equal(roles.peut(a, 'domiciliation'), true);
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
    const appeler = async function (method, url, body) {
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
    // Le flux d'événements ne passe pas par fetch : il lui faut le cookie brut.
    appeler.jar = jar;
    return appeler;
  };

  const patron = session();
  const agent = session();

  try {
    await run({
      patron: patron,
      agent: agent,
      cookiePatron: function () { return patron.jar.cookie; },
      cookieAgent: function () { return agent.jar.cookie; },
      db: db,
      base: base
    });
  } finally {
    /* Un flux d'événements resté ouvert empêcherait close() d'aboutir : c'est
       une connexion qui, par construction, ne se termine jamais toute seule. */
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
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
    // La domiciliation, elle, reste ouverte par défaut.
    assert.equal((await t.agent('GET', '/api/domiciliation')).status, 200);
    assert.equal((await t.agent('GET', '/api/auth/agents')).status, 403, 'un agent ne gère pas les accès');

    // Mais il tient le guichet.
    assert.equal((await t.agent('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' })).status, 200);
  });
});

test('l’agent ouvre une domiciliation sans avoir la main sur le registre', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    /* Recevoir quelqu'un et ouvrir son dossier, c'est le métier de l'accueil.
       Le droit « registre » resterait fermé — il ouvrirait la correction et la
       suppression de n'importe quelle fiche. */
    const dossier = await t.agent('POST', '/api/contacts', {
      name: 'Awa Diallo',
      email: 'awa@ex.com',
      telephone: '06 11 22 33 44',
      naissance: '1990-04-12',
      notes: 'Reçue au guichet',
      domicilie: true,
      domicilieDepuis: '2026-01-15'
    });
    assert.equal(dossier.status, 201, 'la domiciliation passe');
    assert.equal(dossier.body.domicilie, true);
    assert.equal(dossier.body.telephone, '06 11 22 33 44', 'le téléphone est conservé');
    assert.equal(dossier.body.naissance, '1990-04-12');
    assert.equal(dossier.body.notes, 'Reçue au guichet');

    // Une fiche ordinaire, elle, reste refusée : rien n'a été élargi au passage.
    const ordinaire = await t.agent('POST', '/api/contacts', { name: 'Y', email: 'y@ex.com' });
    assert.equal(ordinaire.status, 403);

    // Et modifier ou supprimer la fiche qu'il vient d'ouvrir lui reste fermé.
    assert.equal((await t.agent('PUT', '/api/contacts/' + dossier.body.id, { name: 'Z' })).status, 403);
    assert.equal((await t.agent('DELETE', '/api/contacts/' + dossier.body.id)).status, 403);
  });
});

/* ---------- les quatre postes du bureau ---------- */

/** Ouvre le flux et rend une promesse sur les prochains événements reçus. */
function ouvrirFlux(base, cookie) {
  const http = require('node:http');
  return new Promise(function (resolve, reject) {
    const req = http.get(
      base + '/api/flux',
      { headers: cookie ? { Cookie: cookie } : {} },
      function (res) {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(Object.assign(new Error('flux refusé'), { status: res.statusCode }));
        }
        let tampon = '';
        /* Les événements arrivent quand ils arrivent — souvent avant qu'on ne
           les demande. On les met de côté ; « prochain » sert la file s'il y a
           déjà quelque chose, et n'attend que si elle est vide. */
        const recus = [];
        const attentes = [];
        res.setEncoding('utf8');
        res.on('data', function (bout) {
          tampon += bout;
          let coupe;
          while ((coupe = tampon.indexOf('\n\n')) !== -1) {
            const bloc = tampon.slice(0, coupe);
            tampon = tampon.slice(coupe + 2);
            // Les commentaires de maintien (« : ping ») ne sont pas des événements.
            if (!/^event: /m.test(bloc)) continue;
            const evenement = {
              nom: (bloc.match(/^event: (.+)$/m) || [])[1],
              data: JSON.parse((bloc.match(/^data: (.+)$/m) || [])[1] || 'null')
            };
            if (attentes.length) attentes.shift()(evenement);
            else recus.push(evenement);
          }
        });
        resolve({
          prochain: function () {
            if (recus.length) return Promise.resolve(recus.shift());
            return new Promise(function (r, rej) {
              const minuteur = setTimeout(function () {
                rej(new Error('aucun événement reçu en 4 s'));
              }, 4000);
              attentes.push(function (evenement) {
                clearTimeout(minuteur);
                r(evenement);
              });
            });
          },
          fermer: function () {
            req.destroy();
          }
        });
      }
    );
    req.on('error', reject);
  });
}

test('le flux prévient les autres postes à chaque écriture', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    const flux = await ouvrirFlux(t.base, t.cookieAgent());
    const accueil = await flux.prochain();
    assert.equal(accueil.nom, 'bonjour', 'le flux s’annonce avec la révision courante');

    // Une écriture faite par le poste du responsable…
    const attendu = flux.prochain();
    await t.patron('POST', '/api/notify', { name: 'Ana', email: 'ana@ex.com' });
    const maj = await attendu;
    assert.equal(maj.nom, 'maj', '…arrive sur le poste de l’agent');
    assert.ok(maj.data.revision > accueil.data.revision, 'la révision avance');

    /* Rien du contenu ne voyage : le poste rappellera /api/state, qui applique
       ses droits. Un agent sans le droit « codes » n'apprend donc rien ici. */
    assert.deepEqual(Object.keys(maj.data), ['revision']);
    flux.fermer();
  });
});

test('le flux est refusé sans session', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await assert.rejects(
      function () {
        return ouvrirFlux(t.base, '');
      },
      function (err) {
        assert.equal(err.status, 401);
        return true;
      }
    );
  });
});

test('les postes reliés se comptent, et se décomptent en partant', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    assert.equal((await t.patron('GET', '/api/reseau')).body.postes.length, 0);

    const a = await ouvrirFlux(t.base, t.cookiePatron());
    const b = await ouvrirFlux(t.base, t.cookieAgent());
    await a.prochain();
    await b.prochain();

    const vue = (await t.patron('GET', '/api/reseau')).body;
    assert.equal(vue.postes.length, 2);
    assert.ok(vue.postes.some(function (p) { return p.role === 'responsable' && p.moi; }));
    assert.ok(vue.postes.some(function (p) { return p.role === 'agent' && p.identifiant === cree.agent.identifiant; }));
    assert.ok(vue.reseau.port >= 0 && vue.reseau.protocole);

    b.fermer();
    // Laisser au serveur le temps de voir la connexion tomber.
    await new Promise(function (r) { setTimeout(r, 250); });
    assert.equal((await t.patron('GET', '/api/reseau')).body.postes.length, 1, 'le poste parti ne compte plus');
    a.fermer();
  });
});

test('un agent sans le droit réglages ne lit pas l’adresse du serveur', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });
    const refus = await t.agent('GET', '/api/reseau');
    assert.equal(refus.status, 403);
    assert.equal(refus.body.code, 'droit');
  });
});

test('le registre des domiciliations en cours liste les dossiers en règle', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await t.patron('POST', '/api/contacts', {
      name: 'Awa Diallo', email: 'awa@ex.com', box: 'D-07',
      domicilie: true, domicilieDepuis: new Date().toISOString().slice(0, 10)
    });
    await t.patron('POST', '/api/contacts', { name: 'Simon Passant', email: 'simon@ex.com' });

    const vue = (await t.patron('GET', '/api/domiciliation')).body;
    /* Une domiciliation ouverte aujourd'hui n'est ni à renouveler ni en
       absence : sans cette liste, elle n'apparaîtrait nulle part. */
    assert.equal(vue.aRenouveler.length, 0);
    assert.equal(vue.sansPassage.length, 0);
    assert.equal(vue.actives.length, 1, 'le dossier en règle est bien listé');
    assert.equal(vue.actives[0].name, 'Awa Diallo');
    assert.equal(vue.actives[0].box, 'D-07');
    assert.ok(vue.actives[0].etat.echeance, 'avec son échéance');
  });
});

test('une domiciliation close sort du registre des dossiers en cours', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const fiche = (
      await t.patron('POST', '/api/contacts', {
        name: 'Awa Diallo', email: 'awa@ex.com', domicilie: true, domicilieDepuis: '2026-01-10'
      })
    ).body;
    assert.equal((await t.patron('GET', '/api/domiciliation')).body.actives.length, 1);

    await t.patron('PUT', '/api/contacts/' + fiche.id, {
      name: 'Awa Diallo', email: 'awa@ex.com', domicilie: true,
      domicilieDepuis: '2026-01-10', domiciliationCloseLe: '2026-06-30', domiciliationMotif: 'relogée'
    });
    assert.equal((await t.patron('GET', '/api/domiciliation')).body.actives.length, 0);
  });
});

test('un agent d’antenne ne voit que les domiciliations de son antenne', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await t.patron('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      antennes: [{ id: 'antenne-nord', nom: 'Antenne Nord' }, { id: 'antenne-sud', nom: 'Antenne Sud' }]
    });
    const jour = new Date().toISOString().slice(0, 10);
    await t.patron('POST', '/api/contacts', {
      name: 'Nadia Nord', email: 'nadia@ex.com', antenneId: 'antenne-nord', domicilie: true, domicilieDepuis: jour
    });
    await t.patron('POST', '/api/contacts', {
      name: 'Simon Sud', email: 'simon@ex.com', antenneId: 'antenne-sud', domicilie: true, domicilieDepuis: jour
    });

    const cree = (await t.patron('POST', '/api/auth/agents', { name: 'Accueil Sud', antenneId: 'antenne-sud' })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    assert.equal((await t.patron('GET', '/api/domiciliation')).body.actives.length, 2, 'le responsable voit les deux');

    const vue = (await t.agent('GET', '/api/domiciliation')).body;
    assert.equal(vue.actives.length, 1, 'l’agent ne voit que son antenne');
    assert.equal(vue.actives[0].name, 'Simon Sud');
    assert.equal(vue.rapport.actives, 1, 'le rapport annuel se limite lui aussi à son antenne');
  });
});

test('un code d’une autre antenne ne livre rien, ni fiche ni remise', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await t.patron('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      antennes: [{ id: 'antenne-nord', nom: 'Antenne Nord' }, { id: 'antenne-sud', nom: 'Antenne Sud' }]
    });
    await t.patron('POST', '/api/contacts', {
      name: 'Nadia Nord', email: 'nadia@ex.com', box: 'N-01', antenneId: 'antenne-nord'
    });
    const envoi = await t.patron('POST', '/api/notify', {
      name: 'Nadia Nord', email: 'nadia@ex.com', antenneId: 'antenne-nord'
    });
    const code = envoi.body.record.pickupCode;

    const cree = (await t.patron('POST', '/api/auth/agents', {
      name: 'Accueil Sud',
      antenneId: 'antenne-sud',
      permissions: { guichet: true, remise: true, codes: true }
    })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    /* Le code est à quatre chiffres : un agent peut en essayer un au hasard.
       S'il tombe juste, il ne doit rien apprendre d'un autre point d'accueil —
       ni le nom de la personne, ni sa boîte — et ne rien pouvoir remettre. */
    const fiche = await t.agent('GET', '/api/history/by-code/' + code);
    assert.equal(fiche.status, 404, 'la fiche d’une autre antenne reste introuvable');
    assert.ok(!JSON.stringify(fiche.body).includes('Nadia'), 'aucun nom ne fuit');
    assert.ok(!JSON.stringify(fiche.body).includes('N-01'), 'aucune boîte ne fuit');

    const remise = await t.agent('POST', '/api/history/pickup-by-code', { code: code });
    assert.equal(remise.status, 404, 'et il ne peut pas la remettre');

    // Le responsable, lui, y accède : c'est bien un filtre d'antenne, pas une panne.
    assert.equal((await t.patron('GET', '/api/history/by-code/' + code)).status, 200);
  });
});

test('aucune route de lecture ne contourne le filtre d’antenne', function () {
  /* L'interface passe par /api/state, qui filtre. Mais rien n'empêche
     d'appeler les autres routes directement depuis un onglet de développeur :
     ce sont elles qu'il faut vérifier, pas ce que l'écran affiche. */
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await t.patron('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      antennes: [{ id: 'antenne-nord', nom: 'Antenne Nord' }, { id: 'antenne-sud', nom: 'Antenne Sud' }]
    });
    await t.patron('POST', '/api/contacts', {
      name: 'Nadia Nord', email: 'nadia@ex.com', box: 'N-01', antenneId: 'antenne-nord'
    });
    await t.patron('POST', '/api/contacts', {
      name: 'Simon Sud', email: 'simon@ex.com', box: 'S-01', antenneId: 'antenne-sud'
    });
    await t.patron('POST', '/api/notify', { name: 'Nadia Nord', email: 'nadia@ex.com', antenneId: 'antenne-nord' });

    const cree = (await t.patron('POST', '/api/auth/agents', {
      name: 'Accueil Sud',
      antenneId: 'antenne-sud',
      permissions: { guichet: true, remise: true, registre: true, exports: true }
    })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    const sansNadia = function (reponse, route) {
      assert.ok(
        !JSON.stringify(reponse.body).includes('Nadia'),
        route + ' laisse fuir un destinataire d’une autre antenne'
      );
    };

    sansNadia(await t.agent('GET', '/api/contacts'), 'GET /api/contacts');
    sansNadia(await t.agent('GET', '/api/history'), 'GET /api/history');
    sansNadia(await t.agent('GET', '/api/state'), 'GET /api/state');

    // Les chiffres agrégés portent eux aussi sur la seule antenne de l'agent.
    const stats = await t.agent('GET', '/api/stats');
    const statsPatron = await t.patron('GET', '/api/stats');
    assert.notDeepEqual(stats.body, statsPatron.body, 'l’agent ne compte pas tout le réseau');

    // Et il voit bien la sienne : c'est un filtre, pas une panne.
    assert.ok(JSON.stringify((await t.agent('GET', '/api/contacts')).body).includes('Simon'));
  });
});

test('la sauvegarde complète est réservée à qui règle le bureau', function () {
  /* Elle emporte tout : toutes les antennes, l'historique avec ses codes en
     clair, et la liste des comptes. Un accès d'agent ne doit pas pouvoir
     repartir avec le registre entier en un seul appel. */
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await t.patron('POST', '/api/contacts', { name: 'Nadia Nord', email: 'nadia@ex.com' });
    const envoi = await t.patron('POST', '/api/notify', { name: 'Nadia Nord', email: 'nadia@ex.com' });

    const cree = (await t.patron('POST', '/api/auth/agents', {
      name: 'Accueil',
      permissions: { guichet: true, remise: true, registre: true, exports: true }
    })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    const refus = await t.agent('GET', '/api/backup');
    assert.equal(refus.status, 403, 'la sauvegarde est refusée à un agent');
    assert.equal(refus.body.code, 'droit');
    assert.ok(
      !String(JSON.stringify(refus.body)).includes(envoi.body.record.pickupCode),
      'et aucun code de retrait ne part avec le refus'
    );

    // Le responsable, lui, sauvegarde.
    assert.equal((await t.patron('GET', '/api/backup')).status, 200);
  });
});

/* ---------- renouveler et clore ----------

   Le modèle portait ces deux états depuis le début et le rapport annuel les
   comptait, mais rien dans l'application ne permettait de les produire :
   « Closes dans l'année » affichait invariablement zéro. */

test('renouveler reporte l’échéance sans toucher à la date d’élection', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const fiche = (
      await t.patron('POST', '/api/contacts', {
        name: 'Awa Diallo', email: 'awa@ex.com', domicilie: true, domicilieDepuis: '2025-01-15'
      })
    ).body;
    assert.equal(fiche.domicilieJusqua, '2026-01-15', 'douze mois après l’élection');

    const r = await t.patron('POST', '/api/contacts/' + fiche.id + '/domiciliation', {
      action: 'renouveler'
    });
    assert.equal(r.status, 200, r.body && r.body.error);

    const apres = r.body.contact;
    assert.equal(apres.domicilieDepuis, '2025-01-15', 'l’ancienneté ne bouge pas : elle vaut des droits');
    assert.ok(apres.domicilieJusqua > '2026-01-15', 'l’échéance repart d’aujourd’hui');
    assert.equal(apres.renouvellements.length, 1, 'le renouvellement est tracé');
    assert.ok(apres.renouvellements[0].par, 'avec qui l’a fait');
  });
});

test('clore alimente le rapport annuel, qui affichait toujours zéro', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const annee = new Date().getFullYear();
    const fiche = (
      await t.patron('POST', '/api/contacts', {
        name: 'Awa Diallo', email: 'awa@ex.com', domicilie: true,
        domicilieDepuis: annee + '-01-15'
      })
    ).body;

    const avant = (await t.patron('GET', '/api/domiciliation')).body;
    assert.equal(avant.rapport.closesDansLAnnee, 0);
    assert.equal(avant.actives.length, 1);

    const r = await t.patron('POST', '/api/contacts/' + fiche.id + '/domiciliation', {
      action: 'clore', motif: 'relogée', note: 'par le service social'
    });
    assert.equal(r.status, 200, r.body && r.body.error);
    assert.match(r.body.contact.domiciliationMotif, /relogée/);

    const apres = (await t.patron('GET', '/api/domiciliation')).body;
    assert.equal(apres.closesDansLAnnee || apres.rapport.closesDansLAnnee, 1, 'le rapport compte enfin');
    assert.equal(apres.actives.length, 0, 'et elle sort des dossiers en cours');
    assert.ok(apres.rapport.motifs && Object.keys(apres.rapport.motifs).length > 0, 'le motif est ventilé');
  });
});

test('un motif inventé est refusé', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const fiche = (
      await t.patron('POST', '/api/contacts', {
        name: 'Awa', email: 'awa@ex.com', domicilie: true, domicilieDepuis: '2026-01-15'
      })
    ).body;
    const r = await t.patron('POST', '/api/contacts/' + fiche.id + '/domiciliation', {
      action: 'clore', motif: 'parce que'
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Motif de clôture attendu/);
  });
});

test('une domiciliation close ne se renouvelle pas', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const fiche = (
      await t.patron('POST', '/api/contacts', {
        name: 'Awa', email: 'awa@ex.com', domicilie: true, domicilieDepuis: '2026-01-15'
      })
    ).body;
    await t.patron('POST', '/api/contacts/' + fiche.id + '/domiciliation', {
      action: 'clore', motif: 'à sa demande'
    });
    const r = await t.patron('POST', '/api/contacts/' + fiche.id + '/domiciliation', {
      action: 'renouveler'
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /close/i);
  });
});

test('modifier une fiche ne doit pas annuler un renouvellement', function () {
  /* Piège : cleanContact recalcule l'échéance depuis la date d'élection quand
     la requête ne la porte pas. Une modification de fiche après renouvellement
     ramènerait donc l'échéance douze mois après l'élection d'origine — le
     renouvellement serait effacé sans que personne ne le voie. */
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const fiche = (
      await t.patron('POST', '/api/contacts', {
        name: 'Awa', email: 'awa@ex.com', domicilie: true, domicilieDepuis: '2025-01-15'
      })
    ).body;
    const renouvelee = (
      await t.patron('POST', '/api/contacts/' + fiche.id + '/domiciliation', { action: 'renouveler' })
    ).body.contact;

    // L'interface doit renvoyer l'échéance courante avec la modification.
    const modifiee = await t.patron('PUT', '/api/contacts/' + fiche.id, {
      name: 'Awa Diallo',
      email: 'awa@ex.com',
      domicilie: true,
      domicilieDepuis: renouvelee.domicilieDepuis,
      domicilieJusqua: renouvelee.domicilieJusqua
    });
    assert.equal(modifiee.status, 200, modifiee.body && modifiee.body.error);
    assert.equal(
      modifiee.body.domicilieJusqua,
      renouvelee.domicilieJusqua,
      'le renouvellement survit à une correction de fiche'
    );
    assert.equal(modifiee.body.renouvellements.length, 1, 'et sa trace aussi');
  });
});

test('un agent privé de domiciliation ne peut plus ouvrir de dossier', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const cree = (
      await t.patron('POST', '/api/auth/agents', {
        name: 'Guichet seul',
        permissions: { guichet: true, remise: true, domiciliation: false }
      })
    ).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    const refus = await t.agent('POST', '/api/contacts', {
      name: 'Awa Diallo',
      email: 'awa@ex.com',
      domicilie: true,
      domicilieDepuis: '2026-01-15'
    });
    assert.equal(refus.status, 403);
    assert.equal(refus.body.code, 'droit');
    assert.equal((await t.agent('GET', '/api/domiciliation')).status, 403);
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

/* ═══════════ effacer vraiment ═══════════

   Supprimer un destinataire le sortait du registre et laissait tout le reste :
   son courrier à l'historique — nom, objet, dates — et son nom au journal.
   Pour un registre qui porte des personnes sans domicile stable, parfois des
   gens qui se cachent de quelqu'un, « sortie du registre » n'est pas une
   réponse à « effacez-moi de vos fichiers ». */

async function avecUneFiche(t, extra) {
  await t.patron('POST', '/api/auth/signup', PATRON);
  const cree = await t.patron(
    'POST', '/api/contacts',
    Object.assign({ name: 'Amina Diallo', telephone: '06 12 34 56 78' }, extra || {})
  );
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  return cree.body;
}

test('la suppression simple garde le courrier : c’est ce qui la distingue', function () {
  return withServer(async function (t) {
    const c = await avecUneFiche(t);
    await t.patron('POST', '/api/notify', {
      contactId: c.id, name: c.name, subject: 'Un courrier vous attend'
    });
    assert.equal(t.db.data.history.length, 1);

    const sup = await t.patron('DELETE', '/api/contacts/' + c.id);
    assert.equal(sup.status, 200);
    assert.equal(sup.body.complet, false);
    assert.equal(t.db.data.contacts.length, 0);
    assert.equal(t.db.data.history.length, 1, 'l’historique est conservé');
  });
});

test('l’effacement complet ne laisse aucune trace nominative', function () {
  return withServer(async function (t) {
    const c = await avecUneFiche(t);
    await t.patron('POST', '/api/notify', {
      contactId: c.id, name: c.name, subject: 'Un courrier vous attend'
    });
    await t.patron('POST', '/api/contacts/' + c.id + '/passage', { note: 'passée au guichet' });

    const jav = JSON.stringify(t.db.data.journal);
    assert.ok(jav.includes('Amina Diallo'), 'le journal la nomme avant l’effacement');

    const eff = await t.patron('DELETE', '/api/contacts/' + c.id + '?effacer=complet');
    assert.equal(eff.status, 200);
    assert.equal(eff.body.complet, true);
    assert.ok(eff.body.courriersEfface >= 1, 'le courrier est compté');

    assert.equal(t.db.data.contacts.length, 0, 'la fiche est partie');
    assert.equal(t.db.data.history.length, 0, 'son courrier aussi');

    const reste = JSON.stringify(t.db.data);
    assert.ok(!reste.includes('Amina Diallo'), 'plus aucune occurrence du nom : ' + reste.slice(0, 400));
    assert.ok(!reste.includes('06 12 34 56 78'), 'ni du numéro de téléphone');
  });
});

test('l’effacement garde la trace de l’acte : qui, quand, combien', function () {
  return withServer(async function (t) {
    const c = await avecUneFiche(t);
    await t.patron('POST', '/api/notify', {
      contactId: c.id, name: c.name, subject: 'Un courrier vous attend'
    });
    await t.patron('DELETE', '/api/contacts/' + c.id + '?effacer=complet');

    const acte = t.db.data.journal.find(function (l) {
      return l.action === 'destinataire effacé';
    });
    assert.ok(acte, 'l’effacement lui-même est consigné');
    assert.equal(acte.qui, 'Akram', 'on sait qui a effacé');
    assert.equal(acte.cible, 'personne effacée', 'sans renommer la personne');
    assert.ok(acte.at, 'et quand');
    assert.match(acte.details, /courrier\(s\) effacé\(s\)/);
  });
});

test('un nom corrigé avant l’effacement ne reste pas au journal sous l’ancien', function () {
  return withServer(async function (t) {
    const c = await avecUneFiche(t);
    await t.patron('POST', '/api/contacts/' + c.id + '/passage', { note: 'première visite' });

    // La fiche est corrigée : le journal garde l'ancien nom sous « cible ».
    const maj = await t.patron('PUT', '/api/contacts/' + c.id, {
      name: 'Amina Diallo-Sow', telephone: '06 12 34 56 78'
    });
    assert.equal(maj.status, 200);
    assert.deepEqual(maj.body.nomsAnterieurs, ['Amina Diallo']);
    assert.ok(JSON.stringify(t.db.data.journal).includes('Amina Diallo'), 'l’ancien nom est bien là');

    await t.patron('DELETE', '/api/contacts/' + c.id + '?effacer=complet');
    const reste = JSON.stringify(t.db.data);
    assert.ok(!reste.includes('Amina Diallo-Sow'), 'le nom courant est parti');
    assert.ok(!reste.includes('Amina Diallo'), 'l’ancien nom aussi : ' + reste.slice(0, 400));
  });
});

test('le nom glissé dans une note du journal part aussi', function () {
  return withServer(async function (t) {
    const c = await avecUneFiche(t);
    await t.patron('POST', '/api/contacts/' + c.id + '/passage', {
      note: 'Amina Diallo est passée avec sa fille'
    });
    assert.ok(JSON.stringify(t.db.data.journal).includes('est passée avec sa fille'));

    await t.patron('DELETE', '/api/contacts/' + c.id + '?effacer=complet');
    const reste = JSON.stringify(t.db.data);
    assert.ok(!reste.includes('Amina Diallo'), 'le texte libre est nettoyé aussi');
    assert.ok(reste.includes('est passée avec sa fille'), 'sans effacer le reste de la note');
  });
});

test('effacer quelqu’un n’emporte pas le courrier des autres fiches sans courriel', function () {
  return withServer(async function (t) {
    const a = await avecUneFiche(t);
    const b = await t.patron('POST', '/api/contacts', {
      name: 'Omar Benali', telephone: '06 99 88 77 66'
    });
    assert.equal(b.status, 201);

    await t.patron('POST', '/api/notify', { contactId: a.id, name: a.name, subject: 'Pour Amina' });
    await t.patron('POST', '/api/notify', { contactId: b.body.id, name: b.body.name, subject: 'Pour Omar' });
    assert.equal(t.db.data.history.length, 2);

    await t.patron('DELETE', '/api/contacts/' + a.id + '?effacer=complet');

    /* Les deux ont un courriel vide. « '' === '' » aurait emporté les deux
       courriers — c'est exactement le piège déjà rencontré ailleurs. */
    assert.equal(t.db.data.history.length, 1, 'seul le courrier d’Amina part');
    assert.equal(t.db.data.history[0].name, 'Omar Benali');
    assert.equal(t.db.data.contacts.length, 1);
  });
});

test('effacer demande le droit registre', function () {
  return withServer(async function (t) {
    const c = await avecUneFiche(t);
    const cree = await t.patron('POST', '/api/auth/agents', { name: 'Accueil' });
    const entree = await t.agent('POST', '/api/auth/login-code', {
      identifiant: cree.body.agent.identifiant, code: cree.body.code
    });
    assert.equal(entree.status, 200);

    const refus = await t.agent('DELETE', '/api/contacts/' + c.id + '?effacer=complet');
    assert.equal(refus.status, 403);
    assert.equal(refus.body.code, 'droit');
    assert.equal(t.db.data.contacts.length, 1, 'rien n’a bougé');
  });
});

test('un courrier ancien, sans lien de fiche, ne rattache pas deux personnes sans courriel', function () {
  return withServer(async function (t) {
    const a = await avecUneFiche(t);
    await t.patron('POST', '/api/contacts', { name: 'Omar Benali', telephone: '06 99 88 77 66' });

    /* Les courriers d'avant portaient le nom et le courriel, pas l'identifiant
       de la fiche. Quand les deux courriels sont vides, seul le garde-fou
       empêche « '' === '' » de rattacher le courrier d'Omar à Amina. */
    await t.db.write(function (data) {
      data.history.push(
        { id: 'h1', contactId: null, name: 'Amina Diallo', email: '', subject: 'Pour Amina',
          date: new Date().toISOString(), status: 'envoyé' },
        { id: 'h2', contactId: null, name: 'Omar Benali', email: '', subject: 'Pour Omar',
          date: new Date().toISOString(), status: 'envoyé' }
      );
    });

    await t.patron('DELETE', '/api/contacts/' + a.id + '?effacer=complet');

    const restants = t.db.data.history.map(function (h) { return h.name; });
    assert.ok(restants.includes('Omar Benali'), 'le courrier d’Omar reste : ' + JSON.stringify(restants));
  });
});

test('une fiche d’une autre antenne ne se modifie ni ne s’efface', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    await t.patron('PUT', '/api/settings', {
      subject: 'S', body: 'B',
      antennes: [{ id: 'antenne-nord', nom: 'Antenne Nord' }, { id: 'antenne-sud', nom: 'Antenne Sud' }]
    });
    const nord = (await t.patron('POST', '/api/contacts', {
      name: 'Nadia Nord', email: 'nadia@ex.com', box: 'N-01', antenneId: 'antenne-nord'
    })).body;

    const cree = (await t.patron('POST', '/api/auth/agents', {
      name: 'Accueil Sud',
      antenneId: 'antenne-sud',
      permissions: { guichet: true, remise: true, registre: true }
    })).body;
    await t.agent('POST', '/api/auth/login-code', { identifiant: cree.agent.identifiant, code: cree.code });

    /* La lecture filtrait déjà par antenne ; l'écriture, non. Un agent du Sud
       avec le droit « registre » pouvait modifier — et surtout effacer — une
       fiche du Nord qu'il n'a pas le droit de voir. */
    const maj = await t.agent('PUT', '/api/contacts/' + nord.id, {
      name: 'Autre nom', email: 'nadia@ex.com'
    });
    assert.equal(maj.status, 404, 'modifier une fiche d’une autre antenne : introuvable');

    const sup = await t.agent('DELETE', '/api/contacts/' + nord.id);
    assert.equal(sup.status, 404, 'la supprimer non plus');

    const eff = await t.agent('DELETE', '/api/contacts/' + nord.id + '?effacer=complet');
    assert.equal(eff.status, 404, 'l’effacer encore moins');

    assert.equal(t.db.data.contacts.length, 1, 'la fiche du Nord est intacte');
    assert.equal(t.db.data.contacts[0].name, 'Nadia Nord');

    // Le responsable, lui, y accède : c'est un filtre d'antenne, pas une panne.
    assert.equal((await t.patron('DELETE', '/api/contacts/' + nord.id)).status, 200);
  });
});

test('un courrier s’inscrit pour une personne sans adresse électronique', function () {
  return withServer(async function (t) {
    await t.patron('POST', '/api/auth/signup', PATRON);
    const c = (await t.patron('POST', '/api/contacts', {
      name: 'Amina Diallo', telephone: '06 12 34 56 78'
    })).body;

    const pose = await t.patron('POST', '/api/history', {
      contactId: c.id, name: c.name, email: '', subject: 'Un courrier vous attend'
    });
    assert.equal(pose.status, 201, JSON.stringify(pose.body));
    assert.equal(pose.body.name, 'Amina Diallo');

    // Le nom, lui, reste indispensable : sans lui la ligne ne désigne personne.
    const sansNom = await t.patron('POST', '/api/history', { name: '', email: 'x@ex.com' });
    assert.equal(sansNom.status, 400);
  });
});
