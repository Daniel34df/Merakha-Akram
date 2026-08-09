'use strict';

/* Le rendu d'un tableau, ouvert hors navigateur.

   C'est la première part du *rendu* que la suite ordinaire peut vérifier. Tout
   le reste de l'interface exige un écran et vit dans `tools/verifier/` ; ce
   module-ci est du calcul de chaîne, donc il se teste ici, vite et partout.

   Ce qu'on lui demande n'est pas cosmétique. Un tableau du guichet dit quel
   courrier attend qui, et pour combien de temps encore : une colonne décalée
   d'un cran, et un agent appelle la mauvaise personne. */

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/js/ui/tableau.js');
const tableau = T.tableau;

const TROIS = [{ n: 'Amina', b: 'B-12' }, { n: 'Yannick', b: 'A-03' }, { n: 'Śarah', b: 'C-01' }];

test('le module se charge hors navigateur', function () {
  assert.equal(typeof T.tableau, 'function');
  assert.equal(typeof T.verifierLargeur, 'function');
});

test('une liste vide rend l’état vide, jamais un tableau à zéro ligne', function () {
  const html = tableau({
    colonnes: ['Nom'],
    lignes: [],
    ligne: function (x) { return [x.n]; },
    vide: 'Aucun courrier en attente.'
  });
  assert.equal(html, '<div class="empty">Aucun courrier en attente.</div>');
  assert.ok(html.indexOf('<table') < 0, 'un en-tête seul, sans ligne, est pire que rien');
});

test('sans message, une liste vide ne rend rien du tout', function () {
  /* Certains écrans placent leur propre explication au-dessus : leur imposer
     un état vide en dessous ferait deux fois la même phrase. */
  assert.equal(tableau({ colonnes: ['Nom'], lignes: [], ligne: function () { return ['']; } }), '');
});

test('l’enveloppe, l’en-tête et les lignes', function () {
  const html = tableau({
    colonnes: ['Nom', 'N° boîte'],
    lignes: TROIS,
    ligne: function (x) { return [x.n, x.b]; }
  });
  assert.match(html, /^<div class="table-scroll"><table><thead>/);
  assert.match(html, /<\/tbody><\/table><\/div>$/);
  assert.equal((html.match(/<tr/g) || []).length, 4, 'trois lignes plus celle de l’en-tête');
  assert.equal((html.match(/<th[ >]/g) || []).length, 2, '« <thead> » ne compte pas pour une colonne');
  assert.match(html, /<td>Amina<\/td><td>B-12<\/td>/);
});

test('la classe d’une colonne se pose sur toute la colonne', function () {
  /* Elle était recopiée sur chaque cellule de chaque ligne. Une fois suffit,
     et une fois ne peut pas être oubliée à la troisième ligne. */
  const html = tableau({
    colonnes: [{ titre: 'N° boîte', classe: 'box-cell' }, { titre: '', classe: 'actions' }],
    lignes: TROIS,
    ligne: function (x) { return [x.b, '<button>Fiche</button>']; }
  });
  assert.equal((html.match(/<td class="box-cell">/g) || []).length, 3);
  assert.equal((html.match(/<td class="actions">/g) || []).length, 3);
  /* Mais pas sur l'intitulé : `box-cell` et `tel-cell` fixent une police et une
     couleur de donnée, qui n'ont rien à faire sur un en-tête. La première
     version le posait des deux côtés, et l'empreinte l'a vu tout de suite. */
  assert.match(html, /<th>N° boîte<\/th>/);
  assert.ok(html.indexOf('<th class=') < 0, 'la classe d’une colonne ne remonte pas sur son intitulé');
});

test('un intitulé peut demander sa propre classe, s’il la demande', function () {
  const html = tableau({
    colonnes: [{ titre: 'Taux', classe: 'attente-cell', classeTitre: 'a-droite' }],
    lignes: [{ t: '80 %' }],
    ligne: function (x) { return [x.t]; }
  });
  assert.match(html, /<th class="a-droite">Taux<\/th>/);
  assert.match(html, /<td class="attente-cell">80 %<\/td>/);
});

test('une cellule peut ajouter sa propre classe et ses attributs', function () {
  const html = tableau({
    colonnes: [{ titre: 'Nom', classe: 'nom' }],
    lignes: [{ n: 'Amina' }],
    ligne: function (x) {
      return [{ html: x.n, classe: 'gras', attrs: 'title="Cc : x@y.z"' }];
    }
  });
  assert.match(html, /<td class="nom gras" title="Cc : x@y\.z">Amina<\/td>/);
});

test('la ligne peut porter une classe : c’est ce qui signale un courrier qui traîne', function () {
  const html = tableau({
    colonnes: ['Nom'],
    lignes: TROIS,
    ligne: function (x) { return [x.n]; },
    attrsLigne: function (x, i) { return i === 1 ? ' class="vieux"' : ''; }
  });
  assert.equal((html.match(/<tr class="vieux">/g) || []).length, 1);
  assert.equal((html.match(/<tr>/g) || []).length, 3, 'les deux autres lignes et l’en-tête');
});

test('sans colonnes, pas d’en-tête — certaines listes n’en veulent pas', function () {
  const html = tableau({
    lignes: [{ b: 'B-12', n: 4 }],
    ligne: function (x) { return [x.b, x.n]; }
  });
  assert.ok(html.indexOf('<thead>') < 0);
  assert.match(html, /<table><tbody><tr><td>B-12<\/td><td>4<\/td><\/tr>/);
});

test('une ligne peut rendre son balisage entier — l’unique échappatoire', function () {
  /* Le registre sort *deux* `<tr>` pour la fiche en cours de correction :
     celui des champs, et celui des absences en dessous. Sans cette porte, cet
     écran-là aurait dû garder son tableau écrit à la main — et c'est exactement
     comme ça qu'un motif recopié survit à sa mise en commun. */
  const html = tableau({
    colonnes: ['Nom', 'Boîte'],
    lignes: TROIS,
    ligne: function (x, i) {
      if (i === 1) return { brut: '<tr class="edition"><td colspan="2">en cours</td></tr><tr><td colspan="2">absences</td></tr>' };
      return [x.n, x.b];
    },
    attrsLigne: function () { return ' class="normale"'; }
  });
  assert.match(html, /<tr class="edition"><td colspan="2">en cours<\/td><\/tr><tr><td colspan="2">absences<\/td><\/tr>/);
  assert.equal((html.match(/<tr class="normale">/g) || []).length, 2, 'les autres lignes restent ordinaires');
  assert.ok(html.indexOf('<tr class="normale"><tr') < 0, 'la ligne brute n’est pas enveloppée une seconde fois');
});

test('le défilement se retire quand le tableau vit déjà dans un cadre', function () {
  const html = tableau({
    colonnes: ['Nom'], lignes: TROIS, ligne: function (x) { return [x.n]; }, defilement: false
  });
  assert.match(html, /^<table>/);
  assert.ok(html.indexOf('table-scroll') < 0);
});

test('une hauteur peut être imposée à l’enveloppe', function () {
  const html = tableau({
    colonnes: ['Nom'], lignes: TROIS, ligne: function (x) { return [x.n]; }, style: 'max-height:38vh;'
  });
  assert.match(html, /^<div class="table-scroll" style="max-height:38vh;">/);
});

/* ── ce que le module ne fait pas, et pourquoi ── */

test('rien n’est échappé : c’est l’appelant qui sait', function () {
  /* Les cellules arrivent écrites — du texte échappé pour les unes, des
     boutons pour les autres. Échapper ici obligerait à rouvrir une porte pour
     tout le HTML légitime, et cette porte reste ouverte. Le test énonce la
     règle pour que personne ne « corrige » le module un jour. */
  const html = tableau({
    colonnes: ['Nom'],
    lignes: [{ n: '<script>alert(1)</script>' }],
    ligne: function (x) { return [x.n]; }
  });
  assert.match(html, /<td><script>alert\(1\)<\/script><\/td>/);
});

test('le compte des cellules se vérifie, parce que le décalage est muet', function () {
  /* Une colonne ajoutée à l'en-tête sans sa cellule ne casse rien : le tableau
     sort, plus étroit d'un cran, et tout glisse. C'est le défaut le plus cher
     de cette famille — on lit le téléphone de quelqu'un d'autre. */
  const trop = {
    colonnes: ['Nom', 'Boîte'],
    lignes: TROIS,
    ligne: function (x) { return [x.n, x.b, 'en trop']; }
  };
  const pasAssez = {
    colonnes: ['Nom', 'Boîte', 'Attente'],
    lignes: TROIS,
    ligne: function (x) { return [x.n, x.b]; }
  };
  const juste = {
    colonnes: ['Nom', 'Boîte'],
    lignes: TROIS,
    ligne: function (x) { return [x.n, x.b]; }
  };
  assert.equal(T.verifierLargeur(trop), 1);
  assert.equal(T.verifierLargeur(pasAssez), -1);
  assert.equal(T.verifierLargeur(juste), 0);
});

test('une cellule absente vaut une cellule vide, pas « undefined »', function () {
  const html = tableau({
    colonnes: ['Nom', 'Téléphone'],
    lignes: [{ n: 'Amina' }],
    ligne: function (x) { return [x.n, x.tel]; }
  });
  assert.match(html, /<td>Amina<\/td><td><\/td>/);
  assert.ok(html.indexOf('undefined') < 0, 'un « undefined » dans une colonne téléphone est un appel manqué');
});
