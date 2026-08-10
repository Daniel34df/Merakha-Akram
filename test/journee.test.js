'use strict';

/* Le relevé de journée.

   Ce que ces tests gardent fermé : une passation qui perd ce que l'agent du
   soir savait et que celui du matin ignore. Un colis encombrant posé quelque
   part sans emplacement noté, une personne appelée sans réponse, un envoi
   refusé par le serveur de courriel — trois choses qui, hier, ne survivaient
   pas à la fin du service.

   Le module ne clôt rien : il n'y a pas d'état « journée fermée » dans les
   données. Un bureau où quelqu'un oublie de cliquer ne doit pas se retrouver
   bloqué le lendemain, et un courrier déposé à 17 h 05 doit pouvoir
   s'inscrire. */

const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../assets/js/journee.js');

/* Une heure de l'après-midi, pour que le jour local et le jour UTC coïncident
   dans les cas ordinaires — et un test dédié pour le cas où ils diffèrent. */
const MIDI = '2026-08-10T13:00:00.000Z';
const JOUR = '2026-08-10';

function courrier(extra) {
  return Object.assign(
    { id: 'h' + Math.random(), name: 'Jean Dupont', date: MIDI,
      pickedUpAt: null, closedAt: null, status: 'envoyé', type: 'lettre' },
    extra
  );
}

const VIDE = { history: [], contacts: [], settings: {} };

/* ── le jour, tel qu'il est vécu ── */

test('le jour est celui de l’horloge du bureau, pas celui de Greenwich', function () {
  /* `toISOString().slice(0,10)` donne le jour UTC. Un courrier saisi à 23 h 30
     en été à Paris tomberait alors dans la journée du lendemain, et le relevé
     du soir n'aurait pas la dernière heure de travail. */
  const tard = new Date(2026, 7, 10, 23, 30, 0);
  assert.equal(J.jourLocal(tard), '2026-08-10');
  const tot = new Date(2026, 7, 10, 0, 30, 0);
  assert.equal(J.jourLocal(tot), '2026-08-10');
  assert.equal(J.jourLocal('pas une date'), '');
});

/* ── le compte ── */

test('une journée sans mouvement se dit telle quelle', function () {
  const r = J.releve(VIDE, { at: MIDI });
  assert.equal(r.compte.entres, 0);
  assert.equal(r.calme, true);
  assert.match(J.phrase(r), /Aucun mouvement/);
});

test('entrés, remis et classés se comptent séparément', function () {
  const data = {
    history: [
      courrier(),
      courrier(),
      /* Entré hier, remis aujourd'hui : il compte en sortie, pas en entrée. */
      courrier({ date: '2026-08-09T10:00:00.000Z', pickedUpAt: MIDI }),
      /* Classé sans avoir été remis — parti sans laisser d'adresse. */
      courrier({ date: '2026-08-01T10:00:00.000Z', closedAt: MIDI })
    ],
    contacts: [], settings: {}
  };
  const r = J.releve(data, { at: MIDI });
  assert.equal(r.compte.entres, 2);
  assert.equal(r.compte.sortis, 1);
  assert.equal(r.compte.clos, 1);
  assert.equal(r.compte.enAttente, 2, 'ce que le suivant trouvera en arrivant');
  assert.match(J.phrase(r), /Rien en suspens/);
});

test('un courrier remis le jour même compte une fois en entrée et une fois en sortie', function () {
  const r = J.releve(
    { history: [courrier({ pickedUpAt: MIDI })], contacts: [], settings: {} },
    { at: MIDI }
  );
  assert.equal(r.compte.entres, 1);
  assert.equal(r.compte.sortis, 1);
  assert.equal(r.compte.clos, 0, 'remis n’est pas classé : ce serait le compter deux fois');
});

/* ── ce qui reste en plan : le cœur du relevé ── */

test('un colis encombrant sans emplacement est le point le plus grave', function () {
  /* Il est au registre, il a son code de retrait, et personne demain ne saura
     où il est posé. C'est la seule perte réellement irréversible d'une
     journée ordinaire. */
  const r = J.releve(
    {
      history: [courrier({ type: 'colis', colis: { poids: 14, emplacement: '' } })],
      contacts: [], settings: {}
    },
    { at: MIDI }
  );
  assert.equal(r.suspens[0].cle, 'colisSansEmplacement');
  assert.equal(r.suspens[0].gravite, 'haute');
  assert.match(r.suspens[0].faire, /notez/i, 'la consigne est écrite, pas seulement le constat');
  assert.match(J.phrase(r), /passer la nuit/);
});

test('un petit colis rangé au casier ne réclame rien', function () {
  const r = J.releve(
    {
      history: [courrier({ type: 'colis', colis: { poids: 0.5, emplacement: '' } })],
      contacts: [], settings: {}
    },
    { at: MIDI }
  );
  assert.equal(r.calme, true);
});

test('un colis encombrant dont l’emplacement est noté ne remonte pas', function () {
  const r = J.releve(
    {
      history: [courrier({ type: 'colis', colis: { poids: 14, emplacement: 'étagère du fond' } })],
      contacts: [], settings: {}
    },
    { at: MIDI }
  );
  assert.equal(r.calme, true);
});

test('une personne appelée sans réponse aujourd’hui se transmet', function () {
  /* Sans cette ligne, l'information reste dans la tête de celui qui a appelé,
     et le suivant refait le même appel au même moment de la journée. */
  const r = J.releve(
    {
      history: [courrier({ appels: [{ at: MIDI, joint: false, note: 'sonne dans le vide' }] })],
      contacts: [], settings: {}
    },
    { at: MIDI }
  );
  const s = r.suspens.find(function (x) { return x.cle === 'injoignables'; });
  assert.ok(s, 'la tentative sans réponse remonte');
  assert.match(s.faire, /autre heure/);
});

test('un appel abouti ne remonte pas, et un appel d’hier non plus', function () {
  const r = J.releve(
    {
      history: [
        courrier({ appels: [{ at: MIDI, joint: true }] }),
        courrier({ appels: [{ at: '2026-08-09T13:00:00.000Z', joint: false }] })
      ],
      contacts: [], settings: {}
    },
    { at: MIDI }
  );
  assert.ok(!r.suspens.some(function (x) { return x.cle === 'injoignables'; }));
});

test('un envoi refusé par le serveur de courriel se transmet : personne n’a été prévenu', function () {
  const r = J.releve(
    { history: [courrier({ status: 'échec' })], contacts: [], settings: {} },
    { at: MIDI }
  );
  const s = r.suspens.find(function (x) { return x.cle === 'envoisEchoues'; });
  assert.ok(s);
  assert.match(s.faire, /appelez/i);
});

test('un courrier urgent pèse plus lourd le soir que dans la journée', function () {
  /* En cours de journée c'est un courrier à traiter ; une fois la journée
     passée, c'est une consigne pour l'ouverture. */
  const data = { history: [courrier({ urgent: true })], contacts: [], settings: {} };
  const enJournee = J.releve(data, { at: MIDI, jour: JOUR });
  const leLendemain = J.releve(data, { at: '2026-08-11T09:00:00.000Z', jour: JOUR });
  assert.equal(enJournee.suspens[0].gravite, 'moyenne');
  assert.equal(leLendemain.suspens[0].gravite, 'haute');
  assert.equal(enJournee.enCours, true);
  assert.equal(leLendemain.enCours, false);
});

test('un courrier urgent déjà remis ne se transmet pas', function () {
  const r = J.releve(
    { history: [courrier({ urgent: true, pickedUpAt: MIDI })], contacts: [], settings: {} },
    { at: MIDI }
  );
  assert.equal(r.calme, true);
});

test('relire une journée passée montre cette journée-là, pas aujourd’hui', function () {
  /* Le défaut qu'une vérification de navigateur a trouvé : en ouvrant le
     relevé du 15 janvier 2020, l'écran annonçait « à ne pas laisser passer la
     nuit : un colis encombrant sans emplacement » — à propos d'un colis arrivé
     ce matin, six ans plus tard. « En attente » doit vouloir dire « en attente
     **ce soir-là** ». */
  const data = {
    history: [courrier({ type: 'colis', date: MIDI, colis: { poids: 14, emplacement: '' } })],
    contacts: [], settings: {}
  };
  const vieux = J.releve(data, { at: MIDI, jour: '2020-01-15' });
  assert.deepEqual(vieux.suspens, [], 'ce colis n’existait pas ce jour-là');
  assert.equal(vieux.compte.enAttente, 0);
  assert.match(J.phrase(vieux), /Aucun mouvement/);

  // Et aujourd'hui, il remonte bien.
  assert.equal(J.releve(data, { at: MIDI }).suspens.length, 1);
});

test('un courrier remis depuis reste « en attente » le soir où il l’était', function () {
  /* L'inverse du piège précédent : un relevé qui regarde l'état d'aujourd'hui
     dirait d'une journée passée qu'elle s'est terminée sans rien en suspens,
     alors que l'agent de ce soir-là avait bien un urgent sur les bras. */
  const data = {
    history: [courrier({
      urgent: true,
      date: '2026-08-05T13:00:00.000Z',
      pickedUpAt: '2026-08-07T10:00:00.000Z'
    })],
    contacts: [], settings: {}
  };
  const le5 = J.releve(data, { at: MIDI, jour: '2026-08-05' });
  assert.equal(le5.compte.enAttente, 1, 'ce soir-là, il était encore là');
  assert.equal(le5.suspens[0].cle, 'urgentsEnAttente');

  const le8 = J.releve(data, { at: MIDI, jour: '2026-08-08' });
  assert.equal(le8.compte.enAttente, 0, 'le 8, il était remis depuis la veille');
  assert.deepEqual(le8.suspens, []);
});

/* ── ce qui arrive demain ── */

test('les échéances de domiciliation figurent au relevé', function () {
  const r = J.releve(
    {
      history: [],
      contacts: [{ id: 'c1', name: 'Amina Diallo', domicilie: true, domicilieDepuis: '2024-01-10' }],
      settings: {}
    },
    { at: MIDI }
  );
  assert.equal(r.echeances.length, 1, 'celui qui ouvre demain doit le savoir avant d’ouvrir');
});

test('un bureau sans domiciliation n’a pas d’échéances', function () {
  const r = J.releve(VIDE, { at: MIDI });
  assert.deepEqual(r.echeances, []);
});

/* ── on peut relire une journée passée ── */

test('un jour antérieur se relit tel qu’il a été', function () {
  const data = {
    history: [
      courrier({ date: '2026-08-05T13:00:00.000Z' }),
      courrier({ date: MIDI })
    ],
    contacts: [], settings: {}
  };
  const r = J.releve(data, { at: MIDI, jour: '2026-08-05' });
  assert.equal(r.compte.entres, 1);
  assert.equal(r.enCours, false);
  assert.equal(r.jour, '2026-08-05');
});

/* ── robustesse ── */

test('des données abîmées ne font pas tomber le relevé', function () {
  assert.doesNotThrow(function () { J.releve(null, { at: MIDI }); });
  assert.doesNotThrow(function () { J.releve({}, { at: MIDI }); });
  assert.doesNotThrow(function () {
    J.releve({ history: [null, { date: 'n’importe quoi' }], contacts: [null] }, { at: MIDI });
  });
  assert.equal(J.phrase(null), '');
});
