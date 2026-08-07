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

/** Un courrier compte comme en attente tant qu'il n'a pas été retiré. */
function enAttente(entree) {
  return !entree.pickedUpAt && entree.status !== 'échec';
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

/** Résumé destiné à l'interface : combien en attente, depuis combien de temps. */
function resume(history, now) {
  const maintenant = now || Date.now();
  const attente = (history || []).filter(enAttente);
  const ages = attente.map(function (e) {
    return joursEcoules(e.date, maintenant);
  });
  return {
    enAttente: attente.length,
    plusAncienJours: ages.length ? Math.floor(Math.max.apply(null, ages)) : 0,
    recuperes: (history || []).filter(function (e) {
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
  resume: resume,
  joursEcoules: joursEcoules,
  startReminderLoop: startReminderLoop
};
