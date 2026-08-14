'use strict';

/* La référence d'un courrier.

   « COUR-2026-000042 » se dit au téléphone, se note au crayon sur une
   enveloppe, se scanne, et ne désigne qu'un seul courrier pour toujours —
   même retiré, même archivé. Le code de retrait à quatre chiffres, lui, cesse
   de vouloir dire quoi que ce soit une fois le courrier remis. */

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../assets/js/reference.js');

test('une référence s’écrit et se relit', function () {
  assert.equal(R.formater(42, 2026), 'COUR-2026-000042');
  assert.equal(R.formater(1, 2026), 'COUR-2026-000001');
  assert.deepEqual(R.lire('COUR-2026-000042'), { prefixe: 'COUR', annee: 2026, numero: 42 });
  assert.equal(R.lire('cour-2026-000042').numero, 42, 'la casse ne compte pas quand on la dicte');
});

test('ce qui n’est pas une référence rend null', function () {
  ['', 'COUR-2026', '2026-000042', 'COUR-26-000042', 'B-012', '4821', null]
    .forEach(function (t) {
      assert.equal(R.lire(t), null, JSON.stringify(t));
    });
  assert.equal(R.estReference('COUR-2026-000042'), true);
  assert.equal(R.estReference('B-012'), false);
});

test('le compteur repart à un chaque année', function () {
  /* C'est ce qui garde le numéro court et lisible longtemps. Sans l'année, il
     faudrait six chiffres qui ne veulent rien dire. */
  const h = [
    { reference: 'COUR-2025-000310' },
    { reference: 'COUR-2026-000002' },
    { reference: 'COUR-2026-000001' }
  ];
  assert.equal(R.prochain(h, 2026), 3);
  assert.equal(R.prochain(h, 2027), 1, 'la nouvelle année repart de zéro');
  assert.equal(R.suivante(h, 2026), 'COUR-2026-000003');
});

test('deux antennes comptent chacune de leur côté', function () {
  const h = [{ reference: 'COUR-2026-000009' }, { reference: 'PAR-2026-000002' }];
  assert.equal(R.prochain(h, 2026, 'PAR'), 3);
  assert.equal(R.prochain(h, 2026, 'COUR'), 10);
  assert.equal(R.prochain(h, 2026, 'LYO'), 1, 'une antenne neuve part de un');
});

test('un historique sans référence part de un', function () {
  assert.equal(R.prochain([], 2026), 1);
  assert.equal(R.prochain(null, 2026), 1);
  assert.equal(R.prochain([{ id: 'h1' }, { reference: '' }], 2026), 1);
});

test('le compteur se déduit de l’existant, pas d’un compteur rangé à part', function () {
  /* Un compteur séparé se désynchronise à la première restauration de
     sauvegarde, et personne ne s'en aperçoit avant d'avoir deux courriers
     COUR-2026-000017. Ici, le maximum réellement présent fait foi — même si
     des références manquent au milieu. */
  const h = [{ reference: 'COUR-2026-000017' }, { reference: 'COUR-2026-000003' }];
  assert.equal(R.prochain(h, 2026), 18);
});

test('un préfixe se dicte au téléphone : lettres, majuscules, court', function () {
  assert.equal(R.nettoyerPrefixe('créteil'), 'CRETEI', 'les accents tombent, six lettres au plus');
  assert.equal(R.nettoyerPrefixe('par-11'), 'PAR');
  assert.equal(R.nettoyerPrefixe('x'), 'COUR', 'trop court : on retombe sur le défaut');
  assert.equal(R.nettoyerPrefixe(''), 'COUR');
  assert.equal(R.nettoyerPrefixe('123'), 'COUR');
});

test('le préfixe d’une antenne vient de son nom', function () {
  assert.equal(R.prefixeAntenne({ nom: 'Paris 11e' }), 'PAR');
  assert.equal(R.prefixeAntenne({ nom: 'Lyon' }), 'LYO');
  assert.equal(R.prefixeAntenne(null), 'COUR', 'sans antenne, le préfixe du bureau');
  assert.equal(R.prefixeAntenne({ nom: '' }, 'BDC'), 'BDC');
});

test('une référence formée se relit toujours — l’aller-retour', function () {
  [1, 7, 42, 999, 123456].forEach(function (n) {
    [2024, 2026, 2099].forEach(function (a) {
      ['COUR', 'PAR', 'LYO'].forEach(function (p) {
        const r = R.lire(R.formater(n, a, p));
        assert.deepEqual(r, { prefixe: p, annee: a, numero: n });
      });
    });
  });
});
