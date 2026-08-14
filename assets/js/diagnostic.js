/* Bureau du Courrier — l'état de santé de l'installation.

   Ce que ça résout. Cette application est installée par un bureau, pas par un
   service informatique. Personne ne surveille le disque, personne ne relit les
   journaux, et personne ne remarque qu'aucune sauvegarde n'a été faite depuis
   trois mois — jusqu'au jour où le disque lâche et où le registre des
   domiciliations disparaît avec lui. Ce registre-là, ce sont des gens dont
   l'adresse administrative existe uniquement dans ce fichier.

   Le diagnostic dit **ce qui menace les données avant que ça arrive**, en
   français, avec le geste qui l'écarte.

   Trois règles qui le rendent utilisable :

     · **il ne signale que ce qui se répare.** « Le disque a 12 % d'espace
       libre » appelle une action ; « la version de Node est 22.3.1 » n'en
       appelle aucune et ne fait qu'user l'attention.

     · **il distingue ce qui est grave de ce qui est à surveiller.** Un
       diagnostic dont tout est rouge se lit comme un diagnostic dont rien ne
       l'est.

     · **il ne prétend jamais avoir vérifié ce qu'il n'a pas pu voir.** Une
       observation absente rend un point « inconnu », pas « bon ». Dire « tout
       va bien » sans avoir regardé est la seule façon de rendre cet écran
       nuisible : il empêcherait quelqu'un d'aller voir.

   Le module est pur : il reçoit des **observations** déjà faites (le serveur
   sait lire un disque, pas lui) et rend des constats. C'est ce qui permet de
   vérifier hors navigateur qu'un disque plein est bien signalé, sans remplir
   de disque.

   Calcul pur, vérifiable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory();
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.diagnostic = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Quatre niveaux, et « inconnu » en est un à part entière : c'est lui qui
     empêche l'écran de mentir par omission. */
  const NIVEAUX = ['grave', 'attention', 'inconnu', 'bon'];

  /* Au-delà de sept jours sans copie, une panne de disque coûte une semaine de
     travail — assez pour qu'un renouvellement de domiciliation soit perdu.
     Trente jours, c'est un registre qu'on ne peut plus reconstruire de
     mémoire. */
  const SAUVEGARDE_ATTENTION = 7;
  const SAUVEGARDE_GRAVE = 30;

  function constat(cle, titre, niveau, dit, faire) {
    return { cle: cle, titre: titre, niveau: niveau, dit: dit, faire: faire || '' };
  }

  function jours(depuis, at) {
    if (!depuis) return null;
    const d = new Date(depuis);
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor(((at || new Date()) - d) / 86400000));
  }

  /* Le bilan. `obs` est ce que le serveur a pu observer ; tout y est facultatif,
     et ce qui manque devient « inconnu ». */
  function bilan(obs, options) {
    const o = obs || {};
    const at = (options && options.at) ? new Date(options.at) : new Date();
    const out = [];

    /* ── les sauvegardes ──
       Le premier point, parce que c'est le seul dont l'absence est
       irrattrapable. Tout le reste se répare ; un registre perdu, non. */
    if (o.sauvegardes === undefined || o.sauvegardes === null) {
      out.push(constat('sauvegarde', 'Sauvegardes', 'inconnu',
        'Impossible de lire le dossier des sauvegardes.',
        'Vérifiez que le dossier « data/sauvegardes » existe et qu’il est accessible.'));
    } else if (!o.sauvegardes.length) {
      out.push(constat('sauvegarde', 'Sauvegardes', 'grave',
        'Aucune sauvegarde n’a jamais été faite.',
        'Réglages → Sauvegarde → « Sauvegarder maintenant ». Puis copiez le fichier ' +
        'sur une clé USB : une copie restée sur le même disque disparaît avec lui.'));
    } else {
      const age = jours(o.sauvegardes[0].at, at);
      if (age === null) {
        out.push(constat('sauvegarde', 'Sauvegardes', 'inconnu',
          'La date de la dernière sauvegarde est illisible.',
          'Refaites-en une pour repartir sur une base sûre.'));
      } else if (age >= SAUVEGARDE_GRAVE) {
        out.push(constat('sauvegarde', 'Sauvegardes', 'grave',
          'La dernière sauvegarde date de ' + age + ' jours.',
          'Un mois de travail perdu, c’est un registre qu’on ne reconstruit pas de mémoire. ' +
          'Sauvegardez maintenant.'));
      } else if (age >= SAUVEGARDE_ATTENTION) {
        out.push(constat('sauvegarde', 'Sauvegardes', 'attention',
          'La dernière sauvegarde date de ' + age + ' jours.',
          'Sauvegardez, et copiez le fichier ailleurs que sur cette machine.'));
      } else {
        out.push(constat('sauvegarde', 'Sauvegardes', 'bon',
          age === 0 ? 'Sauvegardé aujourd’hui.' : 'Sauvegardé il y a ' + age + ' jour' + (age > 1 ? 's' : '') + '.',
          ''));
      }
    }

    /* ── le code de reprise ──
       Il est publié avec le code source du projet. Tant qu'il n'a pas été
       changé, il n'est un secret pour personne : il ouvre le compte
       responsable, et avec lui tout le registre. */
    if (o.codeMaitreDefaut === undefined) {
      out.push(constat('codeMaitre', 'Code de reprise', 'inconnu',
        'Impossible de savoir si le code de reprise a été changé.', ''));
    } else if (o.codeMaitreDefaut) {
      out.push(constat('codeMaitre', 'Code de reprise', 'grave',
        'Le code de reprise est encore celui d’usine, publié avec le code source.',
        'Posez la variable MASTER_CODE avant d’ouvrir l’application au réseau. ' +
        'En l’état, il n’est un secret pour personne.'));
    } else {
      out.push(constat('codeMaitre', 'Code de reprise', 'bon',
        'Un code propre au bureau a été posé.', ''));
    }

    /* ── l'espace disque ──
       Un disque plein n'abîme pas les données — les écritures sont atomiques —
       mais il empêche d'en inscrire de nouvelles, et le guichet s'arrête. */
    if (typeof o.disqueLibrePourcent !== 'number') {
      out.push(constat('disque', 'Espace disque', 'inconnu',
        'Espace disque non mesuré sur cette machine.', ''));
    } else if (o.disqueLibrePourcent < 5) {
      out.push(constat('disque', 'Espace disque', 'grave',
        'Il reste ' + o.disqueLibrePourcent + ' % d’espace libre.',
        'Le guichet s’arrêtera dès que le disque sera plein. Faites de la place maintenant.'));
    } else if (o.disqueLibrePourcent < 15) {
      out.push(constat('disque', 'Espace disque', 'attention',
        'Il reste ' + o.disqueLibrePourcent + ' % d’espace libre.',
        'Supprimez les anciennes sauvegardes, ou déplacez-les sur une clé.'));
    } else {
      out.push(constat('disque', 'Espace disque', 'bon',
        o.disqueLibrePourcent + ' % d’espace libre.', ''));
    }

    /* ── le registre est-il écrivable ──
       Le cas d'un dossier passé en lecture seule après une restauration
       système : l'application démarre, l'écran s'affiche, et rien ne
       s'enregistre. C'est la panne la plus déroutante possible. */
    if (o.registreEcrivable === undefined) {
      out.push(constat('ecriture', 'Écriture du registre', 'inconnu',
        'Impossible de vérifier que le registre est écrivable.', ''));
    } else if (!o.registreEcrivable) {
      out.push(constat('ecriture', 'Écriture du registre', 'grave',
        'Le fichier du registre n’est pas écrivable.',
        'Rien de ce qui est saisi ne sera conservé. Vérifiez les droits du dossier « data ».'));
    } else {
      out.push(constat('ecriture', 'Écriture du registre', 'bon', 'Le registre s’écrit normalement.', ''));
    }

    /* ── l'envoi de courriel ──
       « Attention » et non « grave » : un bureau qui prévient par téléphone
       fonctionne très bien sans courriel, et une partie de son public n'a pas
       d'adresse. Ce n'est une panne que si le bureau comptait dessus. */
    if (o.courriel === undefined) {
      out.push(constat('courriel', 'Envoi de courriel', 'inconnu', 'État de l’envoi inconnu.', ''));
    } else if (o.courriel === 'essai') {
      out.push(constat('courriel', 'Envoi de courriel', 'attention',
        'Mode essai : les messages ne partent pas réellement.',
        'C’est voulu en démonstration. En service, reliez une boîte dans les Réglages.'));
    } else if (!o.courriel) {
      out.push(constat('courriel', 'Envoi de courriel', 'attention',
        'Aucune boîte d’envoi n’est reliée.',
        'Les personnes sans téléphone ne peuvent pas être prévenues. ' +
        'Reliez une boîte, ou tenez la liste des appels à jour.'));
    } else {
      out.push(constat('courriel', 'Envoi de courriel', 'bon', 'Une boîte d’envoi est reliée.', ''));
    }

    /* ── la liaison chiffrée ──
       Elle ne compte que si l'application sort de la machine. En local, sur
       127.0.0.1, exiger https n'apporterait rien et découragerait un bureau
       qui n'en a pas besoin. */
    if (o.reseau === undefined) {
      out.push(constat('https', 'Liaison chiffrée', 'inconnu', 'Portée du serveur inconnue.', ''));
    } else if (!o.reseau) {
      out.push(constat('https', 'Liaison chiffrée', 'bon',
        'Le serveur ne sort pas de cette machine : la question ne se pose pas.', ''));
    } else if (o.https) {
      out.push(constat('https', 'Liaison chiffrée', 'bon', 'Les postes se relient en https.', ''));
    } else {
      out.push(constat('https', 'Liaison chiffrée', 'attention',
        'Les postes se relient en clair sur le réseau.',
        'Les mots de passe et les noms des personnes domiciliées circulent en clair. ' +
        'Lancez « certificat.cmd » pour passer en https.'));
    }

    /* ── la signature du créateur ──
       Non signée n'est pas une anomalie : la plupart des installations
       tournent depuis les sources et n'ont pas de manifeste. Une signature
       **invalide**, en revanche, veut dire que des fichiers ont changé. */
    if (o.integrite === undefined) {
      out.push(constat('signature', 'Intégrité des fichiers', 'inconnu', 'État de la signature inconnu.', ''));
    } else if (o.integrite === 'ok') {
      out.push(constat('signature', 'Intégrité des fichiers', 'bon',
        'Les fichiers correspondent à la version signée.', ''));
    } else if (o.integrite === 'non-signee') {
      out.push(constat('signature', 'Intégrité des fichiers', 'bon',
        'Version non signée — installation depuis les sources.', ''));
    } else {
      out.push(constat('signature', 'Intégrité des fichiers', 'grave',
        'Les fichiers ne correspondent plus à la version signée.',
        'Réinstallez depuis une copie d’origine. Vos données ne sont pas touchées : ' +
        'elles vivent dans « data », que la signature ne couvre pas.'));
    }

    /* Le plus grave d'abord. À niveau égal, l'ordre d'ajout — qui suit
       l'importance de ce qu'on perd. */
    out.sort(function (a, b) {
      return NIVEAUX.indexOf(a.niveau) - NIVEAUX.indexOf(b.niveau);
    });
    return out;
  }

  /* La phrase du haut. Elle ne dit « rien à signaler » que si rien n'est
     inconnu : c'est toute la différence entre « j'ai regardé » et « je n'ai
     rien vu ». */
  function phrase(constats) {
    const l = constats || [];
    const g = l.filter(function (c) { return c.niveau === 'grave'; }).length;
    const a = l.filter(function (c) { return c.niveau === 'attention'; }).length;
    const i = l.filter(function (c) { return c.niveau === 'inconnu'; }).length;
    if (g) return g === 1 ? 'Un point grave demande une action.' : g + ' points graves demandent une action.';
    if (a) return a === 1 ? 'Un point à surveiller.' : a + ' points à surveiller.';
    if (i) return i === 1 ? 'Un point n’a pas pu être vérifié.' : i + ' points n’ont pas pu être vérifiés.';
    if (!l.length) return '';
    return 'Rien à signaler : l’installation est en ordre.';
  }

  return {
    NIVEAUX: NIVEAUX,
    SAUVEGARDE_ATTENTION: SAUVEGARDE_ATTENTION,
    SAUVEGARDE_GRAVE: SAUVEGARDE_GRAVE,
    bilan: bilan,
    phrase: phrase
  };
});
