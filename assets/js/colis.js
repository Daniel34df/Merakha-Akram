/* Bureau du Courrier — le colis, qui n'est pas une lettre.

   Un colis se distingue d'une lettre sur un point que l'application ignorait
   jusqu'ici : **il occupe de la place**. Une lettre va dans le casier de la
   personne et y reste le temps qu'il faut. Un colis de quinze kilos ne rentre
   dans aucun casier, il est posé quelque part dans le local — et si personne
   n'a noté où, il est perdu pour tout le monde sauf pour celui qui l'a posé.
   C'est le vrai problème de ce type de courrier dans un bureau qui domicilie :
   pas le suivi transporteur, mais **où est-il rangé**.

   D'où l'ordre de ce module :

     1. **l'emplacement** — la seule information sans laquelle un colis
        encombrant est irretrouvable. Elle est demandée dès qu'il ne tient pas
        dans un casier, et pas avant : exiger « où l'avez-vous mis » pour une
        petite boîte qui va au casier B-012 serait une question pour rien.

     2. **le transporteur et le numéro de suivi** — ce qu'on lit sur
        l'étiquette. Le numéro sert à répondre à « il devait arriver mardi,
        vous l'avez ? » sans décacheter quoi que ce soit, et à retrouver le
        colis chez le transporteur s'il n'est jamais arrivé.

     3. **le poids et les dimensions** — notés parce qu'ils décident du reste,
        pas pour eux-mêmes.

   **Ce qu'on ne fait pas.** Aucun appel au site du transporteur : ce serait la
   première dépendance réseau du projet, et surtout elle enverrait le numéro de
   suivi d'une personne domiciliée — donc son existence, sa date de retrait et
   l'adresse du bureau — à un tiers, à chaque consultation. On fabrique un lien
   que l'agent ouvre s'il le veut ; c'est son geste, pas le nôtre.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(enNode ? require('./util.js') : root.BC.util);
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.colis = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  /* Au-delà de ces valeurs, un colis ne tient pas dans un casier ordinaire et
     doit être rangé ailleurs — donc son emplacement doit être noté.

     Les seuils sont ceux d'un casier de boîte aux lettres collective courant :
     une trentaine de centimètres de profondeur, et un poids qu'on soulève d'une
     main. Ils sont réglables par bureau, parce qu'un local varie ; les valeurs
     ici ne sont qu'un point de départ raisonnable. */
  const SEUILS = { poidsKg: 5, cotecm: 35 };

  /* Les transporteurs qu'on voit passer dans un bureau français, et de quoi
     fabriquer le lien de suivi. `motif` sert à deviner lequel c'est à partir du
     seul numéro — l'agent lit l'étiquette, il ne devrait pas avoir à choisir
     dans une liste ce que le numéro dit déjà.

     `url` reçoit le numéro déjà encodé. Un transporteur sans `url` reste
     utilisable : on note son nom et son numéro, il n'y a simplement pas de
     lien à ouvrir. */
  const TRANSPORTEURS = [
    /* Colissimo : treize caractères, commençant par un chiffre — « 6A », « 8R »,
       « 11 »… — ou treize chiffres tout court. On ne réclame **pas** les
       numéros qui commencent par deux lettres : ce sont ceux de Chronopost, et
       une alternative en « C[A-Z] » lui aurait volé tous ceux qui commencent
       par un C. Deviner faux vaut moins bien que ne rien deviner. */
    { id: 'colissimo', label: 'La Poste — Colissimo',
      motif: /^[0-9][A-Z0-9][0-9]{9}[A-Z]{2}$|^[0-9]{13}$/,
      url: 'https://www.laposte.fr/outils/suivre-vos-envois?code=' },
    { id: 'chronopost', label: 'Chronopost',
      motif: /^[A-Z]{2}[0-9]{9}[A-Z]{2}$/,
      url: 'https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=' },
    { id: 'mondialrelay', label: 'Mondial Relay',
      motif: /^[0-9]{8}$/,
      url: 'https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=' },
    { id: 'dpd', label: 'DPD',
      motif: /^[0-9]{14}$/,
      url: 'https://www.dpd.fr/trace/' },
    { id: 'ups', label: 'UPS',
      motif: /^1Z[0-9A-Z]{16}$/,
      url: 'https://www.ups.com/track?tracknum=' },
    { id: 'dhl', label: 'DHL',
      motif: /^[0-9]{10}$/,
      url: 'https://www.dhl.com/fr-fr/home/tracking.html?tracking-id=' },
    { id: 'gls', label: 'GLS', motif: null,
      url: 'https://gls-group.com/FR/fr/suivi-colis?match=' },
    { id: 'amazon', label: 'Amazon', motif: null, url: '' },
    /* « Autre » n'est pas un défaut de conception : beaucoup de colis arrivent
       par un transporteur local ou une plateforme dont le bureau n'a que faire.
       Le nom se tape à la main dans ce cas. */
    { id: 'autre', label: 'Autre transporteur', motif: null, url: '' }
  ];

  function transporteur(id) {
    return TRANSPORTEURS.find(function (t) { return t.id === id; }) || null;
  }

  /* Un numéro de suivi comparable et affichable : sans espaces ni tirets, en
     majuscules. Les étiquettes les impriment par groupes de quatre, et le même
     numéro recopié à la main n'a jamais les mêmes espaces. */
  function normaliserSuivi(texte) {
    return String(texte === null || texte === undefined ? '' : texte)
      .replace(/[\s.-]/g, '')
      .toUpperCase();
  }

  /* Deviner le transporteur d'après la forme du numéro.

     Rendu comme une **proposition**, jamais comme un fait : les formats se
     recoupent (treize chiffres peuvent être un Colissimo comme autre chose), et
     un transporteur deviné faux enverrait l'agent sur le mauvais site. Quand
     rien ne correspond, on rend null plutôt que de choisir au hasard. */
  function deviner(suivi) {
    const n = normaliserSuivi(suivi);
    if (n.length < 8) return null;
    const t = TRANSPORTEURS.find(function (x) { return x.motif && x.motif.test(n); });
    return t ? t.id : null;
  }

  /* Le lien de suivi, ou '' quand il n'y en a pas.

     Rien n'est appelé ici : c'est une adresse qu'on met dans un lien, et c'est
     l'agent qui décide de l'ouvrir. Consulter automatiquement reviendrait à
     dire à un tiers, à chaque affichage de la liste, que telle personne
     domiciliée à telle adresse attend tel colis. */
  function lienSuivi(transporteurId, suivi) {
    const t = transporteur(transporteurId);
    const n = normaliserSuivi(suivi);
    if (!t || !t.url || !n) return '';
    return t.url + encodeURIComponent(n);
  }

  function nombre(v) {
    const n = Number(String(v === null || v === undefined ? '' : v).replace(',', '.'));
    return isFinite(n) && n > 0 ? n : 0;
  }

  /* Un colis est encombrant s'il dépasse le poids ou l'une des trois cotes.

     Une seule cote suffit : un tube d'un mètre de long pèse deux kilos et ne
     rentre dans aucun casier. Raisonner sur le volume laisserait passer
     exactement ce cas-là. */
  function encombrant(colis, seuils) {
    const s = Object.assign({}, SEUILS, seuils || {});
    const c = colis || {};
    if (nombre(c.poids) > s.poidsKg) return true;
    return [c.longueur, c.largeur, c.hauteur].some(function (d) {
      return nombre(d) > s.cotecm;
    });
  }

  /* Ce qu'il manque pour que ce colis soit retrouvable.

     La liste est courte exprès. Un formulaire qui réclame huit champs pour un
     paquet de chaussettes finit rempli n'importe comment — et ce qui est
     rempli n'importe comment ne se relit pas. On ne réclame l'emplacement que
     quand le colis ne tient pas dans un casier ; le reste est utile, jamais
     exigé. */
  function manques(colis, seuils) {
    const c = colis || {};
    const out = [];
    if (encombrant(c, seuils) && !String(c.emplacement || '').trim()) {
      out.push({
        champ: 'emplacement',
        message: 'Ce colis ne tient pas dans un casier : notez où il est rangé, ' +
          'sinon seul celui qui l’a posé saura le retrouver.'
      });
    }
    return out;
  }

  /* Nettoyage à l'entrée, côté serveur comme côté écran. Un colis dont tous les
     champs sont vides rend null : mieux vaut pas de colis du tout qu'un objet
     vide qui laisse croire que quelqu'un a rempli quelque chose. */
  function nettoyer(brut) {
    const b = brut || {};
    const suivi = normaliserSuivi(b.suivi).slice(0, 40);
    const c = {
      poids: nombre(b.poids),
      longueur: nombre(b.longueur),
      largeur: nombre(b.largeur),
      hauteur: nombre(b.hauteur),
      transporteur: transporteur(b.transporteur) ? b.transporteur : (deviner(suivi) || ''),
      /* Le nom libre ne sert qu'avec « Autre transporteur ». Le garder ailleurs
         donnerait deux noms possibles pour un même colis, et on ne saurait
         plus lequel croire. */
      transporteurNom: b.transporteur === 'autre' ? String(b.transporteurNom || '').trim().slice(0, 60) : '',
      suivi: suivi,
      emplacement: String(b.emplacement || '').trim().slice(0, 80)
    };
    const rempli = c.poids || c.longueur || c.largeur || c.hauteur ||
      c.transporteur || c.suivi || c.emplacement;
    return rempli ? c : null;
  }

  /* La ligne qu'on lit au guichet, dans l'ordre où elle sert : d'abord où il
     est, ensuite ce que c'est. Quelqu'un attend devant le comptoir. */
  function resume(colis) {
    const c = colis || {};
    const bouts = [];
    if (c.emplacement) bouts.push('rangé : ' + c.emplacement);
    const t = transporteur(c.transporteur);
    const nom = c.transporteur === 'autre' && c.transporteurNom ? c.transporteurNom : (t && t.label);
    if (nom) bouts.push(nom);
    if (c.suivi) bouts.push('n° ' + c.suivi);
    if (nombre(c.poids)) bouts.push(nombre(c.poids) + ' kg');
    const cotes = [c.longueur, c.largeur, c.hauteur].map(nombre);
    if (cotes.every(Boolean)) bouts.push(cotes.join('×') + ' cm');
    return bouts.join(' · ');
  }

  return {
    SEUILS: SEUILS,
    TRANSPORTEURS: TRANSPORTEURS,
    transporteur: transporteur,
    normaliserSuivi: normaliserSuivi,
    deviner: deviner,
    lienSuivi: lienSuivi,
    encombrant: encombrant,
    manques: manques,
    nettoyer: nettoyer,
    resume: resume
  };
});
