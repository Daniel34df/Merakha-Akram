'use strict';

/* Le tableau de bord.

   Ce que ces tests gardent fermé : un relevé qui rassure à tort. Un tableau de
   bord qui affiche « rien à signaler » alors qu'une domiciliation a expiré est
   pire que pas de tableau de bord du tout — sans lui, quelqu'un serait allé
   voir. C'est la raison pour laquelle une source absente disparaît de la liste
   au lieu d'y figurer à zéro : « 0 casier plein » se lit comme une
   vérification faite, et ce n'en est pas une.

   La date est injectée partout. Un test qui dépend du calendrier de la machine
   qui le joue passe en mars et tombe en septembre, et ne prouve rien. */

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../assets/js/bord.js');

const MAINTENANT = '2026-06-15T10:00:00.000Z';

function jours(n) {
  return new Date(Date.parse(MAINTENANT) - n * 86400000).toISOString();
}

function courrier(extra) {
  return Object.assign(
    { id: 'h' + Math.random(), name: 'Jean Dupont', email: 'jean@exemple.org',
      date: jours(1), status: 'envoyé', pickedUpAt: null, closedAt: null, type: 'lettre' },
    extra
  );
}

const VIDE = { history: [], contacts: [], boites: [], settings: {} };

/* ── un bureau qui n'a rien à faire ── */

test('un bureau vide est calme, et ne prétend rien avoir vérifié', function () {
  const r = B.resume(VIDE, { at: MAINTENANT });
  assert.equal(r.calme, true);
  assert.deepEqual(r.alertes, []);
  assert.equal(r.domiciliation, null, 'pas de domiciliation ici : la rubrique n’existe pas');
  assert.equal(r.casiers, null, 'pas de casiers ici non plus');
  assert.match(B.phrase(r), /Rien en attente/);
});

test('des courriers en attente ne sont pas une alerte', function () {
  /* C'est le travail ordinaire. Le compter comme un avertissement ferait
     paraître le bureau en retard tous les jours, et l'agent cesserait de
     regarder — c'est exactement comme ça qu'un vrai signal se perd. */
  const r = B.resume(
    Object.assign({}, VIDE, { history: [courrier(), courrier(), courrier()] }),
    { at: MAINTENANT }
  );
  assert.equal(r.calme, true, 'trois courriers du jour : rien ne presse');
  assert.equal(r.courrier.attente, 3, 'le chiffre existe pour qui en a besoin');
  /* Mais il n'a pas de puce : l'onglet « Remise » le porte déjà, et la phrase
     du haut le redit. Une troisième fois coûterait une ligne entière au champ
     de saisie sur un écran de 360 px. */
  assert.deepEqual(r.alertes, []);
  assert.match(B.phrase(r), /Rien ne presse — 3 courriers/);
});

/* ── ce qui presse ── */

test('un courrier qui traîne se signale, celui d’hier non', function () {
  const r = B.resume(
    Object.assign({}, VIDE, { history: [courrier({ date: jours(9) }), courrier({ date: jours(1) })] }),
    { at: MAINTENANT }
  );
  assert.equal(r.courrier.vieux, 1);
  assert.equal(r.calme, false);
  assert.ok(r.alertes.some(function (a) { return a.cle === 'vieux' && a.n === 1; }));
});

test('un courrier retiré ne compte plus, même s’il est vieux', function () {
  const r = B.resume(
    Object.assign({}, VIDE, { history: [courrier({ date: jours(40), pickedUpAt: jours(38) })] }),
    { at: MAINTENANT }
  );
  assert.equal(r.courrier.attente, 0);
  assert.equal(r.calme, true);
});

test('une domiciliation expirée passe avant tout le reste', function () {
  /* C'est le seul « danger » du tableau : quelqu'un perd son adresse
     maintenant, et avec elle la CAF et l'assurance maladie. */
  const contacts = [
    { id: 'c1', name: 'Amina Diallo', domicilie: true, domicilieDepuis: '2024-01-10' },
    { id: 'c2', name: 'Sarah Benali', domicilie: true, domicilieDepuis: '2026-06-01' }
  ];
  const r = B.resume(
    Object.assign({}, VIDE, { contacts: contacts, history: [courrier({ urgent: true })] }),
    { at: MAINTENANT }
  );
  assert.equal(r.alertes[0].cle, 'domiExpirees', 'en tête, devant le courrier urgent');
  assert.equal(r.alertes[0].niveau, 'danger');
  assert.equal(r.domiciliation.total, 2);
  assert.equal(r.domiciliation.expirees, 1);
  assert.match(B.phrase(r), /priorité/);
});

test('à gravité égale, ce qui touche le plus de monde vient en premier', function () {
  /* L'agent lit la première ligne. Entre deux avertissements, celui qui
     concerne douze personnes passe avant celui qui en concerne une. */
  const history = [];
  for (let i = 0; i < 5; i++) history.push(courrier({ id: 'u' + i, urgent: true }));
  history.push(courrier({ id: 'v1', date: jours(30) }));
  const r = B.resume(Object.assign({}, VIDE, { history: history }), { at: MAINTENANT });
  const avert = r.alertes.filter(function (a) { return a.niveau === 'warn'; });
  assert.ok(avert.length >= 2);
  assert.ok(avert[0].n >= avert[1].n, 'du plus nombreux au moins nombreux');
});

/* ── le pluriel, parce qu'il se lit ── */

test('le libellé s’accorde sur les deux mots', function () {
  const un = { history: [], contacts: [{ id: 'c1', name: 'A', domicilie: true, domicilieDepuis: '2024-01-10' }], boites: [], settings: {} };
  const deux = {
    history: [],
    contacts: [
      { id: 'c1', name: 'A', domicilie: true, domicilieDepuis: '2024-01-10' },
      { id: 'c2', name: 'B', domicilie: true, domicilieDepuis: '2024-02-10' }
    ],
    boites: [], settings: {}
  };
  const a = B.resume(un, { at: MAINTENANT }).alertes[0];
  const b = B.resume(deux, { at: MAINTENANT }).alertes[0];
  assert.equal(a.libelle, 'domiciliation expirée');
  assert.equal(b.libelle, 'domiciliations expirées', 'le « s » porte sur les deux mots');
});

/* ── chaque chiffre mène quelque part ── */

test('toute alerte dit où aller : un chiffre sans destination n’est pas une action', function () {
  const r = B.resume(
    {
      history: [courrier({ date: jours(20), urgent: true })],
      contacts: [{ id: 'c1', name: 'A', domicilie: true, domicilieDepuis: '2024-01-10' }],
      boites: [{ id: 'b1', numero: 'B-001', statut: 'horsservice', periodes: [] }],
      settings: {}
    },
    { at: MAINTENANT }
  );
  assert.ok(r.alertes.length >= 3);
  r.alertes.forEach(function (a) {
    assert.ok(a.ou && a.ou.panneau, a.cle + ' doit mener à un écran');
    assert.ok(a.phrase && a.phrase.length > 20, a.cle + ' doit dire ce qui est en jeu');
    assert.ok(a.libelle, a.cle + ' doit avoir un mot écrit, pas seulement une couleur');
  });
});

/* ── les casiers ── */

test('sans casiers au plan, la rubrique n’existe pas — elle ne vaut pas zéro', function () {
  /* « 0 casier plein » dans un bureau qui n'a jamais ouvert le plan se lit
     comme une vérification faite. Ce n'en est pas une. */
  const r = B.resume(Object.assign({}, VIDE, { boites: [] }), { at: MAINTENANT });
  assert.equal(r.casiers, null);
  assert.ok(!r.alertes.some(function (a) { return a.cle.indexOf('casiers') === 0; }));
});

test('un local sans aucune place libre se signale', function () {
  const boites = [
    { id: 'b1', numero: 'B-001', statut: 'occupee', periodes: [] },
    { id: 'b2', numero: 'B-002', statut: 'occupee', periodes: [] }
  ];
  const r = B.resume(Object.assign({}, VIDE, { boites: boites }), { at: MAINTENANT });
  assert.equal(r.casiers.total, 2);
  assert.equal(r.casiers.libres, 0);
  assert.ok(r.alertes.some(function (a) { return a.cle === 'casiersPleins'; }));
});

test('un local avec de la place ne dit rien', function () {
  const boites = [
    { id: 'b1', numero: 'B-001', statut: 'libre', periodes: [] },
    { id: 'b2', numero: 'B-002', statut: 'occupee', periodes: [] }
  ];
  const r = B.resume(Object.assign({}, VIDE, { boites: boites }), { at: MAINTENANT });
  assert.equal(r.casiers.libres, 1);
  assert.ok(!r.alertes.some(function (a) { return a.cle === 'casiersPleins'; }));
});

/* ── robustesse ── */

test('des données absentes ou abîmées ne font pas tomber le relevé', function () {
  /* Cet écran est le premier que l'agent voit. S'il plante, l'application
     paraît morte alors que tout le reste fonctionne. */
  assert.doesNotThrow(function () { B.resume(null, { at: MAINTENANT }); });
  assert.doesNotThrow(function () { B.resume({}, { at: MAINTENANT }); });
  assert.doesNotThrow(function () {
    B.resume({ history: [{ date: 'pas une date' }, null], contacts: [null], boites: [] }, { at: MAINTENANT });
  });
  assert.equal(B.phrase(null), '');
});

test('sans date fournie, le relevé se fait maintenant', function () {
  const r = B.resume(VIDE);
  assert.ok(Math.abs(Date.now() - Date.parse(r.at)) < 5000);
});
