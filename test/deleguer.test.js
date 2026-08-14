'use strict';

/* La délégation d'événements.

   Ce que ce test garde fermé : un bouton muet. Une liste qui se redessine
   reposait ses écouteurs après chaque rendu ; un rendu qui oubliait de
   rappeler cette boucle produisait des boutons qui s'affichent, se cliquent,
   et ne font rien. C'est le pire mode de panne d'une interface, parce qu'il
   ressemble à une lenteur — l'agent reclique, puis appelle.

   `ui/noyau.js` a besoin d'un DOM ; on lui en fabrique un minuscule plutôt que
   d'ouvrir un navigateur, parce que ce qui se vérifie ici est une mécanique,
   pas un écran. */

const test = require('node:test');
const assert = require('node:assert/strict');

/* Un DOM de poche : juste ce que `deleguer` touche. */
function faireElement(nom) {
  const el = {
    nom: nom,
    enfants: [],
    parent: null,
    ecouteurs: {},
    addEventListener: function (type, fn) {
      (el.ecouteurs[type] = el.ecouteurs[type] || []).push(fn);
    },
    contains: function (autre) {
      let n = autre;
      while (n) {
        if (n === el) return true;
        n = n.parent;
      }
      return false;
    },
    closest: function (sel) {
      let n = el;
      while (n) {
        if (n.correspond && n.correspond(sel)) return n;
        n = n.parent;
      }
      return null;
    },
    ajouter: function (enfant) {
      enfant.parent = el;
      el.enfants.push(enfant);
      return enfant;
    },
    declencher: function (type) {
      /* Un vrai événement remonte ; ici le conteneur suffit, puisque c'est lui
         qui porte l'écouteur. */
      let n = el;
      while (n) {
        (n.ecouteurs[type] || []).forEach(function (fn) { fn({ target: el }); });
        n = n.parent;
      }
    }
  };
  return el;
}

function bouton(marque) {
  const b = faireElement('button');
  b.correspond = function (sel) { return sel === marque; };
  return b;
}

function charger() {
  /* Le module s'attache à `globalThis.BC` ; on le recharge à neuf pour que les
     tests ne se marchent pas dessus. */
  delete require.cache[require.resolve('../assets/js/ui/noyau.js')];
  global.document = {
    addEventListener: function () {},
    /* `deleguer` accepte un identifiant aussi bien qu'un élément ; il passe
       alors par `$`, qui interroge le document. */
    getElementById: function () { return null; },
    documentElement: {},
    body: {}
  };
  global.window = global;
  return require('../assets/js/ui/noyau.js');
}

test('un seul écouteur suffit, quel que soit le nombre de boutons', function () {
  const ui = charger();
  const boite = faireElement('div');
  let vus = 0;
  ui.deleguer(boite, '[data-x]', function () { vus++; });

  const a = boite.ajouter(bouton('[data-x]'));
  const b = boite.ajouter(bouton('[data-x]'));
  a.declencher('click');
  b.declencher('click');
  assert.equal(vus, 2);
  assert.equal((boite.ecouteurs.click || []).length, 1, 'un seul écouteur posé');
});

test('un bouton dessiné après coup marche sans qu’on y pense', function () {
  /* C'est toute la raison d'être de la délégation : le contenu peut être
     réécrit cent fois, l'écouteur ne bouge pas. */
  const ui = charger();
  const boite = faireElement('div');
  let vus = 0;
  ui.deleguer(boite, '[data-x]', function () { vus++; });
  // …puis un rendu plus tard.
  const tardif = boite.ajouter(bouton('[data-x]'));
  tardif.declencher('click');
  assert.equal(vus, 1);
});

test('déléguer deux fois ne double pas les appels', function () {
  /* `init()` peut être rappelé ; deux écouteurs identiques enverraient deux
     fois la même notification, donc deux courriels à la même personne. */
  const ui = charger();
  const boite = faireElement('div');
  let vus = 0;
  ui.deleguer(boite, '[data-x]', function () { vus++; });
  ui.deleguer(boite, '[data-x]', function () { vus++; });
  boite.ajouter(bouton('[data-x]')).declencher('click');
  assert.equal(vus, 1);
});

test('un même conteneur peut déléguer plusieurs gestes', function () {
  /* Une marque unique n'en aurait laissé passer qu'un — et le second bouton
     serait resté muet. */
  const ui = charger();
  const boite = faireElement('div');
  let envoi = 0;
  let suppression = 0;
  ui.deleguer(boite, '[data-envoyer]', function () { envoi++; });
  ui.deleguer(boite, '[data-supprimer]', function () { suppression++; });
  boite.ajouter(bouton('[data-envoyer]')).declencher('click');
  boite.ajouter(bouton('[data-supprimer]')).declencher('click');
  assert.equal(envoi, 1);
  assert.equal(suppression, 1);
});

test('un clic à côté ne déclenche rien', function () {
  const ui = charger();
  const boite = faireElement('div');
  let vus = 0;
  ui.deleguer(boite, '[data-x]', function () { vus++; });
  const autre = faireElement('span');
  autre.correspond = function () { return false; };
  boite.ajouter(autre).declencher('click');
  assert.equal(vus, 0);
});

test('la cible reçoit l’élément, pas seulement l’événement', function () {
  const ui = charger();
  const boite = faireElement('div');
  let recu = null;
  ui.deleguer(boite, '[data-x]', function (el) { recu = el; });
  const b = boite.ajouter(bouton('[data-x]'));
  b.declencher('click');
  assert.equal(recu, b, 'c’est le bouton qui est passé, pas son conteneur');
});

test('un conteneur absent ne fait pas tomber le chargement', function () {
  /* Un écran qui n'existe pas dans cette page — l'application se charge dans
     des contextes réduits — ne doit pas empêcher les autres de s’armer. */
  const ui = charger();
  assert.doesNotThrow(function () { ui.deleguer(null, '[data-x]', function () {}); });
  assert.doesNotThrow(function () { ui.deleguer('inexistant', '[data-x]', function () {}); });
});
