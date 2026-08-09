'use strict';

/* Le code de reprise tiré à l'installation.
 *
 * Ce que ces tests gardent fermé : une installation neuve qui démarrerait sur
 * le code publié avec le code source. C'était le cas de toutes jusqu'ici — les
 * installateurs tiraient la clé de chiffrement au sort, mais pas celui-là. */

const test = require('node:test');
const assert = require('node:assert/strict');
const cm = require('../tools/code-maitre.js');
const authSrv = require('../server/auth.js');

test('le code tiré fait douze chiffres, et rien que des chiffres', function () {
  const code = cm.tirer();
  assert.match(code, /^\d{12}$/, 'obtenu : ' + code);
});

test('deux tirages ne donnent pas le même code', function () {
  /* Sans cela, « tiré au sort » ne voudrait rien dire — et tous les bureaux
     partageraient la même clé de coffre, ce qui est exactement le défaut
     qu'on corrige. */
  const vus = new Set();
  for (let i = 0; i < 200; i++) vus.add(cm.tirer());
  assert.equal(vus.size, 200, 'aucune répétition sur deux cents tirages');
});

test('le code tiré n’est jamais celui du dépôt', function () {
  for (let i = 0; i < 500; i++) {
    assert.notEqual(cm.tirer(), authSrv.MASTER_CODE_DEFAUT);
  }
});

test('le tirage ne passe pas par Math.random', function () {
  /* Math.random est prévisible : deux machines qui démarrent ensemble peuvent
     rendre la même suite. La règle vaut pour tout secret du projet, et elle se
     vérifie ici plutôt que de se relire. */
  const vrai = Math.random;
  let appele = false;
  Math.random = function () {
    appele = true;
    return vrai();
  };
  try {
    cm.tirer();
  } finally {
    Math.random = vrai;
  }
  assert.equal(appele, false);
});

test('le code s’affiche par groupes de quatre, et se relit sans espaces', function () {
  assert.equal(cm.grouper('482190375164'), '4821 9037 5164');
  // Ce qui est affiché doit pouvoir être retapé tel quel : les espaces sautent.
  assert.equal(cm.grouper('4821 9037 5164').replace(/\s/g, ''), '482190375164');
  assert.equal(cm.grouper(''), '');
});

test('la forme attendue se reconnaît, groupée ou non', function () {
  const code = cm.tirer();
  assert.equal(cm.valide(code), true);
  assert.equal(cm.valide(cm.grouper(code)), true, 'un code recopié avec ses espaces reste valable');
  assert.equal(cm.valide('123'), false);
  assert.equal(cm.valide('abcdefghijkl'), false);
  assert.equal(cm.valide(''), false);
});

test('le code tiré est accepté par le serveur comme code maître', function () {
  /* Le bout qui compte vraiment : ce que l'installateur écrit doit ouvrir la
     reprise, et l'ancien code publié ne doit plus rien ouvrir. */
  const code = cm.tirer();
  const db = { data: { masterCodeHash: authSrv.empreinteCodeMaitre(code) } };

  assert.equal(authSrv.verifierCodeMaitre(db, code), true);
  assert.equal(authSrv.verifierCodeMaitre(db, authSrv.MASTER_CODE_DEFAUT), false);
  assert.equal(authSrv.estCodeMaitreDefaut(db), false, 'la carte d’alerte doit disparaître');
});
