/* Vérification : le rendu paresseux.
 *
 * Ce que ça règle, mesuré. Sur un registre de deux ans — 300 fiches, 6 000
 * courriers — un rendu complet coûtait 356 ms. Et il ne se déclenche pas
 * seulement quand on clique : **chaque écriture faite sur le poste d'à côté**
 * en provoque un, par la synchronisation en direct. Le guichet se figeait un
 * tiers de seconde sous les doigts de quelqu'un en train de taper, sans raison
 * visible pour lui.
 *
 * On ne peint donc que l'écran ouvert. Ce script garde fermées les trois
 * façons dont ça peut mal tourner :
 *
 *   1. **Un compteur d'onglet qui ment.** Les compteurs sont visibles en
 *      permanence ; s'ils étaient calculés en peignant les écrans, ils
 *      resteraient figés. Un tableau non peint, on le voit en l'ouvrant ; un
 *      compteur faux, on le croit. C'est le seul mensonge que ce changement
 *      pouvait introduire, et c'est celui qui compte.
 *
 *   2. **Un écran qui reste vieux.** Ouvrir un onglet masqué depuis dix
 *      minutes doit montrer l'état d'aujourd'hui. Sinon on aurait échangé une
 *      lenteur contre un mensonge, ce qui est un mauvais marché.
 *
 *   3. **Un écran visible qui ne suit plus.** Ce qu'on regarde doit se mettre
 *      à jour tout de suite, sans changer d'onglet.
 */
'use strict';

const C = require('./commun.js');

const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);
  await page.waitForTimeout(600);

  /* ---- 1. le compteur dit vrai sans que l'écran soit peint ---- */
  console.log('\n1. Le compteur d’onglet ne ment pas, même sans peindre l’écran');
  await page.evaluate(async () => {
    const S = window.BC.store;
    await S.addContact({ name: 'Zoé Nouvelle', telephone: '06 55 55 55 55' });
    await S.loadServerState();
    window.BC.ui.ecrans.app.renderAll();
  });
  await page.waitForTimeout(800);

  const compteur = await page.$eval('#tabCountContacts', (e) => e.textContent);
  ok(compteur === '1', 'l’onglet Registre annonce la bonne fiche (' + compteur + ')');

  const lignesAvant = await page.$$eval('#contactsTable tbody tr', (e) => e.length);
  ok(lignesAvant === 0,
    'et le tableau, lui, n’a pas été peint — c’est là qu’est le temps gagné (' + lignesAvant + ')');

  /* ---- 2. l'écran se rattrape en s'ouvrant ---- */
  console.log('\n2. Un écran masqué se rattrape quand on l’ouvre');
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(700);
  const apres = await page.$$eval('#contactsTable tbody tr', (e) =>
    e.map((t) => t.innerText).join(' | '));
  ok(/Zoé Nouvelle/.test(apres),
    'la fiche arrivée pendant que l’écran dormait y est bien');

  /* ---- 3. l'écran visible suit sans qu'on change d'onglet ---- */
  console.log('\n3. L’écran qu’on regarde suit tout de suite');
  await page.evaluate(async () => {
    const S = window.BC.store;
    await S.addContact({ name: 'Karim Second', telephone: '06 44 44 44 44' });
    await S.loadServerState();
    window.BC.ui.ecrans.app.renderAll();
  });
  await page.waitForTimeout(800);
  const encore = await page.$$eval('#contactsTable tbody tr', (e) =>
    e.map((t) => t.innerText).join(' | '));
  ok(/Karim Second/.test(encore), 'la deuxième fiche paraît sans changer d’onglet');
  ok(/Zoé Nouvelle/.test(encore), 'et la première est toujours là');

  /* ---- 4. le gain, mesuré ---- */
  console.log('\n4. Ce que ça coûte, sur un registre de deux ans');
  const mesure = await page.evaluate(() => {
    const S = window.BC.store;
    const contacts = [];
    for (let i = 0; i < 300; i++) {
      contacts.push({ id: 'c' + i, name: 'Personne ' + i, email: '', telephone: '060000' + i,
        box: 'B-' + String(i % 200).padStart(3, '0'), etiquettes: [] });
    }
    const history = [];
    for (let i = 0; i < 6000; i++) {
      history.push({ id: 'h' + i, contactId: 'c' + (i % 300), name: 'Personne ' + (i % 300),
        email: '', date: new Date(Date.now() - i * 3600000).toISOString(),
        status: 'envoyé', type: 'lettre', pickupCode: String(1000 + (i % 9000)),
        pickedUpAt: i % 3 ? new Date().toISOString() : null, closedAt: null, reminderCount: 0 });
    }
    S.state.contacts = contacts;
    S.state.history = history;

    const t = [];
    for (let i = 0; i < 12; i++) {
      const d = performance.now();
      window.BC.ui.ecrans.app.renderAll();
      t.push(performance.now() - d);
    }
    t.sort((a, b) => a - b);
    return Math.round(t[6]);
  });
  /* Le seuil est large exprès : une machine de vérification n'a pas la vitesse
     d'un poste de bureau, et un seuil serré échouerait pour de mauvaises
     raisons. Ce qu'on garde fermé, c'est le retour au rendu complet — qui
     coûtait 356 ms sur cette même machine. */
  ok(mesure < 200,
    'un rendu coûte ' + mesure + ' ms là où le rendu complet en coûtait 356');

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
