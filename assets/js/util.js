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

  /* Types de courrier. Le délai propre à chaque type l'emporte sur le délai
     général : un recommandé ou un colis n'attend pas aussi longtemps qu'une
     lettre ordinaire — l'un a une valeur juridique, l'autre encombre le local. */
  const TYPES_COURRIER = [
    { id: 'lettre', label: 'Lettre', article: 'Un courrier', relanceJours: null },
    { id: 'recommande', label: 'Recommandé', article: 'Un courrier recommandé', relanceJours: 7 },
    { id: 'colis', label: 'Colis', article: 'Un colis', relanceJours: 5 },
    { id: 'administratif', label: 'Administratif', article: 'Un courrier administratif', relanceJours: 10 }
  ];

  function typeCourrier(id) {
    return (
      TYPES_COURRIER.find(function (t) {
        return t.id === id;
      }) || TYPES_COURRIER[0]
    );
  }

  /** Distance d'édition, pour proposer un nom quand l'orthographe diffère. */
  function distance(a, b) {
    const s1 = normalize(a);
    const s2 = normalize(b);
    if (s1 === s2) return 0;
    if (!s1.length || !s2.length) return Math.max(s1.length, s2.length);

    let precedente = [];
    for (let j = 0; j <= s2.length; j++) precedente[j] = j;
    for (let i = 1; i <= s1.length; i++) {
      const courante = [i];
      for (let j = 1; j <= s2.length; j++) {
        const cout = s1[i - 1] === s2[j - 1] ? 0 : 1;
        courante[j] = Math.min(courante[j - 1] + 1, precedente[j] + 1, precedente[j - 1] + cout);
      }
      precedente = courante;
    }
    return precedente[s2.length];
  }

  /**
   * Destinataires dont le nom ressemble à la recherche, du plus proche au moins
   * proche. Sert quand la recherche exacte ne donne rien : les noms sur les
   * enveloppes sont souvent approximatifs.
   */
  function suggestionsProches(contacts, query, limite) {
    const q = normalize(query);
    if (q.length < 3) return [];
    // Tolérance proportionnelle à la longueur : deux fautes sur « Tremblay »,
    // une seule sur « Roy », sans quoi tout ressemblerait à tout.
    const tolerance = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;

    return (contacts || [])
      .map(function (c) {
        // On compare aussi mot à mot : « Tremblet » doit trouver « Élodie Tremblay ».
        const mots = normalize(c.name).split(' ');
        const d = Math.min.apply(
          null,
          [distance(c.name, query)].concat(
            mots.map(function (mot) {
              return distance(mot, query);
            })
          )
        );
        return { contact: c, distance: d };
      })
      .filter(function (r) {
        return r.distance > 0 && r.distance <= tolerance;
      })
      .sort(function (a, b) {
        return a.distance - b.distance;
      })
      .slice(0, limite || 3)
      .map(function (r) {
        return r.contact;
      });
  }

  /**
   * État de présence d'un destinataire.
   *   absentUntil — date 'AAAA-MM-JJ' incluse, ou vide
   *   departed    — a quitté l'organisme, définitivement
   *   substituteId— qui reçoit le courrier à sa place
   *
   * Notifier quelqu'un qui ne viendra pas est une perte sèche : le guichet doit
   * pouvoir le dire avant d'envoyer.
   */
  function presence(contact, now) {
    const c = contact || {};
    const maintenant = now ? new Date(now) : new Date();
    const jour = maintenant.toISOString().slice(0, 10);

    if (c.departed) {
      return { etat: 'parti', message: 'a quitté l’organisme', substituteId: c.substituteId || null };
    }
    if (c.absentUntil && c.absentUntil >= jour) {
      return {
        etat: 'absent',
        message: 'absent·e jusqu’au ' + formatJour(c.absentUntil),
        jusqua: c.absentUntil,
        substituteId: c.substituteId || null
      };
    }
    return { etat: 'present', message: '', substituteId: null };
  }

  /** '2026-08-15' → '15 août 2026'. */
  function formatJour(iso) {
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
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

  /* Gabarit à employer pour un type de courrier donné.

     Un recommandé n'appelle pas la même phrase qu'un prospectus : chaque type
     peut avoir son propre message. Un type sans gabarit propre — le cas normal
     — retombe sur le modèle général, si bien qu'un registre créé avant cette
     option continue de fonctionner sans rien changer.

     Un gabarit partiel (sujet sans corps) est ignoré plutôt qu'appliqué à
     moitié : mieux vaut le message général qu'un courriel sans texte. */
  function gabaritPour(settings, typeId) {
    const general = { subject: (settings && settings.subject) || '', body: (settings && settings.body) || '' };
    const propre = settings && settings.templates && settings.templates[typeId];
    if (!propre) return general;
    const subject = String(propre.subject || '').trim();
    const body = String(propre.body || '').trim();
    if (!subject || !body) return general;
    return { subject: subject, body: body, propre: true };
  }

  /** Ne garde que les gabarits complets, sur des types connus. */
  function nettoyerGabarits(templates) {
    const out = {};
    if (!templates || typeof templates !== 'object') return out;
    TYPES_COURRIER.forEach(function (t) {
      const entree = templates[t.id];
      if (!entree) return;
      const subject = String(entree.subject || '').trim();
      const body = String(entree.body || '').trim();
      if (subject && body) out[t.id] = { subject: subject, body: body };
    });
    return out;
  }

  /** Deux destinataires sont « les mêmes » si le courriel coïncide (insensible à la casse). */
  function sameContact(a, b) {
    return normalize(a && a.email) === normalize(b && b.email);
  }

  /** Numéro de boîte comparable : « b-012 », « B 12 » et « B12 » se rejoignent. */
  function normalizeBox(box) {
    return normalize(box).replace(/[\s._-]/g, '');
  }

  /**
   * Vrai si le destinataire correspond à la recherche.
   * mode : 'nom' (nom et courriel), 'boite' (numéro de boîte), 'tout' (les deux).
   * Tous les mots de la requête doivent être présents.
   */
  function matchesQuery(contact, query, mode) {
    const terms = normalize(query).split(' ').filter(Boolean);
    if (terms.length === 0) return false;

    if (mode === 'boite') {
      // Un numéro se cherche d'un bloc : « b12 » ne doit pas répondre à « b1 »
      // par accident sur un autre champ, mais un début de numéro reste utile.
      const cible = normalizeBox(contact.box);
      if (!cible) return false;
      return normalizeBox(query) !== '' && cible.includes(normalizeBox(query));
    }

    let haystack = normalize(contact.name) + ' ' + normalize(contact.email);
    if (mode !== 'nom') haystack += ' ' + normalize(contact.box);
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

  function csvEscape(value, separator) {
    const s = value === null || value === undefined ? '' : String(value);
    const sep = separator || ';';
    return s.indexOf(sep) !== -1 || /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* Excel choisit son séparateur d'après la langue du système : virgule en
     anglais, point-virgule en français. Un fichier séparé par des virgules
     s'ouvre donc en une seule colonne sur un Windows français. On écrit avec des
     points-virgules et on l'annonce par une ligne « sep= », qu'Excel comprend et
     que les autres outils ignorent ou lisent correctement. */
  function toCsv(rows, columns, options) {
    const opts = options || {};
    const sep = opts.separator || ';';
    const ligne = function (valeurs) {
      return valeurs
        .map(function (v) {
          return csvEscape(v, sep);
        })
        .join(sep);
    };
    const lignes = [ligne(columns)];
    rows.forEach(function (row) {
      lignes.push(
        ligne(
          columns.map(function (col) {
            return row[col];
          })
        )
      );
    });
    const entete = opts.declareSeparator === false ? '' : 'sep=' + sep + '\r\n';
    return entete + lignes.join('\r\n');
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
    // « sep=; » est une indication pour Excel, pas une ligne de données.
    const rows = parseCsv(String(text || '').replace(/^\uFEFF?sep=.\r?\n/i, ''));
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
    const boxIdx = header.findIndex(function (h) {
      return ['boite', 'boîte', 'numero de boite', 'numero', 'no boite', 'n boite', 'casier', 'box'].includes(h);
    });
    const hasHeader = nameIdx !== -1 && emailIdx !== -1;
    const ni = hasHeader ? nameIdx : 0;
    const ei = hasHeader ? emailIdx : 1;
    // Sans en-tête, une troisième colonne est lue comme le numéro de boîte.
    const bi = hasHeader ? boxIdx : 2;

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
      const box = bi !== -1 ? (cells[bi] || '').trim() : '';
      contacts.push({ name: name, email: email, box: box });
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
    gabaritPour: gabaritPour,
    nettoyerGabarits: nettoyerGabarits,
    sameContact: sameContact,
    matchesQuery: matchesQuery,
    normalizeBox: normalizeBox,
    TYPES_COURRIER: TYPES_COURRIER,
    typeCourrier: typeCourrier,
    distance: distance,
    suggestionsProches: suggestionsProches,
    presence: presence,
    formatJour: formatJour,
    sortByName: sortByName,
    toCsv: toCsv,
    parseCsv: parseCsv,
    parseContactsCsv: parseContactsCsv,
    formatDateTime: formatDateTime,
    isSameDay: isSameDay
  };
});
