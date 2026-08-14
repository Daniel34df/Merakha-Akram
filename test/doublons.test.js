'use strict';

/* Les fiches qui se ressemblent.

   Ce que ces tests gardent fermé : une deuxième fiche créée pour quelqu'un qui
   en avait déjà une. À partir de là son courrier arrive tantôt sur l'une,
   tantôt sur l'autre, et il lui est refusé un courrier qui est là — sous son
   autre nom. Pour une domiciliation, les deux fiches ont chacune leur échéance,
   et celle qui compte n'est pas forcément celle qu'on regarde.

   Le module prévient, il ne tranche pas. Fusionner deux dossiers de deux
   personnes différentes serait pire que le doublon. */

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../assets/js/doublons.js');

const REGISTRE = [
  { id: 'c1', name: 'Jean Dupont', email: 'jean@exemple.org', telephone: '06 12 34 56 78' },
  { id: 'c2', name: 'Amina Diallo', email: '', telephone: '07 00 00 00 00' },
  { id: 'c3', name: 'Sarah Benali', email: 'sarah@exemple.org', telephone: '' }
];

/* ── le téléphone ── */

test('deux façons d’écrire un numéro sont le même numéro', function () {
  const n = '0612345678';
  ['06 12 34 56 78', '06.12.34.56.78', '06-12-34-56-78', '+33 6 12 34 56 78', '0033612345678']
    .forEach(function (t) {
      assert.equal(D.normaliserTelephone(t), n, t);
    });
});

test('un numéro trop court ne fait correspondre personne', function () {
  /* « 06 » seul rapprocherait la moitié du registre. */
  assert.equal(D.normaliserTelephone('06'), '');
  assert.equal(D.normaliserTelephone('12345'), '');
  assert.equal(D.normaliserTelephone(''), '');
  assert.equal(D.normaliserTelephone(null), '');
});

/* ── le nom ── */

test('l’ordre nom/prénom ne fait pas deux personnes', function () {
  /* Il varie d'un formulaire à l'autre et d'une administration à l'autre. */
  assert.equal(D.nomsProches('Jean Dupont', 'Dupont Jean'), true);
  assert.equal(D.cleNom('Jean Dupont'), D.cleNom('DUPONT, jean'));
});

test('une faute de frappe rapproche, une différence réelle non', function () {
  assert.equal(D.nomsProches('Jean Dupont', 'Jean Dupond'), true, 'une lettre');
  assert.equal(D.nomsProches('Jean Dupont', 'Marie Tremblay'), false);
  assert.equal(D.nomsProches('Amina Diallo', 'Amine Diallo'), true, 'proche — à l’agent de trancher');
});

test('sur un nom court, aucune tolérance', function () {
  /* « Roy » et « Ray » sont deux noms. Tolérer une faute sur trois lettres
     ferait se ressembler tout le registre. */
  assert.equal(D.nomsProches('Roy', 'Ray'), false);
  assert.equal(D.nomsProches('Roy', 'Roy'), true);
});

test('un nom vide ne ressemble à rien', function () {
  assert.equal(D.nomsProches('', 'Jean Dupont'), false);
  assert.equal(D.nomsProches('Jean Dupont', ''), false);
  assert.equal(D.nomsProches(null, null), false);
});

/* ── la recherche ── */

test('un même courriel est le signal le plus sûr', function () {
  const t = D.chercher(REGISTRE, { name: 'Autre Nom', email: 'JEAN@Exemple.ORG' });
  assert.equal(t.length, 1);
  assert.equal(t[0].contact.id, 'c1');
  assert.equal(t[0].raison, 'courriel');
  assert.equal(t[0].certitude, 'haute');
});

test('deux personnes sans courriel ne sont pas un doublon', function () {
  /* « '' === '' » ferait de toutes les personnes sans adresse un même doublon.
     Une bonne part du public de ce bureau n'a pas de courriel — c'est souvent
     la raison même de sa venue. */
  const t = D.chercher(REGISTRE, { name: 'Quelqu’un d’Autre', email: '', telephone: '' });
  assert.deepEqual(t, []);
});

test('un même téléphone signale, même sous un autre nom', function () {
  const t = D.chercher(REGISTRE, { name: 'Nom Différent', telephone: '+33 7 00 00 00 00' });
  assert.equal(t.length, 1);
  assert.equal(t[0].contact.id, 'c2');
  assert.equal(t[0].raison, 'telephone');
});

test('un nom proche signale, avec une certitude plus faible', function () {
  const t = D.chercher(REGISTRE, { name: 'Jean Dupond' });
  assert.equal(t.length, 1);
  assert.equal(t[0].raison, 'nom');
  assert.equal(t[0].certitude, 'faible');
  assert.equal(t[0].sur, 'nom très proche');
});

test('un nom identique est plus sûr qu’un nom approchant, sans être une preuve', function () {
  const t = D.chercher(REGISTRE, { name: 'jean dupont' });
  assert.equal(t[0].certitude, 'moyenne');
  assert.equal(t[0].sur, 'même nom');
});

test('les plus sûrs viennent en tête : l’agent ne lira peut-être que la première ligne', function () {
  const registre = [
    { id: 'a', name: 'Jean Dupond', email: '', telephone: '' },
    { id: 'b', name: 'Sans Rapport', email: 'jean@exemple.org', telephone: '' }
  ];
  const t = D.chercher(registre, { name: 'Jean Dupont', email: 'jean@exemple.org' });
  assert.equal(t[0].contact.id, 'b', 'le courriel avant le nom');
  assert.equal(t[0].certitude, 'haute');
});

test('une fiche ne se signale pas comme son propre doublon', function () {
  /* Sans ça, corriger une faute de frappe déclencherait un avertissement à
     chaque enregistrement. */
  const t = D.chercher(REGISTRE, REGISTRE[0], { exclureId: 'c1' });
  assert.deepEqual(t, []);
});

test('un candidat vide ne cherche rien', function () {
  assert.deepEqual(D.chercher(REGISTRE, {}), []);
  assert.deepEqual(D.chercher(REGISTRE, null), []);
  assert.deepEqual(D.chercher(null, { name: 'Jean' }), []);
});

test('la liste est bornée : un avertissement n’est pas un annuaire', function () {
  const gros = [];
  for (let i = 0; i < 50; i++) gros.push({ id: 'x' + i, name: 'Jean Dupont', email: '', telephone: '' });
  assert.equal(D.chercher(gros, { name: 'Jean Dupont' }).length, 5);
  assert.equal(D.chercher(gros, { name: 'Jean Dupont' }, { limite: 2 }).length, 2);
});

/* ── ce qu'on en dit ── */

test('le message dit « peut-être », jamais « c’est »', function () {
  /* Le module ne sait pas si Jean Dupont et Jean Dupond sont la même personne.
     C'est l'agent qui a la personne en face de lui. */
  const t = D.chercher(REGISTRE, { name: 'Jean Dupont', email: 'jean@exemple.org' });
  const m = D.message(t);
  assert.match(m, /Vérifiez/);
  assert.match(m, /même courriel/);
  assert.ok(m.indexOf('doublon') > 0, 'le mot est dit, pour que l’enjeu soit clair');
  assert.equal(D.message([]), '', 'rien à dire quand rien ne ressemble');
});
