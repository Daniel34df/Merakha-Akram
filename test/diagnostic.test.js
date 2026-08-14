'use strict';

/* Le diagnostic de l'installation.

   Ce que ces tests gardent fermé : un écran qui rassure à tort. Cette
   application est installée par un bureau, pas par un service informatique.
   Personne ne surveille le disque et personne ne relit les journaux — jusqu'au
   jour où le disque lâche et où le registre des domiciliations disparaît. Ce
   registre-là, ce sont des gens dont l'adresse administrative n'existe que
   dans ce fichier.

   La règle la plus importante ici : **ce qui n'a pas pu être observé rend
   « inconnu », jamais « bon »**. Dire « tout va bien » sans avoir regardé est
   la seule façon de rendre cet écran nuisible — il empêcherait quelqu'un
   d'aller voir. */

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../assets/js/diagnostic.js');

const MAINTENANT = '2026-08-10T12:00:00.000Z';

function ilYA(n) {
  return new Date(Date.parse(MAINTENANT) - n * 86400000).toISOString();
}

/* Une installation en ordre, dont on part pour n'abîmer qu'une chose à la fois. */
const SAINE = {
  sauvegardes: [{ at: ilYA(1), fichier: 'registre-2026-08-09.json' }],
  codeMaitreDefaut: false,
  disqueLibrePourcent: 62,
  registreEcrivable: true,
  courriel: true,
  reseau: true,
  https: true,
  integrite: 'ok'
};

function point(obs, cle) {
  return D.bilan(obs, { at: MAINTENANT }).find(function (c) { return c.cle === cle; });
}

test('une installation en ordre le dit, et rien ne remonte', function () {
  const b = D.bilan(SAINE, { at: MAINTENANT });
  assert.ok(b.every(function (c) { return c.niveau === 'bon'; }),
    b.filter(function (c) { return c.niveau !== 'bon'; }).map(function (c) { return c.cle; }).join(', '));
  assert.match(D.phrase(b), /Rien à signaler/);
});

/* ── la règle qui compte le plus ── */

test('ce qui n’a pas été observé rend « inconnu », jamais « bon »', function () {
  /* Un bilan vide qui dirait « tout va bien » empêcherait quelqu'un d'aller
     voir. C'est la seule façon de rendre cet écran nuisible. */
  const b = D.bilan({}, { at: MAINTENANT });
  assert.ok(b.length > 0, 'un bilan vide n’est pas un bilan');
  assert.ok(b.every(function (c) { return c.niveau === 'inconnu'; }),
    'tous les points sont inconnus quand rien n’a été observé');
  assert.match(D.phrase(b), /n’ont pas pu être vérifiés/);
  assert.equal(D.bilan(null, { at: MAINTENANT }).length, b.length);
});

/* ── les sauvegardes ── */

test('aucune sauvegarde est le point le plus grave d’une installation', function () {
  /* Tout le reste se répare ; un registre perdu, non. */
  const c = point(Object.assign({}, SAINE, { sauvegardes: [] }), 'sauvegarde');
  assert.equal(c.niveau, 'grave');
  assert.match(c.faire, /USB|clé/i, 'la consigne dit d’en sortir une copie de la machine');
});

test('l’ancienneté d’une sauvegarde se gradue', function () {
  assert.equal(point(Object.assign({}, SAINE, { sauvegardes: [{ at: ilYA(2) }] }), 'sauvegarde').niveau, 'bon');
  assert.equal(point(Object.assign({}, SAINE, { sauvegardes: [{ at: ilYA(9) }] }), 'sauvegarde').niveau, 'attention');
  assert.equal(point(Object.assign({}, SAINE, { sauvegardes: [{ at: ilYA(45) }] }), 'sauvegarde').niveau, 'grave');
});

test('un dossier de sauvegardes illisible n’est pas un dossier vide', function () {
  /* « Je n'ai pas pu lire » et « il n'y a rien » appellent deux gestes
     différents, et confondre les deux ferait sauvegarder par-dessus. */
  assert.equal(point(Object.assign({}, SAINE, { sauvegardes: null }), 'sauvegarde').niveau, 'inconnu');
  assert.equal(point(Object.assign({}, SAINE, { sauvegardes: [{ at: 'illisible' }] }), 'sauvegarde').niveau, 'inconnu');
});

/* ── le code de reprise ── */

test('le code de reprise d’usine est signalé comme grave', function () {
  /* Il est publié avec le code source : il ouvre le compte responsable, et
     avec lui tout le registre des personnes domiciliées. */
  const c = point(Object.assign({}, SAINE, { codeMaitreDefaut: true }), 'codeMaitre');
  assert.equal(c.niveau, 'grave');
  assert.match(c.faire, /MASTER_CODE/);
  assert.match(c.dit, /publié/);
});

/* ── le disque ── */

test('un disque qui se remplit se gradue avant d’être plein', function () {
  assert.equal(point(Object.assign({}, SAINE, { disqueLibrePourcent: 3 }), 'disque').niveau, 'grave');
  assert.equal(point(Object.assign({}, SAINE, { disqueLibrePourcent: 11 }), 'disque').niveau, 'attention');
  assert.equal(point(Object.assign({}, SAINE, { disqueLibrePourcent: 40 }), 'disque').niveau, 'bon');
  assert.equal(point(Object.assign({}, SAINE, { disqueLibrePourcent: null }), 'disque').niveau, 'inconnu');
});

test('un registre en lecture seule est grave : rien de ce qui est saisi ne reste', function () {
  /* La panne la plus déroutante possible — l'application démarre, l'écran
     s'affiche, et rien ne s'enregistre. */
  const c = point(Object.assign({}, SAINE, { registreEcrivable: false }), 'ecriture');
  assert.equal(c.niveau, 'grave');
  assert.match(c.dit, /pas écrivable/);
});

/* ── ce qui n'est pas une panne ── */

test('l’absence de courriel n’est pas une panne, mais se signale', function () {
  /* Un bureau qui prévient par téléphone fonctionne très bien sans courriel,
     et une bonne part de son public n'a pas d'adresse. */
  const c = point(Object.assign({}, SAINE, { courriel: false }), 'courriel');
  assert.equal(c.niveau, 'attention');
  assert.notEqual(c.niveau, 'grave');
  assert.equal(point(Object.assign({}, SAINE, { courriel: 'essai' }), 'courriel').niveau, 'attention');
});

test('sans réseau, https n’est pas une question', function () {
  /* Exiger https sur 127.0.0.1 n'apporterait rien et découragerait un bureau
     d'un seul poste, qui est le cas le plus courant. */
  const c = point(Object.assign({}, SAINE, { reseau: false, https: false }), 'https');
  assert.equal(c.niveau, 'bon');
  assert.match(c.dit, /ne sort pas/);
});

test('sur le réseau et en clair, https se réclame', function () {
  const c = point(Object.assign({}, SAINE, { reseau: true, https: false }), 'https');
  assert.equal(c.niveau, 'attention');
  assert.match(c.faire, /certificat/);
  assert.match(c.dit, /en clair/);
});

test('une version non signée n’est pas une alerte, une signature rompue si', function () {
  /* La plupart des installations tournent depuis les sources et n'ont pas de
     manifeste. Une signature invalide, elle, veut dire que des fichiers ont
     changé. */
  assert.equal(point(Object.assign({}, SAINE, { integrite: 'non-signee' }), 'signature').niveau, 'bon');
  const rompue = point(Object.assign({}, SAINE, { integrite: 'INTEGRITY-001' }), 'signature');
  assert.equal(rompue.niveau, 'grave');
  assert.match(rompue.faire, /données ne sont pas touchées/,
    'et le message rassure sur les données : la peur ferait faire des bêtises');
});

/* ── l'ordre et la phrase ── */

test('le plus grave se lit en premier', function () {
  const b = D.bilan(
    Object.assign({}, SAINE, { courriel: false, sauvegardes: [] }),
    { at: MAINTENANT }
  );
  assert.equal(b[0].niveau, 'grave');
  assert.equal(b[0].cle, 'sauvegarde');
  assert.match(D.phrase(b), /grave/);
});

test('chaque point qui n’est pas « bon » dit quoi faire', function () {
  /* Un constat sans consigne oblige à chercher ailleurs, et on ne cherche
     pas : l'écran devient décoratif. */
  const b = D.bilan(
    { sauvegardes: [], codeMaitreDefaut: true, disqueLibrePourcent: 2,
      registreEcrivable: false, courriel: false, reseau: true, https: false, integrite: 'INTEGRITY-001' },
    { at: MAINTENANT }
  );
  b.forEach(function (c) {
    if (c.niveau === 'bon') return;
    assert.ok(c.faire && c.faire.length > 15, c.cle + ' doit dire quoi faire');
    assert.ok(c.dit && c.dit.length > 10, c.cle + ' doit dire ce qui se passe');
    assert.ok(c.titre, c.cle + ' doit avoir un titre lisible');
  });
});

test('sans constats, aucune phrase inventée', function () {
  assert.equal(D.phrase([]), '');
  assert.equal(D.phrase(null), '');
});
