/* Bureau du Courrier — file d'attente des écritures hors ligne.

   Le problème : au guichet, le réseau tombe ou le serveur redémarre en pleine
   journée. Sans file d'attente, chaque action tentée pendant la coupure est
   perdue — un courrier signalé, une remise enregistrée — et l'employé·e ne
   l'apprend qu'en constatant le vide, plus tard.

   Le principe : une écriture qui n'arrive pas au serveur est mise de côté,
   appliquée tout de suite au registre affiché, et rejouée dans l'ordre au
   retour du réseau. Rien n'est perdu, et l'écran ne ment pas.

   Ce module ne fait que tenir la liste — il n'appelle pas le réseau et ne
   touche pas au DOM. C'est ce qui le rend vérifiable hors navigateur.

   Le point délicat est l'identifiant : un destinataire créé hors ligne reçoit
   un identifiant provisoire, et le courrier qu'on lui signale ensuite y
   renvoie. Au rejeu, le serveur attribue le vrai identifiant ; il faut alors
   le substituer dans tout ce qui reste en file. D'où `remapper`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.attente = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Préfixe des identifiants provisoires. Reconnaissable d'un coup d'œil dans
  // le registre comme dans le fichier de la file.
  const PREFIXE_LOCAL = 'local-';

  /* Plafond de la file. Une coupure de plusieurs jours ne doit pas gonfler
     indéfiniment le stockage du navigateur ; au-delà, on refuse d'empiler
     plutôt que de jeter en silence une action déjà annoncée comme prise. */
  const MAX_FILE = 500;

  function estIdLocal(id) {
    return typeof id === 'string' && id.indexOf(PREFIXE_LOCAL) === 0;
  }

  function nouvelIdLocal(hasard) {
    const tirage = hasard || function () {
      return Math.random().toString(36).slice(2, 10);
    };
    return PREFIXE_LOCAL + tirage();
  }

  /** Une intention d'écriture : de quoi rejouer la requête telle quelle. */
  function creerIntention(input) {
    return {
      id: input.id || nouvelIdLocal(),
      at: input.at || new Date().toISOString(),
      op: input.op,
      method: input.method || 'POST',
      path: input.path,
      // Identifiant provisoire créé par cette action, s'il y en a un : c'est la
      // clé qui permettra de substituer le vrai identifiant au rejeu.
      idLocal: input.idLocal || null,
      body: input.body === undefined ? null : input.body,
      // Phrase montrée à l'employé·e : « Courrier signalé à Marie Tremblay ».
      description: input.description || input.op
    };
  }

  function ajouter(items, intention) {
    if (items.length >= MAX_FILE) {
      const err = new Error('Trop d’actions en attente (' + MAX_FILE + ') — rétablissez la connexion.');
      err.code = 'file-pleine';
      throw err;
    }
    return items.concat([intention]);
  }

  function retirer(items, id) {
    return items.filter(function (i) {
      return i.id !== id;
    });
  }

  /* Substitue les identifiants provisoires par les vrais, dans le chemin comme
     dans le corps. Les identifiants sont uniques et assez longs pour qu'une
     substitution textuelle ne puisse pas frapper autre chose. */
  function remapper(items, correspondances) {
    const cles = Object.keys(correspondances || {});
    if (cles.length === 0) return items;
    const remplacer = function (texte) {
      let out = texte;
      cles.forEach(function (provisoire) {
        out = out.split(provisoire).join(correspondances[provisoire]);
      });
      return out;
    };
    return items.map(function (i) {
      const corps = i.body === null || i.body === undefined ? i.body : JSON.parse(remplacer(JSON.stringify(i.body)));
      return Object.assign({}, i, { path: remplacer(i.path), body: corps });
    });
  }

  /** De quoi écrire la bannière : combien, depuis quand, et quoi. */
  function resume(items) {
    if (items.length === 0) return { total: 0, depuis: null, libelles: [] };
    const tries = items.slice().sort(function (a, b) {
      return new Date(a.at) - new Date(b.at);
    });
    return {
      total: items.length,
      depuis: tries[0].at,
      libelles: tries.map(function (i) {
        return i.description;
      })
    };
  }

  /* Un refus du serveur au rejeu (4xx) est définitif : le courrier a pu être
     remis par un collègue entre-temps, le destinataire supprimé… Réessayer
     indéfiniment ne servirait à rien. Une panne réseau ou une erreur serveur
     (5xx), elle, mérite d'attendre le prochain essai. */
  function estDefinitif(status) {
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  return {
    PREFIXE_LOCAL: PREFIXE_LOCAL,
    MAX_FILE: MAX_FILE,
    estIdLocal: estIdLocal,
    nouvelIdLocal: nouvelIdLocal,
    creerIntention: creerIntention,
    ajouter: ajouter,
    retirer: retirer,
    remapper: remapper,
    resume: resume,
    estDefinitif: estDefinitif
  };
});
