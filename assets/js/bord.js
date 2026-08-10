/* Bureau du Courrier — ce qui appelle une action aujourd'hui.

   Le problème que ça résout. Tout ce qui presse existe déjà quelque part dans
   l'application : les courriers non retirés sont au Suivi, les personnes à
   appeler à la Remise, les domiciliations qui expirent à la Domiciliation, les
   casiers pleins au Registre. Rien ne manque — mais il faut ouvrir cinq écrans
   pour savoir si la journée est calme, et personne ne le fait cinq fois par
   jour. Ce qui se voit rarement finit par ne plus se voir : une domiciliation
   expire, la personne perd son adresse, et avec elle la CAF et l'assurance
   maladie.

   Ce module ne calcule presque rien lui-même. Il **assemble** ce que
   `domiciliation.js`, `appels.js`, `attente.js` et `boites.js` savent déjà
   dire, et les range dans un ordre : le plus grave d'abord. Recalculer ici ce
   qu'un autre module calcule ailleurs, c'est se garantir deux réponses
   différentes à la même question le jour où l'un des deux change.

   **Ce qu'il ne fait pas.** Il ne dit jamais « tout va bien » quand il n'a pas
   regardé. Une source absente — pas encore de casiers, pas de domiciliation
   dans ce bureau — disparaît de la liste ; elle n'y figure pas à zéro, ce qui
   se lirait comme une vérification faite. Et il ne compte que ce qui est
   **actionnable** : un chiffre sur lequel on ne peut rien n'appelle pas
   l'attention, il l'use.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(
    enNode ? require('./util.js') : root.BC.util,
    enNode ? require('./domiciliation.js') : root.BC.domiciliation,
    enNode ? require('./appels.js') : root.BC.appels,
    enNode ? require('./boites.js') : root.BC.boites
  );
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.bord = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util, domi, appels, boites) {
  'use strict';

  /* Au-delà de ce nombre de jours, un courrier en attente n'est plus « récent »
     mais « qui traîne ». Sept jours : c'est le délai au bout duquel une
     personne prévenue qui n'est pas venue a probablement manqué le message,
     pas seulement tardé. */
  const VIEUX_JOURS = 7;

  /* Trois niveaux, et ils veulent dire quelque chose de précis :

       danger  — une échéance est passée ; quelqu'un perd un droit maintenant.
       warn    — une échéance approche ; il reste du temps pour agir.
       info    — c'est le travail ordinaire de la journée, ni en retard ni
                 urgent. Il est compté parce qu'il faut le faire, pas parce
                 qu'il inquiète.

     Sans cette distinction, tout se peint de la même couleur et plus rien ne
     ressort — ce qui revient exactement à ne rien signaler. */
  const NIVEAUX = ['danger', 'warn', 'info'];

  function enAttente(h) {
    return !!h && !h.pickedUpAt && !h.closedAt;
  }

  function joursDepuis(iso, maintenant) {
    if (!iso) return 0;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 0;
    return Math.max(0, Math.floor(((maintenant || new Date()) - d) / 86400000));
  }

  /* Une entrée du tableau de bord.

     `ou` dit où l'on va en cliquant : c'est ce qui fait la différence entre un
     chiffre et une action. Un tableau de bord qui affiche « 4 domiciliations
     expirées » sans mener aux quatre dossiers oblige à les rechercher à la
     main, et on ne le fait pas. */
  function entree(cle, n, niveau, mot, mots, phrase, ou) {
    return {
      cle: cle,
      n: n,
      niveau: niveau,
      /* Les deux formes sont écrites, pas déduites. « domiciliation expirée »
         fait « domiciliations expirées » : le pluriel français porte sur les
         deux mots, et une règle qui ajoute un « s » à la fin rendrait
         « domiciliation expirées ». Deux chaînes coûtent moins qu'une règle
         qui se trompe. */
      mot: mot,
      libelle: n === 1 ? mot : mots,
      phrase: phrase,
      ou: ou
    };
  }

  /* Le relevé du jour.

     `at` est injectable pour que les tests ne dépendent pas du calendrier de
     la machine qui les joue — un test qui passe en mars et tombe en septembre
     ne prouve rien. */
  function resume(data, options) {
    const o = options || {};
    const at = o.at ? new Date(o.at) : new Date();
    /* Les entrées vides sont écartées ici, à l'entrée. Cet écran est le
       premier que l'agent voit : s'il tombe, l'application paraît morte alors
       que tout le reste marche. Et il passe ses listes à `appels.js` et
       `domiciliation.js`, qui n'ont aucune raison de se protéger contre une
       ligne nulle — c'est l'assembleur qui ne doit pas leur en donner. Un
       fichier tronqué ou une restauration partielle suffit à en produire. */
    const propre = function (liste) {
      return (Array.isArray(liste) ? liste : []).filter(Boolean);
    };
    const history = propre(data && data.history);
    const contacts = propre(data && data.contacts);
    const listeBoites = propre(data && data.boites);
    const settings = (data && data.settings) || {};
    const opts = { maintenant: at };

    const attente = history.filter(enAttente);
    const urgents = attente.filter(function (h) { return h.urgent; });
    const vieux = attente.filter(function (h) {
      return joursDepuis(h.date, at) >= (o.vieuxJours || VIEUX_JOURS);
    });

    /* Les appels : ceux que personne n'a encore prévenus, et ceux qu'il faut
       relancer. `appels.listeDuJour` fait déjà la distinction et l'ordre. */
    const appelsDuJour = appels.listeDuJour(history, opts);
    const jamaisPrevenus = appelsDuJour.filter(function (a) { return a.motif === 'prevenir'; });

    /* La domiciliation. `aRenouveler` rend « bientôt » et « expirée »
       ensemble ; on les sépare, parce qu'elles n'appellent pas le même geste
       ni la même urgence. */
    const domiOpts = {
      maintenant: at,
      validiteMois: settings.domiciliationMois,
      absenceMois: settings.domiciliationAbsenceMois
    };
    const domicilies = contacts.filter(function (c) { return c && c.domicilie; });
    const renouveler = domicilies.length ? domi.aRenouveler(domicilies, history, domiOpts) : [];
    const expirees = renouveler.filter(function (d) { return d.etat.etat === 'expiree'; });
    const bientot = renouveler.filter(function (d) { return d.etat.etat === 'bientot'; });
    const absents = domicilies.length ? domi.sansPassage(domicilies, history, domiOpts) : [];

    const alertes = [];

    /* L'ordre d'ajout ne fait pas l'ordre d'affichage — le tri par niveau s'en
       charge plus bas — mais il fixe l'ordre à niveau égal, et celui-là suit ce
       qu'un bureau fait dans sa journée : d'abord les gens, ensuite les
       dossiers, ensuite le local. */

    if (expirees.length) {
      alertes.push(entree('domiExpirees', expirees.length, 'danger',
        'domiciliation expirée', 'domiciliations expirées',
        'L’attestation ne vaut plus : la personne n’a plus d’adresse valable pour la CAF ni pour l’assurance maladie.',
        { panneau: 'domiciliation' }));
    }
    if (absents.length) {
      alertes.push(entree('domiAbsents', absents.length, 'warn',
        'absence prolongée', 'absences prolongées',
        'Sans manifestation, la radiation devient possible — un passage, un appel ou un retrait suffit à l’écarter.',
        { panneau: 'domiciliation' }));
    }
    if (bientot.length) {
      alertes.push(entree('domiBientot', bientot.length, 'warn',
        'domiciliation à renouveler', 'domiciliations à renouveler',
        'L’échéance approche ; il reste du temps pour convoquer la personne.',
        { panneau: 'domiciliation' }));
    }

    if (jamaisPrevenus.length) {
      alertes.push(entree('aPrevenir', jamaisPrevenus.length, 'warn',
        'personne à prévenir', 'personnes à prévenir',
        'Le courrier est arrivé et la personne ne le sait pas encore.',
        { panneau: 'remise', filtre: '' }));
    }
    if (urgents.length) {
      alertes.push(entree('urgents', urgents.length, 'warn',
        'courrier urgent', 'courriers urgents',
        'Signalé urgent à la réception.',
        { panneau: 'remise', filtre: '' }));
    }
    if (vieux.length) {
      alertes.push(entree('vieux', vieux.length, 'warn',
        'courrier qui traîne', 'courriers qui traînent',
        'En attente depuis plus de ' + (o.vieuxJours || VIEUX_JOURS) + ' jours : le message est peut-être passé inaperçu.',
        { panneau: 'suivi', filtre: '' }));
    }
    /* Le total des courriers en attente n'a **pas** sa puce. Il est déjà sur
       l'onglet « Remise », à trois centimètres au-dessus, et la phrase du haut
       le redit quand la journée est calme (« Rien ne presse — 3 courriers
       attendent d'être remis »). Une puce de plus le répéterait une troisième
       fois, et sur un écran de 360 px chaque puce coûte une ligne entière au
       champ de saisie. Le chiffre reste dans `courrier.attente` pour qui en a
       besoin. */

    /* Les casiers ne se comptent que si le bureau en tient. Un bureau qui n'a
       pas ouvert le plan du local n'a pas à voir « 0 casier plein » : ce
       chiffre-là se lirait comme une vérification faite. */
    let casiers = null;
    if (listeBoites.length) {
      const incoherentes = boites.incoherences
        ? boites.incoherences(listeBoites, contacts, settings.numerotation)
        : [];
      const libres = listeBoites.filter(function (b) { return b.statut === 'libre'; });
      const horsService = listeBoites.filter(function (b) { return b.statut === 'horsservice'; });
      casiers = {
        total: listeBoites.length,
        libres: libres.length,
        horsService: horsService.length,
        incoherences: incoherentes.length
      };
      if (incoherentes.length) {
        alertes.push(entree('casiersIncoherents', incoherentes.length, 'warn',
          'casier en désaccord', 'casiers en désaccord',
          'Le plan du local et le registre ne disent pas la même chose — l’un des deux se trompe de porte.',
          { panneau: 'registre', section: 'casiers' }));
      }
      if (horsService.length) {
        alertes.push(entree('casiersHorsService', horsService.length, 'info',
          'casier hors service', 'casiers hors service',
          'Serrure cassée ou porte condamnée : autant de places qui manquent.',
          { panneau: 'registre', section: 'casiers' }));
      }
      if (!libres.length) {
        alertes.push(entree('casiersPleins', 0, 'warn',
          'plus aucun casier libre', 'plus aucun casier libre',
          'La prochaine domiciliation n’aura pas de boîte où mettre son courrier.',
          { panneau: 'registre', section: 'casiers' }));
      }
    }

    /* Le plus grave d'abord, et à gravité égale le plus nombreux : entre deux
       avertissements, celui qui concerne douze personnes passe avant celui qui
       en concerne une. */
    alertes.sort(function (a, b) {
      const d = NIVEAUX.indexOf(a.niveau) - NIVEAUX.indexOf(b.niveau);
      return d !== 0 ? d : b.n - a.n;
    });

    return {
      at: at.toISOString(),
      calme: !alertes.some(function (a) { return a.niveau !== 'info'; }),
      alertes: alertes,
      courrier: {
        attente: attente.length,
        urgents: urgents.length,
        vieux: vieux.length,
        aPrevenir: jamaisPrevenus.length,
        aRelancer: appelsDuJour.length - jamaisPrevenus.length
      },
      domiciliation: domicilies.length
        ? {
            total: domicilies.length,
            expirees: expirees.length,
            bientot: bientot.length,
            absents: absents.length
          }
        : null,
      casiers: casiers
    };
  }

  /* La phrase du haut. Elle dit l'état de la journée en une ligne, avant tout
     chiffre — parce qu'on la lit en passant, souvent debout, et qu'on ne
     compte pas des pastilles dans ce cas-là. */
  function phrase(r) {
    if (!r) return '';
    const graves = r.alertes.filter(function (a) { return a.niveau === 'danger'; });
    if (graves.length) {
      return 'À traiter en priorité : ' + graves[0].n + ' ' + graves[0].libelle + '.';
    }
    const avert = r.alertes.filter(function (a) { return a.niveau === 'warn'; });
    if (avert.length) {
      return avert.length === 1
        ? 'Un point demande votre attention.'
        : avert.length + ' points demandent votre attention.';
    }
    if (r.courrier.attente) {
      return r.courrier.attente === 1
        ? 'Rien ne presse — un courrier attend d’être remis.'
        : 'Rien ne presse — ' + r.courrier.attente + ' courriers attendent d’être remis.';
    }
    return 'Rien en attente ce matin.';
  }

  return {
    VIEUX_JOURS: VIEUX_JOURS,
    NIVEAUX: NIVEAUX,
    resume: resume,
    phrase: phrase
  };
});
