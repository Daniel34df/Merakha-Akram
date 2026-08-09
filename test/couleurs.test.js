/* La palette doit rester lisible.

   Une refonte visuelle se juge sur une capture d'écran, et une capture d'écran
   ment : elle est regardée par quelqu'un qui a une bonne vue, sur un bon écran,
   dans une pièce éclairée. Le guichet, lui, tourne sur un portable posé de
   biais, près d'une fenêtre, huit heures d'affilée.

   Ce fichier lit les jetons de couleur directement dans `style.css` et calcule
   les rapports de contraste de la norme WCAG 2.1 pour chaque paire
   texte/fond — dans les deux thèmes. Un accent joli et illisible n'est pas un
   accent : c'est le même défaut que le code à barres sans zone de silence, qui
   sortait magnifiquement et qu'aucun lecteur ne prenait.

   Deux seuils, ceux de la norme :
     4,5:1  texte courant  (AA)
     3,0:1  grand texte, et tout ce qui n'est pas du texte — filets, bordures,
            anneaux de focus  (AA, critères 1.4.3 et 1.4.11)

   Le test lit le fichier plutôt qu'une liste recopiée : une couleur changée
   dans la feuille est vérifiée sans que personne ait à y penser. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'css', 'style.css'),
  'utf8'
);

/* ── lecture des jetons ────────────────────────────────────────────────── */

/** Le contenu d'un bloc, à partir de son sélecteur, accolades équilibrées. */
function bloc(selecteur) {
  const debut = CSS.indexOf(selecteur);
  assert.ok(debut >= 0, 'bloc introuvable dans style.css : ' + selecteur);
  const ouvre = CSS.indexOf('{', debut);
  let profondeur = 0;
  for (let i = ouvre; i < CSS.length; i++) {
    if (CSS[i] === '{') profondeur++;
    else if (CSS[i] === '}') {
      profondeur--;
      if (profondeur === 0) return CSS.slice(ouvre + 1, i);
    }
  }
  throw new Error('accolade non refermée après ' + selecteur);
}

/** Les couples `--nom:valeur` d'un bloc. */
function jetons(texte) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(texte))) out[m[1]] = m[2].trim();
  return out;
}

/** Résout un jeton jusqu'à une couleur, en suivant les `var(--autre)`. */
function resoudre(nom, table, vus) {
  vus = vus || [];
  assert.ok(vus.indexOf(nom) < 0, 'référence circulaire : ' + vus.concat(nom).join(' → '));
  const valeur = table[nom];
  assert.ok(valeur, 'jeton absent : ' + nom);
  const via = valeur.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (via) return resoudre(via[1], table, vus.concat(nom));
  return valeur;
}

const CLAIR = jetons(bloc(':root{'));
const SOMBRE = Object.assign({}, CLAIR, jetons(bloc(':root[data-theme="sombre"]')));

/* Le bloc du thème système doit dire exactement la même chose que le bloc du
   choix explicite : deux copies qui divergent, c'est une bascule qui change la
   couleur d'un bouton selon la façon dont on est arrivé au thème sombre. */
const SOMBRE_SYSTEME = jetons(bloc(':root:not([data-theme="clair"])'));

/* ── le calcul de la norme ─────────────────────────────────────────────── */

function canal(v) {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, 'couleur illisible : ' + hex);
  const n = m[1];
  const c = [0, 2, 4].map(function (i) {
    return canal(parseInt(n.slice(i, i + 2), 16) / 255);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contraste(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Le rapport entre deux jetons d'un même thème. */
function entre(table, avant, arriere) {
  return contraste(resoudre(avant, table), resoudre(arriere, table));
}

/* ── ce qu'on exige ────────────────────────────────────────────────────── */

/* Texte : 4,5:1. Chaque encre sur chaque fond où elle se pose réellement. */
const TEXTE = [
  ['--ink', '--bg'],
  ['--ink', '--surface'],
  ['--ink', '--surface-2'],
  ['--ink-2', '--bg'],
  ['--ink-2', '--surface'],
  ['--ink-2', '--surface-2'],
  ['--accent-texte', '--surface'],
  ['--accent-texte', '--bg'],
  ['--ok', '--surface'],
  ['--warn', '--surface'],
  ['--danger', '--surface'],
  ['--info', '--surface'],
  ['--danger', '--danger-wash'],
  ['--ok', '--ok-wash'],
  ['--warn', '--warn-wash']
];

/* Non-texte : 3:1. Ce qui doit se distinguer sans se lire.

   `--line` n'y figure pas, et c'est délibéré : c'est un séparateur décoratif —
   entre deux lignes d'un tableau — que la norme n'astreint à rien. `--bord`,
   lui, dessine le pourtour d'un champ ou d'une case : il faut voir où finir
   d'écrire, donc 3:1 sur les deux surfaces où on le pose. Confondre les deux
   jetons, c'est soit un tableau zébré de traits durs, soit un formulaire dont
   les champs sont invisibles. */
const NON_TEXTE = [
  ['--bord', '--surface'],
  ['--bord', '--surface-2'],
  ['--a1', '--bg'],
  ['--a1', '--surface'],
  ['--h-guichet', '--surface'],
  ['--h-remise', '--surface'],
  ['--h-registre', '--surface'],
  ['--h-suivi', '--surface'],
  ['--h-domiciliation', '--surface'],
  ['--h-reglages', '--surface']
];

/* Aplats qui portent du texte blanc : boutons, pastilles, en-têtes. */
const APLATS_BLANC = ['--accent', '--accent-2', '--danger', '--ok'];

const THEMES = [['clair', CLAIR], ['sombre', SOMBRE]];

test('le texte atteint AA sur tous les fonds où il se pose', function () {
  THEMES.forEach(function (t) {
    const nom = t[0];
    const table = t[1];
    TEXTE.forEach(function (paire) {
      const r = entre(table, paire[0], paire[1]);
      assert.ok(
        r >= 4.5,
        'thème ' + nom + ' : ' + paire[0] + ' sur ' + paire[1] +
          ' ne fait que ' + r.toFixed(2) + ':1 (il en faut 4,5)'
      );
    });
  });
});

test('les filets et les teintes d’onglet se distinguent du fond', function () {
  THEMES.forEach(function (t) {
    const nom = t[0];
    const table = t[1];
    NON_TEXTE.forEach(function (paire) {
      const r = entre(table, paire[0], paire[1]);
      assert.ok(
        r >= 3,
        'thème ' + nom + ' : ' + paire[0] + ' sur ' + paire[1] +
          ' ne fait que ' + r.toFixed(2) + ':1 (il en faut 3)'
      );
    });
  });
});

/* Le thème sombre inverse tout, sauf ça : un bouton reste un aplat coloré
   portant du texte blanc. C'est la paire qui se casse le plus vite quand on
   éclaircit un accent pour qu'il « ressorte mieux » sur du noir. */
test('le texte blanc reste lisible sur les aplats colorés', function () {
  THEMES.forEach(function (t) {
    const nom = t[0];
    const table = t[1];
    APLATS_BLANC.forEach(function (jeton) {
      if (nom === 'sombre' && (jeton === '--danger' || jeton === '--ok')) return;
      const r = contraste('#FFFFFF', resoudre(jeton, table));
      assert.ok(
        r >= 4.5,
        'thème ' + nom + ' : blanc sur ' + jeton +
          ' ne fait que ' + r.toFixed(2) + ':1 (il en faut 4,5)'
      );
    });
  });
});

test('les deux écritures du thème sombre disent la même chose', function () {
  Object.keys(SOMBRE_SYSTEME).forEach(function (nom) {
    assert.equal(
      jetons(bloc(':root[data-theme="sombre"]'))[nom],
      SOMBRE_SYSTEME[nom],
      nom + ' diffère entre le thème suivi du système et le thème choisi'
    );
  });
  assert.deepEqual(
    Object.keys(jetons(bloc(':root[data-theme="sombre"]'))).sort(),
    Object.keys(SOMBRE_SYSTEME).sort(),
    'les deux blocs sombres ne couvrent pas les mêmes jetons'
  );
});

/* ── le papier ─────────────────────────────────────────────────────────
   Les valeurs gelées. Si l'une bouge, c'est qu'une refonte d'écran a débordé
   sur un document qu'une personne présente à un guichet. */
test('les couleurs du papier n’ont pas bougé', function () {
  assert.equal(CLAIR['--p-ink'], '#16233F');
  assert.equal(CLAIR['--p-ink-2'], '#5B6B82');
  assert.equal(CLAIR['--p-paper'], '#F4F0E6');
  assert.equal(CLAIR['--p-line'], '#CFC6AE');
  assert.equal(CLAIR['--p-accent'], '#B8892B');
  assert.match(CLAIR['--print-display'], /Special Elite/);
  assert.match(CLAIR['--print-serif'], /Source Serif 4/);
  assert.match(CLAIR['--print-mono'], /JetBrains Mono/);
});

test('aucun thème ne repeint le papier', function () {
  ['--p-ink', '--p-ink-2', '--p-paper', '--p-line', '--p-accent',
   '--print-display', '--print-serif', '--print-mono'].forEach(function (jeton) {
    assert.ok(
      !(jeton in jetons(bloc(':root[data-theme="sombre"]'))) &&
        !(jeton in SOMBRE_SYSTEME),
      jeton + ' est redéfini par le thème sombre : le papier suivrait l’écran'
    );
  });
});

/* Les règles qui s'impriment ne doivent tirer leurs polices et leurs encres
   que des jetons du papier. Ce contrôle-là attrape la retouche distraite —
   celle qui remet `var(--ink)` dans l'attestation six mois plus tard. */
test('les règles du papier ne piochent que dans les jetons du papier', function () {
  const SELECTEURS = [
    '.feuille-casier', '.attestation', '.attest-', '.etq-', '.planche-etiquettes'
  ];
  const ECRAN = /var\(--(ink|ink-2|bg|surface|surface-2|line|a1|a2|accent|accent-2|accent-texte|display|sans|serif|typewriter|navy|paper|card|field|brass|slate|forest|rust)\)/;

  /* On ne lit pas le bloc @media print : il est déjà en valeurs littérales. */
  const avantPrint = CSS.slice(0, CSS.indexOf('body.impression-casier'));
  const regles = avantPrint.split('}');
  regles.forEach(function (r) {
    const tete = r.slice(r.lastIndexOf('\n', r.indexOf('{')) + 1, r.indexOf('{'));
    if (r.indexOf('{') < 0) return;
    const vise = SELECTEURS.some(function (s) {
      return tete.indexOf(s) >= 0;
    });
    if (!vise) return;
    const fautif = ECRAN.exec(r);
    assert.ok(
      !fautif,
      'règle du papier « ' + tete.trim() + ' » : ' + fautif +
        ' vient de l’écran, il faut un jeton --p-* ou --print-*'
    );
  });
});
