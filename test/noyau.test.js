'use strict';

/* Le socle de l'interface, ouvert hors navigateur.

   L'intérêt n'est pas de tester « stampSuffix » — c'est de prouver que ce
   module se charge sous Node. C'est la condition qui manquait à store.js et
   qui a laissé vivre un bug pendant tout un cycle : un fichier qu'aucune suite
   ne peut ouvrir est un fichier que personne ne relit.

   Le DOM n'est touché qu'à l'intérieur des fonctions, jamais au chargement :
   c'est ce qui rend ce chargement possible. Si quelqu'un ajoute un appel au
   DOM au niveau du module, ce fichier de test échouera aussitôt — et c'est
   exactement ce qu'on lui demande. */

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../assets/js/ui/noyau.js');

test('le socle se charge hors navigateur, avec tout ce qu’il expose', function () {
  [
    '$', 'esc', 'view', 'toast', 'stamp', 'confirmDialog', 'setMsg',
    'download', 'downloadBytes', 'MIME_XLSX', 'stampSuffix',
    'enAttente', 'joursDepuis', 'antennes', 'antenneImposee', 'deLAntenne'
  ].forEach(function (nom) {
    assert.ok(ui[nom] !== undefined, nom + ' manque au socle');
  });
});

test('le suffixe d’horodatage des fichiers exportés', function () {
  const s = ui.stampSuffix();
  assert.match(s, /^\d{8}$/, 'AAAAMMJJ, de quoi classer les exports : ' + s);
  assert.equal(s.slice(0, 4), String(new Date().getFullYear()));
});

test('le type MIME du classeur est celui qu’Excel reconnaît', function () {
  assert.equal(
    ui.MIME_XLSX,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
});

test('un courrier attend tant qu’il n’est ni retiré, ni classé, ni en échec', function () {
  assert.equal(ui.enAttente({ pickedUpAt: null, closedAt: null, status: 'envoyé' }), true);
  assert.equal(ui.enAttente({ pickedUpAt: '2026-08-01', closedAt: null, status: 'envoyé' }), false);
  assert.equal(ui.enAttente({ pickedUpAt: null, closedAt: '2026-08-01', status: 'envoyé' }), false);
  assert.equal(ui.enAttente({ pickedUpAt: null, closedAt: null, status: 'échec' }), false);
  /* « à prévenir » attend comme les autres : le courrier est là, la personne
     ne le sait pas encore. */
  assert.equal(ui.enAttente({ pickedUpAt: null, closedAt: null, status: 'à prévenir' }), true);
});

test('les jours écoulés se comptent en jours entiers', function () {
  const ilYaTroisJours = new Date(Date.now() - 3 * 86400000).toISOString();
  assert.equal(ui.joursDepuis(ilYaTroisJours), 3);
  assert.equal(ui.joursDepuis(new Date().toISOString()), 0);
});

test('sans antenne déclarée, tout le monde passe le filtre', function () {
  // C'est la règle qui garde l'application simple pour un bureau unique.
  assert.equal(ui.antennes().length, 0);
  assert.equal(ui.deLAntenne({ antenneId: '' }), true);
  assert.equal(ui.deLAntenne({ antenneId: 'antenne-nord' }), true);
});
