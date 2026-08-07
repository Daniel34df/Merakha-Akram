/* Bureau du Courrier — rôles, accès et autorisations.

   Deux façons d'entrer dans l'application, pour deux usages différents :

     · le **responsable** ouvre l'application avec un courriel et un mot de
       passe. C'est le compte du bureau, créé au tout premier démarrage. Il voit
       tout, règle tout, et c'est lui qui distribue les accès ;

     · un **agent** ouvre l'application avec un identifiant et un code d'accès,
       remis par le responsable. Pas de courriel à créer, pas de mot de passe à
       retenir : un poste d'accueil tenu par plusieurs personnes n'a pas à
       gérer des boîtes mail. L'accès est limité à ce que le responsable a
       coché, et se retire d'un clic.

   Ce module ne décide de rien tout seul : il dit seulement ce qu'un compte a le
   droit de faire. Le serveur s'en sert pour refuser, l'interface pour masquer.
   Les deux consultent la même table, ce qui évite qu'un bouton caché reste
   ouvert derrière. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.roles = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Les autorisations, une par capacité réellement distincte. On ne multiplie
     pas les cases : chacune doit correspondre à une question que le responsable
     se pose vraiment en confiant un poste. */
  const DROITS = [
    {
      id: 'guichet',
      label: 'Guichet — signaler un courrier reçu',
      detail: 'Chercher un destinataire et lui envoyer la notification.'
    },
    {
      id: 'remise',
      label: 'Remise — rendre un courrier',
      detail: 'Marquer un courrier récupéré, depuis la liste ou par code.'
    },
    {
      id: 'codes',
      label: 'Voir les codes de retrait',
      detail:
        'Sans ce droit, les codes sont masqués partout : listes, historique, fiches. ' +
        'L’agent peut toujours remettre un courrier en saisissant le code que la personne présente.'
    },
    {
      id: 'registre',
      label: 'Modifier le registre',
      detail: 'Ajouter, corriger ou supprimer un destinataire.'
    },
    {
      id: 'domiciliation',
      label: 'Domiciliation',
      detail: 'Consulter les échéances d’attestation et les passages.'
    },
    {
      id: 'exports',
      label: 'Exporter et imprimer',
      detail: 'Sortir le registre en Excel ou en CSV, imprimer les feuilles.'
    },
    {
      id: 'reglages',
      label: 'Réglages du bureau',
      detail: 'Modèles de message, sauvegardes, durée de conservation.'
    }
  ];

  /* Ce qu'un agent reçoit par défaut : de quoi tenir le guichet, rien de plus.
     Les codes de retrait en sont volontairement exclus — c'est la demande qui
     motive tout ce module. */
  const DEFAUT_AGENT = {
    guichet: true,
    remise: true,
    codes: false,
    registre: false,
    domiciliation: false,
    exports: false,
    reglages: false
  };

  function toutesLesPermissions(valeur) {
    const out = {};
    DROITS.forEach(function (d) {
      out[d.id] = !!valeur;
    });
    return out;
  }

  /** Ne garde que les droits connus, et les force en booléens. */
  function nettoyerPermissions(permissions) {
    const out = Object.assign({}, DEFAUT_AGENT);
    if (!permissions || typeof permissions !== 'object') return out;
    DROITS.forEach(function (d) {
      if (permissions[d.id] !== undefined) out[d.id] = !!permissions[d.id];
    });
    return out;
  }

  /* Le responsable n'a pas de table d'autorisations : il a tout, par
     construction. Lui en donner une ouvrirait la possibilité de se retirer
     à soi-même le droit de se les redonner. */
  function estResponsable(user) {
    return !!user && user.role === 'responsable';
  }

  function peut(user, droit) {
    if (!user) return false;
    if (estResponsable(user)) return true;
    const p = nettoyerPermissions(user.permissions);
    return !!p[droit];
  }

  /* Un agent sans le droit « codes » ne doit pas recevoir les codes de retrait,
     même dans une réponse qu'il a le droit de lire par ailleurs. On les retire
     du contenu servi plutôt que de compter sur l'interface pour ne pas les
     afficher : un onglet de développeur suffirait à les lire. */
  function masquerCodes(history, user) {
    if (peut(user, 'codes')) return history;
    return (history || []).map(function (h) {
      const copie = Object.assign({}, h);
      // On garde l'information « un code existe », sans le révéler.
      copie.pickupCode = h.pickupCode ? '••••' : h.pickupCode;
      copie.codeMasque = !!h.pickupCode;
      return copie;
    });
  }

  /* Identifiant d'agent, lisible et dictable au téléphone : deux lettres, un
     tiret, quatre chiffres. Pas de O ni de I, qu'on confond avec 0 et 1. */
  const LETTRES = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  function genererIdentifiant(tirage) {
    const hasard = tirage || function (n) {
      return Math.floor(Math.random() * n);
    };
    let out = '';
    for (let i = 0; i < 2; i++) out += LETTRES[hasard(LETTRES.length)];
    out += '-';
    for (let i = 0; i < 4; i++) out += String(hasard(10));
    return out;
  }

  function identifiantValide(id) {
    return /^[A-HJ-NP-Z]{2}-\d{4}$/.test(String(id || '').toUpperCase());
  }

  function normaliserIdentifiant(id) {
    return String(id || '').toUpperCase().replace(/\s/g, '');
  }

  /* Code d'accès de l'agent : six chiffres, comme les codes de confirmation.
     Assez court pour être recopié sur un papier, assez long pour ne pas se
     deviner — et de toute façon protégé par le freinage des tentatives. */
  function codeAccesValide(code) {
    return /^\d{6}$/.test(String(code || ''));
  }

  return {
    DROITS: DROITS,
    DEFAUT_AGENT: DEFAUT_AGENT,
    toutesLesPermissions: toutesLesPermissions,
    nettoyerPermissions: nettoyerPermissions,
    estResponsable: estResponsable,
    peut: peut,
    masquerCodes: masquerCodes,
    genererIdentifiant: genererIdentifiant,
    identifiantValide: identifiantValide,
    normaliserIdentifiant: normaliserIdentifiant,
    codeAccesValide: codeAccesValide
  };
});
