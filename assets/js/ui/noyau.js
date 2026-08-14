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
    // Section ouverte dans le Registre : les personnes, ou les casiers.
    sectionRegistre: 'destinataires',
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

  /* ═════════════ les écrans, et comment ils s'appellent ═════════════

     Chaque module d'écran s'inscrit ici au chargement ; les autres s'y
     adressent **au moment de l'appel**, jamais au chargement. C'est ce qui
     permet à deux écrans de se rendre service mutuellement sans que l'ordre des
     balises <script> ne devienne une contrainte — et ce qui rend les liens
     entre écrans visibles : un `ui.ecrans.registre.ouvrirFiche(...)` se
     retrouve d'un coup de grep, un appel direct ne se voyait pas. */

  /* ─────────── la délégation ───────────

     Le problème qu'elle règle. Une liste qui se redessine — les courriers en
     attente, les appels du jour, les suggestions — repose ses écouteurs après
     chaque rendu :

         box.querySelectorAll('button[data-send]').forEach(function (btn) {
           btn.addEventListener('click', …);
         });

     Ça marche, et ça a trois défauts. Le travail est refait à chaque rendu, y
     compris quand rien n'a changé. Un rendu qui oublie de rappeler cette
     boucle produit des boutons **muets** : ils s'affichent, ils se cliquent, et
     il ne se passe rien — le pire mode de panne d'une interface, parce qu'il
     ressemble à une lenteur. Et un écouteur posé sur un élément qu'un autre
     rendu vient de remplacer ne sert plus à personne.

     `deleguer` pose **un** écouteur sur le conteneur, une fois pour toutes, et
     retrouve la cible au moment du clic. Le contenu peut être réécrit cent
     fois : l'écouteur, lui, ne bouge pas. Un bouton dessiné plus tard marche
     sans qu'on ait à y penser, ce qui est exactement la garantie qui manquait.

     Le double appel est neutralisé : `init()` peut être rappelé, et deux
     écouteurs identiques enverraient deux fois la même notification. */
  function deleguer(racine, selecteur, gestionnaire, evenement) {
    const el = typeof racine === 'string' ? $(racine) : racine;
    if (!el) return;
    const type = evenement || 'click';
    /* Une marque par couple événement + sélecteur : un même conteneur délègue
       souvent plusieurs gestes, et un drapeau unique n'en laisserait passer
       qu'un. */
    const cle = '__deleg_' + type + '_' + selecteur;
    if (el[cle]) return;
    el[cle] = true;
    el.addEventListener(type, function (e) {
      const cible = e.target && e.target.closest ? e.target.closest(selecteur) : null;
      /* `closest` peut remonter au-delà du conteneur quand celui-ci est
         imbriqué dans un autre qui délègue le même sélecteur. On s'assure que
         la cible est bien à nous. */
      if (!cible || !el.contains(cible)) return;
      gestionnaire(cible, e);
    });
  }

  const ecrans = {};

  function inscrire(nom, api) {
    ecrans[nom] = api;
    return api;
  }

  /* Vrai quand le serveur exigera une session que nous n'avons pas : inutile
     d'aller chercher des données qui reviendront en 401. Trois écrans posent
     la question, aucun n'en est propriétaire. */
  function sessionManquante() {
    return S.auth.accountsExist && !S.auth.user;
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

  /* ═════════════ l'attente ═════════════

     Deux façons de dire « ça arrive », et elles ne servent pas au même moment.

     Un **squelette** remplit la place que le contenu prendra. Ce n'est pas de
     la décoration : un tableau qui apparaît d'un coup fait sauter la page, et
     le clic qu'on avait commencé à viser tombe sur autre chose. Le mot
     « Chargement… » ne réserve rien du tout.

     Un **bouton occupé** dit que le geste est parti. Sans lui, un envoi lent
     ressemble à un clic manqué, et on reclique — d'où deux notifications pour
     un seul courrier. La file hors ligne sait maintenant les dédoublonner,
     mais la deuxième pression reste une seconde perdue au guichet. */

  /* Des lignes grises à la place d'un tableau qui n'est pas encore là.
     `largeurs` donne le dessin : des pourcentages, pour que ça ressemble à du
     texte et non à des barres égales. */
  function squelette(lignes, largeurs) {
    const n = Math.max(1, Math.min(12, Number(lignes) || 3));
    const l = Array.isArray(largeurs) && largeurs.length ? largeurs : [92, 74, 84, 66];
    let out = '<div class="squelette" aria-hidden="true">';
    for (let i = 0; i < n; i++) {
      out += '<div class="squelette-ligne" style="width:' + l[i % l.length] + '%"></div>';
    }
    return out + '</div>';
  }

  /* Le même état, posé et retiré à la main. Sept endroits de l'application
     désactivaient déjà leur bouton pendant l'envoi ; ils disaient donc « pas
     maintenant » sans jamais dire « c'est parti ». Un bouton grisé et un bouton
     occupé se ressemblent à l'écran et ne veulent pas dire la même chose. */
  function occupe(bouton, oui) {
    if (!bouton) return;
    bouton.disabled = !!oui;
    if (oui) bouton.setAttribute('aria-busy', 'true');
    else bouton.removeAttribute('aria-busy');
  }

  /* Marque un bouton occupé le temps d'une promesse, et le relâche quoi qu'il
     arrive — y compris quand la promesse échoue, sans quoi un serveur en panne
     laisserait le guichet avec un bouton mort jusqu'au rechargement. */
  function pendant(bouton, promesse) {
    if (!bouton) return promesse;
    bouton.setAttribute('aria-busy', 'true');
    bouton.disabled = true;
    const relacher = function () {
      bouton.removeAttribute('aria-busy');
      bouton.disabled = false;
    };
    return Promise.resolve(promesse).then(
      function (v) {
        relacher();
        return v;
      },
      function (e) {
        relacher();
        throw e;
      }
    );
  }

  /* ═════════════ le thème ═════════════

     Clair, sombre, ou celui du système. Trois états et non deux : « auto » est
     le défaut, et c'est le bon — un poste de guichet suit l'éclairage de la
     pièce via le réglage du système d'exploitation. Mais un agent qui travaille
     le soir dans une salle éclairée au néon peut vouloir trancher, et son choix
     doit alors l'emporter sur le système.

     Le choix vit dans le stockage local, pas dans le registre : c'est une
     préférence d'affichage propre à un poste. La partager entre les postes du
     bureau reviendrait à imposer aux autres l'éclairage de sa propre pièce, et
     à faire voyager sur le réseau quelque chose qui n'a rien à y faire. */

  const CLE_THEME = 'bdc-theme';
  const THEMES = ['auto', 'clair', 'sombre'];

  /* La couleur de la barre du navigateur, sur téléphone et en application
     installée. Ce sont les valeurs de `--bg` des deux thèmes ; elles sont
     recopiées ici parce qu'une balise <meta> ne sait pas lire une variable
     CSS. Le test de couleurs vérifie qu'elles ne divergent pas. */
  const BARRE = { clair: '#F8FAFC', sombre: '#0F172A' };

  /** Ce que la personne a choisi : 'auto', 'clair' ou 'sombre'. */
  function themeChoisi() {
    try {
      const c = root.localStorage.getItem(CLE_THEME);
      return THEMES.indexOf(c) > 0 ? c : 'auto';
    } catch (e) {
      /* Navigation privée, stockage refusé : on suit le système. */
      return 'auto';
    }
  }

  /* La résolution, séparée de son application : c'est la seule partie qui a une
     règle, donc la seule qui se vérifie sans navigateur. */
  function resoudreTheme(choix, systemeSombre) {
    if (choix === 'clair' || choix === 'sombre') return choix;
    return systemeSombre ? 'sombre' : 'clair';
  }

  /** Le thème réellement affiché, choix et système confondus. */
  function themeResolu() {
    const sombre = !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
    return resoudreTheme(themeChoisi(), sombre);
  }

  /* Applique un choix, le retient, et met la barre du navigateur d'accord.
     En « auto » l'attribut est **retiré** plutôt que posé à une valeur : c'est
     ce qui laisse la règle de média reprendre la main dans la feuille de
     style. Poser data-theme="auto" figerait le thème du moment. */
  function appliquerTheme(choix) {
    const valide = THEMES.indexOf(choix) >= 0 ? choix : 'auto';
    const racine = document.documentElement;
    if (valide === 'auto') {
      racine.removeAttribute('data-theme');
    } else {
      racine.setAttribute('data-theme', valide);
    }
    try {
      if (valide === 'auto') root.localStorage.removeItem(CLE_THEME);
      else root.localStorage.setItem(CLE_THEME, valide);
    } catch (e) {
      /* Sans stockage, le choix vaut pour la session : mieux que rien. */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BARRE[themeResolu()]);
    return themeResolu();
  }

  /** Le choix suivant dans le tour : auto → clair → sombre → auto. */
  function themeSuivant() {
    return THEMES[(THEMES.indexOf(themeChoisi()) + 1) % THEMES.length];
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
    const HAUTEUR = 3;
    const large = Math.max(24, ici.width - marge * 2);
    const x = ici.left - cadre.left - zone.clientLeft + (ici.width - large) / 2;
    /* Le second axe : sur un écran étroit, les six onglets passent sur
       plusieurs lignes et l'onglet ouvert n'est pas forcément sur la
       dernière. */
    const y = ici.bottom - cadre.top - zone.clientTop - HAUTEUR - 2;
    barre.style.width = large + 'px';
    barre.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
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
    ecrans: ecrans,
    inscrire: inscrire,
    deleguer: deleguer,
    sessionManquante: sessionManquante,
    mouvementReduit: mouvementReduit,
    squelette: squelette,
    occupe: occupe,
    pendant: pendant,
    glisseOnglet: glisseOnglet,
    majCompteur: majCompteur,
    THEMES: THEMES,
    BARRE_THEME: BARRE,
    themeChoisi: themeChoisi,
    resoudreTheme: resoudreTheme,
    themeResolu: themeResolu,
    appliquerTheme: appliquerTheme,
    themeSuivant: themeSuivant
  };
});
