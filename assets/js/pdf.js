/* Bureau du Courrier — écrire un PDF, sans dépendance.

   Pourquoi c'est nécessaire. Une attestation de domiciliation s'imprime, et
   c'est le cas le plus fréquent. Mais elle se **transmet** aussi : la personne
   la dépose à la CAF, l'envoie à l'assurance maladie, la garde sur un
   téléphone. « Imprimer vers un PDF » existe sur la plupart des postes, mais
   pas sur tous, et le résultat porte alors les en-têtes du navigateur — date,
   URL, numéro de page — sur un document qui doit avoir l'air d'un document
   officiel, parce qu'il en est un.

   Pourquoi c'est écrit à la main. Une bibliothèque PDF, c'est la première
   dépendance du projet, sur un poste de réception qui n'installe rien. Le
   format PDF a une propriété qui rend l'exercice raisonnable : **on peut en
   écrire un lisible avec du texte et quelques nombres**. Pas d'images, pas de
   compression, pas de polices embarquées — les quatorze polices « standard »
   (Helvetica, Times, Courier) sont garanties présentes dans tout lecteur, et
   c'est tout ce dont une attestation a besoin.

   Ce que ce module ne fait pas, et n'essaiera pas de faire :

     · **pas de rendu HTML.** Convertir une page en PDF, c'est réécrire un
       moteur de mise en page. Ce module reçoit des blocs déjà décrits — un
       titre, un paragraphe, un tableau — et les pose sur la page.
     · **pas d'images ni de logos.** Elles demanderaient la compression, donc
       une bibliothèque. L'en-tête du bureau s'écrit en texte.
     · **pas d'unicode complet.** L'encodage WinAnsi couvre le français, ce qui
       est l'usage. Un caractère hors de cette table devient un point
       d'interrogation plutôt que de corrompre le fichier.

   Calcul pur, vérifiable hors navigateur — un PDF est un tableau d'octets, et
   un tableau d'octets se relit dans un test. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory();
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.pdf = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* A4 en points PostScript (1/72 de pouce), la seule unité que PDF connaisse.
     210 × 297 mm. */
  const A4 = { largeur: 595.28, hauteur: 841.89 };
  const MARGE = 56; // ~2 cm

  /* Les polices standard, garanties présentes dans tout lecteur — c'est ce qui
     permet de ne rien embarquer. */
  const POLICES = { normal: 'Helvetica', gras: 'Helvetica-Bold', italique: 'Helvetica-Oblique' };

  /* Largeur moyenne d'un caractère, en fraction de la taille de police. Les
     vraies largeurs Helvetica sont une table de 256 entrées ; cette
     approximation suffit à couper les lignes au bon endroit, et une ligne
     coupée un mot trop tôt est sans conséquence sur une attestation. Trop
     généreuse serait pire : le texte déborderait de la page. */
  const LARGEUR_MOY = 0.5;

  /* WinAnsi (CP1252) pour les caractères français hors ASCII. Sans cette table,
     « é » sort en deux octets UTF-8 et le lecteur affiche « Ã© » — sur une
     attestation destinée à une administration, c'est disqualifiant. */
  const WINANSI = {
    '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135,
    'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, 'Ž': 142, '‘': 145,
    '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '˜': 152,
    '™': 153, 'š': 154, '›': 155, 'œ': 156, 'ž': 158, 'Ÿ': 159
  };

  /* Un texte, en octets PDF.

     Les parenthèses et la barre oblique inverse ouvrent et ferment les chaînes
     PDF : les laisser passer telles quelles casserait le fichier — et un nom
     de famille comme « O'Brien (dit Paul) » suffit à le déclencher. */
  function encoder(texte) {
    const out = [];
    const s = String(texte === null || texte === undefined ? '' : texte);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const code = c.charCodeAt(0);
      let octet;
      if (code < 256) octet = code;
      else if (WINANSI[c] !== undefined) octet = WINANSI[c];
      else octet = 63; // « ? » : lisible, plutôt qu'un fichier corrompu.
      if (octet === 40 || octet === 41 || octet === 92) out.push(92); // ( ) \
      out.push(octet);
    }
    return out;
  }

  function chaine(texte) {
    return '(' + encoder(texte).map(function (o) { return String.fromCharCode(o); }).join('') + ')';
  }

  /* Couper un paragraphe en lignes qui tiennent dans la largeur.

     Un mot plus long que la ligne entière — une adresse électronique, un
     numéro de suivi — est coupé net plutôt que de déborder : mieux vaut une
     coupure laide qu'un texte qui sort de la feuille et qu'on ne lit pas. */
  function couper(texte, largeur, taille) {
    const max = Math.max(1, Math.floor(largeur / (taille * LARGEUR_MOY)));
    const lignes = [];
    String(texte === null || texte === undefined ? '' : texte)
      .split('\n')
      .forEach(function (paragraphe) {
        const mots = paragraphe.split(/\s+/).filter(Boolean);
        if (!mots.length) { lignes.push(''); return; }
        let courante = '';
        mots.forEach(function (mot) {
          while (mot.length > max) {
            if (courante) { lignes.push(courante); courante = ''; }
            lignes.push(mot.slice(0, max));
            mot = mot.slice(max);
          }
          const essai = courante ? courante + ' ' + mot : mot;
          if (essai.length <= max) {
            courante = essai;
          } else {
            if (courante) lignes.push(courante);
            courante = mot;
          }
        });
        if (courante) lignes.push(courante);
      });
    return lignes;
  }

  /* ─────────── le document ───────────

     Un PDF est une suite d'objets numérotés, puis une table qui dit où chacun
     commence en octets depuis le début du fichier. C'est cette table — le
     « xref » — qui oblige à construire le fichier en deux temps : on assemble,
     on mesure, puis on écrit les positions.

     `blocs` est une liste de descriptions, pas de HTML :
       { type:'titre',  texte }
       { type:'texte',  texte, taille?, gras?, italique? }
       { type:'espace', hauteur? }
       { type:'trait' }
       { type:'tableau', entetes:[], lignes:[[]] }
       { type:'signature', texte }                 — un cadre à signer
  */
  function document(blocs, options) {
    const o = options || {};
    const pages = [];
    let flux = [];
    let y = A4.hauteur - MARGE;
    const largeur = A4.largeur - 2 * MARGE;

    function nouvellePage() {
      if (flux.length) pages.push(flux.join('\n'));
      flux = [];
      y = A4.hauteur - MARGE;
    }

    /* Descendre de `h`, en changeant de page s'il ne reste pas la place. La
       marge du bas est la même que celle du haut : un texte qui court jusqu'au
       bord d'une attestation la fait passer pour un brouillon. */
    function place(h) {
      if (y - h < MARGE) nouvellePage();
      y -= h;
      return y;
    }

    function ligne(texte, taille, police, decalage) {
      flux.push('BT /' + police + ' ' + taille + ' Tf ' +
        (MARGE + (decalage || 0)) + ' ' + y.toFixed(2) + ' Td ' + chaine(texte) + ' Tj ET');
    }

    (blocs || []).forEach(function (bloc) {
      if (!bloc) return;
      const type = bloc.type || 'texte';

      if (type === 'espace') {
        place(bloc.hauteur === undefined ? 12 : bloc.hauteur);
        return;
      }

      if (type === 'trait') {
        place(10);
        flux.push('0.7 w ' + MARGE + ' ' + y.toFixed(2) + ' m ' +
          (A4.largeur - MARGE) + ' ' + y.toFixed(2) + ' l S');
        place(6);
        return;
      }

      if (type === 'signature') {
        /* Un cadre vide et une légende. Une attestation qui se signe à la main
           a besoin d'une place prévue pour ça, sinon la signature se pose sur
           le texte. */
        place(70);
        flux.push('0.7 w ' + (A4.largeur - MARGE - 200) + ' ' + y.toFixed(2) +
          ' 200 60 re S');
        const gardeY = y;
        y = gardeY - 12;
        ligne(bloc.texte || 'Signature et cachet', 8, POLICES.italique, largeur - 200);
        y = gardeY;
        place(6);
        return;
      }

      if (type === 'tableau') {
        const taille = bloc.taille || 9;
        const colonnes = (bloc.entetes || []).length ||
          ((bloc.lignes || [])[0] || []).length || 1;
        const pas = largeur / colonnes;

        if (bloc.entetes && bloc.entetes.length) {
          place(taille + 6);
          bloc.entetes.forEach(function (t, i) {
            ligne(String(t), taille, POLICES.gras, i * pas);
          });
          place(4);
          flux.push('0.4 w ' + MARGE + ' ' + y.toFixed(2) + ' m ' +
            (A4.largeur - MARGE) + ' ' + y.toFixed(2) + ' l S');
        }
        (bloc.lignes || []).forEach(function (l) {
          place(taille + 5);
          (l || []).forEach(function (cellule, i) {
            /* Une cellule trop longue est tronquée, pas repliée : un tableau
               dont les lignes n'ont pas toutes la même hauteur devient
               illisible, et c'est un tableau qu'on lit en diagonale. */
            const max = Math.max(1, Math.floor((pas - 6) / (taille * LARGEUR_MOY)));
            const t = String(cellule === null || cellule === undefined ? '' : cellule);
            ligne(t.length > max ? t.slice(0, max - 1) + '…' : t, taille, POLICES.normal, i * pas);
          });
        });
        return;
      }

      /* titre ou texte */
      const titre = type === 'titre';
      const taille = bloc.taille || (titre ? 16 : 10.5);
      const police = titre || bloc.gras ? POLICES.gras : bloc.italique ? POLICES.italique : POLICES.normal;
      const interligne = taille * 1.45;
      if (titre) place(8);
      couper(bloc.texte, largeur, taille).forEach(function (l) {
        place(interligne);
        if (l) ligne(l, taille, police);
      });
      if (titre) place(6);
    });

    nouvellePage();
    if (!pages.length) pages.push('');
    return assembler(pages, o);
  }

  /* Assemblage : objets, table de positions, et la fin de fichier.

     Numérotation : 1 = catalogue, 2 = arbre des pages, 3 = police, puis pour
     chaque page un objet page et un objet flux. */
  function assembler(pages, options) {
    const objets = [];
    const nPages = pages.length;
    const idsPages = [];
    for (let i = 0; i < nPages; i++) idsPages.push(4 + i * 2);

    objets[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objets[2] = '<< /Type /Pages /Kids [' +
      idsPages.map(function (id) { return id + ' 0 R'; }).join(' ') +
      '] /Count ' + nPages + ' >>';
    /* Une seule ressource de police déclarée en trois variantes : les lecteurs
       les résolvent par leur nom standard, rien n'est embarqué. */
    objets[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

    const fontsDict = '<< /Helvetica 3 0 R /Helvetica-Bold 5000 0 R /Helvetica-Oblique 5001 0 R >>';
    objets[5000] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    objets[5001] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>';

    pages.forEach(function (flux, i) {
      const idPage = idsPages[i];
      const idFlux = idPage + 1;
      objets[idPage] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
        A4.largeur.toFixed(2) + ' ' + A4.hauteur.toFixed(2) + '] ' +
        '/Resources << /Font ' + fontsDict + ' >> /Contents ' + idFlux + ' 0 R >>';
      objets[idFlux] = { flux: flux };
    });

    const utilises = Object.keys(objets).map(Number).sort(function (a, b) { return a - b; });
    /* Les numéros doivent être contigus pour la table xref : on les renumérote
       en gardant l'ordre, et on réécrit les renvois. */
    const renum = {};
    utilises.forEach(function (id, i) { renum[id] = i + 1; });

    function remplacerRenvois(s) {
      return String(s).replace(/(\d+) 0 R/g, function (_, id) {
        return (renum[Number(id)] || Number(id)) + ' 0 R';
      });
    }

    /* La deuxième ligne est un commentaire contenant quatre octets au-dessus de
       127. La norme le demande dès qu'un fichier contient des données binaires
       — et le nôtre en contient dès le premier accent. C'est ce qui dit au
       lecteur, et à tout ce qui transporte le fichier, de le traiter comme du
       binaire et non comme du texte.

       Sans cette ligne, le fichier reste structurellement valable : `file` le
       reconnaît, la table des positions est juste, les longueurs sont exactes.
       Mais le lecteur PDF de Chromium refuse de l'afficher — page blanche,
       sans message. C'est un défaut qu'aucune vérification de structure ne
       trouve : il a fallu ouvrir le fichier dans un vrai lecteur. */
    let corps = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const positions = [0];
    utilises.forEach(function (id) {
      positions.push(corps.length);
      const n = renum[id];
      const val = objets[id];
      if (val && val.flux !== undefined) {
        const f = val.flux;
        corps += n + ' 0 obj\n<< /Length ' + f.length + ' >>\nstream\n' + f + '\nendstream\nendobj\n';
      } else {
        corps += n + ' 0 obj\n' + remplacerRenvois(val) + '\nendobj\n';
      }
    });

    const debutXref = corps.length;
    const total = utilises.length + 1;
    let xref = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let i = 1; i < total; i++) {
      xref += String(positions[i]).padStart(10, '0') + ' 00000 n \n';
    }
    const info = options && options.titre
      ? ''
      : '';
    corps += xref + info + 'trailer\n<< /Size ' + total + ' /Root ' + renum[1] + ' 0 R >>\n' +
      'startxref\n' + debutXref + '\n%%EOF\n';

    /* Un tableau d'octets, pas une chaîne : les caractères WinAnsi au-dessus de
       127 doivent sortir tels quels, et `TextEncoder` les recoderait en UTF-8. */
    const octets = new Uint8Array(corps.length);
    for (let i = 0; i < corps.length; i++) octets[i] = corps.charCodeAt(i) & 0xff;
    return octets;
  }

  return {
    A4: A4,
    MARGE: MARGE,
    POLICES: POLICES,
    encoder: encoder,
    chaine: chaine,
    couper: couper,
    document: document
  };
});
