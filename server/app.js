/* Bureau du Courrier — serveur HTTP (aucune dépendance obligatoire).
   Sert l'interface statique et l'API JSON sous /api. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const util = require('../assets/js/util.js');
const { DEFAULT_SETTINGS } = require('./db.js');

const VERSION = '1.0.0';
const MAX_BODY = 1024 * 1024; // 1 Mo : largement de quoi importer un gros registre

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('JSON invalide'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanContact(input) {
  const name = String((input && input.name) || '').trim();
  const email = String((input && input.email) || '').trim();
  if (!name) throw Object.assign(new Error('Nom manquant'), { status: 400 });
  if (!util.isValidEmail(email)) throw Object.assign(new Error('Courriel invalide'), { status: 400 });
  return { name: name, email: email };
}

function findDuplicate(contacts, email, exceptId) {
  return (
    contacts.find(function (c) {
      return util.normalize(c.email) === util.normalize(email) && c.id !== exceptId;
    }) || null
  );
}

/* ---------- fichiers statiques ---------- */

async function serveStatic(req, res, rootDir) {
  const parsed = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(parsed.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(rootDir, path.normalize(rel));
  // Empêche toute sortie de l'arborescence servie (« /../server/.env »).
  if (!target.startsWith(rootDir + path.sep) && target !== rootDir) {
    res.writeHead(403).end('Interdit');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404).end('Introuvable');
    return;
  }

  const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(target).pipe(res);
}

/* ---------- API ---------- */

async function handleApi(req, res, ctx, pathname) {
  const { db, mailer } = ctx;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      app: 'bureau-du-courrier',
      version: VERSION,
      smtp: mailer.enabled,
      mailMode: mailer.mode,
      mailReason: mailer.reason || null,
      storage: 'fichier'
    });
  }

  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, db.data);
  }

  /* --- destinataires --- */

  if (pathname === '/api/contacts') {
    if (method === 'GET') return sendJson(res, 200, db.data.contacts);
    if (method === 'POST') {
      const input = cleanContact(await readBody(req));
      const clash = findDuplicate(db.data.contacts, input.email, null);
      if (clash) {
        throw Object.assign(new Error('Ce courriel est déjà au registre sous « ' + clash.name + ' »'), { status: 409 });
      }
      const contact = { id: crypto.randomUUID(), name: input.name, email: input.email, createdAt: new Date().toISOString() };
      await db.write(function (data) {
        data.contacts.push(contact);
      });
      return sendJson(res, 201, contact);
    }
  }

  const contactMatch = pathname.match(/^\/api\/contacts\/([^/]+)$/);
  if (contactMatch) {
    const id = decodeURIComponent(contactMatch[1]);
    const existing = db.data.contacts.find(function (c) {
      return c.id === id;
    });
    if (!existing) throw Object.assign(new Error('Destinataire introuvable'), { status: 404 });

    if (method === 'PUT') {
      const input = cleanContact(await readBody(req));
      const clash = findDuplicate(db.data.contacts, input.email, id);
      if (clash) {
        throw Object.assign(new Error('Ce courriel est déjà au registre sous « ' + clash.name + ' »'), { status: 409 });
      }
      const updated = Object.assign({}, existing, input, { updatedAt: new Date().toISOString() });
      await db.write(function (data) {
        const i = data.contacts.findIndex(function (c) {
          return c.id === id;
        });
        data.contacts[i] = updated;
      });
      return sendJson(res, 200, updated);
    }
    if (method === 'DELETE') {
      await db.write(function (data) {
        data.contacts = data.contacts.filter(function (c) {
          return c.id !== id;
        });
      });
      return sendJson(res, 200, { deleted: id });
    }
  }

  /* --- historique --- */

  if (pathname === '/api/history') {
    if (method === 'GET') return sendJson(res, 200, db.data.history);
    if (method === 'POST') {
      const body = await readBody(req);
      const record = {
        id: body.id || crypto.randomUUID(),
        contactId: body.contactId || null,
        name: String(body.name || '').trim(),
        email: String(body.email || '').trim(),
        subject: String(body.subject || '').trim(),
        cc: String(body.cc || '').trim(),
        bcc: String(body.bcc || '').trim(),
        date: body.date || new Date().toISOString(),
        method: body.method === 'auto' ? 'auto' : 'manuel',
        status: ['envoyé', 'préparé', 'échec'].includes(body.status) ? body.status : 'préparé'
      };
      if (!record.name || !record.email) {
        throw Object.assign(new Error('Nom et courriel requis'), { status: 400 });
      }
      await db.write(function (data) {
        data.history.unshift(record);
      });
      return sendJson(res, 201, record);
    }
    if (method === 'DELETE') {
      await db.write(function (data) {
        data.history = [];
      });
      return sendJson(res, 200, { cleared: true });
    }
  }

  /* --- réglages --- */

  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJson(res, 200, db.data.settings);
    if (method === 'PUT') {
      const body = await readBody(req);
      const subject = String(body.subject || '').trim();
      const messageBody = String(body.body || '').trim();
      if (!subject || !messageBody) {
        throw Object.assign(new Error('Sujet et corps du message requis'), { status: 400 });
      }
      const from = String(body.from || '').trim();
      if (from && !util.isValidAddress(from)) {
        throw Object.assign(new Error('Expéditeur invalide'), { status: 400 });
      }
      const cc = util.parseAddressList(body.cc);
      const bcc = util.parseAddressList(body.bcc);
      if (cc.errors.length || bcc.errors.length) {
        throw Object.assign(
          new Error('Adresse en copie invalide : ' + cc.errors.concat(bcc.errors).join(', ')),
          { status: 400 }
        );
      }

      const settings = Object.assign({}, DEFAULT_SETTINGS, {
        subject: subject,
        body: messageBody,
        officeName: String(body.officeName || DEFAULT_SETTINGS.officeName).trim(),
        from: from,
        cc: util.formatAddressList(cc.entries),
        bcc: util.formatAddressList(bcc.entries)
      });
      await db.write(function (data) {
        data.settings = settings;
      });
      return sendJson(res, 200, settings);
    }
  }

  /* --- envoi --- */

  if (pathname === '/api/notify' && method === 'POST') {
    const body = await readBody(req);
    const to = String(body.email || '').trim();
    const name = String(body.name || '').trim();
    if (!util.isValidEmail(to)) throw Object.assign(new Error('Courriel invalide'), { status: 400 });
    if (!mailer.enabled) {
      throw Object.assign(new Error(mailer.reason || 'Envoi automatique indisponible'), { status: 503 });
    }

    const settings = db.data.settings;
    const vars = {
      nom: name,
      courriel: to,
      date: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
      bureau: settings.officeName
    };
    const subject = body.subject ? String(body.subject) : util.renderTemplate(settings.subject, vars);
    const text = body.body ? String(body.body) : util.renderTemplate(settings.body, vars);

    // De / Cc / Cci : ce que la requête précise l'emporte, sinon les réglages.
    const from = String(body.from !== undefined ? body.from : settings.from || '').trim();
    if (from && !util.isValidAddress(from)) {
      throw Object.assign(new Error('Expéditeur invalide'), { status: 400 });
    }
    const cc = util.parseAddressList(body.cc !== undefined ? body.cc : settings.cc);
    const bcc = util.parseAddressList(body.bcc !== undefined ? body.bcc : settings.bcc);
    if (cc.errors.length || bcc.errors.length) {
      throw Object.assign(
        new Error('Adresse en copie invalide : ' + cc.errors.concat(bcc.errors).join(', ')),
        { status: 400 }
      );
    }
    const ccList = util.formatAddressList(cc.entries);
    const bccList = util.formatAddressList(bcc.entries);

    let record = {
      id: crypto.randomUUID(),
      contactId: body.contactId || null,
      name: name,
      email: to,
      subject: subject,
      cc: ccList,
      bcc: bccList,
      date: new Date().toISOString(),
      method: 'auto',
      status: 'envoyé'
    };

    try {
      await mailer.send({ to: to, from: from, cc: ccList, bcc: bccList, subject: subject, text: text });
    } catch (err) {
      record.status = 'échec';
      await db.write(function (data) {
        data.history.unshift(record);
      });
      throw Object.assign(new Error('Envoi refusé par le serveur de courriel : ' + err.message), {
        status: 502,
        record: record
      });
    }

    await db.write(function (data) {
      data.history.unshift(record);
    });
    return sendJson(res, 200, { sent: true, record: record });
  }

  throw Object.assign(new Error('Route inconnue'), { status: 404 });
}

/* ---------- assemblage ---------- */

function createServer(ctx) {
  const rootDir = path.resolve(ctx.rootDir || path.join(__dirname, '..'));

  return http.createServer(async function (req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'Méthode non autorisée' });
      }
      try {
        return await serveStatic(req, res, rootDir);
      } catch (err) {
        console.error(err);
        if (!res.headersSent) res.writeHead(500).end('Erreur interne');
        return;
      }
    }

    try {
      await handleApi(req, res, ctx, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500 && status !== 502 && status !== 503) console.error(err);
      if (!res.headersSent) {
        sendJson(res, status, { error: err.message, record: err.record || undefined });
      }
    }
  });
}

module.exports = { createServer: createServer, VERSION: VERSION };
