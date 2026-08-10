/* Bureau du Courrier — un code à barres sur l'attestation.
 *
 * À quoi ça sert. Une personne domiciliée revient au guichet avec son
 * attestation. Sans code, l'agent retape son nom — mal orthographié une fois
 * sur trois, quand il ne s'agit pas d'un nom qu'on ne sait pas écrire. Avec un
 * lecteur de comptoir, le dossier s'ouvre d'un geste.
 *
 * Pourquoi Code 39 et pas un QR. Le Code 39 se code à la main en une table de
 * motifs : neuf éléments par caractère, trois larges et six étroits, d'où son
 * nom. Aucune somme de contrôle obligatoire, aucune dépendance, et tous les
 * lecteurs de comptoir le lisent depuis quarante ans. Un QR exigerait un
 * correcteur Reed-Solomon — donc une bibliothèque, dans un projet qui n'en a
 * aucune, pour un gain nul à cet usage.
 *
 * Ce module ne rend que des barres : ni DOM, ni impression. C'est ce qui le
 * rend vérifiable hors navigateur, motif par motif.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.codebarres = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Chaque caractère vaut neuf éléments, alternant barre et espace en
     commençant par une barre : « n » étroit, « w » large. La table est celle de
     la norme ; elle se relit caractère par caractère dans les tests. */
  const MOTIFS = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw',
    'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn',
    'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn', 'K': 'wnnnnnnww', 'L': 'nnwnnnnww',
    'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn',
    'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw',
    'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn',
    '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn',
    '$': 'nwnwnwnnn', '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn',
    // L'astérisque n'encode rien : il ouvre et ferme la lecture.
    '*': 'nwnnwnwnn'
  };

  const DELIMITEUR = '*';

  /** Les caractères que le Code 39 sait écrire. Le reste doit être écarté. */
  function estCodable(caractere) {
    return Object.prototype.hasOwnProperty.call(MOTIFS, caractere) && caractere !== DELIMITEUR;
  }

  /**
   * Ramène un texte à ce que le Code 39 accepte : majuscules, chiffres, et
   * quelques signes. Les accents tombent — un lecteur ne les rendrait pas — et
   * ce qui reste illisible est retiré plutôt que de faire échouer l'encodage.
   */
  function normaliser(texte) {
    return String(texte === null || texte === undefined ? '' : texte)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .split('')
      .filter(estCodable)
      .join('');
  }

  /**
   * La suite des barres et espaces d'un texte.
   * @returns {Array<{large: boolean, barre: boolean}>} du premier au dernier.
   */
  function elements(texte) {
    const propre = normaliser(texte);
    if (!propre) return [];
    // Encadré du délimiteur : c'est lui qui dit au lecteur où commencer.
    const suite = DELIMITEUR + propre + DELIMITEUR;
    const out = [];
    suite.split('').forEach(function (c, index) {
      // Un espace étroit sépare deux caractères, sans quoi ils se confondent.
      if (index > 0) out.push({ large: false, barre: false });
      MOTIFS[c].split('').forEach(function (taille, i) {
        out.push({ large: taille === 'w', barre: i % 2 === 0 });
      });
    });
    return out;
  }

  /**
   * Le code à barres en HTML : une suite de traits de largeur variable.
   *
   * Rendu en éléments plutôt qu'en image : rien à encoder en base64, rien à
   * charger, et l'impression sort net à n'importe quelle résolution — une
   * image tramée, elle, devient illisible au lecteur.
   *
   * @param {string} texte
   * @param {{hauteur?: number, etroit?: number, avecTexte?: boolean}} [options]
   * @returns {string} HTML, zone de silence comprise.
   */
  function html(texte, options) {
    const o = options || {};
    const propre = normaliser(texte);
    if (!propre) return '';
    const hauteur = o.hauteur || 38;
    const etroit = o.etroit || 2;
    // Rapport 1:3 — la norme tolère 1:2 à 1:3 ; le plus large se lit mieux.
    const large = etroit * 3;

    /* La zone de silence : une marge blanche d'au moins dix fois la largeur
       d'un élément étroit, de chaque côté. Sans elle, le lecteur ne trouve pas
       le début du code et refuse de lire — le défaut classique des codes à
       barres faits maison, invisible à l'œil et fatal au comptoir. */
    const silence = etroit * 10;

    const barres = elements(propre)
      .map(function (el) {
        const l = el.large ? large : etroit;
        return (
          '<span class="cb-el' +
          (el.barre ? ' cb-barre' : '') +
          '" style="width:' + l + 'px;height:' + hauteur + 'px;"></span>'
        );
      })
      .join('');

    /* Le code reste écrit en clair sous les barres : un lecteur en panne, une
       impression pâle, et l'attestation doit rester utilisable à l'œil. */
    const legende =
      o.avecTexte === false
        ? ''
        : '<span class="cb-legende">' + propre.replace(/[&<>"]/g, '') + '</span>';

    return (
      '<span class="codebarres" role="img"' +
      ' style="padding-left:' + silence + 'px;padding-right:' + silence + 'px;"' +
      ' aria-label="Code ' + propre.replace(/[&<>"]/g, '') + '">' +
      barres + legende +
      '</span>'
    );
  }

  /* ═══════════════ LA LECTURE ═══════════════

     Le module savait écrire ; il sait maintenant relire. C'est ce qui permet
     de scanner sans dépendance : la table est déjà là, il suffit de la
     retourner.

     Pourquoi ça vaut la peine. `BarcodeDetector`, l'API native des
     navigateurs, n'existe pas partout — pas dans le Chromium de cette machine,
     pas dans Firefox. S'appuyer dessus seul, c'est un scanner qui marche chez
     soi et nulle part ailleurs. Ce décodeur-ci lit **les étiquettes que
     l'application imprime elle-même** — celles des casiers, celles des
     attestations — sur n'importe quel navigateur, et sans rien installer.

     Ce qu'il ne lit pas : les QR, les Code 128 des transporteurs. Pour
     ceux-là, l'API native quand elle est là, ou la douchette USB — qui les lit
     tous depuis quarante ans et tape le code comme un clavier. */

  const PAR_MOTIF = (function () {
    const out = {};
    Object.keys(MOTIFS).forEach(function (c) {
      out[MOTIFS[c]] = c;
    });
    return out;
  })();

  /* Un caractère = neuf éléments dont **exactement trois larges**. C'est cette
     invariance qui permet de décoder sans connaître l'échelle : on trie les
     neuf mesures, les trois plus grandes sont les larges.

     C'est aussi ce qui rend la lecture robuste à un code photographié de
     travers, où les barres s'élargissent d'un bout à l'autre : le classement
     se refait à chaque caractère, jamais une fois pour tout le code. */
  function classer(neuf) {
    const tries = neuf.slice().sort(function (a, b) { return b - a; });
    const seuil = tries[2];
    // Départage à égalité : sans lui, quatre mesures identiques donneraient
    // quatre larges et un motif introuvable.
    let restants = 3;
    return neuf.map(function (x) {
      if (x > seuil) return 'w';
      if (x === seuil && restants > 0) { restants--; return 'w'; }
      return 'n';
    });
  }

  /* Décode une suite de largeurs brutes — barres et espaces alternés, en
     commençant par une barre. Rend le texte lu, ou `null`. */
  function lireLargeurs(largeurs) {
    const l = (largeurs || []).filter(function (x) { return x > 0; });
    // n caractères = 9n éléments + (n-1) espaces de séparation.
    if (l.length < 9 || (l.length + 1) % 10 !== 0) return null;
    const n = (l.length + 1) / 10;

    let texte = '';
    for (let i = 0; i < n; i++) {
      const neuf = l.slice(i * 10, i * 10 + 9);
      const c = PAR_MOTIF[classer(neuf).join('')];
      if (!c) return null;
      texte += c;
    }
    // Le délimiteur ouvre et ferme : sans lui, ce n'est pas un Code 39.
    if (texte.length < 3 || texte[0] !== DELIMITEUR || texte[texte.length - 1] !== DELIMITEUR) {
      return null;
    }
    const contenu = texte.slice(1, -1);
    return contenu.indexOf(DELIMITEUR) >= 0 ? null : contenu;
  }

  /* Une ligne de pixels en niveaux de gris → les largeurs des zones noires et
     blanches. Le seuil est la moyenne entre le plus clair et le plus sombre de
     *cette ligne* : un éclairage de guichet n'est jamais celui d'un scanner à
     plat, et un seuil fixe à 128 rate un code photographié dans l'ombre. */
  function segmenter(gris) {
    if (!gris || gris.length < 3) return [];
    let min = 255;
    let max = 0;
    for (let i = 0; i < gris.length; i++) {
      if (gris[i] < min) min = gris[i];
      if (gris[i] > max) max = gris[i];
    }
    // Trop peu de contraste : ce n'est pas un code à barres, c'est un mur.
    if (max - min < 40) return [];
    const seuil = (min + max) / 2;

    const runs = [];
    let noirCourant = gris[0] < seuil;
    let debut = 0;
    for (let i = 1; i <= gris.length; i++) {
      const noir = i < gris.length ? gris[i] < seuil : !noirCourant;
      if (noir !== noirCourant) {
        runs.push({ noir: noirCourant, largeur: i - debut });
        noirCourant = noir;
        debut = i;
      }
    }
    /* On part de la première barre noire et on s'arrête à la dernière : le
       blanc du papier autour n'est pas un élément du code. */
    let a = 0;
    while (a < runs.length && !runs[a].noir) a++;
    let b = runs.length - 1;
    while (b >= 0 && !runs[b].noir) b--;
    if (a > b) return [];
    return runs.slice(a, b + 1).map(function (r) { return r.largeur; });
  }

  /** Une ligne de pixels gris → le texte, ou `null`. */
  function lireLigne(gris) {
    return lireLargeurs(segmenter(gris));
  }

  return {
    MOTIFS: MOTIFS,
    DELIMITEUR: DELIMITEUR,
    estCodable: estCodable,
    normaliser: normaliser,
    elements: elements,
    html: html,
    classer: classer,
    lireLargeurs: lireLargeurs,
    segmenter: segmenter,
    lireLigne: lireLigne
  };
});
