/* Bureau du Courrier — la référence d'un courrier.

   Le code de retrait à quatre chiffres sert à une chose et une seule :
   prouver, au moment du retrait, qu'on est bien la personne attendue. Une fois
   le courrier remis, il ne veut plus rien dire — et il est court, donc il se
   répète. Il ne peut pas servir à désigner un courrier.

   « COUR-2026-000042 » désigne un courrier et un seul, pour toujours : même
   retiré, même archivé, même six ans plus tard quand quelqu'un rappelle pour
   savoir ce qu'est devenu son pli recommandé. Il se dicte au téléphone, se
   note au crayon sur une enveloppe, se colle en Code 39 et se rescanne.

   Trois morceaux, dans cet ordre parce que c'est l'ordre où on les lit :

     - **le préfixe** — le bureau, ou l'antenne quand il y en a plusieurs.
       Court et en lettres, parce qu'il se dicte : « C, O, U, R ».
     - **l'année** — c'est elle qui garde le numéro court. Sans elle, il
       faudrait six chiffres qui ne veulent rien dire, et le compteur
       n'arrêterait jamais de monter.
     - **le rang dans l'année**, sur six chiffres.

   Un point de méthode qui compte : **le prochain numéro se déduit de ce qui
   existe**, jamais d'un compteur rangé à part. Un compteur séparé se
   désynchronise à la première restauration de sauvegarde, et personne ne s'en
   aperçoit avant d'avoir deux courriers COUR-2026-000017 — deux personnes,
   deux plis, un seul numéro.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(enNode ? require('./util.js') : root.BC.util);
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.reference = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  const PREFIXE_DEFAUT = 'COUR';
  const CHIFFRES = 6;

  /* Deux lettres au moins, six au plus. En dessous de deux, un préfixe ne
     distingue rien ; au-delà de six, il ne se dicte plus. */
  const MOTIF = /^([A-Z]{2,6})-(\d{4})-(\d{6})$/;

  /* Un préfixe utilisable : sans accents (ils ne se dictent pas et ne se
     tapent pas partout de la même façon), en majuscules, lettres seulement.
     Ce qui n'en laisse pas assez retombe sur le défaut plutôt que de produire
     une référence illisible. */
  function nettoyerPrefixe(texte, defaut) {
    const p = util
      .normalize(texte)
      .replace(/[^a-z]/g, '')
      .toUpperCase()
      .slice(0, 6);
    if (p.length >= 2) return p;
    return defaut === undefined ? PREFIXE_DEFAUT : nettoyerPrefixe(defaut, PREFIXE_DEFAUT);
  }

  /* Le préfixe d'une antenne vient de son nom, sur trois lettres : « Paris
     11e » donne PAR, « Lyon » donne LYO. Trois suffit à distinguer les
     antennes d'un même bureau, et c'est ce qui se retient. Sans antenne, le
     préfixe du bureau. */
  function prefixeAntenne(antenne, defaut) {
    const nom = antenne && antenne.nom ? antenne.nom : '';
    const p = util.normalize(nom).replace(/[^a-z]/g, '').toUpperCase().slice(0, 3);
    if (p.length >= 2) return p;
    return defaut === undefined ? PREFIXE_DEFAUT : nettoyerPrefixe(defaut, PREFIXE_DEFAUT);
  }

  function formater(numero, annee, prefixe) {
    const p = prefixe === undefined ? PREFIXE_DEFAUT : prefixe;
    return p + '-' + annee + '-' + String(numero).padStart(CHIFFRES, '0');
  }

  /* La casse ne compte pas : une référence se dicte au téléphone et se
     retape en minuscules aussi souvent qu'en majuscules. */
  function lire(texte) {
    const m = MOTIF.exec(String(texte === null || texte === undefined ? '' : texte).trim().toUpperCase());
    if (!m) return null;
    return { prefixe: m[1], annee: Number(m[2]), numero: Number(m[3]) };
  }

  function estReference(texte) {
    return lire(texte) !== null;
  }

  /* Le rang suivant, déduit du maximum réellement présent — pas d'un compteur
     tenu à côté. Si des références manquent au milieu (un courrier effacé, une
     sauvegarde partielle), le maximum reste juste : on ne réattribue pas un
     numéro déjà prononcé au téléphone. */
  function prochain(history, annee, prefixe) {
    const p = prefixe === undefined ? PREFIXE_DEFAUT : prefixe;
    let max = 0;
    (history || []).forEach(function (item) {
      const r = item && lire(item.reference);
      if (!r || r.annee !== annee || r.prefixe !== p) return;
      if (r.numero > max) max = r.numero;
    });
    return max + 1;
  }

  function suivante(history, annee, prefixe) {
    return formater(prochain(history, annee, prefixe), annee, prefixe === undefined ? PREFIXE_DEFAUT : prefixe);
  }

  return {
    PREFIXE_DEFAUT: PREFIXE_DEFAUT,
    MOTIF: MOTIF,
    nettoyerPrefixe: nettoyerPrefixe,
    prefixeAntenne: prefixeAntenne,
    formater: formater,
    lire: lire,
    estReference: estReference,
    prochain: prochain,
    suivante: suivante
  };
});
