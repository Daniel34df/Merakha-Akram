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

  const DEFAULT_SETTINGS = {
    subject: 'Un courrier vous attend',
    body:
      'Bonjour {nom},\n\n' +
      'Vous avez un courrier à récupérer à la réception.\n\n' +
      'Merci de passer le chercher dès que possible.',
    officeName: 'Bureau du Courrier'
  };

  const state = {
    mode: 'mémoire',
    smtp: false,
    contacts: [],
    history: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    lastError: null
  };

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
    const res = await fetch('/api' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
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
      throw err;
    }
    return payload;
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

  async function init() {
    const health = await detectServer();

    if (health) {
      state.mode = 'serveur';
      state.smtp = !!health.smtp;
      try {
        const data = await api('/state');
        state.contacts = data.contacts || [];
        state.history = data.history || [];
        state.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
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
    const contact = { id: util.uuid(), name: input.name.trim(), email: input.email.trim() };
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
      email: patch.email.trim()
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
    const record = Object.assign({ id: util.uuid(), date: new Date().toISOString() }, entry);
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
    if (state.mode !== 'serveur' || !state.smtp) {
      throw new Error('Envoi automatique indisponible');
    }
    const result = await api('/notify', {
      method: 'POST',
      body: JSON.stringify({
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        subject: message.subject,
        body: message.body
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
