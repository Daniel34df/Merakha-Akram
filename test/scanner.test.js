'use strict';

/* Scanner un code, et savoir ce qu'il désigne.

   Le point qui compte dans tout ce fichier : **un scanner qui se trompe est
   pire qu'un scanner absent.** Au guichet, il ouvre la fiche de quelqu'un
   d'autre — avec son nom, son adresse, son courrier — devant la personne qui
   attend. Mieux vaut ne rien reconnaître que reconnaître faux.

   D'où l'ordre de reconnaissance, du plus certain au plus large, et le refus
   de deviner quand plusieurs personnes correspondent. */

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../assets/js/scanner.js');
const B = require('../assets/js/boites.js');
const cb = require('../assets/js/codebarres.js');

const AMINA = { id: 'c1', name: 'Amina Diallo', email: '', telephone: '06 12 34 56 78', box: 'B-012' };
const YANNICK = { id: 'c2', name: 'Yannick Mbala', email: 'y@exemple.org', telephone: '', box: '' };
const AMINE = { id: 'c3', name: 'Amine Diallo', email: 'amine@exemple.org', telephone: '', box: '' };

function etat(extra) {
  const boite = B.attribuer(B.creer({ id: 'b1', numero: 'B-012' }), AMINA, '2026-01-01T00:00:00.000Z');
  return Object.assign({
    contacts: [AMINA, YANNICK],
    history: [
      { id: 'h1', contactId: 'c1', name: 'Amina Diallo', pickupCode: '4821' },
      { id: 'h2', contactId: 'c2', name: 'Yannick Mbala', pickupCode: '9137', pickedUpAt: '2026-02-01' },
      { id: 'h3', contactId: 'c2', name: 'Yannick Mbala', reference: 'COUR-2026-000042' }
    ],
    boites: [boite, B.creer({ id: 'b2', numero: 'B-020' })]
  }, extra || {});
}

/* ── ce que le poste sait faire ── */

test('sans contexte sûr, la caméra est fermée — et on dit pourquoi', function () {
  /* « Ça ne marche pas » sans raison est ce qui fait renoncer. L'écran doit
     pouvoir proposer autre chose, donc le module doit lui dire quoi. */
  const c = S.capacites({ isSecureContext: false, navigator: { mediaDevices: { getUserMedia: function () {} } } });
  assert.equal(c.camera, false);
  assert.match(c.raison, /https/);
  assert.match(c.raison, /douchette/, 'et propose la solution qui, elle, marche partout');
  assert.equal(c.douchette, true, 'la douchette ne dépend de rien');
});

test('en https avec caméra, elle est ouverte', function () {
  const c = S.capacites({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia: function () {} } } });
  assert.equal(c.camera, true);
  assert.equal(c.raison, '');
});

test('un navigateur sans BarcodeDetector garde le décodeur maison', function () {
  /* C'est le cas réel : l'API native est absente du Chromium de cette machine
     et de Firefox. Le Code 39 — donc les étiquettes que l'application imprime
     elle-même — reste lisible partout. */
  const c = S.capacites({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia: function () {} } } });
  assert.equal(c.natif, false);
  assert.equal(c.code39, true);
});

test('sans navigateur du tout, rien ne jette', function () {
  const c = S.capacites();
  assert.equal(c.camera, false);
  assert.equal(c.douchette, true);
});

/* ── ce qu'un code veut dire ── */

test('un numéro de casier ouvre le casier et son titulaire', function () {
  const r = S.interpreter('B-012', etat());
  assert.equal(r.type, 'boite');
  assert.equal(r.boite.numero, 'B-012');
  assert.equal(r.contact.name, 'Amina Diallo');
  assert.match(S.libelle(r), /Casier B-012 — Amina Diallo/);
});

test('les quatre écritures d’un casier mènent au même endroit', function () {
  /* La même clé que partout ailleurs : un lecteur qui rend « b12 » ne doit pas
     échouer là où « B-012 » réussit. */
  ['B-012', 'b12', 'B 12', 'b-012'].forEach(function (c) {
    assert.equal(S.interpreter(c, etat()).type, 'boite', c);
  });
});

test('un casier libre se dit libre, il n’invente pas de titulaire', function () {
  const r = S.interpreter('B-020', etat());
  assert.equal(r.type, 'boite');
  assert.equal(r.contact, null);
  assert.match(S.libelle(r), /libre/);
});

test('un code de retrait ouvre le courrier qui attend', function () {
  const r = S.interpreter('4821', etat());
  assert.equal(r.type, 'retrait');
  assert.equal(r.courrier.name, 'Amina Diallo');
});

test('un code de retrait déjà servi n’ouvre plus rien', function () {
  /* Le courrier de Yannick est retiré depuis février. Rouvrir sa fiche sur ce
     code laisserait croire qu'il reste quelque chose à lui remettre. */
  const r = S.interpreter('9137', etat());
  assert.equal(r.type, 'inconnu');
  assert.match(S.libelle(r), /Aucun code de retrait/);
});

test('une référence de courrier est reconnue à sa forme', function () {
  const r = S.interpreter('COUR-2026-000042', etat());
  assert.equal(r.type, 'courrier');
  assert.equal(r.courrier.name, 'Yannick Mbala');
  assert.equal(S.interpreter('cour-2026-000042', etat()).type, 'courrier', 'la casse ne compte pas');
});

test('un nom vient en dernier, après tous les codes', function () {
  /* L'ordre est celui de la certitude. S'il était inversé, un nom qui
     ressemble à un numéro de casier ouvrirait la mauvaise fiche. */
  const r = S.interpreter('Amina', etat());
  assert.equal(r.type, 'contact');
  assert.equal(r.contact.id, 'c1');
});

test('plusieurs personnes correspondent : on les liste, on ne choisit pas', function () {
  /* Choisir à la place de l'agent, c'est remettre le courrier d'Amina à
     Amine. La liste est la seule réponse honnête. */
  const r = S.interpreter('Diallo', etat({ contacts: [AMINA, AMINE] }));
  assert.equal(r.type, 'plusieurs');
  assert.equal(r.contacts.length, 2);
  assert.match(S.libelle(r), /2 personnes/);
});

test('un code inconnu le dit, il ne renvoie pas au hasard', function () {
  const r = S.interpreter('ZZZZZZ', etat());
  assert.equal(r.type, 'inconnu');
  assert.match(S.libelle(r), /Aucun code ne correspond/);
});

test('un code vide ne déclenche rien', function () {
  assert.equal(S.interpreter('', etat()).type, 'vide');
  assert.equal(S.interpreter('   ', etat()).type, 'vide');
  assert.equal(S.interpreter(null, etat()).type, 'vide');
});

test('sans état, rien ne jette', function () {
  assert.equal(S.interpreter('B-012').type, 'inconnu');
  assert.equal(S.interpreter('B-012', {}).type, 'inconnu');
});

/* ── de l'image au code ── */

/** Une image RGBA contenant le code, comme une caméra la verrait. */
function image(texte, largeur, hauteur, echelle) {
  const e = echelle || 3;
  const els = cb.elements(texte);
  const colonnes = [];
  for (let i = 0; i < 20; i++) colonnes.push(255);
  els.forEach(function (el) {
    const n = (el.large ? 3 : 1) * e;
    for (let i = 0; i < n; i++) colonnes.push(el.barre ? 15 : 245);
  });
  while (colonnes.length < largeur) colonnes.push(255);

  const d = new Uint8ClampedArray(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y++) {
    for (let x = 0; x < largeur; x++) {
      const v = colonnes[x] === undefined ? 255 : colonnes[x];
      const i = (y * largeur + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  return d;
}

test('une image contenant une étiquette se lit', function () {
  const largeur = 400;
  const hauteur = 60;
  assert.equal(S.lireImage(image('B-012', largeur, hauteur), largeur, hauteur), 'B-012');
});

test('une étiquette photographiée tête-bêche se lit aussi', function () {
  /* Un cas courant au comptoir, et le Code 39 se lit dans les deux sens :
     refuser une étiquette à l'envers serait un refus gratuit. */
  const largeur = 400;
  const hauteur = 40;
  const d = image('B-012', largeur, hauteur);
  const envers = new Uint8ClampedArray(d.length);
  for (let y = 0; y < hauteur; y++) {
    for (let x = 0; x < largeur; x++) {
      const src = (y * largeur + (largeur - 1 - x)) * 4;
      const dst = (y * largeur + x) * 4;
      envers[dst] = d[src]; envers[dst + 1] = d[src + 1];
      envers[dst + 2] = d[src + 2]; envers[dst + 3] = 255;
    }
  }
  assert.equal(S.lireImage(envers, largeur, hauteur), 'B-012');
});

test('une image sans code rend null', function () {
  const largeur = 100;
  const hauteur = 20;
  const d = new Uint8ClampedArray(largeur * hauteur * 4).fill(200);
  assert.equal(S.lireImage(d, largeur, hauteur), null);
  assert.equal(S.lireImage(null, largeur, hauteur), null);
  assert.equal(S.lireImage(d, 0, 0), null);
});
