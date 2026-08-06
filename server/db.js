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
    sessions: []
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
      await fs.mkdir(path.dirname(self.file), { recursive: true });
      const tmp = self.file + '.' + process.pid + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(self.data, null, 2), 'utf8');
      await fs.rename(tmp, self.file);
      return result;
    });
    return this.queue;
  }
}

module.exports = { Db: Db, DEFAULT_SETTINGS: DEFAULT_SETTINGS, emptyDb: emptyDb };
