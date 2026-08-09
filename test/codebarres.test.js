'use strict';

/* Le code à barres de l'attestation.
 *
 * Un code faux ne se voit pas : il s'imprime, il a l'air d'un code à barres, et
 * c'est le lecteur du guichet qui découvre le problème — devant la personne.
 * D'où des tests qui comparent les motifs à la table de la norme, caractère par
 * caractère, plutôt que de constater « ça produit du HTML ». */

const test = require('node:test');
const assert = require('node:assert/strict');
const cb = require('../assets/js/codebarres.js');

/** La suite « nw » d'un caractère, telle que le module la rend. */
function motif(caractere) {
  return cb.MOTIFS[caractere];
}

test('chaque caractère vaut neuf éléments, trois larges et six étroits', function () {
  /* C'est la règle qui donne son nom au Code 39, et la seule qui se vérifie
     sans lecteur : un motif qui s'en écarte ne sera pas lu. */
  Object.keys(cb.MOTIFS).forEach(function (c) {
    const m = motif(c);
    assert.equal(m.length, 9, 'motif de « ' + c + ' » : ' + m);
    const larges = m.split('').filter(function (x) { return x === 'w'; }).length;
    assert.equal(larges, 3, '« ' + c +' » a ' + larges + ' éléments larges');
  });
});

test('les motifs sont ceux de la norme', function () {
  // Quelques-uns, relevés sur la table de référence.
  assert.equal(motif('0'), 'nnnwwnwnn');
  assert.equal(motif('1'), 'wnnwnnnnw');
  assert.equal(motif('9'), 'nnwwnnwnn');
  assert.equal(motif('A'), 'wnnnnwnnw');
  assert.equal(motif('B'), 'nnwnnwnnw');
  assert.equal(motif('Z'), 'nwwnwnnnn');
  assert.equal(motif('-'), 'nwnnnnwnw');
  assert.equal(motif('*'), 'nwnnwnwnn', 'le délimiteur');
});

test('deux caractères n’ont jamais le même motif', function () {
  // Sinon le lecteur rendrait l'un pour l'autre, en silence.
  const vus = new Map();
  Object.keys(cb.MOTIFS).forEach(function (c) {
    const m = motif(c);
    assert.ok(!vus.has(m), '« ' + c + ' » et « ' + vus.get(m) + ' » partagent ' + m);
    vus.set(m, c);
  });
});

/* ---------- ce qu'on accepte d'encoder ---------- */

test('le texte est ramené à ce que le Code 39 sait écrire', function () {
  assert.equal(cb.normaliser('b-12'), 'B-12');
  assert.equal(cb.normaliser('Boîte 7'), 'BOITE 7', 'les accents tombent, le lecteur ne les rend pas');
  assert.equal(cb.normaliser('  A1  '), '  A1  '.toUpperCase());
});

test('ce qui n’est pas codable est retiré, pas rejeté', function () {
  /* Une attestation doit sortir. Un caractère exotique dans un numéro de boîte
     ne doit pas empêcher l'impression — il disparaît du code, le nom reste
     lisible en clair juste à côté. */
  assert.equal(cb.normaliser('B#12'), 'B12');
  assert.equal(cb.normaliser('日本'), '');
  assert.equal(cb.normaliser(null), '');
  assert.equal(cb.normaliser(undefined), '');
});

test('l’astérisque ne s’encode pas : il ne sert qu’à délimiter', function () {
  assert.equal(cb.estCodable('*'), false);
  assert.equal(cb.normaliser('A*B'), 'AB', 'sinon la lecture s’arrêterait au milieu');
});

/* ---------- la suite des barres ---------- */

test('le code est encadré du délimiteur, aux deux bouts', function () {
  const els = cb.elements('A');
  // * + séparateur + A + séparateur + *  =  9 + 1 + 9 + 1 + 9
  assert.equal(els.length, 29);

  const neufPremiers = els.slice(0, 9).map(function (e) { return e.large ? 'w' : 'n'; }).join('');
  const neufDerniers = els.slice(-9).map(function (e) { return e.large ? 'w' : 'n'; }).join('');
  assert.equal(neufPremiers, motif('*'), 'le lecteur doit savoir où commencer');
  assert.equal(neufDerniers, motif('*'), 'et où finir');
});

test('barres et espaces alternent, en commençant par une barre', function () {
  const els = cb.elements('B-12');
  assert.equal(els[0].barre, true);
  // Dans chaque motif de neuf, les rangs pairs sont des barres.
  const suite = cb.elements('0');
  suite.slice(0, 9).forEach(function (el, i) {
    assert.equal(el.barre, i % 2 === 0, 'élément ' + i);
  });
});

test('les caractères sont séparés par un espace étroit', function () {
  /* Sans lui, deux caractères se toucheraient et le lecteur lirait autre
     chose. C'est un espace, jamais une barre, et toujours étroit. */
  const els = cb.elements('AB');
  const separateur = els[9];
  assert.equal(separateur.barre, false);
  assert.equal(separateur.large, false);
});

test('un texte vide ne produit aucune barre', function () {
  assert.deepEqual(cb.elements(''), []);
  assert.deepEqual(cb.elements('日本'), [], 'rien de codable : rien à imprimer');
  assert.equal(cb.html(''), '');
});

/* ---------- le rendu ---------- */

test('le code reste écrit en clair sous les barres', function () {
  /* Un lecteur en panne, une impression pâle : l'attestation doit rester
     utilisable à l'œil. C'est le garde-fou du papier. */
  const h = cb.html('B-12');
  assert.match(h, /cb-legende">B-12</);
  assert.match(h, /aria-label="Code B-12"/, 'et lisible par une synthèse vocale');
});

test('les barres larges valent trois fois les étroites', function () {
  const h = cb.html('0', { etroit: 2 });
  assert.match(h, /width:2px/);
  assert.match(h, /width:6px/);
  assert.ok(!/width:4px/.test(h), 'deux largeurs seulement, pas trois');
});

test('la légende peut se taire quand la place manque', function () {
  const h = cb.html('B-12', { avecTexte: false });
  assert.ok(!/cb-legende/.test(h));
  assert.match(h, /cb-barre/, 'les barres restent');
});

test('le rendu n’ouvre pas la porte à du HTML injecté', function () {
  // La normalisation écarte < > & " avant même le rendu, mais on le vérifie.
  const h = cb.html('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(h));
});

test('la zone de silence encadre le code, à dix fois la largeur d’un trait', function () {
  /* C'est le défaut classique du code à barres fait maison : les barres sont
     justes, mais sans marge blanche le lecteur ne trouve pas le début et
     refuse de lire. Invisible à l'œil, fatal au comptoir. */
  assert.match(cb.html('B-12', { etroit: 2 }), /padding-left:20px/);
  assert.match(cb.html('B-12', { etroit: 2 }), /padding-right:20px/);
  // Elle suit la largeur des barres, sans quoi elle ne vaudrait rien.
  assert.match(cb.html('B-12', { etroit: 3 }), /padding-left:30px/);
});
