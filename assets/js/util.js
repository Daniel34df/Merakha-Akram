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
