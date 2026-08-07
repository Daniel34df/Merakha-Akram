/* Bureau du Courrier — persistance serveur.
   Un seul fichier JSON, écrit de façon atomique (fichier temporaire puis rename)
   et sérialisé par une file d'attente : deux requêtes simultanées ne peuvent pas
   s'écraser l'une l'autre ni laisser un fichier à moitié écrit. */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

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

function emptyDb() {
  return {
    contacts: [],
    history: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    users: [],
    sessions: [],
    pending: []
  };
}

class Db {
  constructor(file) {
    this.file = file;
    this.data = emptyDb();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {}),
        // Champs apparus avec les comptes : un registre antérieur ne les a pas.
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions)
          ? parsed.sessions.filter(function (s) {
              return s && new Date(s.expiresAt).getTime() > Date.now();
            })
          : [],
        // Inscriptions en attente de confirmation : les codes périmés ne
        // servent plus à rien et n'ont pas à traîner dans le fichier.
        pending: Array.isArray(parsed.pending)
          ? parsed.pending.filter(function (p) {
              return p && new Date(p.expiresAt).getTime() > Date.now();
            })
          : []
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Fichier illisible ou corrompu : on le met de côté plutôt que de l'écraser.
        if (err instanceof SyntaxError) {
          const backup = this.file + '.corrompu-' + Date.now();
          await fs.rename(this.file, backup).catch(function () {});
          console.warn('[db] fichier illisible, sauvegardé sous ' + path.basename(backup));
        } else {
          throw err;
        }
      }
      this.data = emptyDb();
    }
    return this.data;
  }

  /** Applique une mutation puis écrit le fichier. Les appels sont sérialisés. */
  write(mutator) {
    const self = this;
    this.queue = this.queue.then(async function () {
      const result = mutator(self.data);

      // Les sessions et codes périmés ne servent plus : les garder allonge le
      // fichier et prolonge inutilement la durée de vie de données sensibles.
      const now = Date.now();
      if (Array.isArray(self.data.sessions)) {
        self.data.sessions = self.data.sessions.filter(function (s) {
          return s && new Date(s.expiresAt).getTime() > now;
        });
      }
      if (Array.isArray(self.data.pending)) {
        self.data.pending = self.data.pending.filter(function (p) {
          return p && new Date(p.expiresAt).getTime() > now;
        });
      }

      await fs.mkdir(path.dirname(self.file), { recursive: true });
      const tmp = self.file + '.' + process.pid + '.tmp';
      // 0600 : le registre contient des empreintes de mots de passe et des
      // secrets chiffrés, il n'a pas à être lisible par les autres comptes.
      await fs.writeFile(tmp, JSON.stringify(self.data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, self.file);
      return result;
    });
    return this.queue;
  }
}

/* Sauvegarde datée du registre, avec rotation.

   Le registre tient dans un seul fichier : une erreur de manipulation ou un
   disque défaillant l'emporte en entier. Une copie par jour, gardée quelques
   semaines, coûte quelques kilo-octets et évite de tout perdre. */
async function sauvegarder(db, options) {
  const opts = options || {};
  const dossier = opts.dossier || path.join(path.dirname(db.file), 'sauvegardes');
  const garder = opts.garder === undefined ? 14 : Number(opts.garder);
  const jour = (opts.now ? new Date(opts.now) : new Date()).toISOString().slice(0, 10);
  const cible = path.join(dossier, 'registre-' + jour + '.json');

  await fs.mkdir(dossier, { recursive: true });
  // Une seule copie par jour : la journée en cours est simplement réécrite.
  await fs.writeFile(cible, JSON.stringify(db.data, null, 2), { encoding: 'utf8', mode: 0o600 });

  const fichiers = (await fs.readdir(dossier))
    .filter(function (nom) {
      return /^registre-\d{4}-\d{2}-\d{2}\.json$/.test(nom);
    })
    .sort();
  const aSupprimer = fichiers.slice(0, Math.max(0, fichiers.length - garder));
  for (const nom of aSupprimer) {
    await fs.unlink(path.join(dossier, nom)).catch(function () {});
  }

  return { fichier: cible, conserves: Math.min(fichiers.length, garder), supprimes: aSupprimer.length };
}

module.exports = {
  Db: Db,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  emptyDb: emptyDb,
  sauvegarder: sauvegarder
};
