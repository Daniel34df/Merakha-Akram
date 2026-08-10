/* Bureau du Courrier — couche de persistance.

   Trois modes, choisis automatiquement au démarrage, du plus durable au moins durable :
     1. « serveur »  : un backend Bureau du Courrier répond sur /api  → registre partagé
                       entre les postes, envoi de courriel automatique possible.
     2. « local »    : localStorage du navigateur → registre conservé sur ce poste.
     3. « mémoire »  : rien ne persiste (page ouverte dans un contexte verrouillé).

   Toutes les méthodes sont asynchrones et ne lèvent jamais d'exception de stockage :
   en cas d'échec d'écriture, on rétrograde le mode et on prévient l'interface.

   Ce module se charge des deux côtés, comme util.js, attente.js, roles.js,
   domiciliation.js et reseau.js : window.BC.store dans le navigateur,
   module.exports sous Node. Il l'est devenu tard, et pour une raison précise —
   « updateContact » perdait silencieusement le téléphone d'un destinataire et
   aucune suite de tests ne pouvait s'en apercevoir, faute de pouvoir charger ce
   fichier. Tout ce qui touche au navigateur (localStorage, EventSource,
   location) passe par « root », jamais par un global direct : sous Node, ces
   chemins ne sont simplement pas empruntés. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(
    root,
    enNode ? require('./util.js') : root.BC.util,
    enNode ? require('./attente.js') : root.BC.attente,
    enNode ? require('./domiciliation.js') : root.BC.domiciliation
  );
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.store = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, util, attente, domiciliation) {
  'use strict';

  const CONTACTS_KEY = 'courrier-contacts';
  const HISTORY_KEY = 'courrier-history';
  const SETTINGS_KEY = 'courrier-settings';
  // Choix de l'employé·e : 'partage' (serveur) ou 'local' (ce poste seulement).
  const REGISTRY_PREF_KEY = 'courrier-registre';

  const DEFAULT_SETTINGS = {
    subject: 'Un courrier vous attend',
    body:
      'Bonjour {nom},\n\n' +
      'Vous avez un courrier à récupérer à la réception.\n\n' +
      'Merci de passer le chercher dès que possible.',
    officeName: 'Bureau du Courrier',
    from: '',
    cc: '',
    bcc: '',
    // Gabarits propres à un type de courrier ; vide = tout suit le modèle général.
    templates: {},
    // Gabarits par langue ; vide = tout le monde reçoit le message français.
    langues: {},
    // Antennes ; vide = un seul bureau, la notion n'apparaît pas.
    antennes: [],
    // Joindre le français sous le message rédigé dans une autre langue.
    bilingue: false,
    // Avis de domiciliation ; vide = les textes fournis par l'application.
    avis: {}
  };

  const state = {
    mode: 'mémoire',
    smtp: false,
    // Vrai tant que le code de reprise est celui publié avec l'application.
    codeMaitreParDefaut: false,
    contacts: [],
    history: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    lastError: null,
    registryPreference: 'partage',
    /* Hors ligne : `enLigne` dit si le serveur répond, `file` retient les
       écritures qui n'ont pas pu partir, `dernierRejeu` le bilan du dernier
       retour de réseau. */
    enLigne: true,
    file: [],
    rejeuEnCours: false,
    dernierRejeu: null,
    suivi: { enAttente: 0, plusAncienJours: 0, recuperes: 0 },
    // Comptes : n'existent qu'en mode serveur. accountsExist bascule dès la
    // création du premier compte, et c'est lui qui rend la connexion obligatoire.
    auth: {
      user: null,
      accountsExist: false,
      signupOpen: true,
      googleOAuth: false,
      required: false,
      verifyEmail: false
    }
  };

  /** L'envoi automatique est possible si le serveur a un compte SMTP, ou si la
      personne connectée a relié sa propre boîte. */
  function canSendAutomatically() {
    return state.mode === 'serveur' && (state.smtp || !!(state.auth.user && state.auth.user.mailbox));
  }

  const listeners = [];

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn(state);
      } catch (e) {
        console.error('listener', e);
      }
    });
  }

  /* ---------- transport HTTP ---------- */

  /* ---------- hors ligne ----------

     Une écriture qui n'atteint pas le serveur n'est pas perdue : elle est
     appliquée au registre affiché, mise en file, et rejouée au retour du
     réseau. Les lectures, elles, échouent franchement — mieux vaut une erreur
     visible qu'un écran figé sur des données périmées sans le dire. */

  const FILE_KEY = 'courrier-file';

  function chargerFile() {
    state.file = localRead(FILE_KEY, []) || [];
  }

  function enregistrerFile() {
    localWrite(FILE_KEY, state.file);
  }

  /** Vrai pour une panne de réseau, faux pour un refus du serveur. */
  function estPanneReseau(err) {
    return err instanceof TypeError || err.name === 'AbortError';
  }

  function passerHorsLigne(raison) {
    if (!state.enLigne) return;
    state.enLigne = false;
    state.lastError = raison || 'serveur injoignable';
    surveillerRetour();
    emit();
  }

  function passerEnLigne() {
    if (state.enLigne) return;
    state.enLigne = true;
    emit();
  }

  /* Tant qu'on est hors ligne, on tâte le serveur régulièrement. L'événement
     « online » du navigateur ne suffit pas : il dit que la carte réseau est
     revenue, pas que le serveur du bureau répond. */
  let sonde = null;

  function surveillerRetour() {
    if (sonde) return;
    sonde = setInterval(async function () {
      const health = await detectServer();
      if (!health) return;
      clearInterval(sonde);
      sonde = null;
      passerEnLigne();
      await viderFile();
    }, 15000);
  }

  async function api(path, options) {
    const opts = options || {};
    const mutation = !!opts.method && opts.method !== 'GET';

    /* Une écriture connue de la file part directement en attente quand on sait
       déjà le serveur injoignable : inutile de refaire échouer un appel. */
    if (mutation && opts.horsLigne && !state.enLigne) {
      return mettreEnFile(path, opts);
    }

    let res;
    try {
      res = await fetch(
        '/api' + path,
        Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts)
      );
    } catch (reseau) {
      if (!estPanneReseau(reseau)) throw reseau;
      passerHorsLigne(reseau.message);
      if (mutation && opts.horsLigne) return mettreEnFile(path, opts);
      const err = new Error('Serveur injoignable — action impossible pour l’instant.');
      err.code = 'hors-ligne';
      throw err;
    }
    passerEnLigne();
    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }
    if (!res.ok) {
      const err = new Error((payload && payload.error) || 'Erreur serveur (' + res.status + ')');
      err.status = res.status;
      err.payload = payload;
      /* Session expirée en cours d'usage : on repasse l'interface derrière
         l'écran de connexion plutôt que d'enchaîner les erreurs.

         Seul le code 'session' déclenche ce repli. Un 401 sans ce code veut
         dire « la valeur saisie est fausse », pas « votre session est finie » :
         se tromper de mot de passe actuel ne doit pas déconnecter. */
      if (res.status === 401 && payload && payload.code === 'session' && state.auth.accountsExist) {
        /* N'avertir l'interface que si l'état change vraiment. Sinon chaque 401
           relance un rendu, chaque rendu relance des appels, et les appels
           relancent des 401 : l'application se mitraille elle-même. */
        const changement = state.auth.user !== null || state.auth.required !== true;
        state.auth.user = null;
        state.auth.required = true;
        if (changement) emit();
      }
      throw err;
    }
    return payload;
  }

  /* Met l'écriture de côté et rend tout de suite le résultat optimiste que
     l'appelant attend. L'appelant fournit ce résultat : lui seul sait à quoi
     ressemble une réponse réussie pour son opération. */
  function mettreEnFile(path, opts) {
    const descripteur = opts.horsLigne;
    const intention = attente.creerIntention({
      op: descripteur.op,
      method: opts.method,
      path: path,
      body: opts.body ? JSON.parse(opts.body) : null,
      idLocal: descripteur.idLocal || null,
      description: descripteur.description
    });
    state.file = attente.ajouter(state.file, intention);
    enregistrerFile();
    emit();
    return descripteur.optimiste === undefined ? { enAttente: true } : descripteur.optimiste;
  }

  /* Rejeu de la file, dans l'ordre. On s'arrête à la première panne réseau :
     l'ordre compte (créer le destinataire avant de lui signaler un courrier),
     et insister sur un réseau absent ne ferait que perdre du temps. */
  async function viderFile() {
    if (state.file.length === 0 || state.mode !== 'serveur') return { envoyees: 0, echecs: [] };
    if (state.rejeuEnCours) return { envoyees: 0, echecs: [] };
    state.rejeuEnCours = true;

    let envoyees = 0;
    const echecs = [];
    try {
      while (state.file.length > 0) {
        const intention = state.file[0];
        let res;
        try {
          res = await fetch('/api' + intention.path, {
            method: intention.method,
            /* L'identifiant de l'intention voyage avec elle. Il ne change pas
               d'un rejeu à l'autre : c'est ce qui permet au serveur de
               reconnaître une écriture qu'il a déjà exécutée et dont la
               réponse s'est perdue en route, plutôt que de la refaire — un
               courrier remis deux fois, une fiche créée en double. */
            headers: { 'Content-Type': 'application/json', 'X-Operation-Id': intention.id },
            credentials: 'same-origin',
            body: intention.body === null ? undefined : JSON.stringify(intention.body)
          });
        } catch (reseau) {
          passerHorsLigne(reseau.message);
          break; // le réseau est reparti : on reprendra plus tard, dans l'ordre
        }

        const payload = await res.json().catch(function () {
          return null;
        });

        if (res.ok) {
          envoyees++;
          reconcilier(intention, payload);
        } else if (attente.estDefinitif(res.status)) {
          /* Refus définitif : le courrier a pu être remis par un collègue, le
             destinataire supprimé. On retire l'action et on le dit — la faire
             disparaître en silence serait pire. */
          echecs.push({
            description: intention.description,
            raison: (payload && payload.error) || 'refusé par le serveur (' + res.status + ')'
          });
        } else {
          break; // 5xx : le serveur va mal, on réessaiera
        }
        state.file = attente.retirer(state.file, intention.id);
        enregistrerFile();
      }
    } finally {
      state.rejeuEnCours = false;
    }

    state.dernierRejeu = { envoyees: envoyees, echecs: echecs, at: new Date().toISOString() };
    if (envoyees > 0) await loadServerState();
    emit();
    return state.dernierRejeu;
  }

  /* Le serveur vient d'attribuer les vrais identifiants : on remplace l'objet
     provisoire dans le registre affiché et on répercute la substitution sur
     tout ce qui attend encore. */
  function reconcilier(intention, payload) {
    const reel = (payload && (payload.record || payload.contact)) || (payload && payload.id ? payload : null);
    if (!reel || !reel.id) return;
    const provisoire = intention.idLocal;
    if (!provisoire || provisoire === reel.id) return;

    const correspondances = {};
    correspondances[provisoire] = reel.id;
    state.file = attente.remapper(state.file, correspondances);

    /* Le serveur a reconnu une écriture déjà faite : il n'en renvoie que
       l'identifiant, pas la fiche. La substitution ci-dessus est ce qui
       comptait — le reste de la file y renvoie. Poser cet objet-là dans le
       registre affiché remplacerait une fiche par un accusé de réception ;
       l'état complet arrive de toute façon au retour de `viderFile`. */
    if (payload && payload.rejoue) return;

    const remplacer = function (liste) {
      const i = liste.findIndex(function (x) {
        return x.id === provisoire;
      });
      if (i !== -1) liste[i] = reel;
    };
    remplacer(state.contacts);
    remplacer(state.history);
  }

  /* ---------- comptes ---------- */

  /* ---------- le flux : les autres postes du bureau ----------

     Quatre postes autour d'un même registre. Sans ce flux, chacun ne voit que
     ses propres écritures : le guichet n'apprend l'arrivée d'un pli qu'en
     rechargeant la page, et deux agents peuvent remettre le même courrier.

     EventSource est natif au navigateur et se reconnecte tout seul — c'est ce
     qui permet de ne dépendre de rien. Le message reçu ne contient qu'un numéro
     d'ordre : on redemande l'état, qui arrive filtré selon les droits du poste. */
  let flux = null;
  let fluxAttente = null;
  /* Pour quel compte le flux a été ouvert. Sans cette mémoire, un flux ouvert
     avant la connexion — au tout premier démarrage, quand aucun compte
     n'existe encore — resterait en place ensuite, et le serveur continuerait à
     compter ce poste comme anonyme dans « Postes du bureau ». */
  let fluxPour;

  function couperFlux() {
    if (flux) {
      flux.close();
      flux = null;
    }
    fluxPour = undefined;
    if (fluxAttente) {
      clearTimeout(fluxAttente);
      fluxAttente = null;
    }
  }

  function brancherFlux() {
    const qui = (state.auth.user && state.auth.user.id) || null;
    // Le compte a changé depuis l'ouverture : on rouvre sous la bonne identité.
    if (flux && fluxPour !== qui) couperFlux();
    if (flux) return;
    if (state.mode !== 'serveur' || state.auth.required) return;
    if (typeof root.EventSource !== 'function') return; // navigateur ancien : on s'en passe
    if (root.location && root.location.protocol === 'file:') return;

    const source = new root.EventSource('/api/flux', { withCredentials: true });
    flux = source;
    fluxPour = qui;

    source.addEventListener('maj', function () {
      /* Groupé : une remise de courrier écrit deux fois de suite, et deux
         rechargements complets pour un même geste seraient du gaspillage sur
         quatre postes. */
      if (fluxAttente) return;
      fluxAttente = setTimeout(async function () {
        fluxAttente = null;
        if (state.mode !== 'serveur' || state.auth.required) return;
        try {
          await loadServerState();
          /* Un écran qui change tout seul est déroutant si rien ne dit
             pourquoi. On marque le coup : l'interface s'en sert pour signaler
             que la modification vient d'un autre poste, pas d'un geste
             qu'on aurait fait sans s'en rendre compte. */
          state.majDistanteA = Date.now();
          emit();
        } catch (e) {
          /* Session fermée ou serveur reparti : la sonde et les appels
             ordinaires s'en occupent, ce n'est pas au flux de trancher. */
        }
      }, 250);
    });

    source.addEventListener('error', function () {
      /* EventSource se reconnecte seul. On ne coupe que si la session a été
         fermée entre-temps — sinon on laisserait le poste isolé sans le dire. */
      if (state.auth.required) couperFlux();
    });
  }

  function applyAuth(payload) {
    state.auth.user = (payload && payload.user) || null;
    if (payload && payload.accountsExist !== undefined) state.auth.accountsExist = payload.accountsExist;
    if (payload && payload.signupOpen !== undefined) state.auth.signupOpen = payload.signupOpen;
    if (payload && payload.googleOAuth !== undefined) state.auth.googleOAuth = payload.googleOAuth;
    if (payload && payload.verifyEmail !== undefined) state.auth.verifyEmail = payload.verifyEmail;
    state.auth.required = state.auth.accountsExist && !state.auth.user;
    /* Se connecter branche le poste sur le flux, se déconnecter l'en retire.
       Laisser un flux ouvert après une déconnexion continuerait à rapatrier
       l'état d'un compte fermé. */
    if (state.auth.required) couperFlux();
    else brancherFlux();
    emit();
    return state.auth;
  }

  /* Deux issues possibles : le compte est créé (pas de vérification), ou un code
     part par courriel et il faut le confirmer. On renvoie l'issue à l'appelant. */
  async function signup(input) {
    const result = await api('/auth/signup', { method: 'POST', body: JSON.stringify(input) });
    if (result && result.pending) return { pending: true, email: result.email };
    state.auth.accountsExist = true;
    applyAuth(result);
    await loadServerState();
    return { pending: false, user: result.user };
  }

  async function verifySignup(email, code) {
    const result = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ email: email, code: code }) });
    state.auth.accountsExist = true;
    applyAuth(result);
    await loadServerState();
    return result.user;
  }

  async function resendCode(email) {
    return api('/auth/resend', { method: 'POST', body: JSON.stringify({ email: email }) });
  }

  async function login(input) {
    const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(input) });
    applyAuth(result);
    await loadServerState();
    return result.user;
  }

  /* Mot de passe oublié : la demande, puis la reprise avec le code reçu.
     La demande répond de la même façon que l'adresse ait un compte ou non —
     l'interface ne peut donc rien en déduire, et n'a rien à en dire. */
  async function forgotPassword(email) {
    return api('/auth/forgot', { method: 'POST', body: JSON.stringify({ email: email }) });
  }

  async function resetPassword(email, code, password) {
    const result = await api('/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ email: email, code: code, password: password })
    });
    applyAuth(result);
    await loadServerState();
    return result.user;
  }

  /* Entrée par identifiant : la porte des agents. */
  async function loginAgent(identifiant, code) {
    const result = await api('/auth/login-code', {
      method: 'POST',
      body: JSON.stringify({ identifiant: identifiant, code: code })
    });
    applyAuth(result);
    await loadServerState();
    return result.user;
  }

  /* Accès des agents — réservé au responsable. */
  async function listerAgents() {
    return api('/auth/agents');
  }

  async function creerAgent(nom, permissions, options) {
    return api('/auth/agents', {
      method: 'POST',
      body: JSON.stringify(
        Object.assign({ name: nom, permissions: permissions }, options || {})
      )
    });
  }

  async function majAgent(id, patch) {
    return api('/auth/agents/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify(patch)
    });
  }

  async function regenererCodeAgent(id) {
    return api('/auth/agents/' + encodeURIComponent(id) + '/code', { method: 'POST' });
  }

  async function supprimerAgent(id) {
    return api('/auth/agents/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  /** Code de reprise du compte responsable. */
  async function codeMaitre(code, action, champs) {
    return api('/auth/master', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ code: code, action: action || 'voir' }, champs || {}))
    });
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    state.contacts = [];
    state.history = [];
    applyAuth({ user: null });
  }

  async function connectSmtpMailbox(input) {
    return applyAuth(await api('/auth/mailbox/smtp', { method: 'PUT', body: JSON.stringify(input) }));
  }

  async function disconnectMailbox() {
    return applyAuth(await api('/auth/mailbox', { method: 'DELETE' }));
  }

  /* ---------- localStorage ---------- */

  function localAvailable() {
    try {
      const probe = '__bc_probe__';
      root.localStorage.setItem(probe, '1');
      root.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  function localRead(key, fallback) {
    try {
      const raw = root.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function localWrite(key, value) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      state.lastError = e.message;
      state.mode = 'mémoire';
      emit();
      return false;
    }
  }

  /** Écrit l'état courant dans le support actif. Sans effet en mode « serveur »
      (le serveur est déjà la source de vérité) ni en mode « mémoire ». */
  function persistLocal() {
    if (state.mode !== 'local') return;
    localWrite(CONTACTS_KEY, state.contacts);
    localWrite(HISTORY_KEY, state.history);
    localWrite(SETTINGS_KEY, state.settings);
  }

  /* ---------- démarrage ---------- */

  async function detectServer() {
    if (root.location.protocol === 'file:') return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(function () {
        controller.abort();
      }, 2500);
      const res = await fetch('/api/health', { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const health = await res.json();
      return health && health.app === 'bureau-du-courrier' ? health : null;
    } catch (e) {
      return null;
    }
  }

  async function loadServerState() {
    const data = await api('/state');
    state.contacts = data.contacts || [];
    state.history = data.history || [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    state.suivi = data.suivi || state.suivi;
    /* Le serveur ne le signale qu'au responsable : pour tous les autres, il
       vaut faux, et la carte d'alerte reste fermée. */
    state.codeMaitreParDefaut = !!data.codeMaitreParDefaut;
    emit();
    return state;
  }

  /* ---------- suivi des courriers ---------- */

  function remplacerEntree(record) {
    const i = state.history.findIndex(function (h) {
      return h.id === record.id;
    });
    if (i !== -1) state.history[i] = record;
    emit();
    return record;
  }

  /** Marque un courrier retiré (ou revient en arrière).
      `options.porteur` : nom de la personne venue à la place du destinataire. */
  async function setPickedUp(id, retire, signature, options) {
    const porteur = (options && options.porteur) || null;
    if (state.mode === 'serveur') {
      const courant = state.history.find(function (h) {
        return h.id === id;
      });
      const optimiste = Object.assign({}, courant, {
        pickedUpAt: retire ? new Date().toISOString() : null,
        remisA: retire ? porteur : null,
        signature: retire && signature ? signature : null
      });
      const result = await api('/history/' + encodeURIComponent(id) + '/pickup', {
        method: retire ? 'POST' : 'DELETE',
        body: retire ? JSON.stringify({ signature: signature || '', porteur: porteur || '' }) : undefined,
        horsLigne: {
          op: retire ? 'remise' : 'remise-annulee',
          description:
            (retire ? 'Courrier remis à ' : 'Remise annulée pour ') + ((courant && courant.name) || 'un destinataire'),
          optimiste: { record: optimiste }
        }
      });
      return remplacerEntree(result.record);
    }
    const entree = state.history.find(function (h) {
      return h.id === id;
    });
    if (!entree) return null;
    entree.pickedUpAt = retire ? new Date().toISOString() : null;
    entree.remisA = retire ? porteur : null;
    entree.signature = retire && signature ? signature : null;
    persistLocal();
    emit();
    return entree;
  }

  /** Consulte un courrier par son code, sans rien modifier. */
  async function lookupByCode(code) {
    if (state.mode === 'serveur') return api('/history/by-code/' + encodeURIComponent(code));

    const record = state.history.find(function (h) {
      return h.pickupCode === code && !h.pickedUpAt && !h.closedAt;
    });
    if (!record) {
      const err = new Error('Aucun courrier en attente avec ce code');
      err.status = 404;
      throw err;
    }
    const contact =
      state.contacts.find(function (c) {
        return c.id === record.contactId || util.normalize(c.email) === util.normalize(record.email);
      }) || null;
    const autres = state.history.filter(function (h) {
      return (
        h.id !== record.id &&
        !h.pickedUpAt &&
        !h.closedAt &&
        util.normalize(h.email) === util.normalize(record.email)
      );
    });
    return { record: record, contact: contact, autres: autres };
  }

  /** Remise au guichet par le code présenté par le destinataire.
      `options.porteur` : nom de la personne venue à sa place. */
  async function pickupByCode(code, signature, options) {
    const porteur = (options && options.porteur) || null;
    if (state.mode !== 'serveur') {
      const entree = state.history.find(function (h) {
        return h.pickupCode === code && !h.pickedUpAt && !h.closedAt;
      });
      if (!entree) throw new Error('Aucun courrier en attente avec ce code');
      entree.pickedUpAt = new Date().toISOString();
      entree.pickedUpByCode = true;
      entree.remisA = porteur;
      entree.signature = signature || null;
      persistLocal();
      emit();
      return entree;
    }
    const vise = state.history.find(function (h) {
      return h.pickupCode === code && !h.pickedUpAt && !h.closedAt;
    });
    const result = await api('/history/pickup-by-code', {
      method: 'POST',
      body: JSON.stringify({ code: code, signature: signature || '', porteur: porteur || '' }),
      horsLigne: {
        op: 'remise',
        description: 'Courrier remis à ' + ((vise && vise.name) || 'code ' + code),
        optimiste: {
          record: Object.assign({}, vise, {
            pickedUpAt: new Date().toISOString(),
            pickedUpByCode: true,
            remisA: porteur,
            signature: signature || null
          })
        }
      }
    });
    return remplacerEntree(result.record);
  }

  /** Classe un courrier sans retrait (ou le rouvre : raison à null). */
  async function closeMail(id, raison) {
    if (state.mode === 'serveur') {
      const result = await api('/history/' + encodeURIComponent(id) + '/close', {
        method: raison ? 'POST' : 'DELETE',
        body: raison ? JSON.stringify({ reason: raison }) : undefined
      });
      return remplacerEntree(result.record);
    }
    const entree = state.history.find(function (h) {
      return h.id === id;
    });
    if (!entree) return null;
    entree.closedAt = raison ? new Date().toISOString() : null;
    entree.closeReason = raison || null;
    persistLocal();
    emit();
    return entree;
  }

  /** Relance : seul le serveur sait renvoyer un courriel. */
  async function relancer(id) {
    if (state.mode !== 'serveur') throw new Error('La relance demande le registre partagé');
    const result = await api('/history/' + encodeURIComponent(id) + '/remind', { method: 'POST' });
    remplacerEntree(result.record);
    return result;
  }

  /* ---------- sauvegarde et comptes ---------- */

  /** Listes de travail de la domiciliation + rapport annuel. */
  async function loadDomiciliation(annee) {
    return api('/domiciliation' + (annee ? '?annee=' + encodeURIComponent(annee) : ''));
  }

  /** L'adresse de ce serveur sur le réseau, et les postes reliés en ce moment. */
  async function loadReseau() {
    return api('/reseau');
  }

  /** Renouveler l'attestation, ou clore la domiciliation avec son motif. */
  async function actionDomiciliation(id, action, options) {
    const opts = options || {};
    const result = await api('/contacts/' + encodeURIComponent(id) + '/domiciliation', {
      method: 'POST',
      body: JSON.stringify({ action: action, motif: opts.motif || '', note: opts.note || '' })
    });
    await loadServerState();
    emit();
    return result;
  }

  /** L'agent a appelé la personne qui n'a pas d'adresse électronique. */
  async function noterAppel(id, options) {
    const opts = options || {};
    const result = await api('/history/' + encodeURIComponent(id) + '/appel', {
      method: 'POST',
      body: JSON.stringify({ joint: opts.joint !== false, note: opts.note || '' })
    });
    await loadServerState();
    emit();
    return result;
  }

  /**
   * La personne s'est manifestée. Sur place par défaut ; « telephone » quand
   * c'est elle qui a appelé — la loi met les deux sur le même plan, et le
   * décompte des trois mois avant radiation aussi.
   * @param {string} id
   * @param {string} [note]
   * @param {{moyen?: 'place'|'telephone'}} [options]
   */
  async function enregistrerPassage(id, note, options) {
    const moyen = options && options.moyen === 'telephone' ? 'telephone' : 'place';
    const result = await api('/contacts/' + encodeURIComponent(id) + '/passage', {
      method: 'POST',
      body: JSON.stringify({ note: note || '', moyen: moyen }),
      horsLigne: {
        op: 'passage',
        description: moyen === 'telephone' ? 'Appel de la personne' : 'Passage enregistré',
        optimiste: { enAttente: true }
      }
    });
    if (result && result.contact) {
      const i = state.contacts.findIndex(function (c) {
        return c.id === result.contact.id;
      });
      if (i !== -1) state.contacts[i] = result.contact;
      emit();
    }
    return result;
  }

  /**
   * Prévenir quelqu'un au sujet de sa domiciliation — pas de son courrier.
   * Avec une adresse, le message part ; sans adresse, l'avis est noté et se
   * dira de vive voix. N'écrit rien au registre du courrier.
   * @param {string} id
   * @param {'renouvellement'|'absence'} sujet
   */
  async function envoyerAvis(id, sujet) {
    const result = await api('/contacts/' + encodeURIComponent(id) + '/avis', {
      method: 'POST',
      body: JSON.stringify({ sujet: sujet })
    });
    if (result && result.contact) {
      const i = state.contacts.findIndex(function (c) {
        return c.id === result.contact.id;
      });
      if (i !== -1) state.contacts[i] = result.contact;
      emit();
    }
    return result;
  }

  async function loadStats() {
    return api('/stats');
  }

  /* La signature du créateur et l'intégrité de l'application. En mode local il
     n'y a pas de serveur pour l'attester : on rend un état « non vérifiable »
     plutôt que d'échouer, et l'écran le dit simplement. */
  async function chargerSignature() {
    if (state.mode !== 'serveur') {
      return { etat: 'non-serveur', createur: 'AKRAM MERAKHA', application: 'Bureau du Courrier', verrouille: false };
    }
    return api('/signature');
  }

  /* Déblocage administrateur par le code maître, hors ligne. Rend `true` si
     l'application a été déverrouillée jusqu'au prochain redémarrage. */
  async function debloquerIntegrite(code) {
    const r = await api('/signature/debloquer', {
      method: 'POST',
      body: JSON.stringify({ code: String(code || '') })
    });
    return !!(r && r.deverrouille);
  }

  async function loadJournal(limite) {
    return api('/journal?limite=' + (limite || 100));
  }

  async function serverBackup() {
    return api('/backup', { method: 'POST' });
  }

  async function listerSauvegardes() {
    return api('/backup/list');
  }

  async function restaurerSauvegarde(fichier) {
    const resultat = await api('/backup/restore', {
      method: 'POST',
      body: JSON.stringify({ fichier: fichier })
    });
    await loadServerState();
    return resultat;
  }

  async function changePassword(current, next) {
    return api('/auth/password', { method: 'PUT', body: JSON.stringify({ current: current, next: next }) });
  }

  async function listUsers() {
    return api('/auth/users');
  }

  async function removeUser(id) {
    return api('/auth/users/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  /* Préférence de registre : elle vit dans le navigateur, pas sur le serveur —
     c'est un choix de poste, et il doit pouvoir se faire même hors ligne. */
  function registryPreference() {
    try {
      return root.localStorage.getItem(REGISTRY_PREF_KEY) || 'partage';
    } catch (e) {
      return 'partage';
    }
  }

  function setRegistryPreference(value) {
    try {
      root.localStorage.setItem(REGISTRY_PREF_KEY, value === 'local' ? 'local' : 'partage');
    } catch (e) {
      state.lastError = 'Préférence non conservée : ' + e.message;
    }
    state.registryPreference = registryPreference();
    emit();
    return state.registryPreference;
  }

  /* Après le choix du mode : reprendre la file laissée par la session
     précédente. Appelé sur tous les chemins de sortie d'init() — une écriture
     en attente ne doit pas dépendre de la façon dont l'application a démarré. */
  function reprendreFile() {
    if (root.addEventListener) {
      // Le retour du réseau est une bonne raison de réessayer sans attendre la sonde.
      root.addEventListener('online', function () {
        if (state.mode === 'serveur') viderFile();
      });
    }
    if (state.mode === 'serveur' && state.file.length > 0) viderFile();
  }

  async function init() {
    state.registryPreference = registryPreference();
    /* La file survit à la fermeture du navigateur : on la relit avant tout, y
       compris avant de savoir si le serveur répond. Une remise enregistrée hier
       soir pendant une coupure part ce matin. */
    chargerFile();
    // « Ce poste seulement » : on ne cherche même pas le serveur.
    const health = state.registryPreference === 'local' ? null : await detectServer();

    if (health) {
      state.mode = 'serveur';
      state.smtp = !!health.smtp;
      state.auth.accountsExist = !!health.accountsExist;
      state.auth.googleOAuth = !!health.googleOAuth;
      state.auth.verifyEmail = !!health.verifyEmail;
      try {
        applyAuth(await api('/auth/me'));
        if (!state.auth.required) await loadServerState();
        // Sans compte du tout, applyAuth ne branche rien : le registre est
        // ouvert, mais les postes doivent tout de même se suivre.
        brancherFlux();
        reprendreFile();
        emit();
        return state;
      } catch (e) {
        // Le serveur répond au health check mais pas au reste : on retombe en local.
        state.lastError = e.message;
        state.mode = 'mémoire';
      }
    }

    if (localAvailable()) {
      state.mode = 'local';
      state.contacts = localRead(CONTACTS_KEY, []);
      state.history = localRead(HISTORY_KEY, []);
      state.settings = Object.assign({}, DEFAULT_SETTINGS, localRead(SETTINGS_KEY, {}));
    } else {
      state.mode = 'mémoire';
    }

    // Migration depuis l'ancien prototype, qui stockait des chaînes JSON via window.storage.
    if (state.contacts.length === 0 && root.storage && typeof root.storage.get === 'function') {
      try {
        const legacy = await root.storage.get(CONTACTS_KEY);
        const parsed = legacy && legacy.value ? JSON.parse(legacy.value) : null;
        if (Array.isArray(parsed) && parsed.length) {
          state.contacts = parsed;
          persistLocal();
        }
      } catch (e) {
        /* rien à migrer */
      }
    }

    reprendreFile();
    emit();
    return state;
  }

  /* ---------- destinataires ---------- */

  async function addContact(input) {
    /* Hors ligne, l'identifiant est provisoire : le serveur donnera le vrai au
       rejeu, et `reconcilier` le substituera partout. */
    const contact = {
      id: state.enLigne ? util.uuid() : attente.nouvelIdLocal(util.uuid),
      name: input.name.trim(),
      // Le courriel est facultatif depuis qu'une fiche peut n'avoir qu'un
      // téléphone : ne pas supposer qu'il est là.
      email: (input.email || '').trim(),
      box: (input.box || '').trim(),
      langue: util.langue(input.langue).id,
      antenneId: input.antenneId || '',
      telephone: (input.telephone || '').trim(),
      naissance: input.naissance || '',
      notes: (input.notes || '').trim(),
      absentUntil: input.absentUntil || '',
      departed: !!input.departed,
      substituteId: input.substituteId || null,
      domicilie: !!input.domicilie,
      domicilieDepuis: input.domicilie ? input.domicilieDepuis || '' : '',
      domicilieJusqua: input.domicilie ? input.domicilieJusqua || '' : '',
      domiciliationCloseLe: input.domicilie ? input.domiciliationCloseLe || '' : '',
      domiciliationMotif: input.domicilie ? input.domiciliationMotif || '' : ''
    };
    // Hors ligne, l'échéance se calcule ici : le serveur ne la fournira qu'au rejeu.
    if (contact.domicilie && contact.domicilieDepuis && !contact.domicilieJusqua) {
      contact.domicilieJusqua = domiciliation.echeance(contact.domicilieDepuis);
    }
    if (state.mode === 'serveur') {
      const saved = await api('/contacts', {
        method: 'POST',
        body: JSON.stringify(contact),
        horsLigne: {
          op: 'contact-ajout',
          description: 'Destinataire ajouté : ' + contact.name,
          /* L'identifiant compte même sans préfixe « local- » : le serveur
             attribue le sien à la création, et le courrier signalé ensuite
             renvoie à celui-ci. Sans cette correspondance, le courrier
             rejoué pointerait vers un destinataire inexistant. */
          idLocal: contact.id,
          optimiste: contact
        }
      });
      state.contacts.push(saved);
    } else {
      state.contacts.push(contact);
      persistLocal();
    }
    emit();
    return state.contacts[state.contacts.length - 1];
  }

  async function addContacts(list) {
    const created = [];
    for (const input of list) {
      created.push(await addContact(input));
    }
    return created;
  }

  async function updateContact(id, patch) {
    const idx = state.contacts.findIndex(function (c) {
      return c.id === id;
    });
    if (idx === -1) return null;

    /* Ce que la modification ne mentionne pas est conservé : une correction de
       nom ne doit pas effacer une élection de domicile, ni un numéro de
       téléphone.

       Cette fusion remplace une énumération champ par champ. Elle listait ce
       qu'une fiche contient — donc il fallait penser à l'allonger chaque fois
       que le serveur apprenait un champ de plus. Le téléphone, la date de
       naissance et les observations y ont été oubliés : corriger un numéro le
       renvoyait inchangé, sans le moindre message. Le serveur reste l'autorité
       sur ce qu'une fiche contient (« cleanContact ») ; tenir ici une seconde
       liste de mémoire ne pouvait que dériver à nouveau. */
    const base = state.contacts[idx];
    const updated = Object.assign({}, base, patch);
    updated.name = String(updated.name || '').trim();
    updated.email = String(updated.email || '').trim();
    updated.box = String(updated.box || '').trim();
    updated.telephone = String(updated.telephone || '').trim();
    updated.langue = util.langue(updated.langue).id;
    updated.departed = !!updated.departed;
    updated.domicilie = !!updated.domicilie;
    updated.substituteId = updated.substituteId || null;
    if (state.mode === 'serveur') {
      state.contacts[idx] = await api('/contacts/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify(updated),
        horsLigne: {
          op: 'contact-maj',
          description: 'Destinataire modifié : ' + updated.name,
          optimiste: updated
        }
      });
    } else {
      state.contacts[idx] = updated;
      persistLocal();
    }
    emit();
    return state.contacts[idx];
  }

  /* Deux gestes distincts. Sortir du registre laisse le courrier à
     l'historique ; effacer ne laisse rien — ni fiche, ni courrier, ni nom au
     journal. Le second se demande explicitement : il ne doit jamais être le
     résultat d'un clic de trop. */
  async function removeContact(id, options) {
    const complet = !!(options && options.complet);
    const parti = state.contacts.find(function (c) {
      return c.id === id;
    });
    state.contacts = state.contacts.filter(function (c) {
      return c.id !== id;
    });

    if (complet && parti) {
      state.history = state.history.filter(function (h) {
        if (h.contactId && parti.id) return h.contactId !== parti.id;
        // Sans courriel, pas de rapprochement : sinon on emporterait le
        // courrier de tous les autres destinataires sans adresse.
        return !(parti.email && util.normalize(h.email) === util.normalize(parti.email));
      });
    }

    let bilan = null;
    if (state.mode === 'serveur') {
      bilan = await api(
        '/contacts/' + encodeURIComponent(id) + (complet ? '?effacer=complet' : ''),
        { method: 'DELETE' }
      );
    } else {
      persistLocal();
    }
    emit();
    return bilan;
  }

  /* Sans courriel, il n'y a pas de doublon — même règle que « findDuplicate »
     côté serveur. « '' === '' » aurait désigné la première fiche sans adresse
     venue : à l'import, deux personnes sans courriel étaient prises l'une pour
     l'autre, et la seconde refusée comme déjà présente. */
  function findByEmail(email) {
    const cherche = util.normalize(email);
    if (!cherche) return null;
    return (
      state.contacts.find(function (c) {
        return util.normalize(c.email) === cherche;
      }) || null
    );
  }

  /* ---------- historique ---------- */

  async function addHistory(entry) {
    const record = Object.assign(
      { id: util.uuid(), date: new Date().toISOString(), pickedUpAt: null, reminderCount: 0 },
      entry
    );
    state.history.unshift(record);
    if (state.mode === 'serveur') {
      try {
        await api('/history', { method: 'POST', body: JSON.stringify(record) });
      } catch (e) {
        state.lastError = e.message;
      }
    } else {
      persistLocal();
    }
    emit();
    return record;
  }

  async function clearHistory() {
    state.history = [];
    if (state.mode === 'serveur') {
      await api('/history', { method: 'DELETE' });
    } else {
      persistLocal();
    }
    emit();
  }

  /* ---------- réglages ---------- */

  async function saveSettings(patch) {
    state.settings = Object.assign({}, state.settings, patch);
    if (state.mode === 'serveur') {
      state.settings = await api('/settings', { method: 'PUT', body: JSON.stringify(state.settings) });
    } else {
      persistLocal();
    }
    emit();
    return state.settings;
  }

  /* ---------- envoi ---------- */

  /**
   * Envoi automatique par le serveur (SMTP). Renvoie { sent:true } en cas de succès.
   * Lève une erreur si le mode serveur n'est pas actif ou si SMTP n'est pas configuré :
   * l'appelant retombe alors sur le lien mailto.
   */
  async function sendViaServer(contact, message) {
    /* Sans adresse électronique, il n'y a rien à envoyer : le serveur inscrit
       le courrier et le marque « à prévenir ». Ce chemin ne dépend donc
       d'aucun réglage SMTP — exiger un serveur de courriel pour enregistrer un
       courrier qu'on annoncera au téléphone n'aurait aucun sens. */
    const sansCourriel = state.mode === 'serveur' && !(contact.email || '').trim();
    if (!sansCourriel && !canSendAutomatically()) {
      throw new Error('Envoi automatique indisponible');
    }
    /* Hors ligne, le courriel ne peut pas partir : il partira au rejeu. Le
       courrier, lui, est inscrit tout de suite — c'est ce qui compte au
       guichet. Le code de retrait n'existera qu'au retour du réseau : le
       registre le dit plutôt que d'en inventer un. */
    const optimiste = {
      sent: false,
      enAttente: true,
      record: {
        id: attente.nouvelIdLocal(util.uuid),
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        subject: message.subject,
        type: message.type || 'lettre',
        urgent: !!message.urgent,
        cc: message.cc || '',
        bcc: message.bcc || '',
        date: new Date().toISOString(),
        method: 'auto',
        status: 'à envoyer',
        pickupCode: null,
        pickedUpAt: null,
        reminderCount: 0
      }
    };
    const result = await api('/notify', {
      method: 'POST',
      body: JSON.stringify({
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        subject: message.subject,
        body: message.body,
        type: message.type || 'lettre',
        urgent: !!message.urgent,
        from: message.from || '',
        cc: message.cc || '',
        bcc: message.bcc || ''
      }),
      horsLigne: {
        op: 'notification',
        description: 'Courrier signalé à ' + contact.name,
        idLocal: optimiste.record.id,
        optimiste: optimiste
      }
    });
    // Le serveur consigne lui-même l'envoi : on reprend son entrée telle quelle
    // plutôt que d'en créer une seconde côté client.
    if (result && result.record) {
      state.history.unshift(result.record);
      emit();
    }
    return result;
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    state: state,
    onChange: function (fn) {
      listeners.push(fn);
    },
    init: init,
    canSendAutomatically: canSendAutomatically,
    registryPreference: registryPreference,
    setRegistryPreference: setRegistryPreference,
    signup: signup,
    verifySignup: verifySignup,
    resendCode: resendCode,
    login: login,
    loginAgent: loginAgent,
    listerAgents: listerAgents,
    creerAgent: creerAgent,
    majAgent: majAgent,
    regenererCodeAgent: regenererCodeAgent,
    supprimerAgent: supprimerAgent,
    codeMaitre: codeMaitre,
    forgotPassword: forgotPassword,
    resetPassword: resetPassword,
    logout: logout,
    connectSmtpMailbox: connectSmtpMailbox,
    disconnectMailbox: disconnectMailbox,
    setPickedUp: setPickedUp,
    pickupByCode: pickupByCode,
    lookupByCode: lookupByCode,
    closeMail: closeMail,
    relancer: relancer,
    serverBackup: serverBackup,
    listerSauvegardes: listerSauvegardes,
    restaurerSauvegarde: restaurerSauvegarde,
    loadStats: loadStats,
    chargerSignature: chargerSignature,
    debloquerIntegrite: debloquerIntegrite,
    loadDomiciliation: loadDomiciliation,
    loadReseau: loadReseau,
    noterAppel: noterAppel,
    actionDomiciliation: actionDomiciliation,
    enregistrerPassage: enregistrerPassage,
    envoyerAvis: envoyerAvis,
    loadJournal: loadJournal,
    changePassword: changePassword,
    listUsers: listUsers,
    removeUser: removeUser,
    addContact: addContact,
    addContacts: addContacts,
    updateContact: updateContact,
    removeContact: removeContact,
    findByEmail: findByEmail,
    addHistory: addHistory,
    clearHistory: clearHistory,
    saveSettings: saveSettings,
    sendViaServer: sendViaServer,
    viderFile: viderFile,
    resumeFile: function () {
      return attente.resume(state.file);
    }
  };
});
