/* Bureau du Courrier — les appels à passer.

   Pourquoi ce module existe.

   Une personne qui a une adresse électronique est relancée automatiquement,
   jusqu'à trois fois (`server/reminders.js`, `aRelancer`). Une personne qui
   n'en a pas — le cas le plus fréquent dans un bureau de domiciliation — est
   appelée au téléphone. Jusqu'ici, dès que l'agent notait l'appel, le courrier
   quittait la liste **pour toujours**. Si la personne ne venait pas, plus rien
   ne la ramenait : son courrier glissait vers le dossier « à traiter », dont
   les suites sont le retour à l'expéditeur ou la mise au rebut.

   Autrement dit, la personne joignable par écrit était relancée trois fois, et
   celle qu'on ne peut qu'appeler, une seule. C'était l'inverse de ce qu'un
   bureau d'accueil veut faire.

   Ce module tient les deux listes du matin :

     · **à prévenir** — jamais jointe. Le courrier est là, elle ne le sait pas.
     · **à rappeler** — jointe, mais elle n'est pas venue depuis.

   Il ne fait que décider qui figure dans quelle liste. Aucun réseau, aucun
   DOM : c'est ce qui le rend vérifiable hors navigateur, et c'est voulu — la
   règle d'à côté, restée dans l'écran, a caché un défaut pendant tout un
   cycle. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(enNode ? require('./util.js') : root.BC.util);
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.appels = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  const JOUR = 24 * 60 * 60 * 1000;

  const DEFAUTS = {
    /* Sept jours entre deux appels. Assez pour laisser le temps de passer,
       assez court pour que le courrier ne dorme pas un mois. */
    delaiJours: 7,
    /* Trois rappels au plus, comme pour les relances écrites. Au-delà,
       insister n'aide personne : le courrier passe au dossier « à traiter »,
       où quelqu'un décide quoi en faire. */
    maxRappels: 3
  };

  function avecDefauts(options) {
    const o = options || {};
    return {
      delaiJours: Number(o.delaiJours === undefined ? DEFAUTS.delaiJours : o.delaiJours),
      maxRappels: Number(o.maxRappels === undefined ? DEFAUTS.maxRappels : o.maxRappels),
      maintenant: o.maintenant || Date.now()
    };
  }

  /** Les appels où la personne a effectivement répondu. Une sonnerie dans le
      vide est une tentative, pas une notification. */
  function appelsJoints(entree) {
    return (entree && Array.isArray(entree.appels) ? entree.appels : []).filter(function (a) {
      return a && a.joint !== false;
    });
  }

  /** Date du dernier appel abouti, ou null. On accepte « appeleA » pour les
      courriers d'avant la tenue d'un journal d'appels. */
  function dernierAppel(entree) {
    const joints = appelsJoints(entree);
    if (joints.length) {
      return joints
        .map(function (a) {
          return a.at;
        })
        .sort()
        .pop();
    }
    return (entree && entree.appeleA) || null;
  }

  function joursDepuis(iso, maintenant) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return Infinity;
    return Math.floor((maintenant - t) / JOUR);
  }

  /** Le courrier relève-t-il du téléphone ? Sans adresse, il n'y a rien où
      écrire : c'est la seule façon de prévenir. */
  function parTelephone(entree) {
    return util.enAttente(entree) && !String((entree && entree.email) || '').trim();
  }

  /** Jamais jointe : le courrier est arrivé, elle ne le sait pas encore. */
  function aPrevenir(history) {
    return (history || []).filter(function (h) {
      return parTelephone(h) && h.status !== 'prévenu';
    });
  }

  /** Jointe, mais toujours pas venue. */
  function aRappeler(history, options) {
    const o = avecDefauts(options);
    return (history || []).filter(function (h) {
      if (!parTelephone(h)) return false;
      if (h.status !== 'prévenu') return false;
      const joints = appelsJoints(h).length;
      // Au-delà du plafond, on cesse d'insister et on laisse le dossier suivre.
      if (joints > o.maxRappels) return false;
      const dernier = dernierAppel(h);
      if (!dernier) return false;
      return joursDepuis(dernier, o.maintenant) >= o.delaiJours;
    });
  }

  /**
   * La liste du matin, dans l'ordre où on la traite : d'abord ceux qui ne
   * savent rien, puis ceux qu'il faut relancer, du plus ancien au plus récent.
   * Chaque ligne porte son motif, pour que l'écran puisse le dire.
   */
  function listeDuJour(history, options) {
    const o = avecDefauts(options);
    const neufs = aPrevenir(history).map(function (h) {
      return { entree: h, motif: 'prevenir', tentatives: appelsJoints(h).length, depuis: null };
    });
    const repris = aRappeler(history, options).map(function (h) {
      const dernier = dernierAppel(h);
      return {
        entree: h,
        motif: 'rappeler',
        tentatives: appelsJoints(h).length,
        depuis: joursDepuis(dernier, o.maintenant)
      };
    });
    repris.sort(function (a, b) {
      return b.depuis - a.depuis;
    });
    return neufs.concat(repris);
  }

  return {
    DEFAUTS: DEFAUTS,
    appelsJoints: appelsJoints,
    dernierAppel: dernierAppel,
    aPrevenir: aPrevenir,
    aRappeler: aRappeler,
    listeDuJour: listeDuJour
  };
});
