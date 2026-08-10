'use strict';

/* Le colis.

   Ce que ces tests gardent fermé : un colis encombrant posé quelque part dans
   le local sans que personne n'ait noté où. Il n'est alors pas perdu au sens
   comptable — il est dans le registre, il a un code de retrait — mais il est
   introuvable pour tout le monde sauf pour celui qui l'a posé, et celui-là est
   en congé.

   Le reste (transporteur, numéro de suivi, poids) est utile et jamais exigé :
   un formulaire qui réclame huit champs pour un paquet de chaussettes finit
   rempli n'importe comment, et ce qui est rempli n'importe comment ne se
   relit pas. */

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../assets/js/colis.js');

/* ── le numéro de suivi ── */

test('un numéro recopié à la main est le même numéro', function () {
  /* Les étiquettes l'impriment par groupes de quatre, et personne ne remet les
     mêmes espaces au même endroit. */
  const n = '6A123456789FR';
  ['6A 1234 5678 9FR', '6a123456789fr', '6A-1234-56789-FR', ' 6A123456789FR '].forEach(function (t) {
    assert.equal(C.normaliserSuivi(t), n, t);
  });
  assert.equal(C.normaliserSuivi(null), '');
});

test('le transporteur se devine du numéro, et reste une proposition', function () {
  assert.equal(C.deviner('1Z999AA10123456784'), 'ups');
  assert.equal(C.deviner('12345678'), 'mondialrelay');
  assert.equal(C.deviner('6A 1234 5678 9FR'), 'colissimo');
  /* Chronopost commence par deux lettres, Colissimo par un chiffre. C'est ce
     qui les sépare, et c'est pour ça que Colissimo ne réclame pas les numéros
     en « C… » : il aurait volé tous les Chronopost commençant par un C. */
  assert.equal(C.deviner('CY123456789FR'), 'chronopost');
});

test('un numéro qui ne ressemble à rien ne désigne personne', function () {
  /* Deviner faux enverrait l'agent sur le mauvais site du transporteur, ce qui
     est pire que ne rien proposer : il croirait que le colis n'existe pas. */
  assert.equal(C.deviner('bonjour'), null);
  assert.equal(C.deviner('123'), null, 'trop court pour engager quoi que ce soit');
  assert.equal(C.deviner(''), null);
  assert.equal(C.deviner(null), null);
});

test('le lien de suivi se fabrique, il ne s’appelle pas', function () {
  /* Consulter automatiquement dirait à un tiers, à chaque affichage de la
     liste, que telle personne domiciliée à telle adresse attend tel colis.
     C'est l'agent qui ouvre le lien — c'est son geste. */
  const lien = C.lienSuivi('chronopost', 'XY 1234 5678 9FR');
  assert.match(lien, /^https:\/\/www\.chronopost\.fr\//);
  assert.match(lien, /XY123456789FR$/);
  assert.equal(C.lienSuivi('amazon', '123456789012'), '', 'sans adresse de suivi, pas de lien');
  assert.equal(C.lienSuivi('chronopost', ''), '', 'sans numéro non plus');
  assert.equal(C.lienSuivi('inconnu', '123456789012'), '');
});

/* ── l'encombrement, qui décide du reste ── */

test('un colis lourd ou long ne tient pas dans un casier', function () {
  assert.equal(C.encombrant({ poids: 12 }), true, 'douze kilos');
  assert.equal(C.encombrant({ poids: '2,5' }), false, 'la virgule décimale se lit');
  assert.equal(C.encombrant({ longueur: 100, largeur: 8, hauteur: 8 }), true,
    'un tube d’un mètre pèse deux kilos et ne rentre nulle part');
  assert.equal(C.encombrant({ longueur: 20, largeur: 15, hauteur: 10 }), false);
  assert.equal(C.encombrant({}), false);
  assert.equal(C.encombrant(null), false);
});

test('le seuil suit le local, il n’est pas gravé', function () {
  const petit = { poidsKg: 1, cotecm: 10 };
  assert.equal(C.encombrant({ poids: 2 }, petit), true);
  assert.equal(C.encombrant({ poids: 2 }), false, 'avec le seuil ordinaire, non');
});

/* ── ce qui est exigé, et ce qui ne l'est pas ── */

test('un colis encombrant doit dire où il est rangé', function () {
  const m = C.manques({ poids: 12 });
  assert.equal(m.length, 1);
  assert.equal(m[0].champ, 'emplacement');
  assert.match(m[0].message, /retrouver/);
  assert.deepEqual(C.manques({ poids: 12, emplacement: 'étagère du fond, à droite' }), []);
});

test('un petit colis ne réclame rien', function () {
  /* Il va dans le casier de la personne, comme une lettre. Demander « où
     l’avez-vous mis » pour une boîte qui tient dans B-012 serait une question
     pour rien — et une question pour rien apprend à ne pas répondre. */
  assert.deepEqual(C.manques({ poids: 0.4, longueur: 20, largeur: 15, hauteur: 5 }), []);
  assert.deepEqual(C.manques({}), []);
  assert.deepEqual(C.manques(null), []);
});

/* ── le nettoyage ── */

test('un colis sans rien dedans n’est pas un colis', function () {
  /* Un objet vide laisserait croire que quelqu'un a rempli quelque chose. */
  assert.equal(C.nettoyer({}), null);
  assert.equal(C.nettoyer(null), null);
  assert.equal(C.nettoyer({ poids: '', suivi: '', emplacement: '  ' }), null);
});

test('le nettoyage garde ce qui vaut, et devine le transporteur au passage', function () {
  const c = C.nettoyer({ poids: '3,2', suivi: '1z999aa1 0123456784', emplacement: '  Étagère B  ' });
  assert.equal(c.poids, 3.2);
  assert.equal(c.suivi, '1Z999AA10123456784');
  assert.equal(c.transporteur, 'ups', 'deviné faute d’avoir été choisi');
  assert.equal(c.emplacement, 'Étagère B');
});

test('un poids absurde ne passe pas', function () {
  const c = C.nettoyer({ poids: '-5', longueur: 'beaucoup', suivi: 'AB123456789FR' });
  assert.equal(c.poids, 0);
  assert.equal(c.longueur, 0);
});

test('le nom libre ne sert qu’avec « Autre transporteur »', function () {
  /* Sinon un même colis aurait deux noms possibles — celui de la liste et
     celui tapé à la main — et on ne saurait plus lequel croire. */
  const a = C.nettoyer({ transporteur: 'autre', transporteurNom: 'Transports Diallo', suivi: 'X1' });
  assert.equal(a.transporteurNom, 'Transports Diallo');
  const b = C.nettoyer({ transporteur: 'chronopost', transporteurNom: 'Transports Diallo', suivi: 'X1' });
  assert.equal(b.transporteurNom, '', 'ignoré : le transporteur est déjà nommé');
});

/* ── ce qu'on en lit ── */

test('la ligne du guichet dit d’abord où il est', function () {
  /* Quelqu'un attend devant le comptoir. Ce qu'il faut d'abord, c'est aller le
     chercher — le transporteur et le poids viennent après. */
  const ligne = C.resume({
    emplacement: 'étagère du fond', transporteur: 'chronopost',
    suivi: 'XY123456789FR', poids: 8, longueur: 40, largeur: 30, hauteur: 20
  });
  assert.ok(ligne.indexOf('rangé : étagère du fond') === 0, ligne);
  assert.match(ligne, /Chronopost/);
  assert.match(ligne, /8 kg/);
  assert.match(ligne, /40×30×20 cm/);
  assert.equal(C.resume({}), '');
  assert.equal(C.resume(null), '');
});

test('un transporteur nommé à la main s’affiche sous son nom', function () {
  const ligne = C.resume({ transporteur: 'autre', transporteurNom: 'Transports Diallo', suivi: 'X9' });
  assert.match(ligne, /Transports Diallo/);
  assert.ok(!/Autre transporteur/.test(ligne));
});
