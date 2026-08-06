/* Bureau du Courrier — utilitaires partagés (navigateur + Node).
   Chargé comme script classique dans le navigateur (window.BC.util)
   et comme module CommonJS côté serveur / tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.util = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Minuscule, sans accents, sans espaces superflus — base de toutes les recherches. */
  function normalize(s) {
    return (s || '')
      .toString()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s) {
    return (s === null || s === undefined ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return HTML_ESCAPES[c];
    });
  }

  /* Volontairement permissif : on refuse ce qui ne peut pas être une adresse,
     on ne cherche pas à réimplémenter la RFC 5322. */
  const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

  function isValidEmail(email) {
    return EMAIL_RE.test((email || '').trim());
  }

  /**
   * Extrait l'adresse d'une entrée de la forme « Nom <adresse@ex.com> »
   * ou « adresse@ex.com ». Renvoie '' si rien d'exploitable.
   */
  function extractEmail(entry) {
    const s = (entry || '').toString().trim();
    const angled = s.match(/<([^>]+)>\s*$/);
    return (angled ? angled[1] : s).trim();
  }

  /** Une entrée d'expéditeur valide : une adresse, éventuellement précédée d'un nom. */
  function isValidAddress(entry) {
    return isValidEmail(extractEmail(entry));
  }

  /**
   * Découpe une liste d'adresses séparées par des virgules, des points-virgules
   * ou des sauts de ligne. Renvoie { entries, errors } — jamais d'exception.
   * Les doublons (même adresse) sont retirés, en gardant la première graphie.
   */
  function parseAddressList(text) {
    const entries = [];
    const errors = [];
    const seen = new Set();

    (text || '')
      .split(/[,;\n]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean)
      .forEach(function (entry) {
        if (!isValidAddress(entry)) {
          errors.push(entry);
          return;
        }
        const key = normalize(extractEmail(entry));
        if (seen.has(key)) return;
        seen.add(key);
        entries.push(entry);
      });

    return { entries: entries, errors: errors };
  }

  /** Remet une liste d'adresses sous forme de chaîne « a@ex.com, b@ex.com ». */
  function formatAddressList(entries) {
    return (entries || []).join(', ');
  }

  /* Serveurs d'envoi des messageries courantes, pour pré-remplir le formulaire
     d'association. Une adresse professionnelle sort de cette liste : le champ
     reste alors vide et se renseigne à la main. */
  const SMTP_HOSTS = {
    'gmail.com': 'smtp.gmail.com',
    'googlemail.com': 'smtp.gmail.com',
    'outlook.com': 'smtp-mail.outlook.com',
    'outlook.fr': 'smtp-mail.outlook.com',
    'hotmail.com': 'smtp-mail.outlook.com',
    'hotmail.fr': 'smtp-mail.outlook.com',
    'live.fr': 'smtp-mail.outlook.com',
    'msn.com': 'smtp-mail.outlook.com',
    'yahoo.com': 'smtp.mail.yahoo.com',
    'yahoo.fr': 'smtp.mail.yahoo.com',
    'orange.fr': 'smtp.orange.fr',
    'wanadoo.fr': 'smtp.orange.fr',
    'free.fr': 'smtp.free.fr',
    'sfr.fr': 'smtp.sfr.fr',
    'laposte.net': 'smtp.laposte.net',
    'icloud.com': 'smtp.mail.me.com',
    'me.com': 'smtp.mail.me.com'
  };

  /** Serveur d'envoi probable pour une adresse, ou '' si le domaine est inconnu. */
  function suggestSmtpHost(email) {
    const address = extractEmail(email);
    const at = address.lastIndexOf('@');
    if (at === -1) return '';
    return SMTP_HOSTS[normalize(address.slice(at + 1))] || '';
  }

  /** Vrai pour une adresse Google, seul cas où l'autorisation Gmail s'applique. */
  function isGoogleAddress(email) {
    const domain = normalize(extractEmail(email).split('@')[1] || '');
    return domain === 'gmail.com' || domain === 'googlemail.com';
  }

  /** Identifiant stable, avec repli quand crypto.randomUUID n'existe pas. */
  function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** Remplace {nom}, {courriel} et {date} dans un gabarit de message. */
  function renderTemplate(tpl, vars) {
    return (tpl || '').replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(vars || {}, key) ? String(vars[key]) : match;
    });
  }

  /** Deux destinataires sont « les mêmes » si le courriel coïncide (insensible à la casse). */
  function sameContact(a, b) {
    return normalize(a && a.email) === normalize(b && b.email);
  }

  /** Recherche par nom ou courriel : tous les mots de la requête doivent être présents. */
  function matchesQuery(contact, query) {
    const terms = normalize(query).split(' ').filter(Boolean);
    if (terms.length === 0) return false;
    const haystack = normalize(contact.name) + ' ' + normalize(contact.email);
    return terms.every(function (t) {
      return haystack.includes(t);
    });
  }

  function sortByName(list) {
    return list.slice().sort(function (a, b) {
      return (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
    });
  }

  /* ---------- CSV ---------- */

  function csvEscape(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows, columns) {
    const head = columns.map(csvEscape).join(',');
    const body = rows.map(function (row) {
      return columns
        .map(function (col) {
          return csvEscape(row[col]);
        })
        .join(',');
    });
    return [head].concat(body).join('\r\n');
  }

  /** Analyseur CSV minimal mais correct : guillemets, doublement, retours de ligne inclus. */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = (text || '').replace(/^\uFEFF/, '');

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        quoted = true;
      } else if (ch === ',' || ch === ';') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter(function (r) {
      return r.some(function (c) {
        return c.trim() !== '';
      });
    });
  }

  /**
   * Lit un CSV de destinataires. Accepte un en-tête (nom/name, courriel/email…)
   * ou, à défaut, deux colonnes dans l'ordre nom puis courriel.
   * Renvoie { contacts, errors } — jamais d'exception.
   */
  function parseContactsCsv(text) {
    const rows = parseCsv(text);
    const contacts = [];
    const errors = [];
    if (rows.length === 0) return { contacts: contacts, errors: ['Fichier vide.'] };

    const header = rows[0].map(function (c) {
      return normalize(c);
    });
    const nameIdx = header.findIndex(function (h) {
      return ['nom', 'name', 'nom complet', 'destinataire'].includes(h);
    });
    const emailIdx = header.findIndex(function (h) {
      return ['courriel', 'email', 'e-mail', 'mail', 'adresse'].includes(h);
    });
    const hasHeader = nameIdx !== -1 && emailIdx !== -1;
    const ni = hasHeader ? nameIdx : 0;
    const ei = hasHeader ? emailIdx : 1;

    rows.slice(hasHeader ? 1 : 0).forEach(function (cells, i) {
      const line = i + (hasHeader ? 2 : 1);
      const name = (cells[ni] || '').trim();
      const email = (cells[ei] || '').trim();
      if (!name && !email) return;
      if (!name) {
        errors.push('Ligne ' + line + ' : nom manquant.');
        return;
      }
      if (!isValidEmail(email)) {
        errors.push('Ligne ' + line + ' : courriel invalide (« ' + email + ' »).');
        return;
      }
      contacts.push({ name: name, email: email });
    });

    return { contacts: contacts, errors: errors };
  }

  /* ---------- Dates ---------- */

  function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('fr-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function isSameDay(iso, dateStr) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return false;
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) === dateStr;
  }

  return {
    normalize: normalize,
    escapeHtml: escapeHtml,
    isValidEmail: isValidEmail,
    extractEmail: extractEmail,
    isValidAddress: isValidAddress,
    parseAddressList: parseAddressList,
    formatAddressList: formatAddressList,
    suggestSmtpHost: suggestSmtpHost,
    isGoogleAddress: isGoogleAddress,
    uuid: uuid,
    renderTemplate: renderTemplate,
    sameContact: sameContact,
    matchesQuery: matchesQuery,
    sortByName: sortByName,
    toCsv: toCsv,
    parseCsv: parseCsv,
    parseContactsCsv: parseContactsCsv,
    formatDateTime: formatDateTime,
    isSameDay: isSameDay
  };
});
