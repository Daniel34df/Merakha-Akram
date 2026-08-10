/* Bureau du Courrier — la journée, de l'ouverture à la clôture.

   Le problème. Un bureau de courrier n'est pas tenu par une seule personne.
   Quelqu'un ouvre à neuf heures, quelqu'un d'autre ferme à dix-sept, et entre
   les deux il y a des choses qu'on se dit de vive voix : « le colis de la
   dame du deuxième est derrière le comptoir », « Monsieur Diallo passe demain
   matin », « la boîte B-14 ne ferme plus ». Rien de tout cela ne survit à la
   fin du service.

   Ce que ce module produit, ce n'est donc pas une statistique — les
   statistiques existent déjà, dans l'onglet Suivi. C'est **une passation** :
   ce qui est entré aujourd'hui, ce qui est sorti, et surtout **ce qui reste en
   suspens et que le suivant doit savoir**.

   L'ordre est celui d'une passation, pas celui d'un tableau :

     1. **ce qui est resté en plan** — un colis encombrant sans emplacement
        noté, une personne qu'on n'a pas réussi à joindre, un courrier urgent
        toujours là ce soir. C'est la seule partie qui ne peut pas attendre
        demain ;
     2. **ce qui est entré et sorti** — le compte de la journée, qui répond à
        « est-ce qu'on a bien tout saisi ? » ;
     3. **ce qui arrive demain** — pour que celui qui ouvre sache avant
        d'ouvrir.

   **Ce module ne clôt rien.** Il n'y a pas d'état « journée fermée » dans les
   données, et c'est délibéré : un bureau où un agent oublie de cliquer
   « clôturer » ne doit pas se retrouver bloqué le lendemain, et un courrier
   déposé à 17 h 05 doit pouvoir s'inscrire. Le relevé se lit, s'imprime, et
   c'est tout. Ce qui n'est pas une machine à états n'a pas ses pannes.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(
    enNode ? require('./util.js') : root.BC.util,
    enNode ? require('./colis.js') : root.BC.colis,
    enNode ? require('./domiciliation.js') : root.BC.domiciliation
  );
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.journee = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util, colis, domi) {
  'use strict';

  /* Le jour local d'un horodatage. **Pas** `toISOString().slice(0,10)` : cette
     forme-là donne le jour UTC, et un courrier saisi à 23 h 30 en été à Paris
     tomberait dans la journée du lendemain. Le relevé du soir n'aurait alors
     pas la dernière heure de travail. */
  function jourLocal(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const j = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + j;
  }

  function memeJour(iso, jour) {
    return !!iso && jourLocal(iso) === jour;
  }

  function enAttente(h) {
    return !!h && !h.pickedUpAt && !h.closedAt;
  }

  /* En attente **à la fin de ce jour-là**.

     La nuance n'est pas théorique. Un relevé qui demanderait simplement « est-ce
     en attente maintenant ? » afficherait, en relisant la journée du 15 janvier
     2020, le colis arrivé ce matin — et dirait « à ne pas laisser passer la
     nuit » d'un soir vieux de six ans. Le relevé d'une journée passée doit dire
     ce qu'était cette journée, pas ce qu'est aujourd'hui.

     Les dates se comparent en « AAAA-MM-JJ », où l'ordre alphabétique est
     l'ordre chronologique. */
  function enAttenteLe(h, jour) {
    if (!h || !h.date) return false;
    // Pas encore arrivé ce jour-là.
    if (jourLocal(h.date) > jour) return false;
    // Déjà remis, ou déjà classé, avant la fin de ce jour-là.
    if (h.pickedUpAt && jourLocal(h.pickedUpAt) <= jour) return false;
    if (h.closedAt && jourLocal(h.closedAt) <= jour) return false;
    return true;
  }

  /* Le relevé d'une journée.

     `jour` au format « 2026-08-10 », et `at` pour savoir si la journée est en
     cours ou passée — on ne dit pas la même chose d'un courrier urgent encore
     là à 11 h et du même courrier encore là après la fermeture. */
  function releve(data, options) {
    const o = options || {};
    const at = o.at ? new Date(o.at) : new Date();
    const jour = o.jour || jourLocal(at);
    const enCours = jour === jourLocal(at);

    const history = (Array.isArray(data && data.history) ? data.history : []).filter(Boolean);
    const contacts = (Array.isArray(data && data.contacts) ? data.contacts : []).filter(Boolean);
    const settings = (data && data.settings) || {};

    const entres = history.filter(function (h) { return memeJour(h.date, jour); });
    const sortis = history.filter(function (h) { return memeJour(h.pickedUpAt, jour); });
    const clos = history.filter(function (h) {
      return memeJour(h.closedAt, jour) && !memeJour(h.pickedUpAt, jour);
    });

    /* Ce qui reste en plan. Chaque entrée dit **ce qu'il faut faire**, pas
       seulement ce qui ne va pas : une passation qui se contente de constater
       oblige le suivant à redécouvrir la consigne. */
    const suspens = [];

    /* Un colis encombrant sans emplacement, c'est le cas le plus grave d'une
       journée ordinaire : il est au registre, il a son code de retrait, et
       personne demain ne saura où il est posé. */
    const colisPerdus = history.filter(function (h) {
      return enAttenteLe(h, jour) && h.colis && colis.encombrant(h.colis) && !h.colis.emplacement;
    });
    if (colisPerdus.length) {
      suspens.push({
        cle: 'colisSansEmplacement',
        n: colisPerdus.length,
        gravite: 'haute',
        quoi: colisPerdus.length === 1
          ? 'Un colis encombrant sans emplacement noté'
          : colisPerdus.length + ' colis encombrants sans emplacement noté',
        faire: 'Retrouvez-les dans le local et notez où ils sont, tant que quelqu’un s’en souvient.',
        entrees: colisPerdus
      });
    }

    /* Un courrier signalé urgent qui passe la nuit. En cours de journée ce
       n'est qu'un courrier à traiter ; le soir, c'est une consigne pour
       demain matin. */
    const urgents = history.filter(function (h) {
      return enAttenteLe(h, jour) && h.urgent;
    });
    if (urgents.length) {
      suspens.push({
        cle: 'urgentsEnAttente',
        n: urgents.length,
        gravite: enCours ? 'moyenne' : 'haute',
        quoi: urgents.length + ' courrier' + (urgents.length > 1 ? 's' : '') + ' urgent' +
          (urgents.length > 1 ? 's' : '') + ' encore en attente',
        faire: 'À reprendre en priorité à l’ouverture.',
        entrees: urgents
      });
    }

    /* Les personnes qu'on n'a pas réussi à joindre aujourd'hui : l'appel a été
       tenté et noté comme non abouti. Sans cette ligne, l'information reste
       dans la tête de celui qui a appelé. */
    const injoignables = history.filter(function (h) {
      return enAttenteLe(h, jour) && (h.appels || []).some(function (a) {
        return a && !a.joint && memeJour(a.at, jour);
      });
    });
    if (injoignables.length) {
      suspens.push({
        cle: 'injoignables',
        n: injoignables.length,
        gravite: 'moyenne',
        quoi: injoignables.length + ' personne' + (injoignables.length > 1 ? 's' : '') +
          ' appelée' + (injoignables.length > 1 ? 's' : '') + ' sans réponse aujourd’hui',
        faire: 'Réessayez demain à une autre heure — le même créneau donne le même silence.',
        entrees: injoignables
      });
    }

    /* Les envois refusés par le serveur de courriel. Ils sont au registre avec
       le statut « échec » et n'iront nulle part tout seuls. */
    const echecs = history.filter(function (h) {
      return enAttenteLe(h, jour) && h.status === 'échec' && memeJour(h.date, jour);
    });
    if (echecs.length) {
      suspens.push({
        cle: 'envoisEchoues',
        n: echecs.length,
        gravite: 'moyenne',
        quoi: echecs.length + ' envoi' + (echecs.length > 1 ? 's' : '') + ' refusé' +
          (echecs.length > 1 ? 's' : '') + ' par le serveur de courriel',
        faire: 'Ces personnes n’ont pas été prévenues. Relancez, ou appelez-les.',
        entrees: echecs
      });
    }

    /* Ce qui arrive demain, pour que celui qui ouvre sache avant d'ouvrir. Les
       domiciliations d'abord : c'est le seul poste où l'échéance fait perdre un
       droit, pas seulement du temps. */
    const domiOpts = {
      maintenant: at,
      validiteMois: settings.domiciliationMois,
      absenceMois: settings.domiciliationAbsenceMois
    };
    const domicilies = contacts.filter(function (c) { return c.domicilie; });
    const echeances = domicilies.length
      ? domi.aRenouveler(domicilies, history, domiOpts).slice(0, 10)
      : [];

    return {
      jour: jour,
      enCours: enCours,
      entres: entres,
      sortis: sortis,
      clos: clos,
      compte: {
        entres: entres.length,
        sortis: sortis.length,
        clos: clos.length,
        /* Ce qui reste ce soir, tous jours confondus : c'est ce que le suivant
           trouvera en arrivant, pas ce qu'on a saisi aujourd'hui. */
        enAttente: history.filter(function (h) { return enAttenteLe(h, jour); }).length,
        colis: entres.filter(function (h) { return h.type === 'colis'; }).length,
        urgents: entres.filter(function (h) { return h.urgent; }).length
      },
      suspens: suspens,
      echeances: echeances,
      /* « Calme » ne veut pas dire « vide » : une journée où trente courriers
         sont entrés et tous ont été traités est une bonne journée. */
      calme: suspens.length === 0
    };
  }

  /* La phrase de clôture, celle qu'on lit en éteignant. */
  function phrase(r) {
    if (!r) return '';
    const graves = r.suspens.filter(function (s) { return s.gravite === 'haute'; });
    if (graves.length) return 'À ne pas laisser passer la nuit : ' + graves[0].quoi.toLowerCase() + '.';
    if (r.suspens.length) {
      return r.suspens.length === 1
        ? 'Un point à passer au suivant.'
        : r.suspens.length + ' points à passer au suivant.';
    }
    if (!r.compte.entres && !r.compte.sortis) return 'Aucun mouvement ce jour-là.';
    return 'Rien en suspens : ' + r.compte.entres + ' entré' + (r.compte.entres > 1 ? 's' : '') +
      ', ' + r.compte.sortis + ' remis.';
  }

  return {
    jourLocal: jourLocal,
    releve: releve,
    phrase: phrase
  };
});
