/* Bureau du Courrier — scanner un code, et savoir ce qu'il désigne.

   ─────────────────────────────────────────────────────────────────────────
   La solution, et pourquoi elle a cette forme.

   Le cahier des charges demande un scanner (§5, §13). L'obstacle annoncé était
   double : une bibliothèque de décodage — la première dépendance du projet —
   et l'accès caméra, qui exige https sur chaque poste.

   Les deux se contournent, mais pas en s'appuyant sur ce qu'on croit acquis.
   `BarcodeDetector`, l'API native, **n'existe pas** dans le Chromium de cette
   machine, ni dans Firefox : un scanner qui ne repose que sur elle marche chez
   son auteur et nulle part ailleurs. Vérifié, pas supposé.

   D'où trois couches, de la plus universelle à la plus confortable :

     1. **La douchette USB.** Un lecteur de comptoir à vingt euros se comporte
        comme un clavier : on vise, ça bipe, le code est tapé. Aucune
        permission, aucun https, aucun navigateur particulier, et il lit tout —
        Code 39, Code 128, EAN, QR selon le modèle. C'est ce qu'un vrai guichet
        utilise, et c'est la couche qui marche toujours.

     2. **Le décodeur maison** (`codebarres.lireLigne`). Il lit le Code 39 —
        donc **les étiquettes que l'application imprime elle-même**, celles des
        casiers et des attestations. Depuis la caméra quand elle est
        accessible, ou depuis une photo déposée. Zéro dépendance : la table
        était déjà là pour écrire, il suffisait de la retourner.

     3. **`BarcodeDetector` quand il existe** (Android, ChromeOS, Safari
        récent). Il ajoute les QR et les Code 128 des transporteurs, gratuitement.

   Aucune dépendance n'a été ajoutée. Le projet en a toujours zéro.
   ─────────────────────────────────────────────────────────────────────────

   Ce module ne touche ni au DOM ni à la caméra : il dit ce qui est possible,
   et il interprète un code une fois lu. Tout ce qui a besoin d'un écran vit
   dans `ui/scanner.js`. C'est ce qui rend celui-ci vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(
    enNode ? require('./util.js') : root.BC.util,
    enNode ? require('./codebarres.js') : root.BC.codebarres,
    enNode ? require('./boites.js') : root.BC.boites
  );
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.scanner = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util, codebarres, boites) {
  'use strict';

  /* ── ce que ce poste sait faire ──

     Rendu en un objet plutôt qu'en une suite de tests éparpillés : l'écran doit
     pouvoir expliquer **pourquoi** la caméra n'est pas là, et proposer autre
     chose. « Ça ne marche pas » sans raison est ce qui fait renoncer. */
  function capacites(fenetre) {
    const w = fenetre || {};
    const nav = w.navigator || {};
    const sur = w.isSecureContext === true;
    const media = !!(nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
    const natif = typeof w.BarcodeDetector === 'function';

    let raison = '';
    if (!sur) {
      raison =
        'La caméra n’est ouverte qu’en https, ou depuis le poste qui héberge ' +
        'l’application (http://localhost). Voir docs/mise-en-service-https.md ' +
        'pour équiper le bureau — ou utilisez une douchette, qui n’en a pas besoin.';
    } else if (!media) {
      raison = 'Ce navigateur ne donne pas accès à la caméra.';
    }

    return {
      // La douchette marche toujours : c'est un clavier.
      douchette: true,
      camera: sur && media,
      // Le décodeur maison suffit dès qu'on a une image, caméra ou fichier.
      code39: true,
      // Les QR et les codes des transporteurs, si le navigateur sait les lire.
      natif: natif,
      contexteSur: sur,
      raison: raison
    };
  }

  /* ── ce qu'un code veut dire ──

     Un code lu peut être quatre choses, et l'ordre de reconnaissance est celui
     de la certitude, du plus spécifique au plus général. Se tromper d'ordre,
     c'est ouvrir la fiche de quelqu'un d'autre parce qu'un numéro de casier
     ressemblait à un code de retrait. */

  const REFERENCE = /^COUR-\d{4}-\d{6}$/i;
  const CODE_RETRAIT = /^\d{4}$/;

  function interpreter(code, etat) {
    const brut = String(code || '').trim();
    if (!brut) return { type: 'vide' };

    const s = etat || {};
    const contacts = s.contacts || [];
    const history = s.history || [];
    const plan = s.boites || [];

    /* 1. Une référence de courrier : la forme est sans ambiguïté. */
    if (REFERENCE.test(brut)) {
      const ref = brut.toUpperCase();
      const courrier = history.find(function (h) {
        return String(h.reference || '').toUpperCase() === ref;
      });
      return courrier
        ? { type: 'courrier', courrier: courrier, code: ref }
        : { type: 'inconnu', code: ref, quoi: 'référence de courrier' };
    }

    /* 2. Un code de retrait : quatre chiffres, et il doit correspondre à un
          courrier **qui attend encore**. Un code déjà servi ne rouvre rien. */
    if (CODE_RETRAIT.test(brut)) {
      const courrier = history.find(function (h) {
        return String(h.pickupCode || '') === brut && util.enAttente(h);
      });
      return courrier
        ? { type: 'retrait', courrier: courrier, code: brut }
        : { type: 'inconnu', code: brut, quoi: 'code de retrait' };
    }

    /* 3. Un numéro de casier. On passe par la même clé que le reste de
          l'application — « B-012 », « b12 » et « B 12 » sont la même porte. */
    const boite = boites.trouverParNumero(plan, brut, s.numerotation);
    if (boite) {
      const t = boites.titulaireCourant(boite);
      const titulaire = t && contacts.find(function (c) { return c.id === t.contactId; });
      return { type: 'boite', boite: boite, contact: titulaire || null, code: boite.numero };
    }

    /* 4. Un nom, en dernier : c'est le cas le plus large, donc celui qui doit
          passer après tous les autres. Un seul résultat vaut une réponse ;
          plusieurs valent une liste, jamais un choix fait à la place de l'agent. */
    const trouves = contacts.filter(function (c) {
      return util.matchesQuery(c, brut, 'tout');
    });
    if (trouves.length === 1) return { type: 'contact', contact: trouves[0], code: brut };
    if (trouves.length > 1) return { type: 'plusieurs', contacts: trouves, code: brut };

    return { type: 'inconnu', code: brut, quoi: 'code' };
  }

  /* Une phrase pour l'écran. Elle vit ici et non dans l'interface : c'est la
     même que le scanner soit une caméra, une douchette ou un fichier. */
  function libelle(resultat) {
    const r = resultat || {};
    switch (r.type) {
      case 'boite':
        return r.contact
          ? 'Casier ' + r.boite.numero + ' — ' + r.contact.name
          : 'Casier ' + r.boite.numero + ' — libre';
      case 'retrait':
        return 'Courrier de ' + r.courrier.name + ' — code ' + r.code;
      case 'courrier':
        return 'Courrier ' + r.code + ' — ' + r.courrier.name;
      case 'contact':
        return r.contact.name;
      case 'plusieurs':
        return r.contacts.length + ' personnes correspondent à « ' + r.code + ' »';
      case 'vide':
        return 'Rien à lire.';
      default:
        return 'Aucun ' + (r.quoi || 'code') + ' ne correspond à « ' + r.code + ' ».';
    }
  }

  /* ── lire une image ──

     Une image, ce sont des pixels ; le décodeur veut une ligne. On en essaie
     plusieurs, réparties sur la hauteur : une seule ligne tombe sur un blanc,
     sur le nom imprimé sous le code, ou sur un reflet. Onze lignes coûtent
     onze fois rien et rattrapent la main qui tremble.

     `donnees` : un RGBA plat, comme `getImageData().data`. */
  function lireImage(donnees, largeur, hauteur, options) {
    if (!donnees || !largeur || !hauteur) return null;
    const o = options || {};
    const lignes = Math.max(1, Math.min(41, o.lignes || 11));

    for (let k = 1; k <= lignes; k++) {
      const y = Math.floor((hauteur * k) / (lignes + 1));
      const gris = new Array(largeur);
      const debut = y * largeur * 4;
      for (let x = 0; x < largeur; x++) {
        const i = debut + x * 4;
        // Luminance perçue : un code imprimé en couleur reste lisible.
        gris[x] = (donnees[i] * 299 + donnees[i + 1] * 587 + donnees[i + 2] * 114) / 1000;
      }
      const lu = codebarres.lireLigne(gris);
      if (lu) return lu;

      /* La même ligne à l'envers : une étiquette photographiée tête-bêche est
         un cas courant au comptoir, et le Code 39 se lit dans les deux sens. */
      const luEnvers = codebarres.lireLigne(gris.slice().reverse());
      if (luEnvers) return luEnvers;
    }
    return null;
  }

  return {
    capacites: capacites,
    interpreter: interpreter,
    libelle: libelle,
    lireImage: lireImage,
    REFERENCE: REFERENCE,
    CODE_RETRAIT: CODE_RETRAIT
  };
});
