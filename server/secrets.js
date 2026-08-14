/* Bureau du Courrier — chiffrement des identifiants au repos.

   Le registre (data/db.json) contient des secrets appartenant aux employé·es :
   mot de passe d'application SMTP, jeton de rafraîchissement Google. Ils ne
   doivent jamais s'y trouver en clair — une copie du fichier, une sauvegarde ou
   une erreur de partage suffirait à les exposer.

   Clé : APP_SECRET (variable d'environnement) ou, à défaut, data/secret.key,
   généré au premier démarrage avec des droits restreints. Perdre la clé rend
   les secrets illisibles : les employé·es doivent alors reconnecter leur boîte,
   ce qui est le comportement voulu. */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALGO = 'aes-256-gcm';

function deriveKey(material) {
  // Le matériau peut être une phrase quelconque : on le ramène à 32 octets.
  return crypto.createHash('sha256').update(String(material), 'utf8').digest();
}

function loadOrCreateKeyFile(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const generated = crypto.randomBytes(32).toString('base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {
    /* systèmes de fichiers sans droits POSIX (Windows) */
  }
  console.log('[secrets] clé de chiffrement créée : ' + file + ' (à sauvegarder, à ne pas partager)');
  return generated;
}

function createVault(options) {
  const opts = options || {};
  const material = opts.secret || loadOrCreateKeyFile(opts.keyFile);
  const key = deriveKey(material);

  return {
    /** Chiffre une chaîne. Renvoie '' pour une entrée vide, jamais null. */
    seal: function (plaintext) {
      if (plaintext === null || plaintext === undefined || plaintext === '') return '';
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return 'v1.' + iv.toString('base64url') + '.' + tag.toString('base64url') + '.' + encrypted.toString('base64url');
    },

    /** Déchiffre. Renvoie null si le contenu a été altéré ou si la clé a changé. */
    open: function (sealed) {
      if (!sealed) return '';
      const parts = String(sealed).split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') return null;
      try {
        const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parts[1], 'base64url'));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
      } catch (e) {
        return null;
      }
    }
  };
}

module.exports = { createVault: createVault };
