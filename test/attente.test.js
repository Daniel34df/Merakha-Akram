'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attente = require('../assets/js/attente.js');

test('une intention retient tout ce qu’il faut pour rejouer la requête', function () {
  const i = attente.creerIntention({
    op: 'notification',
    method: 'POST',
    path: '/notify',
    body: { name: 'Ana' },
    description: 'Courrier signalé à Ana'
  });
  assert.equal(i.op, 'notification');
  assert.equal(i.method, 'POST');
  assert.equal(i.path, '/notify');
  assert.deepEqual(i.body, { name: 'Ana' });
  assert.equal(i.description, 'Courrier signalé à Ana');
  assert.ok(i.id, 'chaque intention a son propre identifiant');
  assert.ok(Date.parse(i.at), 'et un horodatage lisible');
  assert.equal(i.idLocal, null);
});

test('les identifiants provisoires se reconnaissent', function () {
  const id = attente.nouvelIdLocal();
  assert.ok(attente.estIdLocal(id));
  assert.ok(!attente.estIdLocal('7f3a-1234-vrai-identifiant'));
  assert.ok(!attente.estIdLocal(undefined));
  assert.notEqual(attente.nouvelIdLocal(), attente.nouvelIdLocal());
});

test('la file conserve l’ordre d’arrivée', function () {
  let file = [];
  ['un', 'deux', 'trois'].forEach(function (nom) {
    file = attente.ajouter(file, attente.creerIntention({ op: 'x', path: '/' + nom, description: nom }));
  });
  assert.deepEqual(
    file.map(function (i) {
      return i.path;
    }),
    ['/un', '/deux', '/trois'],
    'l’ordre compte : créer le destinataire avant de lui signaler un courrier'
  );

  file = attente.retirer(file, file[0].id);
  assert.deepEqual(
    file.map(function (i) {
      return i.path;
    }),
    ['/deux', '/trois']
  );
});

test('la file refuse d’enfler sans fin', function () {
  let file = [];
  for (let i = 0; i < attente.MAX_FILE; i++) {
    file = attente.ajouter(file, attente.creerIntention({ op: 'x', path: '/' + i }));
  }
  assert.throws(
    function () {
      attente.ajouter(file, attente.creerIntention({ op: 'x', path: '/trop' }));
    },
    function (err) {
      return err.code === 'file-pleine';
    }
  );
});

test('remapper substitue l’identifiant provisoire dans le chemin et le corps', function () {
  const provisoire = 'local-abc123';
  const file = [
    attente.creerIntention({
      op: 'notification',
      path: '/notify',
      body: { contactId: provisoire, name: 'Ana' }
    }),
    attente.creerIntention({
      op: 'remise',
      path: '/history/' + provisoire + '/pickup',
      body: null
    })
  ];

  const remappee = attente.remapper(file, { 'local-abc123': 'vrai-42' });
  assert.equal(remappee[0].body.contactId, 'vrai-42');
  assert.equal(remappee[0].body.name, 'Ana', 'le reste du corps est intact');
  assert.equal(remappee[1].path, '/history/vrai-42/pickup');
  assert.equal(remappee[1].body, null);

  // La file d'origine n'est pas modifiée : le rejeu peut échouer et reprendre.
  assert.equal(file[0].body.contactId, provisoire);
});

test('remapper sans correspondance ne touche à rien', function () {
  const file = [attente.creerIntention({ op: 'x', path: '/a', body: { v: 1 } })];
  assert.equal(attente.remapper(file, {}), file);
  assert.equal(attente.remapper(file, null), file);
});

test('resume donne de quoi écrire le bandeau', function () {
  const vide = attente.resume([]);
  assert.equal(vide.total, 0);
  assert.equal(vide.depuis, null);

  const tard = attente.creerIntention({ op: 'x', path: '/b', description: 'Deuxième', at: '2026-08-07T10:00:00.000Z' });
  const tot = attente.creerIntention({ op: 'x', path: '/a', description: 'Première', at: '2026-08-07T09:00:00.000Z' });
  const r = attente.resume([tard, tot]);
  assert.equal(r.total, 2);
  assert.equal(r.depuis, '2026-08-07T09:00:00.000Z', 'l’attente se compte depuis la plus ancienne');
  assert.deepEqual(r.libelles, ['Première', 'Deuxième']);
});

test('un refus 4xx est définitif, une panne serveur ne l’est pas', function () {
  // Le courrier a été remis par un collègue, le destinataire supprimé : insister
  // ne servirait à rien.
  assert.equal(attente.estDefinitif(400), true);
  assert.equal(attente.estDefinitif(404), true);
  assert.equal(attente.estDefinitif(409), true);
  // Le serveur va mal ou nous freine : on réessaiera.
  assert.equal(attente.estDefinitif(500), false);
  assert.equal(attente.estDefinitif(502), false);
  assert.equal(attente.estDefinitif(429), false);
  assert.equal(attente.estDefinitif(408), false);
  assert.equal(attente.estDefinitif(undefined), false);
});

test('une file relue depuis le stockage reste rejouable', function () {
  // Le navigateur a été fermé pendant la coupure : la file passe par JSON.
  const original = [
    attente.creerIntention({ op: 'contact-ajout', path: '/contacts', body: { id: 'local-x', name: 'Ana' }, idLocal: 'local-x' }),
    attente.creerIntention({ op: 'notification', path: '/notify', body: { contactId: 'local-x' } })
  ];
  const relue = JSON.parse(JSON.stringify(original));
  assert.deepEqual(relue, original);

  const remappee = attente.remapper(relue, { 'local-x': 'reel-9' });
  assert.equal(remappee[1].body.contactId, 'reel-9');
});
