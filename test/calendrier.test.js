'use strict';

/* Le calendrier des échéances.

   Ce que ces tests gardent fermé : douze renouvellements le même mardi. Une
   domiciliation se renouvelle en présence de la personne ; douze rendez-vous
   le même jour, ce sont des attestations qui expirent — et une attestation
   expirée, c'est une adresse qui ne vaut plus pour la CAF ni pour l'assurance
   maladie. Vu un mois à l'avance, ça s'étale. Vu le jour même, non.

   Deux règles qui paraissent anodines et ne le sont pas :

     · les jours vides restent affichés — ce sont les creux qui servent, quand
       il s'agit de déplacer un rendez-vous ;
     · une échéance dépassée reste à sa date au lieu de disparaître. La sortir
       du calendrier effacerait la trace de ce qui n'a pas été fait, à
       l'endroit précis où l'on regarde pour le savoir. */

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../assets/js/calendrier.js');

/* Août 2026 : le 1er tombe un samedi, le mois compte 31 jours. Un mois qui
   déborde des deux côtés — c'est le cas qui casse les grilles naïves. */
const AOUT = '2026-08-15T12:00:00.000Z';

function domicilie(nom, depuis, extra) {
  return Object.assign({ id: 'c-' + nom, name: nom, domicilie: true, domicilieDepuis: depuis }, extra || {});
}

/* Douze mois de validité par défaut : une élection au 20 août 2025 vient à
   échéance le 20 août 2026. */
const VIDE = { contacts: [], history: [], settings: {} };

/* ── la grille ── */

test('la semaine commence le lundi, pas le dimanche', function () {
  /* `getDay()` rend 0 pour dimanche. Reprendre ce chiffre tel quel décalerait
     toute la grille d'un jour, et chaque échéance avec elle. */
  assert.deepEqual(C.JOURS[0], 'lundi');
  const g = C.grille('2026-08');
  assert.equal(g[0].length, 7);
  // Le 1er août 2026 est un samedi : la première semaine commence le 27 juillet.
  assert.equal(g[0][0].jour, '2026-07-27');
  assert.equal(g[0][5].jour, '2026-08-01');
});

test('les jours des mois voisins restent dans la grille, marqués', function () {
  /* Les faire disparaître laisserait des trous, et une échéance tombant le 1er
     serait invisible depuis le mois d'avant — c'est-à-dire au moment où l'on
     prépare. */
  const g = C.grille('2026-08');
  assert.equal(g[0][0].hors, true, 'le 27 juillet est hors du mois');
  assert.equal(g[0][5].hors, false, 'le 1er août y est');
  const plat = g.flat();
  assert.equal(plat.filter(function (c) { return !c.hors; }).length, 31, 'les 31 jours d’août');
});

test('la grille couvre tout le mois, quel que soit le mois', function () {
  ['2026-01', '2026-02', '2024-02', '2026-08', '2026-11', '2027-05'].forEach(function (m) {
    const plat = C.grille(m).flat();
    const dedans = plat.filter(function (c) { return !c.hors; });
    const attendu = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
    assert.equal(dedans.length, attendu, m + ' : ' + attendu + ' jours');
    assert.equal(plat.length % 7, 0, m + ' : des semaines entières');
  });
});

test('février bissextile compte ses vingt-neuf jours', function () {
  assert.equal(C.grille('2024-02').flat().filter(function (c) { return !c.hors; }).length, 29);
  assert.equal(C.grille('2026-02').flat().filter(function (c) { return !c.hors; }).length, 28);
});

test('un mois qui n’en est pas un rend une grille vide plutôt qu’une exception', function () {
  assert.deepEqual(C.grille(''), []);
  assert.deepEqual(C.grille('n’importe quoi'), []);
  assert.deepEqual(C.grille(null), []);
});

/* ── se déplacer dans les mois ── */

test('le mois précédent et le suivant se calculent sans se tromper d’année', function () {
  assert.equal(C.decalerMois('2026-08', 1), '2026-09');
  assert.equal(C.decalerMois('2026-12', 1), '2027-01', 'décembre mène à janvier de l’an suivant');
  assert.equal(C.decalerMois('2026-01', -1), '2025-12');
  assert.equal(C.decalerMois('2026-03', -3), '2025-12');
});

test('le mois se nomme en français', function () {
  assert.equal(C.libelleMois('2026-08'), 'août 2026');
  assert.equal(C.libelleMois('2026-01'), 'janvier 2026');
});

/* ── les échéances rangées par jour ── */

test('chaque échéance tombe dans sa case', function () {
  const m = C.mois(
    { contacts: [domicilie('Amina Diallo', '2025-08-20')], history: [], settings: {} },
    { at: AOUT }
  );
  const cases = m.semaines.flat().filter(function (c) { return c.n > 0; });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].jour, '2026-08-20');
  assert.equal(cases[0].echeances[0].contact.name, 'Amina Diallo');
  assert.equal(m.total, 1);
});

test('les jours sans rien restent affichés', function () {
  /* Ce sont les creux qui servent quand il faut déplacer un rendez-vous. Un
     calendrier qui n'afficherait que les jours chargés ne les montrerait plus. */
  const m = C.mois(
    { contacts: [domicilie('Amina Diallo', '2025-08-20')], history: [], settings: {} },
    { at: AOUT }
  );
  const vides = m.semaines.flat().filter(function (c) { return !c.hors && c.n === 0; });
  assert.equal(vides.length, 30, 'trente jours d’août sans échéance, tous visibles');
});

test('une journée chargée se signale avant d’être ingérable', function () {
  /* Le seuil n'interdit rien : il fait voir le paquet assez tôt pour l'étaler
     sur la semaine. */
  const contacts = [];
  for (let i = 0; i < 5; i++) contacts.push(domicilie('Personne ' + i, '2025-08-20'));
  const m = C.mois({ contacts: contacts, history: [], settings: {} }, { at: AOUT });
  assert.equal(m.chargees.length, 1);
  assert.equal(m.chargees[0].jour, '2026-08-20');
  assert.equal(m.chargees[0].n, 5);
  assert.match(C.phrase(m), /journée chargée/);
});

test('trois le même jour ne sont pas encore une journée chargée', function () {
  const contacts = [];
  for (let i = 0; i < 3; i++) contacts.push(domicilie('Personne ' + i, '2025-08-20'));
  const m = C.mois({ contacts: contacts, history: [], settings: {} }, { at: AOUT });
  assert.deepEqual(m.chargees, []);
  assert.match(C.phrase(m), /3 échéances/);
});

test('le seuil suit le bureau, il n’est pas gravé', function () {
  const contacts = [domicilie('A', '2025-08-20'), domicilie('B', '2025-08-20')];
  const m = C.mois({ contacts: contacts, history: [], settings: {} }, { at: AOUT, jourCharge: 2 });
  assert.equal(m.chargees.length, 1);
});

test('les noms d’une même journée sont rangés par ordre alphabétique', function () {
  /* L'agent lit la case pour convoquer : il doit retrouver un nom, pas
     parcourir une liste dans l'ordre où le fichier a été écrit. */
  const m = C.mois(
    {
      contacts: [domicilie('Zoé Martin', '2025-08-20'), domicilie('Amina Diallo', '2025-08-20')],
      history: [], settings: {}
    },
    { at: AOUT }
  );
  const jour = m.semaines.flat().find(function (c) { return c.jour === '2026-08-20'; });
  assert.deepEqual(jour.echeances.map(function (e) { return e.contact.name; }),
    ['Amina Diallo', 'Zoé Martin']);
});

/* ── ce qui est passé ── */

test('une échéance dépassée reste à sa date, marquée', function () {
  /* La sortir du calendrier effacerait la trace de ce qui n'a pas été fait, à
     l'endroit précis où l'on regarde pour le savoir. */
  const m = C.mois(
    { contacts: [domicilie('Amina Diallo', '2025-08-03')], history: [], settings: {} },
    { at: AOUT }
  );
  const jour = m.semaines.flat().find(function (c) { return c.jour === '2026-08-03'; });
  assert.equal(jour.n, 1, 'elle est toujours dans la grille');
  assert.equal(jour.echeances[0].expiree, true);
  assert.equal(jour.passe, true);
  assert.equal(m.expirees, 1);
  assert.match(C.phrase(m), /dépassée/);
});

test('ce qui est dépassé passe avant ce qui est chargé', function () {
  /* Une échéance dépassée, c'est quelqu'un qui perd un droit maintenant. Une
     journée chargée, c'est un problème d'organisation. */
  const contacts = [domicilie('En retard', '2025-08-03')];
  for (let i = 0; i < 5; i++) contacts.push(domicilie('Personne ' + i, '2025-08-25'));
  const m = C.mois({ contacts: contacts, history: [], settings: {} }, { at: AOUT });
  assert.equal(m.expirees, 1);
  assert.equal(m.chargees.length, 1);
  assert.match(C.phrase(m), /dépassée/, 'le retard est annoncé en premier');
});

test('le jour même est marqué', function () {
  const m = C.mois(VIDE, { at: AOUT });
  const jour = m.semaines.flat().find(function (c) { return c.aujourdhui; });
  assert.ok(jour, 'le 15 août est reconnu');
  assert.equal(jour.jour, '2026-08-15');
  assert.equal(jour.passe, false);
});

/* ── qui figure au calendrier ── */

test('une domiciliation close ne prend plus de place', function () {
  /* Elle est terminée : la personne a été relogée, ou est partie. Lui garder
     une échéance ferait convoquer quelqu'un qui n'a plus de dossier. */
  const m = C.mois(
    {
      contacts: [domicilie('Amina Diallo', '2025-08-20', { domiciliationCloseLe: '2026-02-01' })],
      history: [], settings: {}
    },
    { at: AOUT }
  );
  assert.equal(m.total, 0);
});

test('une personne non domiciliée n’a pas d’échéance', function () {
  const m = C.mois(
    { contacts: [{ id: 'c1', name: 'Marc Petit' }], history: [], settings: {} },
    { at: AOUT }
  );
  assert.equal(m.total, 0);
  assert.match(C.phrase(m), /Aucune échéance/);
});

test('un autre mois ne montre pas les échéances de celui-ci', function () {
  const m = C.mois(
    { contacts: [domicilie('Amina Diallo', '2025-08-20')], history: [], settings: {} },
    { at: AOUT, mois: '2026-09' }
  );
  assert.equal(m.total, 0);
  assert.equal(m.libelle, 'septembre 2026');
});

test('la durée de validité du bureau est respectée', function () {
  /* Un bureau qui délivre des attestations de six mois n'a pas les mêmes
     échéances qu'un bureau qui en délivre de douze. */
  const m = C.mois(
    {
      contacts: [domicilie('Amina Diallo', '2026-02-20')],
      history: [],
      settings: { domiciliationMois: 6 }
    },
    { at: AOUT }
  );
  assert.equal(m.total, 1, 'six mois après février, l’échéance tombe en août');
});

/* ── robustesse ── */

test('des données absentes ou abîmées ne font pas tomber le calendrier', function () {
  assert.doesNotThrow(function () { C.mois(null, { at: AOUT }); });
  assert.doesNotThrow(function () { C.mois({}, { at: AOUT }); });
  assert.doesNotThrow(function () {
    C.mois({ contacts: [null, { domicilie: true }], history: [null] }, { at: AOUT });
  });
  assert.equal(C.phrase(null), '');
});
