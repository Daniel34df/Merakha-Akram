'use strict';

/* Les appels à passer.

   Le défaut que ces tests gardent fermé : une personne sans adresse
   électronique était appelée **une fois**, puis son courrier sortait de la
   liste pour toujours. Si elle ne venait pas, plus rien ne la ramenait —
   alors qu'une personne joignable par écrit est relancée trois fois. */

const test = require('node:test');
const assert = require('node:assert/strict');
const appels = require('../assets/js/appels.js');

const JOUR = 24 * 60 * 60 * 1000;
const MAINTENANT = new Date('2026-08-08T10:00:00.000Z').getTime();
const ilYa = j => new Date(MAINTENANT - j * JOUR).toISOString();
const o = { maintenant: MAINTENANT };

function courrier(extra) {
  return Object.assign(
    {
      id: 'h1',
      name: 'Amina Diallo',
      email: '',
      date: ilYa(10),
      status: 'à prévenir',
      pickedUpAt: null,
      closedAt: null,
      appels: []
    },
    extra || {}
  );
}

/* ---------- à prévenir ---------- */

test('un courrier sans adresse, jamais annoncé, est à prévenir', function () {
  assert.equal(appels.aPrevenir([courrier()]).length, 1);
});

test('un courrier avec une adresse ne passe pas par le téléphone', function () {
  // Celui-là est relancé par écrit : le mettre ici le ferait traiter deux fois.
  assert.equal(appels.aPrevenir([courrier({ email: 'amina@example.org' })]).length, 0);
});

test('un courrier retiré, classé ou en échec sort des deux listes', function () {
  ['pickedUpAt', 'closedAt'].forEach(function (champ) {
    const c = courrier({ status: 'prévenu', appels: [{ at: ilYa(30), joint: true }] });
    c[champ] = ilYa(1);
    assert.equal(appels.aPrevenir([c]).length, 0, champ);
    assert.equal(appels.aRappeler([c], o).length, 0, champ);
  });
  const echec = courrier({ status: 'échec' });
  assert.equal(appels.aPrevenir([echec]).length, 0);
});

/* ---------- à rappeler : le trou qu'on bouche ---------- */

test('appelée hier, on ne la rappelle pas aujourd’hui', function () {
  const c = courrier({ status: 'prévenu', appels: [{ at: ilYa(1), joint: true }] });
  assert.equal(appels.aRappeler([c], o).length, 0, 'sept jours n’ont pas passé');
  assert.equal(appels.aPrevenir([c]).length, 0, 'et elle a bien été prévenue');
});

test('appelée il y a huit jours et toujours pas venue : on rappelle', function () {
  const c = courrier({ status: 'prévenu', appels: [{ at: ilYa(8), joint: true }] });
  const liste = appels.aRappeler([c], o);
  assert.equal(liste.length, 1, 'c’est tout l’objet de ce module');
  assert.equal(liste[0].id, 'h1');
});

test('venue chercher son courrier, elle ne revient dans aucune liste', function () {
  const c = courrier({ status: 'prévenu', pickedUpAt: ilYa(2), appels: [{ at: ilYa(9), joint: true }] });
  assert.equal(appels.aRappeler([c], o).length, 0);
});

test('au-delà de trois rappels, on cesse d’insister', function () {
  const trois = [{ at: ilYa(8), joint: true }, { at: ilYa(20), joint: true }, { at: ilYa(30), joint: true }];
  assert.equal(appels.aRappeler([courrier({ status: 'prévenu', appels: trois })], o).length, 1);

  const quatre = trois.concat([{ at: ilYa(40), joint: true }]);
  assert.equal(
    appels.aRappeler([courrier({ status: 'prévenu', appels: quatre })], o).length,
    0,
    'le dossier « à traiter » prend le relais'
  );
});

test('les sonneries dans le vide ne comptent pas comme des appels aboutis', function () {
  /* Un appel sans réponse est une tentative, pas une notification : le
     courrier reste « à prévenir » et n'entame pas le quota de rappels. */
  const c = courrier({
    appels: [{ at: ilYa(1), joint: false }, { at: ilYa(2), joint: false }]
  });
  assert.equal(appels.appelsJoints(c).length, 0);
  assert.equal(appels.aPrevenir([c]).length, 1, 'elle n’a toujours pas été jointe');
  assert.equal(appels.aRappeler([c], o).length, 0);
});

test('un courrier d’avant le journal d’appels est rattrapé par « appeleA »', function () {
  // Les entrées antérieures n'ont pas de tableau d'appels, seulement la date.
  const c = courrier({ status: 'prévenu', appels: undefined, appeleA: ilYa(9) });
  assert.equal(appels.aRappeler([c], o).length, 1);
});

test('marqué prévenu sans aucune trace d’appel : on ne rappelle pas au hasard', function () {
  const c = courrier({ status: 'prévenu', appels: [], appeleA: null });
  assert.equal(appels.aRappeler([c], o).length, 0, 'sans date, aucun délai ne peut être écoulé');
});

test('le délai et le plafond se règlent', function () {
  const c = courrier({ status: 'prévenu', appels: [{ at: ilYa(3), joint: true }] });
  assert.equal(appels.aRappeler([c], { maintenant: MAINTENANT, delaiJours: 2 }).length, 1);
  assert.equal(appels.aRappeler([c], { maintenant: MAINTENANT, delaiJours: 15 }).length, 0);
  assert.equal(appels.aRappeler([c], { maintenant: MAINTENANT, maxRappels: 0 }).length, 0);
});

/* ---------- la liste du matin ---------- */

test('la liste du matin met les inconnus devant, puis les plus attendus', function () {
  const neuf = courrier({ id: 'neuf' });
  const vieux = courrier({ id: 'vieux', status: 'prévenu', appels: [{ at: ilYa(30), joint: true }] });
  const recent = courrier({ id: 'recent', status: 'prévenu', appels: [{ at: ilYa(8), joint: true }] });

  const liste = appels.listeDuJour([recent, vieux, neuf], o);
  assert.deepEqual(liste.map(l => l.entree.id), ['neuf', 'vieux', 'recent']);
  assert.deepEqual(liste.map(l => l.motif), ['prevenir', 'rappeler', 'rappeler']);
  assert.equal(liste[1].depuis, 30, 'l’écran peut dire depuis combien de temps');
  assert.equal(liste[2].tentatives, 1, 'et combien de fois on a déjà appelé');
});

test('personne à appeler : la liste est vide, pas indéfinie', function () {
  assert.deepEqual(appels.listeDuJour([], o), []);
  assert.deepEqual(appels.listeDuJour(undefined, o), []);
});
