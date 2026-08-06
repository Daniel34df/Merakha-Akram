'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('../assets/js/util.js');

test('normalize retire accents, casse et espaces superflus', function () {
  assert.equal(util.normalize('  Élodie   TREMBLAY '), 'elodie tremblay');
  assert.equal(util.normalize('Jean-François'), 'jean-francois');
  assert.equal(util.normalize(null), '');
});

test('escapeHtml neutralise les caractères actifs', function () {
  assert.equal(util.escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(util.escapeHtml("l'ami & co"), 'l&#39;ami &amp; co');
  assert.equal(util.escapeHtml(undefined), '');
});

test('isValidEmail accepte les adresses plausibles et refuse le reste', function () {
  assert.ok(util.isValidEmail('marie.tremblay@exemple.com'));
  assert.ok(util.isValidEmail('m+courrier@sous.domaine.qc.ca'));
  assert.ok(!util.isValidEmail('marie@exemple'));
  assert.ok(!util.isValidEmail('marie exemple.com'));
  assert.ok(!util.isValidEmail('a@b.c'));
  assert.ok(!util.isValidEmail(''));
});

test('matchesQuery cherche sur le nom et le courriel, accents ignorés', function () {
  const c = { name: 'Élodie Tremblay', email: 'elo@exemple.com' };
  assert.ok(util.matchesQuery(c, 'elodie'));
  assert.ok(util.matchesQuery(c, 'ELODIE tremblay'));
  assert.ok(util.matchesQuery(c, 'tremblay elodie'), 'ordre des mots indifférent');
  assert.ok(util.matchesQuery(c, 'exemple.com'));
  assert.ok(!util.matchesQuery(c, 'tremblay martin'));
  assert.ok(!util.matchesQuery(c, '   '));
});

test('renderTemplate remplace les variables connues et laisse les autres', function () {
  const out = util.renderTemplate('Bonjour {nom}, le {date}. {inconnu}', { nom: 'Marie', date: '3 mai' });
  assert.equal(out, 'Bonjour Marie, le 3 mai. {inconnu}');
});

test('toCsv échappe guillemets, virgules et sauts de ligne', function () {
  const csv = util.toCsv([{ nom: 'Dupont, Jean', note: 'dit "Jeannot"' }], ['nom', 'note']);
  assert.equal(csv, 'nom,note\r\n"Dupont, Jean","dit ""Jeannot"""');
});

test('parseContactsCsv lit un fichier avec en-tête', function () {
  const res = util.parseContactsCsv('nom,courriel\r\nMarie Tremblay,marie@exemple.com\r\nJean Roy,jean@exemple.com\r\n');
  assert.equal(res.errors.length, 0);
  assert.deepEqual(res.contacts, [
    { name: 'Marie Tremblay', email: 'marie@exemple.com' },
    { name: 'Jean Roy', email: 'jean@exemple.com' }
  ]);
});

test('parseContactsCsv accepte un fichier sans en-tête et signale les lignes fautives', function () {
  const res = util.parseContactsCsv('Marie Tremblay,marie@exemple.com\nJean Roy,pas-une-adresse\n,orphelin@exemple.com');
  assert.deepEqual(res.contacts, [{ name: 'Marie Tremblay', email: 'marie@exemple.com' }]);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0], /Ligne 2/);
  assert.match(res.errors[1], /Ligne 3/);
});

test('parseCsv gère les champs entre guillemets contenant des sauts de ligne', function () {
  const rows = util.parseCsv('a,"multi\nligne"\nb,c');
  assert.deepEqual(rows, [['a', 'multi\nligne'], ['b', 'c']]);
});

test('sortByName trie selon les règles françaises', function () {
  const sorted = util.sortByName([{ name: 'Étienne' }, { name: 'Adam' }, { name: 'eve' }]);
  assert.deepEqual(sorted.map(function (c) { return c.name; }), ['Adam', 'Étienne', 'eve']);
});

test('isSameDay compare une date ISO à une date de calendrier locale', function () {
  const iso = new Date(2026, 4, 3, 14, 30).toISOString();
  assert.ok(util.isSameDay(iso, '2026-05-03'));
  assert.ok(!util.isSameDay(iso, '2026-05-04'));
  assert.ok(!util.isSameDay('pas une date', '2026-05-03'));
});
