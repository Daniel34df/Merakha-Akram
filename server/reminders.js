/* Bureau du Courrier — suivi des courriers non récupérés et relances.

   Chaque notification consignée dans l'historique représente un courrier en
   attente au guichet. Tant que personne ne l'a marqué comme récupéré, il reste
   dû — et peut donner lieu à une relance.

   Le calcul de ce qui est « à relancer » est une fonction pure, sans horloge ni
   réseau : c'est ce qui la rend vérifiable. La boucle qui l'appelle
   périodiquement n'a, elle, aucune logique. */
'use strict';

const JOUR = 24 * 60 * 60 * 1000;
const util = require('../assets/js/util.js');

/** Délai avant relance : celui du type de courrier s'il en a un, sinon le délai général. */
/* Un courrier marqué urgent — convocation de préfecture, recommandé avec date
   limite — ne peut pas attendre le délai ordinaire. Il l'emporte sur le délai du
   type comme sur le délai général : c'est le point du dispositif où la lenteur
   coûte le plus cher à la personne. */
const DELAI_URGENT = 2;

function delaiPour(entree, delaiGeneral) {
  if (entree && entree.urgent) return DELAI_URGENT;
  const propre = util.typeCourrier(entree.type).relanceJours;
  return propre === null || propre === undefined ? delaiGeneral : propre;
}

function joursEcoules(depuis, maintenant) {
  return (maintenant - new Date(depuis).getTime()) / JOUR;
}

/* Un courrier compte comme en attente tant qu'il n'a été ni retiré ni classé.
   Un courrier classé est sorti du circuit — renvoyé, détruit, remis en main
   propre : il ne doit plus ni compter, ni être relancé, ni resurgir au dossier. */
function enAttente(entree) {
  return !entree.pickedUpAt && !entree.closedAt && entree.status !== 'échec';
}

/**
 * Courriers à relancer maintenant.
 *   delaiJours   — âge minimal du courrier (0 ou moins : aucune relance)
 *   intervalle   — délai minimal entre deux relances pour un même courrier
 *   maxRelances  — au-delà, on cesse d'insister
 */
function aRelancer(history, options) {
  const opts = options || {};
  const delai = Number(opts.delaiJours || 0);
  if (!(delai > 0)) return [];
  const intervalle = Number(opts.intervalleJours || delai);
  const maxRelances = opts.maxRelances === undefined ? 3 : Number(opts.maxRelances);
  const maintenant = opts.now || Date.now();

  return (history || []).filter(function (entree) {
    if (!enAttente(entree)) return false;
    /* Pas d'adresse, pas de relance automatique : il n'y a rien où écrire.
       Ces courriers sont suivis à la main, dans la liste des appels à passer.
       Les laisser ici ferait échouer un envoi par jour et par personne, et
       remplirait le journal d'erreurs qui ne veulent rien dire. */
    if (!entree.email) return false;
    if ((entree.reminderCount || 0) >= maxRelances) return false;
    if (joursEcoules(entree.date, maintenant) < delaiPour(entree, delai)) return false;
    // Une relance récente suffit : on ne réécrit pas tous les jours.
    if (entree.remindedAt && joursEcoules(entree.remindedAt, maintenant) < intervalle) return false;
    return true;
  });
}

/**
 * Courriers à signaler : relancés il y a assez longtemps, toujours pas retirés.
 * Ils quittent la file d'attente ordinaire pour un dossier que quelqu'un doit
 * regarder — retour à l'expéditeur, recherche du destinataire, mise au rebut.
 *
 *   delaiJours     — délai avant la relance (même valeur que aRelancer)
 *   escaladeJours  — délai supplémentaire après la relance
 */
function aSignaler(history, options) {
  const opts = options || {};
  const delai = Number(opts.delaiJours || 0);
  const escalade = Number(opts.escaladeJours || delai);
  if (!(delai > 0) || !(escalade > 0)) return [];
  const maintenant = opts.now || Date.now();

  return (history || []).filter(function (entree) {
    if (!enAttente(entree)) return false;
    if (entree.flaggedAt) return false; // déjà dans le dossier
    // Le décompte part de la relance si elle a eu lieu, sinon de l'envoi : un
    // courrier qui n'a pas pu être relancé ne doit pas rester invisible.
    const reference = entree.remindedAt || entree.date;
    const seuil = entree.remindedAt ? escalade : delaiPour(entree, delai) + escalade;
    return joursEcoules(reference, maintenant) >= seuil;
  });
}

/** État d'un courrier, pour l'affichage et les filtres. */
function etat(entree) {
  if (entree.closedAt) return 'clos';
  if (entree.pickedUpAt) return 'recupere';
  if (entree.status === 'échec') return 'echec';
  if (entree.flaggedAt) return 'signale';
  if (entree.reminderCount > 0) return 'relance';
  return 'attente';
}

/** Résumé destiné à l'interface : combien en attente, depuis combien de temps. */
function resume(history, now) {
  const maintenant = now || Date.now();
  const attente = (history || []).filter(enAttente);
  const ages = attente.map(function (e) {
    return joursEcoules(e.date, maintenant);
  });
  const tous = history || [];
  const relances = tous.filter(function (e) {
    return (e.reminderCount || 0) > 0;
  });

  return {
    enAttente: attente.length,
    plusAncienJours: ages.length ? Math.floor(Math.max.apply(null, ages)) : 0,
    recuperes: tous.filter(function (e) {
      return !!e.pickedUpAt;
    }).length,
    signales: tous.filter(function (e) {
      return etat(e) === 'signale';
    }).length,
    relances: relances.length,
    // Ce que la relance a donné : c'est le chiffre qui dit si elle sert.
    recuperesApresRelance: relances.filter(function (e) {
      return !!e.pickedUpAt;
    }).length
  };
}

/* Récapitulatif périodique destiné au responsable : ce qui s'est passé sur la
   période, et ce qui reste à traiter. Fonction pure, donc vérifiable. */
function construireRecap(history, contacts, options) {
  const opts = options || {};
  const debut = new Date(opts.depuis).getTime();
  const fin = opts.jusqua ? new Date(opts.jusqua).getTime() : Date.now();
  const tous = history || [];

  const surPeriode = function (iso) {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= debut && t <= fin;
  };

  const recus = tous.filter(function (h) {
    return surPeriode(h.date);
  });
  const retires = tous.filter(function (h) {
    return surPeriode(h.pickedUpAt);
  });
  const attente = tous.filter(enAttente);
  const signales = tous.filter(function (h) {
    return etat(h) === 'signale';
  });

  const plusAnciens = attente
    .slice()
    .sort(function (a, b) {
      return new Date(a.date) - new Date(b.date);
    })
    .slice(0, 10)
    .map(function (h) {
      const contact = (contacts || []).find(function (c) {
        return c.id === h.contactId;
      });
      return {
        nom: h.name,
        boite: (contact && contact.box) || '',
        jours: Math.floor(joursEcoules(h.date, fin)),
        relances: h.reminderCount || 0
      };
    });

  return {
    debut: new Date(debut).toISOString(),
    fin: new Date(fin).toISOString(),
    recus: recus.length,
    retires: retires.length,
    enAttente: attente.length,
    signales: signales.length,
    plusAnciens: plusAnciens
  };
}

/**
 * Statistiques d'exploitation : volumes, taux de retrait, délai moyen, boîtes
 * les plus actives. Sert au rapport annuel et à voir si le service tient.
 */
function statistiques(history, contacts, options) {
  const opts = options || {};
  const maintenant = opts.now || Date.now();
  const tous = history || [];

  const parPeriode = function (jours) {
    const depuis = maintenant - jours * JOUR;
    const recus = tous.filter(function (h) {
      return new Date(h.date).getTime() >= depuis;
    });
    const retires = recus.filter(function (h) {
      return !!h.pickedUpAt;
    });
    return {
      recus: recus.length,
      retires: retires.length,
      // Le taux ne veut rien dire sur un échantillon vide.
      taux: recus.length ? Math.round((retires.length / recus.length) * 100) : null
    };
  };

  const delais = tous
    .filter(function (h) {
      return h.pickedUpAt;
    })
    .map(function (h) {
      return (new Date(h.pickedUpAt) - new Date(h.date)) / JOUR;
    });
  const moyenne = delais.length
    ? Math.round((delais.reduce(function (a, b) { return a + b; }, 0) / delais.length) * 10) / 10
    : null;

  const parBoite = {};
  tous.forEach(function (h) {
    const contact = (contacts || []).find(function (c) {
      return c.id === h.contactId;
    });
    const cle = (contact && contact.box) || '(sans boîte)';
    parBoite[cle] = (parBoite[cle] || 0) + 1;
  });
  const boitesActives = Object.keys(parBoite)
    .map(function (b) {
      return { boite: b, courriers: parBoite[b] };
    })
    .sort(function (a, b) {
      return b.courriers - a.courriers;
    })
    .slice(0, 5);

  const parType = {};
  tous.forEach(function (h) {
    const label = util.typeCourrier(h.type).label;
    parType[label] = (parType[label] || 0) + 1;
  });

  return {
    total: tous.length,
    semaine: parPeriode(7),
    mois: parPeriode(30),
    annee: parPeriode(365),
    delaiMoyenJours: moyenne,
    relances: tous.filter(function (h) {
      return (h.reminderCount || 0) > 0;
    }).length,
    signales: tous.filter(function (h) {
      return etat(h) === 'signale';
    }).length,
    boitesActives: boitesActives,
    parType: parType
  };
}

/** Met le récapitulatif en texte lisible dans un courriel. */
function recapEnTexte(recap, bureau) {
  const jour = function (iso) {
    return new Date(iso).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' });
  };
  const lignes = [
    'Récapitulatif du ' + jour(recap.debut) + ' au ' + jour(recap.fin) + ' — ' + (bureau || 'Bureau du Courrier'),
    '',
    '  Courriers reçus sur la période : ' + recap.recus,
    '  Retirés sur la période        : ' + recap.retires,
    '  En attente aujourd’hui        : ' + recap.enAttente,
    '  À traiter (non retirés)       : ' + recap.signales
  ];

  if (recap.plusAnciens.length) {
    lignes.push('', 'Les plus anciens en attente :');
    recap.plusAnciens.forEach(function (c) {
      lignes.push(
        '  ' +
          String(c.jours).padStart(3) +
          ' j  ' +
          (c.boite ? '[' + c.boite + '] ' : '') +
          c.nom +
          (c.relances ? ' (' + c.relances + ' relance' + (c.relances > 1 ? 's' : '') + ')' : '')
      );
    });
  } else {
    lignes.push('', 'Aucun courrier en attente. Rien à signaler.');
  }

  lignes.push('', 'Message automatique du Bureau du Courrier.');
  return lignes.join('\n');
}

/** Vrai s'il est temps d'envoyer le récapitulatif (jour et heure voulus, pas déjà fait). */
function recapDu(options) {
  const opts = options || {};
  const maintenant = opts.now ? new Date(opts.now) : new Date();
  if (maintenant.getDay() !== Number(opts.jour === undefined ? 1 : opts.jour)) return false;
  if (maintenant.getHours() < Number(opts.heure === undefined ? 8 : opts.heure)) return false;
  if (!opts.dernier) return true;
  // Un seul envoi par jour, même si la boucle passe plusieurs fois.
  return joursEcoules(opts.dernier, maintenant.getTime()) >= 1;
}

/**
 * Lance la vérification périodique des relances.
 * Renvoie une fonction d'arrêt. Sans envoi possible, ne fait rien du tout.
 */
function startReminderLoop(ctx, options) {
  const opts = options || {};
  const delaiJours = Number(opts.delaiJours || 0);
  if (!(delaiJours > 0)) return function () {};

  const periode = Number(opts.periodeMs || 6 * 60 * 60 * 1000);

  const passe = async function () {
    try {
      // Le signalement ne dépend pas du courriel : même sans SMTP, les courriers
      // trop anciens doivent apparaître dans le dossier à traiter.
      const aMettreAuDossier = aSignaler(ctx.db.data.history, opts);
      if (aMettreAuDossier.length && opts.signaler) {
        await opts.signaler(aMettreAuDossier);
        console.log('[dossier] ' + aMettreAuDossier.length + ' courrier(s) signalé(s)');
      }

      if (!ctx.mailer || !ctx.mailer.enabled) return;
      const dus = aRelancer(ctx.db.data.history, opts);
      for (const entree of dus) {
        try {
          await opts.envoyer(entree);
        } catch (err) {
          console.error('[relance] ' + entree.email + ' : ' + err.message);
        }
      }
      if (dus.length) console.log('[relance] ' + dus.length + ' courrier(s) relancé(s)');

      if (opts.recapitulatif) await opts.recapitulatif();
    } catch (err) {
      console.error('[relance] passe interrompue :', err.message);
    }
  };

  const timer = setInterval(passe, periode);
  // La boucle ne doit pas maintenir le processus en vie à elle seule.
  if (timer.unref) timer.unref();
  setTimeout(passe, 30000).unref?.();

  return function () {
    clearInterval(timer);
  };
}

module.exports = {
  enAttente: enAttente,
  aRelancer: aRelancer,
  aSignaler: aSignaler,
  DELAI_URGENT: DELAI_URGENT,
  delaiPour: delaiPour,
  construireRecap: construireRecap,
  statistiques: statistiques,
  recapEnTexte: recapEnTexte,
  recapDu: recapDu,
  etat: etat,
  resume: resume,
  joursEcoules: joursEcoules,
  startReminderLoop: startReminderLoop
};
