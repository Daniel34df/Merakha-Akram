'use strict';

/* Les étiquettes d'une fiche.

   Ce que ces tests gardent fermé : dix orthographes du même mot. Si
   « Tutelle », « tutelle » et « TUTELLE » sont trois étiquettes, le filtre en
   trouve trois et l'agent croit à trois situations différentes — ce qui est
   pire que pas d'étiquettes du tout, parce qu'il croira avoir cherché.

   Et une règle qui n'est pas technique : ces mots ne sortent jamais dans un
   courriel. « sdf », « expulsion », « tutelle » écrits dans un message à la
   personne, c'est une information qui blesse et qui ne la regarde pas sous
   cette forme. Le module ne fournit donc aucune variable de gabarit — c'est
   une absence délibérée, pas un oubli. */

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../assets/js/etiquettes.js');

const REGISTRE = [
  { id: 'c1', name: 'Amina Diallo', etiquettes: ['tutelle', 'suivi-social'] },
  { id: 'c2', name: 'Marc Petit', etiquettes: ['suivi-social'] },
  { id: 'c3', name: 'Sarah Benali', etiquettes: ['association', 'suivi-social'] },
  { id: 'c4', name: 'Jean Dupont' }
];

/* ── la normalisation, qui décide de tout le reste ── */

test('une même étiquette écrite de dix façons n’en fait qu’une', function () {
  ['Tutelle', 'TUTELLE', ' tutelle ', 'tutelle.', '-tutelle-'].forEach(function (t) {
    assert.equal(E.normaliser(t), 'tutelle', t);
  });
});

test('les accents et les espaces se ramènent à une forme unique', function () {
  assert.equal(E.normaliser('Suivi social'), 'suivi-social');
  assert.equal(E.normaliser('SUIVI  SOCIAL'), 'suivi-social');
  assert.equal(E.normaliser('démarche à faire'), 'demarche-a-faire');
});

test('une étiquette reste courte : au-delà, c’est une note mal rangée', function () {
  const longue = E.normaliser('une phrase entière qui raconte toute la situation de la personne');
  assert.ok(longue.length <= E.LONGUEUR_MAX, longue.length + ' signes');
  assert.ok(!/-$/.test(longue), 'et ne finit pas sur un tiret de coupure : ' + longue);
});

test('ce qui ne fait pas une étiquette n’en devient pas une', function () {
  assert.equal(E.normaliser(''), '');
  assert.equal(E.normaliser('   '), '');
  assert.equal(E.normaliser('...'), '');
  assert.equal(E.normaliser(null), '');
});

/* ── la saisie ── */

test('la virgule sépare, l’espace non — et c’est ce qui sauve « suivi social »', function () {
  /* Séparer aussi sur l'espace permettrait d'écrire « tutelle suivi-social »
     sans virgule. Mais ça couperait « suivi social » en deux étiquettes qui ne
     veulent rien dire, et les étiquettes en deux mots sont ordinaires en
     français — c'est ce qu'un agent tape spontanément. */
  const attendu = ['tutelle', 'suivi-social'];
  assert.deepEqual(E.lire('tutelle, suivi-social'), attendu);
  assert.deepEqual(E.lire('tutelle; suivi-social'), attendu);
  assert.deepEqual(E.lire('tutelle\nsuivi-social'), attendu);
  assert.deepEqual(E.lire('tutelle, suivi social'), attendu,
    'l’espace interne devient un tiret : les deux graphies se rejoignent');
  assert.deepEqual(E.lire('tutelle suivi-social'), ['tutelle-suivi-social'],
    'sans virgule, c’est une seule étiquette — le prix de l’arbitrage');
});

test('une étiquette saisie deux fois ne compte qu’une fois', function () {
  assert.deepEqual(E.lire('tutelle, Tutelle, TUTELLE'), ['tutelle']);
});

test('une seule lettre ne fait pas une étiquette', function () {
  /* Elle ne distingue rien, et se tape par accident en séparant deux mots. */
  assert.deepEqual(E.lire('a, tutelle, x'), ['tutelle']);
});

test('le nombre par fiche est borné', function () {
  /* Au-delà, elles ne se lisent plus et ne distinguent plus rien. */
  const beaucoup = [];
  for (let i = 0; i < 40; i++) beaucoup.push('etiquette' + i);
  assert.equal(E.lire(beaucoup.join(', ')).length, E.MAX_PAR_FICHE);
});

test('une liste déjà propre se relit telle quelle', function () {
  assert.deepEqual(E.lire(['tutelle', 'suivi-social']), ['tutelle', 'suivi-social']);
  assert.deepEqual(E.lire([]), []);
  assert.deepEqual(E.lire(null), []);
});

test('l’aller-retour saisie → liste → saisie ne perd rien', function () {
  const liste = E.lire('Tutelle, Suivi social, association');
  assert.equal(E.ecrire(liste), 'tutelle, suivi-social, association');
  assert.deepEqual(E.lire(E.ecrire(liste)), liste);
});

/* ── compter et filtrer ── */

test('le registre dit quelles étiquettes il emploie, et combien', function () {
  const t = E.toutes(REGISTRE);
  assert.deepEqual(t[0], { etiquette: 'suivi-social', n: 3 }, 'la plus employée en tête');
  assert.equal(t.length, 3);
  assert.deepEqual(E.toutes([]), []);
  assert.deepEqual(E.toutes(null), []);
});

test('filtrer sur deux étiquettes restreint, il n’additionne pas', function () {
  /* Demander « tutelle » et « suivi-social » et recevoir la somme des deux
     listes ne restreint rien — c'est l'inverse de ce qu'on venait chercher. */
  const deux = E.filtrer(REGISTRE, 'tutelle, suivi-social');
  assert.equal(deux.length, 1);
  assert.equal(deux[0].id, 'c1');

  const une = E.filtrer(REGISTRE, 'suivi-social');
  assert.equal(une.length, 3);
});

test('un filtre vide ne cache personne', function () {
  assert.equal(E.filtrer(REGISTRE, '').length, 4);
  assert.equal(E.filtrer(REGISTRE, null).length, 4);
  assert.equal(E.filtrer(REGISTRE, '   ').length, 4);
});

test('le filtre normalise ce qu’on lui donne', function () {
  /* L'agent tape « Suivi Social » dans le champ ; il doit trouver. */
  assert.equal(E.filtrer(REGISTRE, 'Suivi Social').length, 3);
});

test('une fiche sans étiquette n’est jamais retenue par un filtre', function () {
  const t = E.filtrer(REGISTRE, 'tutelle');
  assert.ok(!t.some(function (c) { return c.id === 'c4'; }));
});

/* ── les propositions ── */

test('on propose d’abord ce que le bureau emploie déjà', function () {
  /* Plutôt que ce que nous avons deviné : c'est ainsi qu'on évite dix
     orthographes du même mot dès le premier jour. */
  const p = E.proposer(REGISTRE, '');
  assert.equal(p[0], 'suivi-social');
  assert.ok(p.indexOf('tutelle') !== -1);
  assert.ok(p.indexOf('discretion') !== -1, 'les suggestions viennent ensuite');
});

test('on ne propose pas une étiquette déjà posée sur la fiche', function () {
  const p = E.proposer(REGISTRE, 'tutelle, suivi-social');
  assert.equal(p.indexOf('tutelle'), -1);
  assert.equal(p.indexOf('suivi-social'), -1);
});

test('un registre vide propose quand même de quoi commencer', function () {
  const p = E.proposer([], '');
  assert.ok(p.length > 0);
  assert.deepEqual(p.slice(0, 2), ['tutelle', 'curatelle']);
});

/* ── ce que le module refuse de faire ── */

test('aucune variable de gabarit n’est exposée', function () {
  /* C'est une absence délibérée. « tutelle » ou « expulsion » dans un message
     envoyé à la personne — ou lu par un tiers — est une information qui blesse
     et qui ne la regarde pas sous cette forme. Rendre les étiquettes
     insérables dans un gabarit rendrait l'accident possible ; ne pas les
     rendre insérables le rend impossible. */
  const exportées = Object.keys(E);
  assert.ok(!exportées.some(function (k) { return /variable|gabarit|message|rendu/i.test(k); }),
    'aucune passerelle vers les messages : ' + exportées.join(', '));
});
