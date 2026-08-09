/* Bureau du Courrier — un tableau, écrit une fois.

   Dix-sept écrans dessinaient un tableau, et les dix-sept recopiaient la même
   enveloppe : `<div class="table-scroll"><table><thead><tr>` … `</tbody></table></div>`,
   un `.map().join('')` au milieu, et une branche « la liste est vide » à côté.
   Six lignes de bruit par tableau, et six occasions de les écrire un peu
   différemment — ce qui est arrivé.

   Le module ne connaît ni le magasin, ni les écrans, ni le DOM : il reçoit des
   données et rend une chaîne. C'est ce qui permet à `test/tableau.test.js` de
   l'ouvrir sous Node, et c'est la première part du *rendu* que la suite
   ordinaire peut vérifier — tout le reste de l'interface exige un navigateur.

   Ce qu'il garantit, et qu'aucune relecture ne garantissait :

     — **autant de cellules que de colonnes.** Une colonne ajoutée à l'en-tête
       sans la cellule correspondante décalait silencieusement toute la ligne ;
       ici la classe de colonne et la cellule sont posées ensemble.
     — **une seule façon de dire « il n'y a rien ».** Vingt-quatre états vides
       existaient, tous en `<div class="empty">`, chacun réécrit à la main.

   Il n'échappe rien : les cellules arrivent déjà écrites par l'appelant, qui
   seul sait ce qui est du texte et ce qui est un bouton. Mettre l'échappement
   ici obligerait à rouvrir une porte pour tout le HTML légitime, et cette porte
   finit toujours par rester ouverte.

   Comme util.js, store.js et ui/noyau.js : window.BC.tableau dans le
   navigateur, module.exports sous Node. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory();
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.tableau = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Les attributs d'une colonne ou d'une cellule : ' class="actions"'. */
  function attributs(spec) {
    if (!spec) return '';
    let out = '';
    if (spec.classe) out += ' class="' + spec.classe + '"';
    if (spec.attrs) out += spec.attrs.charAt(0) === ' ' ? spec.attrs : ' ' + spec.attrs;
    return out;
  }

  /** Une colonne, sous ses deux formes : 'Nom' ou { titre, classe, attrs }. */
  function colonne(c) {
    return typeof c === 'string' ? { titre: c } : (c || { titre: '' });
  }

  /** Une cellule : 'B-12' ou { html, classe, attrs }. */
  function cellule(c, col) {
    const brut = c && typeof c === 'object' && 'html' in c;
    const html = brut ? c.html : c == null ? '' : String(c);
    /* La classe de la colonne s'applique à toute la colonne ; celle de la
       cellule s'y ajoute, pour les cas particuliers d'une ligne. */
    const classes = [col.classe, brut ? c.classe : null].filter(Boolean).join(' ');
    return '<td' + attributs({ classe: classes || null, attrs: brut ? c.attrs : null }) + '>' + html + '</td>';
  }

  /* ── le tableau ──

     tableau({
       colonnes : ['Nom', { titre: '', classe: 'actions' }],   // omis → pas d'en-tête
       lignes   : liste,
       ligne    : (x, i) => ['<strong>…</strong>', boutons],   // autant que de colonnes
                  // ou { brut: '<tr>…</tr>' } pour une ligne irrégulière
       attrsLigne : (x, i) => ' class="vieux"',                // facultatif
       vide     : 'Aucun courrier en attente.',                // facultatif
       defilement : false,                                     // sans l'enveloppe
       style    : 'max-height:38vh;'                           // sur l'enveloppe
     })
  */
  function tableau(o) {
    const options = o || {};
    const lignes = options.lignes || [];

    if (!lignes.length) {
      return options.vide ? '<div class="empty">' + options.vide + '</div>' : '';
    }

    const cols = (options.colonnes || []).map(colonne);
    /* La classe d'une colonne descend sur ses cellules, **pas** sur son
       intitulé : `box-cell` ou `tel-cell` fixent une police et une couleur qui
       n'ont aucun sens sur un `<th>`, lequel a déjà les siennes. L'intitulé
       peut demander la sienne, mais aucun ne le fait aujourd'hui. */
    const tete = options.colonnes
      ? '<thead><tr>' +
        cols.map(function (c) {
          return '<th' + attributs({ classe: c.classeTitre, attrs: c.attrsTitre }) + '>' +
            (c.titre || '') + '</th>';
        }).join('') +
        '</tr></thead>'
      : '';

    const corps = lignes
      .map(function (x, i) {
        const cellules = options.ligne(x, i);
        /* L'échappatoire, et la seule : une ligne qui n'est pas une ligne.
           Le registre en a une — la fiche qu'on est en train de corriger sort
           sur *deux* `<tr>`, celui des champs et celui des absences. Plutôt
           que d'obliger cet écran-là à réécrire toute l'enveloppe à la main,
           il rend son balisage complet et le module le laisse passer. */
        if (cellules && typeof cellules === 'object' && 'brut' in cellules) {
          return cellules.brut;
        }
        const attrs = options.attrsLigne ? options.attrsLigne(x, i) || '' : '';
        return '<tr' + attrs + '>' +
          cellules.map(function (c, k) {
            return cellule(c, cols[k] || {});
          }).join('') +
          '</tr>';
      })
      .join('');

    const table = '<table>' + tete + '<tbody>' + corps + '</tbody></table>';
    if (options.defilement === false) return table;
    return '<div class="table-scroll"' +
      (options.style ? ' style="' + options.style + '"' : '') +
      '>' + table + '</div>';
  }

  /* Combien de cellules manquent, ou sont en trop, sur la première ligne.
     Sert au test : c'est le défaut qui décale une colonne sans rien casser. */
  function verifierLargeur(o) {
    const options = o || {};
    if (!options.colonnes || !(options.lignes || []).length) return 0;
    const premiere = options.ligne(options.lignes[0], 0);
    if (!Array.isArray(premiere)) return 0;
    return premiere.length - options.colonnes.length;
  }

  return { tableau: tableau, verifierLargeur: verifierLargeur };
});
