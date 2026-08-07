/* Bureau du Courrier — couche de persistance.

   Trois modes, choisis automatiquement au démarrage, du plus durable au moins durable :
     1. « serveur »  : un backend Bureau du Courrier répond sur /api  → registre partagé
                       entre les postes, envoi de courriel automatique possible.
     2. « local »    : localStorage du navigateur → registre conservé sur ce poste.
     3. « mémoire »  : rien ne persiste (page ouverte dans un contexte verrouillé).

   Toutes les méthodes sont asynchrones et ne lèvent jamais d'exception de stockage :
   en cas d'échec d'écriture, on rétrograde le mode et on prévient l'interface. */
(function (root) {
  'use strict';

  const util = root.BC.util;

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
    bcc: ''
  };

  const state = {
    mode: 'mémoire',
    smtp: false,
    contacts: [],
    history: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    lastError: null,
    registryPreference: 'partage',
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

  async function api(path, options) {
    const res = await fetch(
      '/api' + path,
      Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, options)
    );
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
      // Session expirée en cours d'usage : on repasse l'interface derrière
      // l'écran de connexion plutôt que d'enchaîner les erreurs.
      if (res.status === 401 && state.auth.accountsExist) {
        state.auth.user = null;
        state.auth.required = true;
        emit();
      }
      throw err;
    }
    return payload;
  }

  /* ---------- comptes ---------- */

  function applyAuth(payload) {
    state.auth.user = (payload && payload.user) || null;
    if (payload && payload.accountsExist !== undefined) state.auth.accountsExist = payload.accountsExist;
    if (payload && payload.signupOpen !== undefined) state.auth.signupOpen = payload.signupOpen;
    if (payload && payload.googleOAuth !== undefined) state.auth.googleOAuth = payload.googleOAuth;
    if (payload && payload.verifyEmail !== undefined) state.auth.verifyEmail = payload.verifyEmail;
    state.auth.required = state.auth.accountsExist && !state.auth.user;
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

  /** Marque un courrier retiré (ou revient en arrière). */
  async function setPickedUp(id, retire, signature) {
    if (state.mode === 'serveur') {
      const result = await api('/history/' + encodeURIComponent(id) + '/pickup', {
        method: retire ? 'POST' : 'DELETE',
        body: retire && signature ? JSON.stringify({ signature: signature }) : undefined
      });
      return remplacerEntree(result.record);
    }
    const entree = state.history.find(function (h) {
      return h.id === id;
    });
    if (!entree) return null;
    entree.pickedUpAt = retire ? new Date().toISOString() : null;
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

  /** Remise au guichet par le code présenté par le destinataire. */
  async function pickupByCode(code, signature) {
    if (state.mode !== 'serveur') {
      const entree = state.history.find(function (h) {
        return h.pickupCode === code && !h.pickedUpAt && !h.closedAt;
      });
      if (!entree) throw new Error('Aucun courrier en attente avec ce code');
      entree.pickedUpAt = new Date().toISOString();
      entree.pickedUpByCode = true;
      entree.signature = signature || null;
      persistLocal();
      emit();
      return entree;
    }
    const result = await api('/history/pickup-by-code', {
      method: 'POST',
      body: JSON.stringify({ code: code, signature: signature || '' })
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

  async function loadStats() {
    return api('/stats');
  }

  async function loadJournal(limite) {
    return api('/journal?limite=' + (limite || 100));
  }

  async function serverBackup() {
    return api('/backup', { method: 'POST' });
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

  async function init() {
    state.registryPreference = registryPreference();
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

    emit();
    return state;
  }

  /* ---------- destinataires ---------- */

  async function addContact(input) {
    const contact = {
      id: util.uuid(),
      name: input.name.trim(),
      email: input.email.trim(),
      box: (input.box || '').trim(),
      absentUntil: input.absentUntil || '',
      departed: !!input.departed,
      substituteId: input.substituteId || null
    };
    if (state.mode === 'serveur') {
      const saved = await api('/contacts', { method: 'POST', body: JSON.stringify(contact) });
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
    const updated = Object.assign({}, state.contacts[idx], {
      name: patch.name.trim(),
      email: patch.email.trim(),
      box: (patch.box || '').trim(),
      absentUntil: patch.absentUntil !== undefined ? patch.absentUntil : state.contacts[idx].absentUntil || '',
      departed: patch.departed !== undefined ? !!patch.departed : !!state.contacts[idx].departed,
      substituteId: patch.substituteId !== undefined ? patch.substituteId : state.contacts[idx].substituteId || null
    });
    if (state.mode === 'serveur') {
      state.contacts[idx] = await api('/contacts/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify(updated)
      });
    } else {
      state.contacts[idx] = updated;
      persistLocal();
    }
    emit();
    return state.contacts[idx];
  }

  async function removeContact(id) {
    state.contacts = state.contacts.filter(function (c) {
      return c.id !== id;
    });
    if (state.mode === 'serveur') {
      await api('/contacts/' + encodeURIComponent(id), { method: 'DELETE' });
    } else {
      persistLocal();
    }
    emit();
  }

  function findByEmail(email) {
    return state.contacts.find(function (c) {
      return util.normalize(c.email) === util.normalize(email);
    }) || null;
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
    if (!canSendAutomatically()) {
      throw new Error('Envoi automatique indisponible');
    }
    const result = await api('/notify', {
      method: 'POST',
      body: JSON.stringify({
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        subject: message.subject,
        body: message.body,
        type: message.type || 'lettre',
        from: message.from || '',
        cc: message.cc || '',
        bcc: message.bcc || ''
      })
    });
    // Le serveur consigne lui-même l'envoi : on reprend son entrée telle quelle
    // plutôt que d'en créer une seconde côté client.
    if (result && result.record) {
      state.history.unshift(result.record);
      emit();
    }
    return result;
  }

  root.BC.store = {
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
    logout: logout,
    connectSmtpMailbox: connectSmtpMailbox,
    disconnectMailbox: disconnectMailbox,
    setPickedUp: setPickedUp,
    pickupByCode: pickupByCode,
    lookupByCode: lookupByCode,
    closeMail: closeMail,
    relancer: relancer,
    serverBackup: serverBackup,
    loadStats: loadStats,
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
    sendViaServer: sendViaServer
  };
})(window);
