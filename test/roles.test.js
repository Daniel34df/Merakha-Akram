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
