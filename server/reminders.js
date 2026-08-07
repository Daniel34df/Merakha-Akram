/* Bureau du Courrier — suivi des courriers non récupérés et relances.

   Chaque notification consignée dans l'historique représente un courrier en
   attente au guichet. Tant que personne ne l'a marqué comme récupéré, il reste
   dû — et peut donner lieu à une relance.

   Le calcul de ce qui est « à relancer » est une fonction pure, sans horloge ni
   réseau : c'est ce qui la rend vérifiable. La boucle qui l'appelle
   périodiquement n'a, elle, aucune logique. */
'use strict';

const JOUR = 24 * 60 * 60 * 1000;

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
    if ((entree.reminderCount || 0) >= maxRelances) return false;
    if (joursEcoules(entree.date, maintenant) < delai) return false;
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
    const seuil = entree.remindedAt ? escalade : delai + escalade;
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
  etat: etat,
  resume: resume,
  joursEcoules: joursEcoules,
  startReminderLoop: startReminderLoop
};
