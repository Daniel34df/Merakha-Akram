/* Bureau du Courrier — les étiquettes d'une fiche.

   Le besoin, tel qu'il se pose. Un bureau qui domicilie suit des situations
   qui ne tiennent dans aucun champ : une personne sous tutelle, un dossier
   suivi par une association, quelqu'un qui ne doit pas voir son courrier remis
   à un tiers, une famille dont les courriers arrivent sous trois noms. Ces
   choses-là se disent aujourd'hui de vive voix, et se perdent au premier
   remplacement.

   Il y a déjà les **notes** pour ça — un texte libre sur la fiche. Ce que les
   notes ne savent pas faire, c'est **regrouper** : « montre-moi tous les
   dossiers suivis par l'association », « combien de personnes sous tutelle ».
   Une note se lit une par une ; une étiquette se compte et se filtre.

   Les deux se complètent et ne se remplacent pas : l'étiquette dit **de quel
   genre** est la situation, la note dit **laquelle**. « tutelle » et « le
   tuteur est M. Roy, joignable au 06… » ne vont pas au même endroit.

   Trois choix de fond :

     · **elles sont libres.** Une liste fermée obligerait à prévoir les
       situations d'avance, et un bureau en rencontre que nous n'imaginons pas.
       Quelques suggestions sont proposées, aucune n'est imposée.

     · **elles se normalisent.** « Tutelle », « tutelle » et « TUTELLE » sont la
       même étiquette, sinon le filtre en trouve trois et l'agent croit à trois
       situations différentes.

     · **elles ne sortent jamais dans un courriel.** Ce sont des mots que
       l'équipe se dit entre elle. « sdf », « expulsion », « tutelle » écrits
       dans un message à la personne, ou visibles par un tiers, c'est une
       information qui blesse et qui ne la regarde pas sous cette forme. Ce
       module ne fournit donc aucune variable de gabarit.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(enNode ? require('./util.js') : root.BC.util);
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.etiquettes = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  /* Vingt-quatre signes : de quoi écrire « aide-alimentaire » sans écrire une
     phrase. Une étiquette qui devient une phrase est une note mal rangée. */
  const LONGUEUR_MAX = 24;
  /* Au-delà de douze sur une même fiche, elles ne se lisent plus et ne
     distinguent plus rien. */
  const MAX_PAR_FICHE = 12;

  /* Des suggestions, pas une liste fermée : un bureau rencontre des situations
     que nous n'imaginons pas. Elles ne servent qu'à amorcer, et à éviter que
     dix orthographes du même mot cohabitent dès le premier jour. */
  const SUGGEREES = [
    'tutelle', 'curatelle', 'suivi-social', 'association',
    'sans-telephone', 'courrier-recommande', 'famille', 'discretion'
  ];

  /* Une étiquette comparable : sans accents, en minuscules, les espaces et la
     ponctuation ramenés à un tiret. « Suivi social », « suivi-social » et
     « SUIVI SOCIAL » deviennent la même — sinon le filtre en trouve trois et
     l'agent croit à trois situations. */
  function normaliser(texte) {
    return util
      .normalize(texte)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, LONGUEUR_MAX)
      .replace(/-+$/, '');
  }

  /* Lire une saisie libre. Le séparateur est la virgule — ou le point-virgule,
     ou le retour à la ligne, qui sont les autres façons naturelles de faire une
     liste.

     **L'espace n'en est pas un**, et c'est un arbitrage. Séparer aussi sur
     l'espace permettrait de taper « tutelle suivi-social » sans virgule ; mais
     ça couperait « suivi social » en deux étiquettes qui ne veulent rien dire.
     Or les étiquettes en deux mots sont ordinaires en français, et c'est ce
     qu'un agent tape spontanément. Perdre « suivi social » coûte plus cher que
     d'exiger une virgule entre deux étiquettes — d'autant que les espaces
     internes deviennent des tirets, donc « suivi social » et « suivi-social »
     se rejoignent de toute façon. */
  function lire(texte) {
    const brut = Array.isArray(texte)
      ? texte
      : String(texte === null || texte === undefined ? '' : texte).split(/[,;\n]+/);
    const out = [];
    brut.forEach(function (morceau) {
      const e = normaliser(morceau);
      /* Une étiquette d'une seule lettre ne distingue rien et se tape par
         accident. */
      if (e.length >= 2 && out.indexOf(e) === -1) out.push(e);
    });
    return out.slice(0, MAX_PAR_FICHE);
  }

  /** Ce qu'on remet dans le champ de saisie. */
  function ecrire(liste) {
    return (Array.isArray(liste) ? liste : []).join(', ');
  }

  function de(contact) {
    return Array.isArray(contact && contact.etiquettes) ? contact.etiquettes.filter(Boolean) : [];
  }

  /* Toutes les étiquettes du registre, avec leur nombre, de la plus employée à
     la moins employée. C'est ce qui permet de proposer ce que le bureau
     emploie déjà plutôt que ce que nous avons deviné. */
  function toutes(contacts) {
    const compte = {};
    (contacts || []).forEach(function (c) {
      de(c).forEach(function (e) {
        compte[e] = (compte[e] || 0) + 1;
      });
    });
    return Object.keys(compte)
      .map(function (e) { return { etiquette: e, n: compte[e] }; })
      .sort(function (a, b) {
        return b.n - a.n || a.etiquette.localeCompare(b.etiquette, 'fr');
      });
  }

  /* Les fiches qui portent **toutes** les étiquettes demandées.

     « Toutes » et non « au moins une » : on filtre pour restreindre. Demander
     « tutelle » et « association » et recevoir la somme des deux listes ne
     restreint rien — c'est l'inverse de ce qu'on venait chercher. */
  function filtrer(contacts, demandees) {
    const cherchees = lire(demandees);
    if (!cherchees.length) return (contacts || []).slice();
    return (contacts || []).filter(function (c) {
      const siennes = de(c);
      return cherchees.every(function (e) { return siennes.indexOf(e) !== -1; });
    });
  }

  /* Ce qui reste à proposer : les suggestions que le bureau n'emploie pas
     encore, plus celles qu'il emploie déjà. Proposer une étiquette déjà posée
     sur la fiche n'aurait pas de sens. */
  function proposer(contacts, dejaPosees) {
    const posees = lire(dejaPosees);
    const employees = toutes(contacts).map(function (t) { return t.etiquette; });
    const out = [];
    employees.concat(SUGGEREES).forEach(function (e) {
      if (posees.indexOf(e) === -1 && out.indexOf(e) === -1) out.push(e);
    });
    return out.slice(0, 12);
  }

  return {
    LONGUEUR_MAX: LONGUEUR_MAX,
    MAX_PAR_FICHE: MAX_PAR_FICHE,
    SUGGEREES: SUGGEREES,
    normaliser: normaliser,
    lire: lire,
    ecrire: ecrire,
    de: de,
    toutes: toutes,
    filtrer: filtrer,
    proposer: proposer
  };
});
