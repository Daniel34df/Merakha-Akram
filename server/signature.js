/* Bureau du Courrier — signature du créateur et intégrité des fichiers.

   ─────────────────────────────────────────────────────────────────────────
   Créé par AKRAM MERAKHA.
   ─────────────────────────────────────────────────────────────────────────

   Ce que ce module fait.

   Chaque version publiée est accompagnée d'un **manifeste** : la liste des
   fichiers de l'application avec leur empreinte SHA-256, le nom du créateur,
   la version, et un **sceau Ed25519**. Le manifeste est scellé avec une clé
   privée que seul le créateur détient ; l'application n'embarque que la clé
   publique, qui ne permet que de vérifier.

   Au démarrage, le serveur relit les fichiers, recalcule les empreintes et les
   compare. Un fichier modifié, ajouté ou disparu se voit. Le résultat est
   affiché, inscrit au journal de sécurité, et — si l'écart touche le cœur de
   l'application — les fonctions sensibles se ferment.

   Pourquoi Ed25519 plutôt qu'une somme de contrôle. Une empreinte seule ne
   protège de rien : qui modifie un fichier recalcule l'empreinte et réécrit le
   manifeste. Il faudrait un secret partagé, mais un secret qui voyage avec le
   logiciel n'en est pas un. Avec une paire de clés, le secret ne quitte jamais
   la machine du créateur : l'application ne sait que vérifier, jamais signer.
   Node sait faire Ed25519 nativement — pas une dépendance de plus.

   Ce que ce module ne peut pas faire, et il faut l'écrire ici plutôt que le
   laisser croire. Le contrôle s'exécute sur la machine de celui qui pourrait
   vouloir le contourner, et il est lui-même un des fichiers qu'il vérifie. Qui
   sait éditer `server/signature.js` peut en retirer le contrôle et remplacer
   la clé publique par la sienne. Aucun logiciel livré en source ne fait mieux,
   quel que soit son prix.

   Ce que ça donne quand même, et qui n'est pas rien :

     · **la falsification devient un acte, pas un oubli.** Retirer la signature
       demande de comprendre le code, de refaire un manifeste et de remplacer
       une clé — pas de supprimer une ligne ;
     · **elle laisse une trace.** Le journal de sécurité garde l'écart, la date,
       le fichier et le compte ;
     · **elle se prouve.** Devant un tiers — un client, un tribunal — une
       version signée se distingue d'une copie modifiée par une vérification
       que n'importe qui peut refaire avec la clé publique ;
     · **elle attrape ce qui arrive vraiment.** Une copie sur clé USB
       interrompue, une mise à jour à moitié appliquée, un fichier corrompu par
       un disque fatigué : dans un bureau, c'est cent fois plus fréquent qu'un
       adversaire, et jusqu'ici rien ne le disait.

   C'est exactement ce que demande le §14 du cahier des charges : rendre la
   falsification **détectable et non rentable**, plutôt que prétendre
   l'empêcher.

   Enfin, une règle qui prime sur tout le reste, et qui vient du §13 : **aucune
   donnée n'est jamais détruite.** Une compromission verrouille des fonctions,
   elle n'efface ni le registre, ni les sauvegardes, ni le journal. Ce registre
   porte les noms et les adresses de gens sans logement ; le protéger passe
   avant la protection du logiciel qui le tient. */
'use strict';

const crypto = require('node:crypto');

const CREATEUR = 'AKRAM MERAKHA';
const APPLICATION = 'Bureau du Courrier';

/* La clé publique du créateur. Elle ne permet que de vérifier — la clé privée
   correspondante ne quitte jamais sa machine et n'est pas dans ce dépôt.
   Vide tant qu'aucune version n'a été scellée : l'application fonctionne
   alors normalement et annonce simplement « non signée ». */
/* La clé embarquée dans la source scellée est le cas normal. `BDC_CLE_PUBLIQUE`
   permet de la fournir sans toucher au fichier — pratique pour une machine de
   pré-production. Ce n'est pas un affaiblissement : qui peut poser cette
   variable peut aussi éditer cette ligne. La constante prime, l'env ne sert que
   lorsqu'elle est vide. */
const CLE_PUBLIQUE = '' || (process.env.BDC_CLE_PUBLIQUE || '').replace(/\\n/g, '\n');

/* Les codes d'incident du cahier des charges. Ils sont affichés à l'écran et
   inscrits au journal : c'est ce qu'on dicte au téléphone pour se faire aider,
   donc ils doivent être courts et stables. */
const CODES = {
  ok: null,
  nonSignee: 'SIGNATURE-000',
  fichiersModifies: 'INTEGRITY-001',
  sceauInvalide: 'SECURITY-001',
  manifesteAbsent: 'SIGNATURE-002',
  revoquee: 'LICENCE-001'
};

const ETATS = {
  ok: 'verifiee',
  nonSignee: 'non-signee',
  compromise: 'compromise',
  revoquee: 'revoquee'
};

/** L'empreinte d'un contenu. */
function empreinte(contenu) {
  return crypto.createHash('sha256').update(contenu).digest('hex');
}

/* La forme canonique de ce qui est signé. Deux exigences : que l'ordre des
   clés ne change rien — sinon une simple relecture par un autre outil
   invaliderait le sceau — et que le sceau lui-même n'entre pas dans ce qu'il
   scelle. */
function canoniser(manifeste) {
  const m = manifeste || {};
  const fichiers = m.fichiers || {};
  const lignes = Object.keys(fichiers).sort().map(function (chemin) {
    return chemin + ':' + fichiers[chemin];
  });
  return JSON.stringify({
    createur: m.createur || '',
    application: m.application || '',
    version: m.version || '',
    cree: m.cree || '',
    algorithme: m.algorithme || 'sha256',
    fichiers: lignes
  });
}

/* L'empreinte du corpus entier : une seule valeur qui résume la version, à
   dicter ou à publier. C'est elle qui apparaît dans « À propos ». */
function empreinteCorpus(manifeste) {
  return empreinte(canoniser(manifeste));
}

/** Un identifiant lisible pour cette version : « BDC-1.2.0-3f9a2c11 ». */
function identifiant(manifeste) {
  return 'BDC-' + (manifeste.version || '0') + '-' + empreinteCorpus(manifeste).slice(0, 8);
}

/** Le manifeste, sans son sceau. `fichiers` : { chemin: contenu }. */
function construire(input) {
  const o = input || {};
  const fichiers = {};
  Object.keys(o.fichiers || {}).sort().forEach(function (chemin) {
    fichiers[chemin] = empreinte(o.fichiers[chemin]);
  });
  const m = {
    createur: CREATEUR,
    application: APPLICATION,
    version: String(o.version || ''),
    cree: o.cree || new Date().toISOString(),
    algorithme: 'sha256',
    fichiers: fichiers
  };
  m.empreinte = empreinteCorpus(m);
  m.identifiant = identifiant(m);
  return m;
}

/** Scelle un manifeste avec la clé privée du créateur. */
function sceller(manifeste, clePriveePem) {
  const sceau = crypto.sign(null, Buffer.from(canoniser(manifeste), 'utf8'), clePriveePem);
  return Object.assign({}, manifeste, { sceau: sceau.toString('base64') });
}

/* Vrai si le sceau est bien celui du créateur. Faux — jamais une exception —
   quand la clé est absente, illisible, ou le sceau forgé : un démarrage de
   serveur ne doit pas échouer parce qu'un fichier de signature est abîmé. */
function verifierSceau(manifeste, clePubliquePem) {
  if (!manifeste || !manifeste.sceau || !clePubliquePem) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(canoniser(manifeste), 'utf8'),
      clePubliquePem,
      Buffer.from(manifeste.sceau, 'base64')
    );
  } catch (e) {
    return false;
  }
}

/* Compare le manifeste aux empreintes réellement lues sur le disque.
   `lues` : { chemin: empreinte }. Rend les écarts, classés — un fichier
   modifié, un fichier disparu et un fichier ajouté ne racontent pas la même
   histoire, et l'écran doit pouvoir le dire. */
function verifierFichiers(manifeste, lues) {
  const attendus = (manifeste && manifeste.fichiers) || {};
  const trouvees = lues || {};
  const ecarts = [];

  Object.keys(attendus).sort().forEach(function (chemin) {
    if (!(chemin in trouvees)) ecarts.push({ chemin: chemin, quoi: 'disparu' });
    else if (trouvees[chemin] !== attendus[chemin]) ecarts.push({ chemin: chemin, quoi: 'modifie' });
  });
  Object.keys(trouvees).sort().forEach(function (chemin) {
    if (!(chemin in attendus)) ecarts.push({ chemin: chemin, quoi: 'ajoute' });
  });

  return { intact: ecarts.length === 0, ecarts: ecarts };
}

/* ── la révocation ──

   Le créateur peut déclarer qu'une version n'est plus autorisée. La liste est
   elle-même signée : sans cela, n'importe qui pourrait révoquer l'application
   d'un bureau en déposant un fichier.

   Elle est **locale**. Une vérification en ligne obligerait l'application à
   appeler un serveur, alors qu'elle est faite pour tourner dans un bureau sans
   internet — et surtout, un serveur injoignable deviendrait une révocation :
   chaque panne de box fermerait le guichet un lundi matin. La liste arrive
   donc par le canal qui convient au créateur (une mise à jour, un fichier
   remis à l'administrateur), et son absence ne révoque rien. */
function verifierRevocation(liste, clePubliquePem) {
  if (!liste || !Array.isArray(liste.versions)) return { valide: false, versions: [] };
  const corps = JSON.stringify({ versions: liste.versions.slice().sort(), emise: liste.emise || '' });
  if (!liste.sceau || !clePubliquePem) return { valide: false, versions: [] };
  try {
    const ok = crypto.verify(
      null, Buffer.from(corps, 'utf8'), clePubliquePem, Buffer.from(liste.sceau, 'base64')
    );
    return { valide: ok, versions: ok ? liste.versions : [] };
  } catch (e) {
    return { valide: false, versions: [] };
  }
}

function estRevoquee(revocation, manifeste) {
  if (!revocation || !revocation.valide || !manifeste) return false;
  return revocation.versions.some(function (v) {
    return v === manifeste.identifiant || v === manifeste.version || v === manifeste.empreinte;
  });
}

/* ── le verdict ──

   Une seule fonction rend l'état de l'application, parce qu'un seul état doit
   exister : trois endroits qui décideraient chacun de leur côté finiraient par
   se contredire, et c'est l'écran qui mentirait. */
function etat(input) {
  const o = input || {};
  const m = o.manifeste;

  if (!m) {
    return {
      etat: ETATS.nonSignee, code: CODES.manifesteAbsent, verrouille: false,
      createur: CREATEUR, application: APPLICATION, version: o.version || '',
      message: 'Cette copie n’est pas signée : son origine ne peut pas être vérifiée.'
    };
  }

  const base = {
    createur: m.createur || CREATEUR,
    application: m.application || APPLICATION,
    version: m.version || '',
    identifiant: m.identifiant || '',
    empreinte: m.empreinte || '',
    cree: m.cree || ''
  };

  /* Sans clé publique embarquée, aucune version n'a encore été scellée : on ne
     prétend pas vérifier ce qu'on ne peut pas vérifier. L'application
     fonctionne, et le dit. */
  if (!o.clePublique) {
    return Object.assign(base, {
      etat: ETATS.nonSignee, code: CODES.nonSignee, verrouille: false,
      message: 'Aucune clé de vérification n’est embarquée : l’intégrité n’est pas contrôlée.'
    });
  }

  if (!verifierSceau(m, o.clePublique)) {
    return Object.assign(base, {
      etat: ETATS.compromise, code: CODES.sceauInvalide, verrouille: true,
      ecarts: [],
      message: 'Le sceau du manifeste ne correspond pas à la signature du créateur.'
    });
  }

  if (estRevoquee(o.revocation, m)) {
    return Object.assign(base, {
      etat: ETATS.revoquee, code: CODES.revoquee, verrouille: true, ecarts: [],
      message: 'Cette version n’est plus autorisée à fonctionner. Les données ne sont pas supprimées.'
    });
  }

  const f = verifierFichiers(m, o.lues || {});
  if (!f.intact) {
    return Object.assign(base, {
      etat: ETATS.compromise, code: CODES.fichiersModifies, verrouille: true, ecarts: f.ecarts,
      message: f.ecarts.length + ' fichier(s) ne correspondent plus à la version signée.'
    });
  }

  return Object.assign(base, {
    etat: ETATS.ok, code: CODES.ok, verrouille: false, ecarts: [],
    message: 'Signature vérifiée, fichiers conformes.'
  });
}

/* ── ce qui se ferme, et ce qui reste ouvert ──

   « Les fonctions sensibles sont désactivées » (§5). Le choix de ce qui est
   sensible n'est pas neutre, et il se justifie ici plutôt que dans un test.

   Se ferment : ce qui reconfigure le bureau, ce qui sort les données, ce qui
   touche aux comptes, ce qui restaure une sauvegarde, ce qui efface. C'est là
   qu'un adversaire irait, et rien de tout cela n'est urgent.

   Restent ouverts : le guichet et la remise. Une intégrité compromise est une
   affaire entre le créateur et l'administrateur ; ce n'est pas une raison pour
   qu'une personne sans logement reparte sans le courrier qui lui ouvre la CAF.
   Fermer le comptoir ferait payer l'incident à qui n'y est pour rien.

   La sauvegarde reste possible, et c'est délibéré : le §11 demande de pouvoir
   diagnostiquer puis restaurer, ce qui commence par mettre les données à
   l'abri. */
const SENSIBLES = [
  { methode: /^(PUT|POST|DELETE)$/, chemin: /^\/api\/settings/ },
  { methode: /^(POST|DELETE|PUT)$/, chemin: /^\/api\/auth\/(agents|users|master|password|mailbox)/ },
  { methode: /^POST$/, chemin: /^\/api\/backup\/restore/ },
  { methode: /^(DELETE)$/, chemin: /^\/api\/contacts\// },
  { methode: /^GET$/, chemin: /^\/api\/backup$/ },
  { methode: /^DELETE$/, chemin: /^\/api\/history/ }
];

function estSensible(methode, chemin) {
  return SENSIBLES.some(function (r) {
    return r.methode.test(String(methode || '')) && r.chemin.test(String(chemin || ''));
  });
}

/* ── la lecture du disque ──

   Tout ce qui précède ne calcule que sur des tableaux, et c'est ce qui le rend
   vérifiable. Voici la seule partie qui touche au disque, gardée courte et à
   l'écart pour la même raison.

   Une lecture qui échoue vaut « disparu », pas une exception : un fichier
   devenu illisible est précisément ce qu'on veut signaler, pas ce qui doit
   empêcher le serveur de démarrer. */
function lireEmpreintes(racine, manifeste) {
  const fs = require('node:fs');
  const path = require('node:path');
  const out = {};
  Object.keys((manifeste && manifeste.fichiers) || {}).forEach(function (chemin) {
    try {
      out[chemin] = empreinte(fs.readFileSync(path.join(racine, chemin)));
    } catch (e) {
      /* laissé absent : `verifierFichiers` le comptera comme disparu */
    }
  });
  return out;
}

/* L'état de l'installation, lu une fois au démarrage. Rien ici ne jette :
   le bureau ouvre à neuf heures, et un fichier de signature abîmé ne doit pas
   l'en empêcher — il doit s'afficher. */
function inspecter(racine, options) {
  const fs = require('node:fs');
  const path = require('node:path');
  const o = options || {};
  let manifeste = null;
  let revocation = null;
  try {
    manifeste = JSON.parse(fs.readFileSync(path.join(racine, 'signature.json'), 'utf8'));
  } catch (e) { manifeste = null; }
  try {
    const brut = JSON.parse(fs.readFileSync(path.join(racine, 'revocations.json'), 'utf8'));
    revocation = verifierRevocation(brut, o.clePublique || CLE_PUBLIQUE);
  } catch (e) { revocation = null; }

  return etat({
    manifeste: manifeste,
    clePublique: o.clePublique !== undefined ? o.clePublique : CLE_PUBLIQUE,
    revocation: revocation,
    version: o.version || '',
    lues: manifeste ? lireEmpreintes(racine, manifeste) : {}
  });
}

module.exports = {
  CREATEUR: CREATEUR,
  lireEmpreintes: lireEmpreintes,
  inspecter: inspecter,
  APPLICATION: APPLICATION,
  CLE_PUBLIQUE: CLE_PUBLIQUE,
  CODES: CODES,
  ETATS: ETATS,
  empreinte: empreinte,
  canoniser: canoniser,
  empreinteCorpus: empreinteCorpus,
  identifiant: identifiant,
  construire: construire,
  sceller: sceller,
  verifierSceau: verifierSceau,
  verifierFichiers: verifierFichiers,
  verifierRevocation: verifierRevocation,
  estRevoquee: estRevoquee,
  etat: etat,
  estSensible: estSensible
};
