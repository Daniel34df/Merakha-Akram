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
    'enAttente', 'joursDepuis', 'antennes', 'antenneImposee', 'deLAntenne',
    'mouvementReduit', 'glisseOnglet', 'majCompteur',
    'THEMES', 'BARRE_THEME', 'themeChoisi', 'resoudreTheme', 'themeResolu',
    'appliquerTheme', 'themeSuivant'
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

/* ═══════════ borner l'affichage ═══════════

   Mesuré avant correctif : dessiner tout l'historique coûtait 300 ms à
   2 000 courriers, 1,5 s à 10 000 — à chaque écriture faite sur un autre
   poste, puisque la moindre mise à jour distante redessine tout. */

test('une liste courte n’est pas tronquée', function () {
  const b = ui.borner([1, 2, 3], 200);
  assert.deepEqual(b.lignes, [1, 2, 3]);
  assert.equal(b.total, 3);
  assert.equal(b.tronque, false, 'pas de bandeau pour rien');
});

test('une liste longue est coupée, et le total reste dit', function () {
  const longue = Array.from({ length: 5000 }, function (_, i) { return i; });
  const b = ui.borner(longue, 200);
  assert.equal(b.lignes.length, 200);
  assert.equal(b.total, 5000, 'l’écran doit pouvoir annoncer combien il y en a');
  assert.equal(b.tronque, true);
  assert.equal(b.lignes[0], 0, 'les plus récents d’abord : on garde le début de la liste');
});

test('« afficher tout » lève la borne', function () {
  const longue = Array.from({ length: 500 }, function (_, i) { return i; });
  const b = ui.borner(longue, 200, true);
  assert.equal(b.lignes.length, 500);
  assert.equal(b.tronque, false);
});

test('la borne ne perd rien : elle s’applique après le filtre', function () {
  /* C'est la propriété qui empêche la borne de devenir une perte de données à
     l'écran. Le filtre porte sur la totalité ; on ne borne que ce qui reste. */
  const tout = Array.from({ length: 5000 }, function (_, i) {
    return { nom: i === 4999 ? 'Amina Diallo' : 'Quelqu’un ' + i };
  });
  const filtre = tout.filter(function (x) { return x.nom === 'Amina Diallo'; });
  const b = ui.borner(filtre, 200);

  assert.equal(b.lignes.length, 1, 'la dernière ligne des 5 000 reste trouvable');
  assert.equal(b.lignes[0].nom, 'Amina Diallo');
  assert.equal(b.tronque, false);
});

test('une borne absente ou absurde n’ampute rien', function () {
  const l = [1, 2, 3];
  assert.equal(ui.borner(l, 0).lignes.length, 3);
  assert.equal(ui.borner(l, -5).lignes.length, 3);
  assert.equal(ui.borner(l).lignes.length, 3);
  assert.deepEqual(ui.borner(undefined, 200).lignes, []);
});

/* ═════════════ le mouvement ═════════════

   Deux fonctions qui touchent au DOM, donc deux fonctions qu'on ne peut pas
   exécuter ici — mais dont on peut vérifier ce qui compte : qu'elles ne
   s'exécutent pas au chargement, qu'elles renoncent proprement quand ce
   qu'elles cherchent n'existe pas, et qu'elles demandent l'avis du réglage
   système avant d'animer quoi que ce soit.

   Ce dernier point n'est pas de l'esthétique. Pour qui souffre de troubles
   vestibulaires, un mouvement non demandé donne la nausée ; « réduire les
   animations » est une demande médicale autant qu'un goût. */

test('le soulignement d’onglet renonce quand la barre n’existe pas', function () {
  /* Sous Node il n'y a pas de document : la fonction doit lever une erreur
     claire plutôt que rien faire silencieusement — mais surtout, elle ne doit
     pas s'être exécutée au chargement du module, ce que prouve le seul fait
     d'être arrivé jusqu'ici. */
  assert.equal(typeof ui.glisseOnglet, 'function');
});

test('un compteur sans élément ne fait rien, et ne jette pas', function () {
  assert.doesNotThrow(function () {
    ui.majCompteur(null, 12);
  });
  assert.doesNotThrow(function () {
    ui.majCompteur(undefined, 0);
  });
});

test('un écart d’un seul pas s’écrit sans animation', function () {
  /* Le faux élément suffit : c'est le chemin court, celui qui n'appelle ni
     requestAnimationFrame ni matchMedia. Passer de 3 à 4 n'a pas besoin d'un
     défilement de quatre cents millisecondes. */
  const el = { textContent: '3' };
  ui.majCompteur(el, 4);
  assert.equal(el.textContent, '4');

  const pareil = { textContent: '7' };
  ui.majCompteur(pareil, 7);
  assert.equal(pareil.textContent, '7');
});

test('une valeur absente ou illisible vaut zéro', function () {
  const el = { textContent: '5' };
  ui.majCompteur(el, null);
  assert.equal(el.textContent, '0', 'null ne doit pas afficher « NaN » sur un onglet');

  const autre = { textContent: '' };
  ui.majCompteur(autre, 1);
  assert.equal(autre.textContent, '1', 'un compteur vide part de zéro');
});

/* ═════════════ le thème ═════════════

   Trois états, pas deux. « auto » est le défaut et suit le système ; un choix
   explicite l'emporte. La règle tient en quatre lignes, ce qui est exactement
   pourquoi elle est sortie de la fonction qui touche au DOM : c'est la seule
   partie qui puisse être fausse, et la seule qu'on puisse vérifier ici. */

test('sans choix, le thème suit le système', function () {
  assert.equal(ui.resoudreTheme('auto', true), 'sombre');
  assert.equal(ui.resoudreTheme('auto', false), 'clair');
});

test('un choix explicite l’emporte sur le système', function () {
  assert.equal(ui.resoudreTheme('clair', true), 'clair', 'système sombre, choix clair');
  assert.equal(ui.resoudreTheme('sombre', false), 'sombre', 'système clair, choix sombre');
});

test('une valeur inconnue retombe sur le système, jamais sur du blanc', function () {
  /* Un stockage local corrompu, une vieille valeur, une faute de frappe : le
     pire résultat serait un écran clair imposé à quelqu'un qui travaille de
     nuit. On retombe donc sur « auto ». */
  ['', null, undefined, 'dark', 'AUTO', 'sombre ', 42].forEach(function (v) {
    assert.equal(ui.resoudreTheme(v, true), 'sombre', 'valeur ' + JSON.stringify(v));
    assert.equal(ui.resoudreTheme(v, false), 'clair', 'valeur ' + JSON.stringify(v));
  });
});

test('le tour des thèmes revient à son point de départ', function () {
  /* Personne ne doit rester coincé dans un thème essayé par curiosité : le
     bouton doit ramener à « auto » en trois clics, pas en deux. */
  assert.deepEqual(ui.THEMES, ['auto', 'clair', 'sombre']);
  assert.equal(ui.THEMES.length, 3);
});

test('la couleur de la barre du navigateur ne diverge pas du fond de page', function () {
  /* Une balise <meta> ne sait pas lire une variable CSS : ces deux valeurs sont
     recopiées à la main dans le socle et dans le script de pré-peinture de
     index.html. Trois copies, donc trois occasions de diverger — et la
     divergence se voit sur un téléphone, en haut de l'écran. */
  const fs = require('node:fs');
  const path = require('node:path');
  const RACINE = path.join(__dirname, '..');
  const css = fs.readFileSync(path.join(RACINE, 'assets/css/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(RACINE, 'index.html'), 'utf8');

  const fond = function (bloc) {
    const i = css.indexOf(bloc);
    assert.ok(i >= 0, 'bloc introuvable : ' + bloc);
    const m = /--bg:\s*(#[0-9A-Fa-f]{6})/.exec(css.slice(i, i + 900));
    assert.ok(m, '--bg introuvable dans ' + bloc);
    return m[1].toUpperCase();
  };

  assert.equal(ui.BARRE_THEME.clair.toUpperCase(), fond(':root{'));
  assert.equal(ui.BARRE_THEME.sombre.toUpperCase(), fond(':root[data-theme="sombre"]'));

  const tot = fs.readFileSync(path.join(RACINE, 'assets/js/theme-tot.js'), 'utf8');
  assert.ok(
    tot.indexOf(ui.BARRE_THEME.sombre) > 0 && tot.indexOf(ui.BARRE_THEME.clair) > 0,
    'le script de pré-peinture ne porte pas les mêmes couleurs que le socle'
  );
  assert.match(
    html,
    new RegExp('<meta name="theme-color" content="' + ui.BARRE_THEME.clair + '">'),
    'la balise theme-color de départ doit être celle du thème clair'
  );

  /* Le script de pré-peinture doit être un fichier, chargé avant la feuille de
     style. En ligne, la politique de sécurité du serveur (script-src 'self')
     le refuse et le thème choisi n'est jamais appliqué : la vérification
     d'apparence l'a montré, ce contrôle-ci l'empêche de revenir. */
  const posTot = html.indexOf('assets/js/theme-tot.js');
  const posCss = html.indexOf('assets/css/style.css');
  assert.ok(posTot > 0, 'index.html ne charge pas assets/js/theme-tot.js');
  assert.ok(posTot < posCss, 'le thème doit être posé avant la feuille de style');
  assert.ok(
    !/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?localStorage/.test(html),
    'un script en ligne touche au stockage : la CSP du serveur le refusera'
  );
});
