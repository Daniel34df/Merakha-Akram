/* Bureau du Courrier — le socle de l'interface.

   Ce que tous les écrans partagent : dire un message, demander confirmation,
   télécharger un fichier, savoir quelle antenne est affichée. Rien qui
   appartienne à un onglet en particulier.

   Ce module existe pour une raison précise. « app.js » avait grossi jusqu'à
   5 755 lignes, et le découper d'un coup demandait de rendre explicites
   soixante-huit références qui traversaient les frontières envisagées — dans
   le seul fichier du projet qu'aucun test unitaire ne couvre. Sortir d'abord
   ce socle-là, qui ne dépend de rien, rend les extractions suivantes bon
   marché au lieu de risquées.

   Les trois sélecteurs d'antenne sont ici, et non dans les réglages : ce ne
   sont que des lectures d'une ligne sur l'état du magasin, dont sept sections
   se servent. Les avoir rangés du côté des réglages était l'erreur qui rendait
   l'impression inextricable.

   Comme util.js, attente.js, roles.js, domiciliation.js, reseau.js et
   store.js : window.BC.ui dans le navigateur, module.exports sous Node. Le DOM
   n'est touché qu'à l'intérieur des fonctions, jamais au chargement — ce qui
   rend le module ouvrable hors navigateur. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(
    root,
    enNode ? require('../util.js') : root.BC.util,
    enNode ? require('../store.js') : root.BC.store
  );
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.ui = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, util, store) {
  'use strict';

  const S = store.state;

  const $ = function (id) {
    return document.getElementById(id);
  };
  const esc = util.escapeHtml;

  /* Filtres d'affichage, purement locaux à l'interface. */
  const view = {
    // Section ouverte dans les Réglages, parmi les cinq groupes.
    sectionReglages: 'bureau',
    // Section ouverte dans le Suivi : à traiter, historique, statistiques.
    sectionSuivi: 'traiter',
    contactFilter: '',
    historyFilter: '',
    historyDate: '',
    editingId: null,
    highlight: -1,
    suggestions: [],
    // Vrai dès que l'employé·e a modifié les copies au guichet : on cesse alors
    // de les réaligner sur les réglages tant qu'elles n'ont pas été remises à zéro.
    copiesTouched: false,
    // Premier démarrage : l'écran d'installation a été écarté volontairement.
    skipAccount: false,
    gateFormChosen: false,
    // Recherche au guichet : 'nom' ou 'boite'.
    searchMode: 'nom',
    historyState: 'tous',
    attenteFilter: '',
    pile: [],
    typeCourrier: 'lettre',
    // Inscription en attente du code de confirmation.
    pendingEmail: null,
    // Adresse confirmée, en cours d'association comme boîte d'envoi.
    associateEmail: null,
    // Réglages : onglet de gabarit affiché et brouillons non enregistrés.
    gabaritActif: 'general',
    gabaritGeneral: { subject: '', body: '' },
    gabarits: {},
    // Langue en cours d'édition dans les Réglages ; 'fr' = le modèle de référence.
    gabaritLangue: 'fr',
    gabaritsLangues: {},
    // Onglet Domiciliation : année du rapport, données servies par le serveur.
    rapportAnnee: new Date().getFullYear(),
    domiciliation: null,
    // Saisie en série : ce qui a été traité depuis l'activation du mode.
    serie: [],
    // Antenne affichée ; '' = toutes. Propre au poste, retenu d'une visite à l'autre.
    antenneActive: ''
  };

  /* ═════════════ retours visuels ═════════════ */

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity 0.3s ease';
      el.style.opacity = '0';
      setTimeout(function () {
        el.remove();
      }, 300);
    }, 3200);
  }

  function stamp(label, who) {
    const overlay = $('stampOverlay');
    $('stampLabel').textContent = label;
    $('stampWho').textContent = who;
    overlay.classList.add('show');
    setTimeout(function () {
      overlay.classList.remove('show');
    }, 1300);
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      const dlg = $('confirmDialog');
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmOk').textContent = okLabel || 'Confirmer';
      if (typeof dlg.showModal !== 'function') {
        resolve(root.confirm(text));
        return;
      }
      dlg.addEventListener(
        'close',
        function () {
          resolve(dlg.returnValue === 'ok');
        },
        { once: true }
      );
      dlg.showModal();
    });
  }

  function setMsg(id, kind, html) {
    $(id).innerHTML = html ? '<div class="msg ' + kind + '">' + html + '</div>' : '';
  }

  function download(filename, text, mime) {
    const blob = new Blob(['\uFEFF' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /** Téléchargement d'un fichier binaire (classeur Excel). */
  function downloadBytes(filename, bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function stampSuffix() {
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    const d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  /* ═════════════ lectures d'un courrier ═════════════

     Deux questions posées partout : ce courrier attend-il encore, et depuis
     combien de jours ? Elles ne relèvent d'aucun écran en particulier — la
     première vit dans util.js, que le serveur charge aussi, pour que les deux
     côtés comptent le même courrier de la même façon. */

  const enAttente = util.enAttente;

  function joursDepuis(iso) {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  /* ═════════════ antennes ═════════════

     Un bureau peut tenir plusieurs points d'accueil. Quand il n'y en a qu'un —
     le cas courant — la notion n'apparaît nulle part à l'écran. */

  function antennes() {
    return S.settings.antennes || [];
  }

  /** L'antenne imposée par le compte : un accès limité n'a rien à choisir. */
  function antenneImposee() {
    return (S.auth.user && S.auth.user.antenneId) || '';
  }

  /** Vrai si l'élément relève de l'antenne affichée. Sans antennes, tout passe. */
  function deLAntenne(objet) {
    return util.dansAntenne(objet, view.antenneActive, antennes());
  }

  return {
    $: $,
    esc: esc,
    view: view,
    toast: toast,
    stamp: stamp,
    confirmDialog: confirmDialog,
    setMsg: setMsg,
    download: download,
    downloadBytes: downloadBytes,
    MIME_XLSX: MIME_XLSX,
    stampSuffix: stampSuffix,
    enAttente: enAttente,
    joursDepuis: joursDepuis,
    antennes: antennes,
    antenneImposee: antenneImposee,
    deLAntenne: deLAntenne
  };
});
