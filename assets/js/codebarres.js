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

  return {
    MOTIFS: MOTIFS,
    DELIMITEUR: DELIMITEUR,
    estCodable: estCodable,
    normaliser: normaliser,
    elements: elements,
    html: html
  };
});
