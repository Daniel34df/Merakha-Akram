'use strict';

/* La couche de persistance, côté poste.

   Ces tests existent parce qu'un bug y a vécu sans être vu : « updateContact »
   énumérait les champs d'une fiche un par un, et le téléphone n'y figurait
   pas. Corriger un numéro le renvoyait inchangé — sans erreur, sans message,
   la personne restait injoignable. Rien ne pouvait l'attraper : le fichier
   n'était pas chargeable hors navigateur.

   Il l'est maintenant. En mode « mémoire », rien ne sort du processus : ni
   réseau, ni localStorage. C'est le mode par défaut sous Node, donc ces tests
   n'ont besoin d'aucun échafaudage. */

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../assets/js/store.js');

function fiche(extra) {
  return Object.assign(
    {
      id: 'c1',
      name: 'Amina Diallo',
      email: '',
      telephone: '06 12 34 56 78',
      box: 'B-12',
      naissance: '1988-04-02',
      notes: 'Passe le mardi',
      langue: 'fr',
      antenneId: '',
      absentUntil: '',
      departed: false,
      substituteId: null,
      domicilie: true,
      domicilieDepuis: '2026-01-10',
      domicilieJusqua: '2027-01-10',
      domiciliationCloseLe: '',
      domiciliationMotif: ''
    },
    extra || {}
  );
}

function poser(contacts) {
  store.state.mode = 'mémoire';
  store.state.contacts = contacts;
  store.state.history = [];
}

/* ---------- ce que la modification transporte ---------- */

test('corriger un téléphone enregistre le nouveau numéro', async function () {
  poser([fiche()]);
  const r = await store.updateContact('c1', {
    name: 'Amina Diallo',
    email: '',
    box: 'B-12',
    telephone: '07 98 76 54 32'
  });
  assert.equal(r.telephone, '07 98 76 54 32');
  assert.equal(store.state.contacts[0].telephone, '07 98 76 54 32');
});

test('corriger une date de naissance et des observations les enregistre', async function () {
  poser([fiche()]);
  const r = await store.updateContact('c1', {
    name: 'Amina Diallo',
    email: '',
    telephone: '06 12 34 56 78',
    naissance: '1988-04-03',
    notes: 'Passe le jeudi'
  });
  assert.equal(r.naissance, '1988-04-03');
  assert.equal(r.notes, 'Passe le jeudi');
});

/* ---------- ce que la modification ne doit pas emporter ---------- */

test('une correction de nom seule ne touche ni la domiciliation ni le téléphone', async function () {
  poser([fiche()]);
  const r = await store.updateContact('c1', { name: 'Amina Diallo-Sow' });
  assert.equal(r.name, 'Amina Diallo-Sow');
  assert.equal(r.telephone, '06 12 34 56 78');
  assert.equal(r.domicilie, true);
  assert.equal(r.domicilieDepuis, '2026-01-10');
  assert.equal(r.domicilieJusqua, '2027-01-10');
  assert.equal(r.naissance, '1988-04-02');
  assert.equal(r.notes, 'Passe le mardi');
});

test('une échéance renouvelée survit à une correction qui la mentionne', async function () {
  // Renouvelée en cours d'année : l'échéance ne suit plus la date d'élection.
  poser([fiche({ domicilieJusqua: '2027-06-30' })]);
  const r = await store.updateContact('c1', {
    name: 'Amina Diallo',
    email: '',
    telephone: '06 12 34 56 78',
    domicilie: true,
    domicilieDepuis: '2026-01-10',
    domicilieJusqua: '2027-06-30'
  });
  assert.equal(r.domicilieDepuis, '2026-01-10', 'l’ancienneté se garde');
  assert.equal(r.domicilieJusqua, '2027-06-30', 'le renouvellement ne doit pas être annulé');
});

test('une clôture posée sur la fiche n’est pas effacée par une correction de nom', async function () {
  poser([fiche({ domiciliationCloseLe: '2026-07-01', domiciliationMotif: 'relogée' })]);
  const r = await store.updateContact('c1', { name: 'Amina D.' });
  assert.equal(r.domiciliationCloseLe, '2026-07-01');
  assert.equal(r.domiciliationMotif, 'relogée');
});

/* ---------- normalisations ---------- */

test('les champs de texte sont ébarbés, la langue ramenée à une langue connue', async function () {
  poser([fiche()]);
  const r = await store.updateContact('c1', {
    name: '  Amina Diallo  ',
    email: '  amina@example.org ',
    box: ' B-13 ',
    telephone: '  06 12 34 56 78  ',
    langue: 'klingon'
  });
  assert.equal(r.name, 'Amina Diallo');
  assert.equal(r.email, 'amina@example.org');
  assert.equal(r.box, 'B-13');
  assert.equal(r.telephone, '06 12 34 56 78');
  assert.equal(r.langue, 'fr');
});

test('modifier une fiche absente du registre ne crée rien', async function () {
  poser([fiche()]);
  const r = await store.updateContact('inconnu', { name: 'Personne' });
  assert.equal(r, null);
  assert.equal(store.state.contacts.length, 1);
});

/* ---------- doublons ---------- */

test('deux personnes sans courriel ne sont pas le même doublon', function () {
  poser([fiche({ id: 'a', email: '' }), fiche({ id: 'b', email: '' })]);
  /* « '' === '' » désignait la première fiche sans adresse venue : à l'import,
     la deuxième personne sans courriel était refusée comme déjà présente. */
  assert.equal(store.findByEmail(''), null);
  assert.equal(store.findByEmail('   '), null);
  assert.equal(store.findByEmail(undefined), null);
});

test('un courriel connu retrouve bien sa fiche, à la casse près', function () {
  poser([fiche({ id: 'a', email: 'amina@example.org' }), fiche({ id: 'b', email: '' })]);
  const t = store.findByEmail('  AMINA@Example.ORG ');
  assert.ok(t, 'le doublon doit être trouvé');
  assert.equal(t.id, 'a');
  assert.equal(store.findByEmail('personne@example.org'), null);
});

/* ---------- le rejeu de la file hors ligne ----------

   Ce que le poste envoie quand le réseau revient, et ce qu'il fait de la
   réponse. Le serveur, lui, est vérifié dans `test/idempotence.test.js` ;
   ici on ne regarde que le poste, avec un faux réseau. */

const attente = require('../assets/js/attente.js');

function reponse(objet, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    json: async function () {
      return objet;
    }
  };
}

/* Rejoue la file avec un faux réseau. `repondre(url, opts, n)` rend le corps
   de la réponse ; tous les appels sont conservés pour être relus après coup. */
async function rejouer(file, contacts, repondre) {
  const vrai = globalThis.fetch;
  const appels = [];
  store.state.mode = 'serveur';
  store.state.enLigne = true;
  store.state.rejeuEnCours = false;
  store.state.file = file;
  store.state.contacts = contacts;
  store.state.history = [];
  globalThis.fetch = async function (url, opts) {
    appels.push({ url: url, opts: opts, contactsAlors: store.state.contacts.slice() });
    // Le rechargement final : hors sujet ici, on le rend vide.
    if (url === '/api/state') return reponse({ contacts: [], history: [] });
    return reponse(repondre(url, opts, appels.length - 1), url.indexOf('/contacts') > 0 ? 200 : 201);
  };
  try {
    const bilan = await store.viderFile();
    return { bilan: bilan, appels: appels };
  } finally {
    globalThis.fetch = vrai;
  }
}

const CREATION = attente.creerIntention({
  id: 'local-op000001',
  op: 'contact.create',
  method: 'POST',
  path: '/contacts',
  idLocal: 'local-x',
  body: { id: 'local-x', name: 'Amina Diallo' },
  description: 'Fiche créée pour Amina Diallo'
});
const PASSAGE = attente.creerIntention({
  id: 'local-op000002',
  op: 'contact.passage',
  method: 'POST',
  path: '/contacts/local-x/passage',
  body: { moyen: 'place' },
  description: 'Passage enregistré'
});

test('chaque écriture rejouée porte l’identifiant de son intention', async function () {
  /* Sans cet en-tête, le serveur ne peut pas reconnaître une écriture qu'il a
     déjà exécutée et dont la réponse s'est perdue en route. */
  const r = await rejouer([CREATION], [fiche({ id: 'local-x' })], function () {
    return { id: 'c-serveur', name: 'Amina Diallo' };
  });
  assert.equal(r.appels[0].opts.headers['X-Operation-Id'], 'local-op000001');
  assert.equal(r.bilan.envoyees, 1);
});

test('un rejeu reconnu recolle les identifiants sans effacer la fiche', async function () {
  /* Le serveur répond « je l'ai déjà fait, voici l'identifiant » : il n'envoie
     pas la fiche, il n'a pas de raison de renvoyer un nom et un téléphone. Le
     poste doit s'en servir pour la substitution — et surtout ne pas poser cet
     accusé de réception à la place de la fiche affichée. */
  const r = await rejouer([CREATION, PASSAGE], [fiche({ id: 'local-x' })], function (url, opts, n) {
    return n === 0 ? { rejoue: true, id: 'c-serveur' } : { contact: { id: 'c-serveur' } };
  });

  assert.equal(r.appels[1].url, '/api/contacts/c-serveur/passage', 'l’identifiant provisoire a été substitué dans la suite de la file');
  const affichee = r.appels[1].contactsAlors[0];
  assert.equal(affichee.name, 'Amina Diallo', 'la fiche est restée une fiche');
  assert.equal(affichee.telephone, '06 12 34 56 78');
  assert.notEqual(affichee.rejoue, true);
});

test('une vraie réponse, elle, remplace bien la fiche provisoire', async function () {
  /* Le garde-fou ci-dessus ne doit pas bloquer le cas ordinaire : quand le
     serveur renvoie la fiche, c'est elle qui fait foi. */
  const r = await rejouer([CREATION, PASSAGE], [fiche({ id: 'local-x' })], function (url, opts, n) {
    return n === 0 ? { contact: { id: 'c-serveur', name: 'Amina Diallo', telephone: '07 98 76 54 32' } } : { contact: {} };
  });
  assert.equal(r.appels[1].contactsAlors[0].id, 'c-serveur');
  assert.equal(r.appels[1].contactsAlors[0].telephone, '07 98 76 54 32');
});
