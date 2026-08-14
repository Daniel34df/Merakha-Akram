'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dom = require('../assets/js/domiciliation.js');

const JOUR = 24 * 60 * 60 * 1000;
const MAINTENANT = new Date('2026-08-07T12:00:00.000Z').getTime();
const ilYA = j => new Date(MAINTENANT - j * JOUR).toISOString();
const jourIlYA = j => ilYA(j).slice(0, 10);

/* ---------- échéance de l'attestation ---------- */

test('l’échéance tombe douze mois après l’élection de domicile', function () {
  assert.equal(dom.echeance('2026-03-15'), '2027-03-15');
  assert.equal(dom.echeance('2026-01-01'), '2027-01-01');
  assert.equal(dom.echeance(''), '');
  assert.equal(dom.echeance('pas une date'), '');
});

test('une échéance qui tomberait un 31 inexistant recule au dernier jour du mois', function () {
  // 31 mars + 1 mois donnerait le 1er mai : on veut le 30 avril.
  assert.equal(dom.echeance('2026-03-31', { validiteMois: 1 }), '2026-04-30');
  assert.equal(dom.echeance('2026-01-31', { validiteMois: 1 }), '2026-02-28');
});

test('la durée de validité est un réglage, pas une règle figée', function () {
  assert.equal(dom.echeance('2026-03-15', { validiteMois: 6 }), '2026-09-15');
});

/* ---------- dernier passage ---------- */

test('le dernier passage retient le signe de vie le plus récent', function () {
  const contact = {
    id: 'c1',
    email: 'ana@ex.com',
    domicilie: true,
    domicilieDepuis: jourIlYA(300),
    passages: [{ at: ilYA(40) }, { at: ilYA(90) }]
  };
  const history = [
    { contactId: 'c1', email: 'ana@ex.com', pickedUpAt: ilYA(70) },
    { contactId: 'c1', email: 'ana@ex.com', pickedUpAt: null }
  ];
  const passage = dom.dernierPassage(contact, history, MAINTENANT);
  assert.equal(passage, ilYA(40), 'la visite sans courrier compte autant qu’un retrait');
});

test('un retrait de courrier vaut passage, même sans visite saisie', function () {
  const contact = { id: 'c1', email: 'ana@ex.com', domicilie: true, domicilieDepuis: jourIlYA(300) };
  const history = [{ contactId: 'c1', email: 'ana@ex.com', pickedUpAt: ilYA(12) }];
  assert.equal(dom.dernierPassage(contact, history, MAINTENANT), ilYA(12));
});

test('sans aucun signe de vie, l’ouverture du dossier fait foi', function () {
  const contact = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(50) };
  const passage = dom.dernierPassage(contact, [], MAINTENANT);
  assert.equal(passage.slice(0, 10), jourIlYA(50));
});

test('le courrier d’un autre destinataire ne compte pas comme passage', function () {
  const contact = { id: 'c1', email: 'ana@ex.com', domicilie: true, domicilieDepuis: jourIlYA(200) };
  const history = [{ contactId: 'c2', email: 'bo@ex.com', pickedUpAt: ilYA(3) }];
  assert.equal(dom.dernierPassage(contact, history, MAINTENANT).slice(0, 10), jourIlYA(200));
});

/* ---------- état d'un dossier ---------- */

test('un dossier sans domiciliation le dit simplement', function () {
  assert.equal(dom.etat({ id: 'c1' }, [], { now: MAINTENANT }).etat, 'aucune');
});

test('une attestation récente est active', function () {
  const c = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(30), passages: [{ at: ilYA(5) }] };
  const e = dom.etat(c, [], { now: MAINTENANT });
  assert.equal(e.etat, 'active');
  assert.equal(e.risqueRadiation, false);
  assert.ok(e.joursRestants > 300);
});

test('une attestation proche du terme passe en « à renouveler »', function () {
  const c = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(350), passages: [{ at: ilYA(2) }] };
  const e = dom.etat(c, [], { now: MAINTENANT });
  assert.equal(e.etat, 'bientot');
  assert.match(e.libelle, /à renouveler sous \d+ jour/);
});

test('une attestation dépassée est signalée comme expirée', function () {
  const c = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(400), passages: [{ at: ilYA(2) }] };
  const e = dom.etat(c, [], { now: MAINTENANT });
  assert.equal(e.etat, 'expiree');
  assert.ok(e.joursRestants < 0);
  assert.match(e.libelle, /expirée depuis \d+ jour/);
});

test('une domiciliation close reste close, quelles que soient les dates', function () {
  const c = {
    id: 'c1',
    domicilie: true,
    domicilieDepuis: jourIlYA(400),
    domiciliationCloseLe: jourIlYA(10),
    domiciliationMotif: 'déménagement'
  };
  const e = dom.etat(c, [], { now: MAINTENANT });
  assert.equal(e.etat, 'close');
  assert.equal(e.motif, 'déménagement');
});

/* ---------- règle des trois mois ---------- */

test('une absence prolongée est signalée avant d’atteindre le seuil', function () {
  // Seuil à ~91 jours, préavis de 21 jours : à 75 jours on alerte déjà.
  const c = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(200), passages: [{ at: ilYA(75) }] };
  const e = dom.etat(c, [], { now: MAINTENANT });
  assert.equal(e.risqueRadiation, true, 'on alerte avant, pour laisser le temps de joindre');
  assert.equal(e.absenceDepassee, false, 'mais le seuil n’est pas encore franchi');
});

test('au-delà de trois mois, le seuil est franchi', function () {
  const c = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(300), passages: [{ at: ilYA(100) }] };
  const e = dom.etat(c, [], { now: MAINTENANT });
  assert.equal(e.absenceDepassee, true);
  assert.equal(e.joursSansPassage, 100);
});

test('une attestation valable n’empêche pas d’être menacé de radiation', function () {
  // Le dossier est neuf, mais la personne n'est jamais revenue.
  const c = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(120) };
  const e = dom.etat(c, [], { now: MAINTENANT });
  assert.equal(e.etat, 'active', 'l’attestation court encore');
  assert.equal(e.absenceDepassee, true, 'et pourtant plus aucun signe de vie');
});

/* ---------- listes de travail ---------- */

const jeu = () => [
  { id: 'ok', name: 'À jour', domicilie: true, domicilieDepuis: jourIlYA(30), passages: [{ at: ilYA(3) }] },
  { id: 'bientot', name: 'Bientôt', domicilie: true, domicilieDepuis: jourIlYA(345), passages: [{ at: ilYA(3) }] },
  { id: 'expiree', name: 'Expirée', domicilie: true, domicilieDepuis: jourIlYA(500), passages: [{ at: ilYA(3) }] },
  { id: 'absent', name: 'Absent', domicilie: true, domicilieDepuis: jourIlYA(100), passages: [{ at: ilYA(95) }] },
  { id: 'close', name: 'Close', domicilie: true, domicilieDepuis: jourIlYA(500), domiciliationCloseLe: jourIlYA(5) },
  { id: 'pas', name: 'Pas domicilié' }
];

test('aRenouveler ne retient que les échéances proches ou dépassées', function () {
  const liste = dom.aRenouveler(jeu(), [], { now: MAINTENANT });
  assert.deepEqual(
    liste.map(function (d) {
      return d.contact.id;
    }),
    ['expiree', 'bientot'],
    'le plus urgent d’abord, et la domiciliation close est écartée'
  );
});

test('sansPassage liste les personnes à contacter avant radiation', function () {
  const liste = dom.sansPassage(jeu(), [], { now: MAINTENANT });
  assert.deepEqual(
    liste.map(function (d) {
      return d.contact.id;
    }),
    ['absent']
  );
  assert.equal(liste[0].etat.joursSansPassage, 95);
});

/* ---------- rapport annuel ---------- */

test('le rapport annuel compte ouvertures, clôtures et motifs', function () {
  const contacts = [
    { id: 'a', domicilie: true, domicilieDepuis: '2026-02-10' },
    { id: 'b', domicilie: true, domicilieDepuis: '2025-11-03' },
    { id: 'c', domicilie: true, domicilieDepuis: '2026-04-01', domiciliationCloseLe: '2026-07-15', domiciliationMotif: 'déménagement' },
    { id: 'd', domicilie: true, domicilieDepuis: '2026-05-01', domiciliationCloseLe: '2026-06-01', domiciliationMotif: 'déménagement' },
    { id: 'e', domicilie: true, domicilieDepuis: '2026-05-02', domiciliationCloseLe: '2026-06-02', domiciliationMotif: 'absence de trois mois' },
    { id: 'f' }
  ];
  const history = [
    { contactId: 'a', date: '2026-03-01T10:00:00.000Z', pickedUpAt: '2026-03-05T10:00:00.000Z' },
    { contactId: 'a', date: '2026-03-20T10:00:00.000Z', pickedUpAt: null },
    { contactId: 'b', date: '2025-12-01T10:00:00.000Z', pickedUpAt: '2025-12-02T10:00:00.000Z' },
    { contactId: 'f', date: '2026-03-01T10:00:00.000Z', pickedUpAt: null }
  ];

  const r = dom.rapportAnnuel(contacts, history, { annee: 2026 });
  assert.equal(r.actives, 2, 'a et b restent ouvertes');
  assert.equal(r.ouvertesDansLAnnee, 4, 'b date de 2025');
  assert.equal(r.closesDansLAnnee, 3);
  assert.deepEqual(r.motifs, { 'déménagement': 2, 'absence de trois mois': 1 });
  assert.equal(r.courriersRecus, 2, 'ceux de 2026 pour des personnes domiciliées');
  assert.equal(r.courriersRetires, 1);
});

test('un rapport sur une année sans activité ne se plaint pas', function () {
  const r = dom.rapportAnnuel([], [], { annee: 2020 });
  assert.equal(r.actives, 0);
  assert.equal(r.ouvertesDansLAnnee, 0);
  assert.deepEqual(r.motifs, {});
});

test('un réglage absent ne doit pas annuler le seuil par défaut', function () {
  /* Object.assign laisserait `undefined` écraser la valeur par défaut : le
     seuil deviendrait NaN et plus personne ne serait jamais signalé. */
  const c = { id: 'c1', domicilie: true, domicilieDepuis: jourIlYA(120) };
  const e = dom.etat(c, [], { now: MAINTENANT, absenceMois: undefined, validiteMois: undefined });
  assert.equal(e.seuilAbsenceJours, 91);
  assert.equal(e.absenceDepassee, true);
  assert.equal(dom.sansPassage([c], [], { now: MAINTENANT, absenceMois: undefined }).length, 1);
});

/* ═══════════ un appel de la personne compte ═══════════

   La loi parle de « présentée **ou manifestée** ». Le registre ne comptait que
   les venues sur place et les courriers retirés : quelqu'un qui téléphonait
   tous les mois sans pouvoir se déplacer — parce qu'il travaille, parce qu'il
   est hospitalisé, parce qu'il n'a pas de quoi payer le transport — apparaissait
   absent depuis trois mois et arrivait sur la liste des radiations. */

const domicilieDepuis = jourIlYA(400);

function dossier(passages) {
  return {
    id: 'c1',
    name: 'Amina Diallo',
    email: '',
    domicilie: true,
    domicilieDepuis: domicilieDepuis,
    domicilieJusqua: jourIlYA(-200),
    passages: passages || []
  };
}

test('un appel de la personne repousse le risque de radiation', function () {
  // Jamais venue depuis l'ouverture du dossier : elle est en risque.
  const muette = dossier([]);
  const avant = dom.etat(muette, [], { now: MAINTENANT });
  assert.equal(avant.risqueRadiation, true, 'sans aucun signe de vie, le risque est signalé');

  // Elle a appelé le mois dernier : c'est une manifestation.
  const appelante = dossier([{ at: ilYA(30), moyen: 'telephone', par: 'Agent' }]);
  const apres = dom.etat(appelante, [], { now: MAINTENANT });
  assert.equal(apres.risqueRadiation, false, 'c’est tout l’objet du correctif');
  assert.equal(apres.joursSansPassage, 30);
  assert.equal(apres.dernierMoyen, 'telephone');
});

test('elle sort de la liste des radiations à venir', function () {
  const muette = dossier([]);
  const appelante = Object.assign(dossier([{ at: ilYA(30), moyen: 'telephone' }]), { id: 'c2' });
  const liste = dom.sansPassage([muette, appelante], [], { now: MAINTENANT });
  assert.deepEqual(liste.map(function (d) { return d.contact.id; }), ['c1']);
});

test('le canal est rendu, pour que l’équipe fasse la différence', function () {
  /* Le décompte ne distingue pas ; l'équipe si. Quelqu'un qu'on n'a pas vu
     depuis trois mois mais qui téléphone n'est pas dans la même situation que
     quelqu'un qui a disparu. */
  const surPlace = dom.derniereManifestation(dossier([{ at: ilYA(5) }]), []);
  assert.equal(surPlace.moyen, 'place', 'un passage sans « moyen » reste une venue');

  const parTelephone = dom.derniereManifestation(dossier([{ at: ilYA(5), moyen: 'telephone' }]), []);
  assert.equal(parTelephone.moyen, 'telephone');

  const retrait = dom.derniereManifestation(dossier([]), [
    { contactId: 'c1', pickedUpAt: ilYA(3) }
  ]);
  assert.equal(retrait.moyen, 'retrait');

  const rien = dom.derniereManifestation(dossier([]), []);
  assert.equal(rien.moyen, 'ouverture', 'à défaut, l’ouverture du dossier fait foi');
});

test('c’est la manifestation la plus récente qui compte, quel que soit le canal', function () {
  const c = dossier([{ at: ilYA(40), moyen: 'telephone' }, { at: ilYA(60) }]);
  const recent = dom.derniereManifestation(c, [{ contactId: 'c1', pickedUpAt: ilYA(10) }]);
  assert.equal(recent.moyen, 'retrait', 'le retrait est plus récent que l’appel');

  const inverse = dom.derniereManifestation(c, [{ contactId: 'c1', pickedUpAt: ilYA(90) }]);
  assert.equal(inverse.moyen, 'telephone', 'ici c’est l’appel le plus récent');
});

test('dernierPassage rend toujours une date, comme avant', function () {
  // La fonction d'origine reste : tout ce qui l'appelait continue de marcher.
  const c = dossier([{ at: ilYA(5), moyen: 'telephone' }]);
  assert.equal(dom.dernierPassage(c, []), ilYA(5));
  assert.equal(typeof dom.dernierPassage(c, []), 'string');
});

/* ── comment la personne s'est manifestée, dit en français ──

   Le libellé vivait dans l'interface, dans un seul des trois écrans qui
   l'affichent. Il appartient à la notion : `derniereManifestation` rend un
   moyen, et c'est ici qu'on sait comment il se dit. */

test('chaque moyen de manifestation a son libellé', function () {
  assert.equal(dom.libelleMoyen('place'), 'passage');
  assert.equal(dom.libelleMoyen('telephone'), 'appel de sa part');
  assert.equal(dom.libelleMoyen('retrait'), 'courrier retiré');
  assert.equal(dom.libelleMoyen('ouverture'), 'ouverture du dossier');
});

test('les quatre moyens que le calcul rend sont tous nommés', function () {
  /* Le vrai risque : ajouter un moyen dans `derniereManifestation` et oublier
     son libellé. L'écran afficherait alors une étiquette vide, sans rien dire. */
  const MOYENS = ['place', 'telephone', 'retrait', 'ouverture'];
  MOYENS.forEach(function (m) {
    assert.ok(dom.libelleMoyen(m), 'le moyen « ' + m + ' » n’a pas de libellé');
  });
  assert.deepEqual(Object.keys(dom.MOYENS).sort(), MOYENS.slice().sort());
});

test('un moyen inconnu ne rend rien, et surtout pas « undefined »', function () {
  assert.equal(dom.libelleMoyen('autre'), '');
  assert.equal(dom.libelleMoyen(undefined), '');
  assert.equal(dom.libelleMoyen(null), '');
});
