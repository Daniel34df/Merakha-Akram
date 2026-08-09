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
    // Historique : l'affichage est borné, sauf demande explicite.
    historyTout: false,
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

  /* ═════════════ borner un tableau ═════════════

     L'historique ne s'efface jamais tout seul — la conservation vaut zéro par
     défaut — et un bureau qui reçoit du courrier tous les jours dépasse les dix
     mille lignes en deux ans. Tout peindre coûtait une seconde et demie, à
     chaque écriture faite sur le poste d'à côté : le guichet se figeait sous
     les doigts de quelqu'un en train de taper.

     On borne donc ce qu'on peint. La règle qui compte, et que le test garde :
     **le filtre s'applique avant**, sur la totalité. Ce qui n'est pas affiché
     reste trouvable en tapant un nom — sans quoi la borne deviendrait une
     perte de données à l'écran. */
  function borner(liste, plafond, tout) {
    const source = liste || [];
    const max = Number(plafond) > 0 ? Number(plafond) : source.length;
    const tronque = !tout && source.length > max;
    return {
      lignes: tronque ? source.slice(0, max) : source,
      total: source.length,
      tronque: tronque
    };
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

  /* ═════════════ mouvement ═════════════

     Deux gestes que la feuille de style ne peut pas faire seule, parce qu'ils
     ont besoin de mesurer quelque chose : la position d'un onglet, et l'écart
     entre deux nombres.

     Les deux commencent par la même question — « est-ce que cette personne
     veut que ça bouge ? ». Le réglage système « réduire les animations » n'est
     pas une préférence esthétique : pour qui souffre de troubles vestibulaires,
     un mouvement non demandé donne la nausée. La feuille de style le respecte
     déjà ; ce qui est écrit en JavaScript doit le demander explicitement. */

  /** Le réglage système « réduire les animations » est-il actif ? */
  function mouvementReduit() {
    return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* Le soulignement de l'onglet ouvert, placé sous le bon bouton.
     Il glisse d'un onglet à l'autre : six barres qu'on allume et qu'on éteint
     feraient clignoter, une barre qui se déplace dit d'où l'on vient. Elle
     prend au passage la teinte de l'onglet, lue sur le bouton lui-même — la
     couleur est déclarée une seule fois, dans la feuille de style. */
  function glisseOnglet(nom) {
    const barre = document.getElementById('navGlisse');
    if (!barre) return;
    const bouton = document.querySelector('nav button[data-panel="' + nom + '"]');
    /* Un onglet caché mesure zéro. Poser la barre à cheval sur rien la ferait
       apparaître dans un coin : on la retire plutôt. */
    if (!bouton || !bouton.offsetWidth) {
      barre.classList.remove('pret');
      return;
    }
    /* On mesure au rectangle plutôt qu'à `offsetLeft` : celui-ci se compte
       depuis le bord *extérieur* du parent, alors qu'un élément absolu se pose
       depuis l'intérieur de sa bordure. Un pixel d'écart, invisible mais faux —
       et faux de la même façon à chaque onglet. */
    const zone = barre.offsetParent || bouton.parentNode;
    const ici = bouton.getBoundingClientRect();
    const cadre = zone.getBoundingClientRect();
    const marge = 14;
    const large = Math.max(24, ici.width - marge * 2);
    const x = ici.left - cadre.left - zone.clientLeft + (ici.width - large) / 2;
    barre.style.width = large + 'px';
    barre.style.transform = 'translateX(' + Math.round(x) + 'px)';
    const teinte = root.getComputedStyle(bouton).getPropertyValue('--teinte');
    if (teinte) barre.style.setProperty('--teinte', teinte.trim());
    barre.classList.add('pret');
  }

  /* Un compteur d'onglet qui passe de 3 à 7 en défilant.
     C'est le seul endroit où un chiffre change sans qu'on ait rien fait — un
     courrier saisi au poste d'à côté. Le voir défiler dit « ça vient de
     bouger » ; le voir sauter ne dit rien du tout.

     Deux gardes : au-delà de six cents millisecondes on n'anime plus rien de
     lisible, et un écart d'un seul pas ne mérite pas d'animation. */
  function majCompteur(el, valeur) {
    if (!el) return;
    const cible = Number(valeur) || 0;
    const depart = Number(el.textContent) || 0;
    if (el._compteur) {
      root.cancelAnimationFrame(el._compteur);
      el._compteur = null;
    }
    /* Quatre raisons de ne pas animer, et la dernière n'est pas théorique :
       ce module se charge aussi sous Node, où `requestAnimationFrame` n'existe
       pas. Un compteur qui refuse de s'écrire parce qu'il ne peut pas défiler
       serait un compteur faux — le chiffre passe d'abord, l'animation ensuite. */
    if (depart === cible ||
        Math.abs(cible - depart) < 2 ||
        mouvementReduit() ||
        typeof root.requestAnimationFrame !== 'function') {
      el.textContent = String(cible);
      return;
    }
    const duree = 420;
    const debut = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    const pas = function (maintenant) {
      const t = Math.min(1, (maintenant - debut) / duree);
      // Décélération : le chiffre ralentit en arrivant, il ne s'arrête pas net.
      const adouci = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(depart + (cible - depart) * adouci));
      if (t < 1) {
        el._compteur = root.requestAnimationFrame(pas);
      } else {
        el._compteur = null;
        el.textContent = String(cible);
      }
    };
    el._compteur = root.requestAnimationFrame(pas);
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
    borner: borner,
    antennes: antennes,
    antenneImposee: antenneImposee,
    deLAntenne: deLAntenne,
    mouvementReduit: mouvementReduit,
    glisseOnglet: glisseOnglet,
    majCompteur: majCompteur
  };
});
