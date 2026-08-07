/* Bureau du Courrier — suivi des élections de domicile.

   Pourquoi ce module existe. Une association agréée peut servir d'adresse
   administrative à des personnes sans domicile stable : c'est cette adresse qui
   leur permet de recevoir les courriers de la CAF, de France Travail, de la
   préfecture, de l'assurance maladie. Deux échéances pèsent sur ce dispositif :

     · l'attestation d'élection de domicile a une durée de validité — un an en
       général. Périmée, elle coupe l'accès aux droits, souvent sans que
       personne ne s'en aperçoive avant le refus d'un guichet ;

     · la domiciliation peut prendre fin si la personne ne s'est pas présentée
       ni manifestée pendant trois mois consécutifs.

   Ces deux dates ne se surveillent pas de tête sur trois cents dossiers. Le
   registre sait déjà quand chacun est passé chercher son courrier : il suffit
   de s'en servir.

   Les durées ci-dessous sont les valeurs courantes, pas une règle gravée :
   elles se remplacent par les options de chaque fonction. Ce module calcule des
   dates, il ne dit pas le droit — l'appréciation reste à l'équipe. */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./util.js') : root.BC.util
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.domiciliation = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  const JOUR = 24 * 60 * 60 * 1000;

  const DEFAUTS = {
    // Durée de validité de l'attestation, en mois.
    validiteMois: 12,
    // On prévient d'une échéance ce nombre de jours à l'avance.
    preavisJours: 30,
    // Absence au-delà de laquelle la domiciliation peut être remise en cause.
    absenceMois: 3,
    // On alerte un peu avant, pour laisser le temps de joindre la personne.
    preavisAbsenceJours: 21
  };

  /* Object.assign laisse une valeur `undefined` écraser la valeur par défaut :
     un appelant qui transmet `{ validiteMois: undefined }` — ce que fait tout
     réglage absent — annulerait silencieusement le seuil. On ne retient donc
     que les options réellement fournies. */
  function avecDefauts(options) {
    const out = Object.assign({}, DEFAUTS);
    Object.keys(options || {}).forEach(function (cle) {
      if (options[cle] !== undefined && options[cle] !== null) out[cle] = options[cle];
    });
    return out;
  }

  /** '2026-08-07' → Date à midi, pour ne pas se faire piéger par les fuseaux. */
  function jour(iso) {
    if (!iso) return null;
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  function versIso(date) {
    if (!date) return '';
    const p = function (n) {
      return String(n).padStart(2, '0');
    };
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
  }

  /** Échéance calculée à partir de la date d'élection : même quantième, N mois plus tard. */
  function echeance(debutIso, options) {
    const opts = avecDefauts(options);
    const d = jour(debutIso);
    if (!d) return '';
    const fin = new Date(d.getTime());
    const quantieme = fin.getDate();
    fin.setMonth(fin.getMonth() + opts.validiteMois);
    /* 31 janvier + 12 mois tombe juste, mais 31 mars + 1 mois donnerait le
       1er mai : on ramène au dernier jour du mois visé. */
    if (fin.getDate() !== quantieme) fin.setDate(0);
    return versIso(fin);
  }

  function joursEntre(depuisIso, jusquaMs) {
    const d = jour(depuisIso);
    if (!d) return null;
    return Math.round((d.getTime() - jusquaMs) / JOUR);
  }

  /* Dernière fois que la personne s'est manifestée. La loi parle de « présentée
     ou manifestée » : un retrait de courrier compte, une visite sans courrier
     aussi — d'où les passages saisis à la main. */
  function dernierPassage(contact, history, now) {
    const maintenant = now === undefined ? Date.now() : now;
    let dernier = null;
    const retenir = function (iso) {
      if (!iso) return;
      const t = new Date(iso).getTime();
      if (isNaN(t) || t > maintenant) return;
      if (dernier === null || t > dernier) dernier = t;
    };

    (contact.passages || []).forEach(function (p) {
      retenir(p && p.at);
    });
    (history || []).forEach(function (h) {
      const sien =
        h.contactId === contact.id ||
        (contact.email && util.normalize(h.email) === util.normalize(contact.email));
      if (sien) retenir(h.pickedUpAt);
    });
    // À défaut de tout signe de vie, l'ouverture du dossier fait foi.
    if (dernier === null) retenir(contact.domicilieDepuis);
    return dernier === null ? null : new Date(dernier).toISOString();
  }

  /* État complet d'un dossier de domiciliation. Un seul objet, pour que
     l'interface n'ait aucun calcul à refaire. */
  function etat(contact, history, options) {
    const opts = avecDefauts(options);
    const maintenant = opts.now === undefined ? Date.now() : opts.now;
    const c = contact || {};

    if (!c.domicilie) return { etat: 'aucune', libelle: 'Pas de domiciliation' };

    if (c.domiciliationCloseLe) {
      return {
        etat: 'close',
        libelle: 'Domiciliation close le ' + util.formatJour(c.domiciliationCloseLe),
        closeLe: c.domiciliationCloseLe,
        motif: c.domiciliationMotif || ''
      };
    }

    const debut = c.domicilieDepuis || '';
    const fin = c.domicilieJusqua || echeance(debut, opts);
    const joursRestants = fin ? joursEntre(fin, maintenant) : null;

    const passage = dernierPassage(c, history, maintenant);
    const joursSansPassage =
      passage === null ? null : Math.floor((maintenant - new Date(passage).getTime()) / JOUR);
    const seuilAbsence = Math.round(opts.absenceMois * 30.4375);

    let quoi = 'active';
    let libelle = 'Domiciliation valable jusqu’au ' + (fin ? util.formatJour(fin) : '—');

    if (joursRestants !== null && joursRestants < 0) {
      quoi = 'expiree';
      libelle = 'Attestation expirée depuis ' + Math.abs(joursRestants) + ' jour(s)';
    } else if (joursRestants !== null && joursRestants <= opts.preavisJours) {
      quoi = 'bientot';
      libelle = 'Attestation à renouveler sous ' + joursRestants + ' jour(s)';
    }

    /* Le risque de radiation est signalé à part : une attestation peut être
       parfaitement valable alors que la personne a disparu depuis trois mois. */
    const risque =
      joursSansPassage !== null && joursSansPassage >= seuilAbsence - opts.preavisAbsenceJours;

    return {
      etat: quoi,
      libelle: libelle,
      debut: debut,
      echeance: fin,
      joursRestants: joursRestants,
      dernierPassage: passage,
      joursSansPassage: joursSansPassage,
      seuilAbsenceJours: seuilAbsence,
      risqueRadiation: risque,
      absenceDepassee: joursSansPassage !== null && joursSansPassage >= seuilAbsence
    };
  }

  /** Dossiers dont l'attestation arrive à terme (ou l'a dépassé). */
  function aRenouveler(contacts, history, options) {
    const opts = avecDefauts(options);
    return (contacts || [])
      .map(function (c) {
        return { contact: c, etat: etat(c, history, opts) };
      })
      .filter(function (d) {
        return d.etat.etat === 'bientot' || d.etat.etat === 'expiree';
      })
      .sort(function (a, b) {
        return (a.etat.joursRestants || 0) - (b.etat.joursRestants || 0);
      });
  }

  /** Dossiers menacés par la règle des trois mois : à contacter avant radiation. */
  function sansPassage(contacts, history, options) {
    const opts = avecDefauts(options);
    return (contacts || [])
      .map(function (c) {
        return { contact: c, etat: etat(c, history, opts) };
      })
      .filter(function (d) {
        return (d.etat.etat === 'active' || d.etat.etat === 'bientot' || d.etat.etat === 'expiree') &&
          d.etat.risqueRadiation;
      })
      .sort(function (a, b) {
        return (b.etat.joursSansPassage || 0) - (a.etat.joursSansPassage || 0);
      });
  }

  /* Rapport annuel : ce que l'organisme agréé doit être en mesure de fournir.
     On compte sur une année civile, ou sur la période demandée. */
  function rapportAnnuel(contacts, history, options) {
    const opts = options || {};
    const annee = opts.annee || new Date().getFullYear();
    const debut = opts.debut || annee + '-01-01';
    const fin = opts.fin || annee + '-12-31';
    const dansLaPeriode = function (iso) {
      if (!iso) return false;
      const d = String(iso).slice(0, 10);
      return d >= debut && d <= fin;
    };

    const domicilies = (contacts || []).filter(function (c) {
      return c.domicilie;
    });
    const ouvertes = domicilies.filter(function (c) {
      return dansLaPeriode(c.domicilieDepuis);
    });
    const closes = domicilies.filter(function (c) {
      return dansLaPeriode(c.domiciliationCloseLe);
    });
    const actives = domicilies.filter(function (c) {
      return !c.domiciliationCloseLe;
    });

    const motifs = {};
    closes.forEach(function (c) {
      const m = c.domiciliationMotif || 'non précisé';
      motifs[m] = (motifs[m] || 0) + 1;
    });

    // Volume de courrier reçu pour les personnes domiciliées sur la période.
    const idsDomicilies = new Set(
      domicilies.map(function (c) {
        return c.id;
      })
    );
    const courriers = (history || []).filter(function (h) {
      return idsDomicilies.has(h.contactId) && dansLaPeriode(h.date);
    });

    return {
      annee: annee,
      debut: debut,
      fin: fin,
      actives: actives.length,
      ouvertesDansLAnnee: ouvertes.length,
      closesDansLAnnee: closes.length,
      motifs: motifs,
      courriersRecus: courriers.length,
      courriersRetires: courriers.filter(function (h) {
        return h.pickedUpAt;
      }).length
    };
  }

  return {
    DEFAUTS: DEFAUTS,
    echeance: echeance,
    dernierPassage: dernierPassage,
    etat: etat,
    aRenouveler: aRenouveler,
    sansPassage: sansPassage,
    rapportAnnuel: rapportAnnuel
  };
});
