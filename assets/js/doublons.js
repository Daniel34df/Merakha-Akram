/* Bureau du Courrier — les fiches qui se ressemblent.

   Le problème, vu du guichet. Quelqu'un se présente, l'agent tape son nom, il
   ne le trouve pas — parce que la fiche existe sous « Jean DUPOND », ou
   « Dupont Jean », ou avec un espace en trop. Il crée une deuxième fiche. À
   partir de là, le courrier arrive tantôt sur l'une, tantôt sur l'autre ; la
   personne se voit refuser un courrier qui est là, sous son autre nom.

   Pour une domiciliation, c'est pire qu'un doublon : les deux fiches ont
   chacune leur date d'élection et leur échéance, et celle qui sert n'est pas
   forcément celle qu'on regarde le jour de la radiation.

   Ce module ne fusionne rien et ne refuse rien. Il **prévient avant** :
   « trois fiches ressemblent à celle-ci, regardez ». C'est l'agent qui sait si
   Jean Dupont et Jean Dupond sont la même personne — pas nous. Décider à sa
   place, ce serait fusionner deux dossiers de deux personnes différentes.

   Trois signaux, du plus sûr au plus douteux, et c'est l'ordre qui compte :

     1. **le courriel** — identique à la casse près : c'est la même personne,
        sauf accident. Certitude.
     2. **le téléphone** — comparé chiffre à chiffre, sans les espaces ni les
        points, avec les indicatifs ramenés au même : « +33 6 12 34 56 78 » et
        « 06 12 34 56 78 » sont le même numéro.
     3. **le nom** — le plus faible. Deux personnes peuvent porter le même nom
        et n'avoir rien à voir, ce qui est ordinaire dans une famille ou dans
        un foyer. On le signale, on ne conclut jamais dessus seul.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(enNode ? require('./util.js') : root.BC.util);
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.doublons = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  /* Un numéro comparable. Les espaces, points et tirets tombent ; l'indicatif
     français revient au 0 national, pour que les deux façons de noter le même
     portable se rejoignent. Les numéros trop courts sont écartés : un « 06 »
     seul ferait correspondre tout le monde. */
  function normaliserTelephone(tel) {
    let n = String(tel === null || tel === undefined ? '' : tel).replace(/[^\d+]/g, '');
    if (n.indexOf('+33') === 0) n = '0' + n.slice(3);
    else if (n.indexOf('0033') === 0) n = '0' + n.slice(4);
    else if (n.indexOf('+') === 0) n = n.slice(1);
    return n.length >= 6 ? n : '';
  }

  /* Le nom, ramené à ce qui compte pour la comparaison : sans accents, sans
     casse, sans ponctuation, et **les mots triés**. C'est ce dernier point qui
     rapproche « Jean Dupont » de « Dupont Jean » — l'ordre nom/prénom varie
     d'un formulaire à l'autre et d'une administration à l'autre. */
  function cleNom(nom) {
    return util
      .normalize(nom)
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(' ')
      .filter(Boolean)
      .sort()
      .join(' ');
  }

  /* Deux noms sont proches si leurs clés coïncident, ou si la distance
     d'édition reste sous une tolérance proportionnelle à la longueur. Deux
     fautes sur « Tremblay », une seule sur « Roy » : sans cette proportion,
     tous les noms courts se ressembleraient. */
  function nomsProches(a, b) {
    const x = cleNom(a);
    const y = cleNom(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const tolerance = x.length <= 4 ? 0 : x.length <= 8 ? 1 : 2;
    return util.distance(x, y) <= tolerance;
  }

  /* Les fiches qui ressemblent à celle qu'on s'apprête à créer.

     `exclureId` sert à la correction d'une fiche : elle ne doit pas se
     signaler comme son propre doublon. */
  function chercher(contacts, candidat, options) {
    const o = options || {};
    const c = candidat || {};
    const courriel = util.normalize(c.email);
    const tel = normaliserTelephone(c.telephone);
    const nom = String(c.name || '').trim();
    if (!courriel && !tel && !nom) return [];

    const out = [];
    (contacts || []).forEach(function (autre) {
      if (!autre || autre.id === o.exclureId) return;

      /* Le courriel d'abord : c'est le seul signal qui vaut à lui seul une
         quasi-certitude. Les adresses vides ne se comparent pas — « '' === '' »
         ferait de toutes les personnes sans courriel un même doublon, et une
         bonne part du public de ce bureau n'a pas d'adresse. */
      if (courriel && util.normalize(autre.email) === courriel) {
        out.push({ contact: autre, raison: 'courriel', sur: 'même courriel', certitude: 'haute' });
        return;
      }
      if (tel && normaliserTelephone(autre.telephone) === tel) {
        out.push({ contact: autre, raison: 'telephone', sur: 'même téléphone', certitude: 'haute' });
        return;
      }
      if (nom && nomsProches(nom, autre.name)) {
        const identique = cleNom(nom) === cleNom(autre.name);
        out.push({
          contact: autre,
          raison: 'nom',
          sur: identique ? 'même nom' : 'nom très proche',
          certitude: identique ? 'moyenne' : 'faible'
        });
      }
    });

    /* Les plus sûrs en tête : c'est ce que l'agent doit lire en premier, et il
       ne lira peut-être que la première ligne. */
    const rang = { haute: 0, moyenne: 1, faible: 2 };
    return out
      .sort(function (a, b) { return rang[a.certitude] - rang[b.certitude]; })
      .slice(0, Math.max(1, Math.min(20, o.limite || 5)));
  }

  /* La phrase qui accompagne l'avertissement. Elle dit ce qu'on a vu et ce
     qu'on ne sait pas — « peut-être », jamais « c'est ». */
  function message(trouves) {
    const n = (trouves || []).length;
    if (!n) return '';
    const sur = trouves[0].certitude === 'haute'
      ? 'Une fiche existe déjà avec ' + trouves[0].sur + '.'
      : n === 1
        ? 'Une fiche porte ' + trouves[0].sur + '.'
        : n + ' fiches portent un nom proche.';
    return sur + ' Vérifiez avant de créer un doublon : deux fiches pour une ' +
      'même personne, et son courrier arrive tantôt sur l’une, tantôt sur l’autre.';
  }

  return {
    normaliserTelephone: normaliserTelephone,
    cleNom: cleNom,
    nomsProches: nomsProches,
    chercher: chercher,
    message: message
  };
});
