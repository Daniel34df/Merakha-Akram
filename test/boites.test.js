'use strict';

/* Les boîtes du local.

   Ce que ces tests gardent fermé n'est pas cosmétique. Un numéro attribué deux
   fois, et deux courriers partent au même casier : celui qui l'ouvre trouve le
   courrier d'un autre, avec son nom et son expéditeur dessus. Un historique de
   titulaires écrasé, et un courrier arrivé trois semaines après un
   déménagement n'a plus personne à qui se rattacher.

   Tout ce fichier tourne hors navigateur : le module ne fait que du calcul sur
   des tableaux, et c'est exactement pour ça qu'il a été écrit ainsi. */

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../assets/js/boites.js');

const T = '2026-08-09T10:00:00.000Z';
const T2 = '2026-09-01T10:00:00.000Z';

const AMINA = { id: 'c-amina', name: 'Amina Diallo', box: 'B-012', createdAt: '2025-01-10T09:00:00.000Z' };
const YANNICK = { id: 'c-yannick', name: 'Yannick Mbala', box: 'A-03', createdAt: '2025-06-02T09:00:00.000Z' };
const SARAH = { id: 'c-sarah', name: 'Śarah Ω', box: '', createdAt: '2026-01-05T09:00:00.000Z' };

function boite(numero, extra) {
  return B.creer(Object.assign({ id: 'b-' + numero, numero: numero, createdAt: T }, extra || {}));
}

/* ---------- la numérotation ---------- */

test('un numéro s’écrit et se relit', function () {
  assert.equal(B.formaterNumero(24), 'B-024');
  assert.equal(B.formaterNumero(7, { prefixe: 'A-', chiffres: 2 }), 'A-07');
  assert.equal(B.formaterNumero(142, { prefixe: '', chiffres: 1 }), '142');
  assert.equal(B.lireNumero('B-024'), 24);
  assert.equal(B.lireNumero('b24'), 24, '« b24 » et « B-024 » sont le même casier');
  assert.equal(B.lireNumero('B 24'), 24);
});

test('un numéro hors schéma se dit hors schéma, il ne se force pas', function () {
  /* « Casier 7 » désigne un vrai casier du local. Le ranger de force dans la
     numérotation en ferait un « B-007 » qui n'est écrit sur aucune porte, et
     entrerait en collision avec le vrai B-007 le jour où il est créé. */
  assert.equal(B.lireNumero('Casier 7'), null);
  assert.equal(B.lireNumero('142'), null, 'sans le préfixe « B- », ce n’est pas de cette série');
  assert.equal(B.lireNumero(''), null);
  assert.equal(B.lireNumero('B-'), null);
  assert.equal(B.lireNumero(null), null);
  // Sans préfixe déclaré, en revanche, un nombre nu est un numéro.
  assert.equal(B.lireNumero('142', { prefixe: '' }), 142);
});

test('le prochain numéro comble le premier trou', function () {
  const plan = [boite('B-001'), boite('B-002'), boite('B-004')];
  assert.equal(B.prochainNumero(plan), 3);
  assert.equal(B.prochainNumero([]), 1);
});

test('sans réutilisation, un numéro retiré ne resert jamais', function () {
  const plan = [boite('B-001'), boite('B-004')];
  assert.equal(B.prochainNumero(plan, { reutiliser: false }), 5);
  assert.equal(B.prochainNumero(plan, { reutiliser: true }), 2);
});

test('une plage épuisée le dit, au lieu d’inventer un casier', function () {
  /* Un numéro au-delà de la plage n'est écrit sur aucune porte du local :
     mieux vaut « plus de boîte libre » qu'un B-201 qui n'existe pas. */
  const plan = [boite('B-001'), boite('B-002')];
  assert.equal(B.prochainNumero(plan, { debut: 1, fin: 2 }), null);
  assert.equal(B.prochainNumero(plan, { debut: 1, fin: 3 }), 3);
});

test('les numéros hors schéma ne perturbent pas le décompte', function () {
  const plan = [boite('B-001'), boite('Casier 7'), boite('B-002')];
  assert.equal(B.prochainNumero(plan), 3);
});

test('les zéros de tête ne fabriquent pas deux casiers', function () {
  /* `util.normalizeBox` rejoignait déjà la casse, les espaces et les tirets,
     mais s'arrêtait là : « B-012 » et « b12 » en ressortaient distincts, alors
     que c'est la même porte. Le registre contenait donc des casiers en double
     sans que rien ne le montre. */
  assert.equal(B.memeNumero('B-012', 'b12'), true);
  assert.equal(B.memeNumero('B-012', 'B 12'), true);
  assert.equal(B.memeNumero('B-012', 'B-102'), false);
  // Hors schéma aussi : « Casier 07 » et « casier 7 » sont le même casier.
  assert.equal(B.memeNumero('Casier 07', 'casier 7'), true);
  // Mais deux clés de familles différentes ne se confondent pas.
  assert.equal(B.memeNumero('N12', 'B-012'), false);
});

test('l’ordre est celui du local : B-2 avant B-10', function () {
  const noms = B.trier([boite('B-010'), boite('B-002'), boite('B-001')]).map(function (b) {
    return b.numero;
  });
  assert.deepEqual(noms, ['B-001', 'B-002', 'B-010']);
});

/* ---------- les titulaires ---------- */

test('attribuer clôt une période et en ouvre une — rien n’est écrasé', function () {
  /* C'est le point du §10. Quelqu'un est relogé, le casier passe à un autre,
     et un courrier arrive trois semaines plus tard pour l'ancien titulaire :
     sans cette suite, plus rien ne dit à qui était ce casier ce jour-là. */
  let b = B.attribuer(boite('B-012'), AMINA, T);
  b = B.attribuer(b, YANNICK, T2);

  assert.equal(b.periodes.length, 2);
  assert.equal(b.periodes[0].nom, 'Amina Diallo');
  assert.equal(b.periodes[0].jusqua, T2, 'la période d’Amina est close, pas supprimée');
  assert.equal(b.periodes[1].nom, 'Yannick Mbala');
  assert.equal(b.periodes[1].jusqua, '');
  assert.equal(B.titulaireCourant(b).contactId, 'c-yannick');
  assert.equal(b.statut, 'occupee');
});

test('libérer rend le casier sans effacer qui l’occupait', function () {
  const b = B.liberer(B.attribuer(boite('B-012'), AMINA, T), 'relogée', T2);
  assert.equal(b.statut, 'libre');
  assert.equal(B.titulaireCourant(b), null);
  assert.equal(b.periodes[0].nom, 'Amina Diallo');
  assert.equal(b.periodes[0].motif, 'relogée');
});

test('la première boîte libre est celle du couloir, pas le prochain numéro', function () {
  /* Deux notions voisines et différentes : `prochainNumero` fabrique un casier
     qui n'existe pas encore, `premiereLibre` en désigne un qui attend, vide. */
  const plan = [
    B.attribuer(boite('B-001'), AMINA, T),
    boite('B-002'),
    boite('B-003', { statut: 'horsservice' })
  ];
  assert.equal(B.premiereLibre(plan).numero, 'B-002');
  assert.equal(B.prochainNumero(plan), 4);
});

test('une boîte hors service n’est pas libre, même sans titulaire', function () {
  assert.equal(B.estLibre(boite('B-001')), true);
  assert.equal(B.estLibre(boite('B-002', { statut: 'horsservice' })), false);
  assert.equal(B.estLibre(boite('B-003', { statut: 'reservee' })), false);
  assert.equal(B.estLibre(B.attribuer(boite('B-004'), AMINA, T)), false);
});

test('chaque statut porte un mot, pas seulement une couleur', function () {
  /* Un casier hors service pris pour un casier libre, c'est un courrier qu'on
     range dans une boîte dont la serrure est cassée. Une pastille de couleur
     seule ne se lit pas quand on distingue mal le rouge du vert. */
  B.STATUTS.forEach(function (s) {
    assert.ok(s.mot && s.mot.length, s.id + ' doit s’écrire en toutes lettres');
  });
  assert.equal(B.etat(boite('B-001', { statut: 'horsservice' }), 0).mot, 'hors service');
});

/* ---------- la capacité ---------- */

test('la capacité prévient avant de déborder, pas après', function () {
  const b = boite('B-001', { capacite: 10 });
  assert.equal(B.etat(b, 3).seuil, 'ok');
  assert.equal(B.etat(b, 8).seuil, 'presque');
  assert.equal(B.etat(b, 8).taux, 80);
  assert.equal(B.etat(b, 10).seuil, 'pleine');
  assert.equal(B.etat(b, 14).seuil, 'pleine');
});

test('les courriers en attente se comptent par titulaire courant', function () {
  const plan = [B.attribuer(boite('B-012'), AMINA, T), boite('B-002')];
  const history = [
    { id: 'h1', contactId: 'c-amina' },
    { id: 'h2', contactId: 'c-amina' },
    { id: 'h3', contactId: 'c-amina', pickedUpAt: T2 },
    { id: 'h4', contactId: 'c-yannick' }
  ];
  const comptes = B.comptesEnAttente(plan, history);
  assert.equal(comptes['b-B-012'], 2, 'le courrier déjà retiré ne pèse plus sur le casier');
  assert.equal(comptes['b-B-002'], 0);
});

/* ---------- la réconciliation ---------- */

test('un numéro saisi qui n’existe pas encore entre au plan', function () {
  /* Le plan du local se remplit tout seul, au fil des inscriptions. Sans ça,
     il faudrait saisir cent casiers avant de pouvoir inscrire quelqu'un. */
  const r = B.reconcilier([], AMINA, 'B-012', null, T);
  assert.equal(r.boites.length, 1);
  assert.equal(r.numero, 'B-012');
  assert.equal(B.titulaireCourant(r.boites[0]).contactId, 'c-amina');
  assert.equal(r.boites[0].statut, 'occupee');
});

test('la fiche reçoit l’orthographe de la boîte, pas celle qui vient d’être tapée', function () {
  /* « b12 », « B 12 » et « B-012 » désignaient trois casiers pour la recherche
     par boîte, et un seul dans le local. C'est la boîte qui fait autorité. */
  const plan = [boite('B-012')];
  const r = B.reconcilier(plan, AMINA, 'b12', null, T);
  assert.equal(r.numero, 'B-012');
  assert.equal(r.boites.length, 1, 'aucun casier en double n’a été fabriqué');
});

test('changer de boîte libère l’ancienne dans le même geste', function () {
  const plan = [B.attribuer(boite('B-012'), AMINA, T), boite('B-020')];
  const r = B.reconcilier(plan, AMINA, 'B-020', null, T2);
  const ancienne = r.boites.find(function (b) { return b.numero === 'B-012'; });
  const neuve = r.boites.find(function (b) { return b.numero === 'B-020'; });
  assert.equal(ancienne.statut, 'libre', 'sans ça, deux casiers restaient à son nom');
  assert.equal(ancienne.periodes[0].jusqua, T2);
  assert.equal(B.titulaireCourant(neuve).contactId, 'c-amina');
  assert.equal(r.numero, 'B-020');
});

test('vider le champ rend le casier', function () {
  const plan = [B.attribuer(boite('B-012'), AMINA, T)];
  const r = B.reconcilier(plan, AMINA, '', null, T2);
  assert.equal(r.numero, '');
  assert.equal(r.boites[0].statut, 'libre');
  assert.equal(r.boites[0].periodes[0].nom, 'Amina Diallo', 'son passage reste au casier');
});

test('réenregistrer une fiche sans changer sa boîte ne bouge rien', function () {
  /* Corriger un téléphone ne doit pas ouvrir une nouvelle période au casier :
     l'historique deviendrait une liste de non-événements. */
  const plan = [B.attribuer(boite('B-012'), AMINA, T)];
  const r = B.reconcilier(plan, AMINA, 'B-012', null, T2);
  assert.equal(r.boites[0].periodes.length, 1);
  assert.equal(r.boites[0].periodes[0].jusqua, '');
});

test('un numéro hors schéma garde son écriture', function () {
  const r = B.reconcilier([], AMINA, 'Casier 7', null, T);
  assert.equal(r.numero, 'Casier 7');
  assert.equal(r.boites[0].numero, 'Casier 7');
});

test('un numéro jamais vu garde l’écriture de celui qui l’a tapé', function () {
  /* Quelqu'un qui saisit un numéro décrit une porte du couloir. Reformater sa
     saisie — « B-12 » en « B-012 » — ferait dire à l'écran autre chose que ce
     que l'agent a sous les yeux. Le schéma n'est l'autorité que là où personne
     n'a rien tapé : quand le serveur attribue le prochain numéro. */
  assert.equal(B.reconcilier([], AMINA, 'B-12', null, T).numero, 'B-12');
  assert.equal(B.reconcilier([], AMINA, 'b12', null, T).numero, 'b12');
  assert.equal(B.reconcilier([], AMINA, 'Casier 7', null, T).numero, 'Casier 7');
  // Mais deux écritures du même numéro restent un seul casier.
  const r = B.reconcilier([], AMINA, 'B-12', null, T);
  assert.equal(B.trouverParNumero(r.boites, 'b012'), r.boites[0]);
});

/* ---------- la migration ---------- */

test('la migration ne perd aucun numéro du registre', function () {
  const registre = [AMINA, YANNICK, SARAH];
  const m = B.migrer(registre, null);
  assert.equal(m.boites.length, 2, 'deux numéros distincts, et la fiche sans boîte n’en fabrique pas');
  assert.deepEqual(m.boites.map(function (b) { return b.numero; }), ['A-03', 'B-012']);
  assert.equal(m.conflits.length, 0);
  const b012 = m.boites.find(function (b) { return b.numero === 'B-012'; });
  assert.equal(B.titulaireCourant(b012).contactId, 'c-amina');
  assert.equal(b012.statut, 'occupee');
});

test('les quatre écritures d’un même casier n’en font qu’un', function () {
  const registre = [
    { id: 'a', name: 'A', box: 'B-012', createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 'b', name: 'B', box: 'b12', createdAt: '2025-02-01T00:00:00.000Z' },
    { id: 'c', name: 'C', box: 'B 12', createdAt: '2025-03-01T00:00:00.000Z' }
  ];
  const m = B.migrer(registre, null);
  assert.equal(m.boites.length, 1);
});

test('deux fiches sur un même casier sont un conflit rendu, pas tranché en silence', function () {
  /* Soit un casier repris sans que l'ancienne fiche ait été corrigée, soit
     deux personnes qui le partagent vraiment — un couple, une famille. La
     migration ne peut pas le savoir. Elle désigne la fiche la plus récente et
     dit qui d'autre était là ; choisir sans le dire ferait disparaître
     quelqu'un du plan sans que personne ne s'en aperçoive. */
  const registre = [
    { id: 'vieux', name: 'Ancien Titulaire', box: 'B-012', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'neuf', name: 'Nouvelle Titulaire', box: 'b-012', createdAt: '2026-01-01T00:00:00.000Z' }
  ];
  const m = B.migrer(registre, null);
  assert.equal(m.boites.length, 1);
  assert.equal(B.titulaireCourant(m.boites[0]).nom, 'Nouvelle Titulaire');
  assert.equal(m.conflits.length, 1);
  assert.equal(m.conflits[0].numero, 'B-012');
  assert.equal(m.conflits[0].titulaire, 'Nouvelle Titulaire');
  assert.deepEqual(m.conflits[0].autres, [{ id: 'vieux', nom: 'Ancien Titulaire' }]);
});

test('un registre vide migre en un plan vide, sans se plaindre', function () {
  assert.deepEqual(B.migrer([], null), { boites: [], conflits: [] });
  assert.deepEqual(B.migrer(null, null), { boites: [], conflits: [] });
});

/* ---------- le miroir, et ce qui le rompt ---------- */

test('après migration, chaque titulaire porte bien le numéro de son casier', function () {
  /* L'invariant, énoncé dans un sens et un seul : le titulaire courant d'une
     boîte porte le numéro de cette boîte sur sa fiche. */
  const registre = [AMINA, YANNICK, SARAH];
  const m = B.migrer(registre, null);
  assert.deepEqual(B.incoherences(m.boites, registre), []);
});

test('une fiche qui nomme un casier occupé par quelqu’un d’autre est signalée', function () {
  const registre = [
    { id: 'vieux', name: 'Ancien Titulaire', box: 'B-012', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'neuf', name: 'Nouvelle Titulaire', box: 'B-012', createdAt: '2026-01-01T00:00:00.000Z' }
  ];
  const m = B.migrer(registre, null);
  const ecarts = B.incoherences(m.boites, registre);
  assert.equal(ecarts.length, 1);
  assert.equal(ecarts[0].type, 'titulaire-different');
  assert.equal(ecarts[0].nom, 'Ancien Titulaire');
  assert.match(ecarts[0].message, /dont le titulaire est Nouvelle Titulaire/);
});

test('une fiche qui nomme un casier absent du plan est signalée', function () {
  const ecarts = B.incoherences([], [AMINA]);
  assert.equal(ecarts.length, 1);
  assert.equal(ecarts[0].type, 'boite-absente-du-plan');
  assert.equal(ecarts[0].boite, 'B-012');
});

test('une fiche effacée ne rend pas son ancien casier incohérent', function () {
  /* Le nom reste dans l'historique du casier quand la fiche part — c'est ce
     qui permet de savoir à qui était la boîte. Ce n'est pas une anomalie. */
  const plan = [B.attribuer(boite('B-012'), AMINA, T)];
  assert.deepEqual(B.incoherences(plan, []), []);
});

/* ---------- le plan du local ---------- */

test('le plan groupe par zone, le fourre-tout en dernier', function () {
  const p = B.plan([
    boite('B-010', { zone: 'Couloir A' }),
    boite('B-002'),
    boite('B-001', { zone: 'Couloir A' }),
    boite('B-003', { zone: 'Accueil' })
  ]);
  assert.deepEqual(p.map(function (z) { return z.zone; }), ['Accueil', 'Couloir A', '']);
  assert.deepEqual(p[1].boites.map(function (b) { return b.numero; }), ['B-001', 'B-010']);
});

/* ---------- les bornes ---------- */

test('une boîte créée est bornée, comme tout ce qui vient d’un formulaire', function () {
  const b = B.creer({
    numero: '  ' + 'X'.repeat(80) + '  ',
    zone: 'Z'.repeat(100),
    motif: 'M'.repeat(400),
    capacite: 99999,
    statut: 'inventé'
  });
  assert.equal(b.numero.length, 40);
  assert.equal(b.zone.length, 60);
  assert.equal(b.motif.length, 200);
  assert.equal(b.capacite, 999);
  assert.equal(b.statut, 'libre', 'un statut inconnu retombe sur « libre », il ne passe pas');
  assert.ok(b.id);
});

test('un schéma venu des réglages est ramené dans des bornes tenables', function () {
  const s = B.schemaDe({ chiffres: 99, debut: -5, fin: -1 });
  assert.equal(s.chiffres, 8);
  assert.equal(s.debut, 0);
  assert.ok(s.fin >= s.debut);
});
