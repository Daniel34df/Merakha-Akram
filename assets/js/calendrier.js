/* Bureau du Courrier — le calendrier des échéances.

   Le problème. Les échéances de domiciliation existent déjà, en liste, triées
   par urgence. C'est ce qu'il faut pour traiter, mais pas pour **prévoir**.
   Une liste répond à « qu'est-ce qui presse aujourd'hui ». Elle ne répond pas
   à « est-ce que la semaine prochaine va être tenable », et c'est cette
   question-là qui décide si l'on convoque quatre personnes lundi ou si l'on
   étale sur quinze jours.

   Concrètement : une domiciliation se renouvelle en présence de la personne.
   Douze échéances le même mardi, ce sont douze rendez-vous impossibles à
   caser, donc des attestations qui expirent — et une attestation expirée,
   c'est une adresse qui ne vaut plus pour la CAF ni pour l'assurance maladie.
   Vu un mois à l'avance, ça se répartit. Vu le jour même, ça ne se répartit
   pas.

   Ce module range donc les échéances **par jour**, sur une grille de mois. Il
   ne décide rien : il montre les paquets.

   Deux choses qu'il fait et qu'on remarque à peine :

     · **les jours sans rien restent visibles.** Un calendrier qui n'afficherait
       que les jours chargés ne montrerait plus les creux — or ce sont les creux
       qui servent, quand il s'agit de déplacer un rendez-vous.

     · **une échéance passée ne disparaît pas du mois.** Elle vire au rouge et
       reste à sa date. La faire sortir du calendrier reviendrait à effacer la
       trace de ce qui n'a pas été fait, exactement là où on regarde pour
       savoir ce qui n'a pas été fait.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(
    enNode ? require('./util.js') : root.BC.util,
    enNode ? require('./domiciliation.js') : root.BC.domiciliation
  );
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.calendrier = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util, domi) {
  'use strict';

  const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const MOIS = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
  ];

  /* Au-delà de ce nombre d'échéances le même jour, la journée est **chargée** :
     un renouvellement se fait en présence de la personne, et quatre rendez-vous
     dans une journée de guichet, c'est déjà beaucoup. Le seuil n'interdit rien ;
     il fait voir le paquet assez tôt pour l'étaler. */
  const JOUR_CHARGE = 4;

  function jourLocal(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const j = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + j;
  }

  /** « 2026-08 » → le mois qui contient ce jour-là. */
  function moisDe(jour) {
    return String(jour || '').slice(0, 7);
  }

  function decalerMois(mois, n) {
    const a = Number(String(mois).slice(0, 4));
    const m = Number(String(mois).slice(5, 7));
    const d = new Date(a, m - 1 + n, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function libelleMois(mois) {
    const m = Number(String(mois).slice(5, 7));
    return (MOIS[m - 1] || '') + ' ' + String(mois).slice(0, 4);
  }

  /* La grille d'un mois : des semaines de sept jours, commençant le lundi.

     Elle déborde sur les mois voisins, et ces jours-là sont marqués `hors`.
     Les faire disparaître laisserait des trous en début et fin de grille, et
     une échéance tombant le 1er d'un mois deviendrait invisible depuis le
     mois précédent — c'est-à-dire au moment où l'on prépare. */
  function grille(mois) {
    const a = Number(String(mois).slice(0, 4));
    const m = Number(String(mois).slice(5, 7));
    if (!a || !m) return [];

    const premier = new Date(a, m - 1, 1);
    /* `getDay()` rend 0 pour dimanche ; en France la semaine commence lundi. */
    const decalage = (premier.getDay() + 6) % 7;
    const debut = new Date(a, m - 1, 1 - decalage);

    const semaines = [];
    let curseur = new Date(debut);
    /* Six semaines couvrent tous les mois possibles ; on s'arrête dès que la
       semaine entamée a dépassé le mois, pour ne pas afficher une ligne vide
       en bas quand elle ne sert à rien. */
    for (let s = 0; s < 6; s++) {
      const semaine = [];
      for (let j = 0; j < 7; j++) {
        semaine.push({
          jour: jourLocal(curseur),
          numero: curseur.getDate(),
          hors: curseur.getMonth() !== m - 1
        });
        curseur = new Date(curseur.getFullYear(), curseur.getMonth(), curseur.getDate() + 1);
      }
      semaines.push(semaine);
      if (curseur.getMonth() !== m - 1 && curseur > new Date(a, m - 1 + 1, 0)) break;
    }
    return semaines;
  }

  /* Le mois, garni.

     Chaque case porte ses échéances. Une échéance dont la date est passée
     reste à sa date et se marque `expiree` — la sortir du calendrier
     effacerait la trace de ce qui n'a pas été fait, à l'endroit précis où l'on
     regarde pour savoir ce qui n'a pas été fait. */
  function mois(data, options) {
    const o = options || {};
    const at = o.at ? new Date(o.at) : new Date();
    const leMois = o.mois || moisDe(jourLocal(at));
    const aujourdhui = jourLocal(at);

    const contacts = (Array.isArray(data && data.contacts) ? data.contacts : []).filter(Boolean);
    const history = (Array.isArray(data && data.history) ? data.history : []).filter(Boolean);
    const settings = (data && data.settings) || {};
    /* `now` et non `maintenant` : c'est le nom que `domiciliation.js` lit.
       Passer l'autre laissait le module retomber sur `Date.now()` — la date
       injectée était donc ignorée, et un test « au 15 juin » se jouait en
       réalité au jour où on le lançait. Il passait par chance, pas par
       justesse. */
    const opts = {
      now: at.getTime(),
      validiteMois: settings.domiciliationMois,
      absenceMois: settings.domiciliationAbsenceMois
    };

    /* Par jour, une entrée par personne domiciliée dont l'échéance tombe là. */
    const parJour = {};
    contacts
      .filter(function (c) { return c.domicilie && !c.domiciliationCloseLe; })
      .forEach(function (c) {
        const etat = domi.etat(c, history, opts);
        const jour = jourLocal(etat.echeance);
        if (!jour) return;
        (parJour[jour] = parJour[jour] || []).push({
          contact: c,
          etat: etat,
          expiree: jour < aujourdhui
        });
      });

    const semaines = grille(leMois).map(function (semaine) {
      return semaine.map(function (case_) {
        const liste = (parJour[case_.jour] || []).sort(function (a, b) {
          return (a.contact.name || '').localeCompare(b.contact.name || '', 'fr', { sensitivity: 'base' });
        });
        return Object.assign({}, case_, {
          aujourdhui: case_.jour === aujourdhui,
          passe: case_.jour < aujourdhui,
          echeances: liste,
          n: liste.length,
          /* « Chargé » n'interdit rien : il fait voir le paquet assez tôt pour
             l'étaler sur la semaine. */
          charge: liste.length >= (o.jourCharge || JOUR_CHARGE),
          expirees: liste.filter(function (e) { return e.expiree; }).length
        });
      });
    });

    const toutes = [];
    semaines.forEach(function (s) {
      s.forEach(function (c) {
        if (!c.hors) toutes.push.apply(toutes, c.echeances);
      });
    });

    return {
      mois: leMois,
      libelle: libelleMois(leMois),
      jours: JOURS,
      semaines: semaines,
      total: toutes.length,
      expirees: toutes.filter(function (e) { return e.expiree; }).length,
      /* Les journées chargées, nommées : c'est la seule chose qu'on veut lire
         sans compter les pastilles à l'œil. */
      chargees: semaines.reduce(function (acc, s) {
        s.forEach(function (c) { if (!c.hors && c.charge) acc.push(c); });
        return acc;
      }, [])
    };
  }

  /* La phrase du haut. Elle dit d'abord ce qui est en retard — c'est le seul
     poste où quelqu'un perd un droit maintenant. */
  function phrase(m) {
    if (!m) return '';
    if (m.expirees) {
      return m.expirees === 1
        ? 'Une échéance est dépassée ce mois-ci.'
        : m.expirees + ' échéances sont dépassées ce mois-ci.';
    }
    if (m.chargees.length) {
      return m.chargees.length === 1
        ? 'Une journée chargée : pensez à étaler les rendez-vous.'
        : m.chargees.length + ' journées chargées : pensez à étaler les rendez-vous.';
    }
    if (!m.total) return 'Aucune échéance ce mois-ci.';
    return m.total === 1 ? 'Une échéance ce mois-ci.' : m.total + ' échéances ce mois-ci.';
  }

  return {
    JOURS: JOURS,
    MOIS: MOIS,
    JOUR_CHARGE: JOUR_CHARGE,
    jourLocal: jourLocal,
    moisDe: moisDe,
    decalerMois: decalerMois,
    libelleMois: libelleMois,
    grille: grille,
    mois: mois,
    phrase: phrase
  };
});
