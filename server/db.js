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
  /* De quoi rédiger une attestation d'élection de domicile : c'est l'organisme
     qui atteste, il doit donc se nommer, dire où il est et sous quel agrément
     il domicilie. Vides, l'attestation s'imprime quand même — avec des traits
     à compléter à la main plutôt qu'un refus d'imprimer. */
  officeAdresse: '',
  officeVille: '',
  officeAgrement: '',
  from: '',
  cc: '',
  bcc: '',
  /* Gabarits propres à un type de courrier ({ colis: {subject, body}, … }).
     Vide par défaut : tous les types emploient le modèle général ci-dessus. */
  templates: {},
  /* Gabarits par langue : { ar: { subject, body, templates: {…} } }. Vide par
     défaut ; une langue sans texte propre retombe sur le modèle français. */
  langues: {},
  /* Antennes : plusieurs points d'accueil partageant un serveur. Vide = un seul
     bureau, et l'application ne montre rien de cette notion. */
  antennes: [],
  /* Durée de conservation des courriers terminés, en mois. 0 = illimitée.
     Un registre qui garde tout indéfiniment expose bien plus qu'il ne devrait
     le jour d'une fuite ; c'est aussi une obligation. */
  conservationMois: 0
};

function emptyDb() {
  return {
    contacts: [],
    history: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    users: [],
    sessions: [],
    pending: [],
    journal: [],
    /* Ce que ce poste portait comme adresses au dernier démarrage. Sert à
       prévenir quand elles ont changé : les autres postes du bureau ne
       trouveraient plus le serveur, sans que personne ne sache pourquoi. */
    reseau: null,
    // Empreinte du code maître : jamais le code lui-même.
    masterCodeHash: ''
  };
}

class Db {
  constructor(file) {
    this.file = file;
    this.data = emptyDb();
    this.queue = Promise.resolve();
    /* Numéro d'ordre des écritures. Il ne sert pas à retrouver un état passé,
       seulement à dire aux autres postes du bureau « quelque chose a bougé,
       redemandez ». Il ne survit pas au redémarrage : les postes se
       reconnectent alors et rechargent tout, ce qui donne le même résultat. */
    this.revision = 0;
    this.abonnes = new Set();
  }

  /* Prévenu à chaque écriture terminée. Rend la fonction de désabonnement —
     un poste qui ferme son navigateur ne doit pas laisser un abonné derrière
     lui, sinon la liste enfle jusqu'au redémarrage. */
  surEcriture(fn) {
    this.abonnes.add(fn);
    const self = this;
    return function () {
      self.abonnes.delete(fn);
    };
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
        journal: Array.isArray(parsed.journal) ? parsed.journal : [],
        masterCodeHash: typeof parsed.masterCodeHash === 'string' ? parsed.masterCodeHash : '',
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

      /* Après le rename, jamais avant : prévenir les autres postes d'une
         écriture qui n'a pas encore touché le disque les ferait recharger un
         état qu'une panne pourrait effacer. Un abonné qui échoue n'emporte pas
         l'écriture avec lui — elle est faite. */
      self.revision++;
      self.abonnes.forEach(function (fn) {
        try {
          fn(self.revision);
        } catch (e) {
          /* un poste qui n'écoute plus ne doit pas gêner les autres */
        }
      });
      return result;
    });
    return this.queue;
  }
}

/* Sauvegarde datée du registre, avec rotation.

   Le registre tient dans un seul fichier : une erreur de manipulation ou un
   disque défaillant l'emporte en entier. Une copie par jour, gardée quelques
   semaines, coûte quelques kilo-octets et évite de tout perdre. */
/* Journal d'activité : qui a fait quoi. Dans un bureau partagé, c'est ce qui
   évite les discussions — sans accuser personne, il suffit de regarder.
   Le journal est borné : au-delà, les plus anciennes lignes disparaissent. */
const JOURNAL_MAX = 2000;

function consigner(db, entree) {
  return db.write(function (data) {
    if (!Array.isArray(data.journal)) data.journal = [];
    data.journal.unshift({
      at: new Date().toISOString(),
      qui: entree.qui || null,
      action: entree.action,
      cible: entree.cible || '',
      details: entree.details || ''
    });
    if (data.journal.length > JOURNAL_MAX) data.journal.length = JOURNAL_MAX;
  });
}

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

/* Sauvegardes disponibles, la plus récente d'abord. Sans cette liste, une
   restauration exige d'aller fouiller le disque du serveur — ce que personne
   au guichet ne fera le jour où le registre est abîmé. */
async function listerSauvegardes(db, options) {
  const opts = options || {};
  const dossier = opts.dossier || path.join(path.dirname(db.file), 'sauvegardes');
  let fichiers;
  try {
    fichiers = await fs.readdir(dossier);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const nom of fichiers) {
    if (!/^registre-\d{4}-\d{2}-\d{2}\.json$/.test(nom)) continue;
    const chemin = path.join(dossier, nom);
    try {
      const stat = await fs.stat(chemin);
      const contenu = JSON.parse(await fs.readFile(chemin, 'utf8'));
      out.push({
        fichier: nom,
        jour: nom.slice(9, 19),
        octets: stat.size,
        // L'aperçu évite de restaurer à l'aveugle une copie presque vide.
        destinataires: Array.isArray(contenu.contacts) ? contenu.contacts.length : 0,
        courriers: Array.isArray(contenu.history) ? contenu.history.length : 0
      });
    } catch (e) {
      out.push({ fichier: nom, jour: nom.slice(9, 19), illisible: true });
    }
  }
  return out.sort(function (a, b) {
    return a.jour < b.jour ? 1 : -1;
  });
}

/* Restauration. On sauvegarde d'abord l'état courant sous un nom distinct :
   restaurer est une opération qu'on peut regretter, et l'annuler doit rester
   possible. Les comptes et les sessions ne sont jamais écrasés — une copie du
   registre n'a pas à faire perdre l'accès à l'application. */
async function restaurer(db, fichier, options) {
  const opts = options || {};
  const dossier = opts.dossier || path.join(path.dirname(db.file), 'sauvegardes');
  if (!/^registre-\d{4}-\d{2}-\d{2}\.json$/.test(String(fichier || ''))) {
    throw Object.assign(new Error('Nom de sauvegarde invalide'), { status: 400 });
  }
  const chemin = path.join(dossier, fichier);

  let copie;
  try {
    copie = JSON.parse(await fs.readFile(chemin, 'utf8'));
  } catch (e) {
    throw Object.assign(new Error('Sauvegarde introuvable ou illisible'), { status: 404 });
  }
  if (!Array.isArray(copie.contacts) || !Array.isArray(copie.history)) {
    throw Object.assign(new Error('Ce fichier ne ressemble pas à un registre'), { status: 400 });
  }

  const avant = {
    destinataires: (db.data.contacts || []).length,
    courriers: (db.data.history || []).length
  };
  const filet = path.join(dossier, 'avant-restauration-' + Date.now() + '.json');
  await fs.mkdir(dossier, { recursive: true });
  await fs.writeFile(filet, JSON.stringify(db.data, null, 2), { encoding: 'utf8', mode: 0o600 });

  await db.write(function (data) {
    data.contacts = copie.contacts;
    data.history = copie.history;
    if (copie.settings) data.settings = Object.assign({}, DEFAULT_SETTINGS, copie.settings);
  });

  return {
    fichier: fichier,
    filet: path.basename(filet),
    avant: avant,
    apres: { destinataires: db.data.contacts.length, courriers: db.data.history.length }
  };
}

/* Durée de conservation. Les données de courrier n'ont pas à s'accumuler sans
   fin : au-delà du délai fixé, les courriers clos ou retirés sont effacés. Ceux
   qui attendent encore ne sont jamais touchés, quel que soit leur âge — un
   courrier non remis reste un courrier non remis. */
function courriersAPurger(history, options) {
  const opts = options || {};
  const mois = Number(opts.mois) || 0;
  if (mois <= 0) return [];
  const limite = (opts.now === undefined ? Date.now() : opts.now) - mois * 30.4375 * 24 * 3600 * 1000;
  return (history || []).filter(function (h) {
    const termine = !!h.pickedUpAt || !!h.closedAt;
    if (!termine) return false;
    const fin = new Date(h.pickedUpAt || h.closedAt).getTime();
    return !isNaN(fin) && fin < limite;
  });
}

async function purger(db, options) {
  const aPurger = courriersAPurger(db.data.history, options);
  if (aPurger.length === 0) return { supprimes: 0 };
  const ids = new Set(
    aPurger.map(function (h) {
      return h.id;
    })
  );
  await db.write(function (data) {
    data.history = data.history.filter(function (h) {
      return !ids.has(h.id);
    });
  });
  return { supprimes: ids.size };
}

module.exports = {
  Db: Db,
  listerSauvegardes: listerSauvegardes,
  restaurer: restaurer,
  courriersAPurger: courriersAPurger,
  purger: purger,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  emptyDb: emptyDb,
  sauvegarder: sauvegarder,
  consigner: consigner,
  JOURNAL_MAX: JOURNAL_MAX
};
