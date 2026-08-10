/* Vérification : le plan du local.
 *
 * Ce que ce script garde fermé, et qu'aucun test unitaire ne peut voir :
 *
 *   1. **La section existe et s'ouvre.** Le Registre a désormais deux
 *      sections ; une barre qui ne se peint pas rendrait les casiers
 *      inaccessibles sans que rien ne plante.
 *
 *   2. **L'état est écrit, pas seulement coloré** (§33, §54). Chaque case
 *      porte son état en toutes lettres. Un casier hors service pris pour un
 *      casier libre, c'est un courrier rangé derrière une serrure cassée — et
 *      c'est exactement ce qu'une pastille verte/rouge fait à qui distingue
 *      mal les deux.
 *
 *   3. **Le miroir tient à l'écran.** Attribuer un casier depuis le plan doit
 *      se voir aussitôt sur la fiche du destinataire ; le libérer doit l'en
 *      retirer. Les deux moitiés vivent dans deux écrans différents, et rien
 *      d'autre ne vérifie qu'elles racontent la même chose.
 */
'use strict';

const C = require('./commun.js');

const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);

  /* ---- 1. la section ---- */
  console.log('\n1. Les casiers ont leur section dans le Registre');
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(600);

  const sections = await page.$$eval('#registreSections button[data-section]', (bs) =>
    bs.map((x) => x.dataset.section));
  ok(sections.join(',') === 'destinataires,casiers',
    'deux sections, dans cet ordre : ' + sections.join(', '));

  // Au départ, ce sont les personnes qu'on voit — c'est l'usage courant.
  const auDepart = await page.$eval('#registreSections button.active', (x) => x.dataset.section);
  ok(auDepart === 'destinataires', 'le Registre s’ouvre sur les destinataires (' + auDepart + ')');

  await page.click('#registreSections button[data-section="casiers"]');
  await page.waitForTimeout(500);
  ok(await page.isVisible('#casiersPlanCard'), 'la section « Casiers » s’ouvre');
  ok(!(await page.isVisible('#addForm')), 'et referme celle des destinataires');

  /* ---- 2. équiper le local ---- */
  console.log('\n2. Le plan se remplit');
  await page.evaluate(async () => {
    await window.BC.store.creerSerieBoites({ debut: 1, fin: 8, zone: 'Couloir A' });
    await window.BC.store.loadServerState();
  });
  await page.waitForTimeout(700);
  const cases = await page.$$eval('.casier', (x) => x.length);
  ok(cases === 8, 'huit casiers au plan (' + cases + ')');

  /* ---- 3. l'état s'écrit, il ne se devine pas ---- */
  console.log('\n3. Chaque case dit son état en toutes lettres');
  await page.evaluate(async () => {
    const S = window.BC.store;
    await S.loadServerState();
    const cible = S.state.boites.find((x) => x.numero === 'B-005');
    await S.majBoite(cible.id, { statut: 'horsservice', motif: 'serrure cassée' });
    await S.loadServerState();
  });
  await page.waitForTimeout(700);

  const hs = await page.$eval('.casier[aria-label*="B-005"]', (el) => ({
    classe: el.className,
    texte: el.innerText,
    mot: (el.querySelector('.casier-mot') || {}).textContent
  }));
  ok(/casier-horsservice/.test(hs.classe), 'la case porte sa classe d’état');
  ok(/hors service/i.test(hs.mot || ''),
    'et le mot « hors service » y est écrit : ' + JSON.stringify(hs.mot));
  ok(/B-005/.test(hs.texte), 'avec son numéro');

  /* La règle, vérifiée sur toutes les cases à la fois : aucune ne se contente
     d'une couleur. C'est ce contrôle-là qui empêche la règle de se perdre au
     prochain ajout de statut. */
  const sansMot = await page.$$eval('.casier', (els) =>
    els.filter((e) => !(e.querySelector('.casier-mot') || {}).textContent).length);
  ok(sansMot === 0, 'aucune case ne repose sur la seule couleur (' + sansMot + ' en défaut)');

  /* ---- 4. le miroir, d'un écran à l'autre ---- */
  console.log('\n4. Attribuer se voit sur la fiche, libérer l’en retire');
  await page.evaluate(async () => {
    const S = window.BC.store;
    await S.addContact({ name: 'Amina Diallo', telephone: '06 12 34 56 78' });
    await S.loadServerState();
  });
  await page.waitForTimeout(700);

  const attribue = await page.evaluate(async () => {
    const S = window.BC.store;
    const boite = S.state.boites.find((b) => b.numero === 'B-003');
    const amina = S.state.contacts.find((c) => c.name === 'Amina Diallo');
    await S.attribuerBoite(boite.id, amina.id);
    await S.loadServerState();
    const apres = S.state.contacts.find((c) => c.id === amina.id);
    return { surLaFiche: apres.box, id: boite.id, contactId: amina.id };
  });
  ok(attribue.surLaFiche === 'B-003',
    'la fiche d’Amina porte le numéro du casier attribué (' + attribue.surLaFiche + ')');

  await page.waitForTimeout(600);
  const caseOccupee = await page.$eval('.casier[aria-label*="B-003"]', (el) => el.innerText);
  ok(/Amina Diallo/.test(caseOccupee), 'et la case du plan affiche son nom');
  ok(/occup/i.test(caseOccupee), 'avec le mot « occupée »');

  const libere = await page.evaluate(async () => {
    const S = window.BC.store;
    await S.libererBoite(window.__idBoite || S.state.boites.find((b) => b.numero === 'B-003').id, 'relogée');
    await S.loadServerState();
    const c = S.state.contacts.find((x) => x.name === 'Amina Diallo');
    const b = S.state.boites.find((x) => x.numero === 'B-003');
    return { surLaFiche: c.box, statut: b.statut, periodes: b.periodes.length, nom: b.periodes[0].nom };
  });
  ok(libere.surLaFiche === '', 'libérer retire le numéro de la fiche');
  ok(libere.statut === 'libre', 'et rend le casier');
  ok(libere.periodes === 1 && libere.nom === 'Amina Diallo',
    'son passage reste inscrit au casier — c’est ce qui permet de savoir à qui il était');

  /* ---- 5. la fiche d'un casier ---- */
  console.log('\n5. La fiche d’un casier s’ouvre au clic');
  await page.waitForTimeout(400);
  await page.click('.casier[aria-label*="B-003"]');
  await page.waitForTimeout(600);
  const fiche = await page.evaluate(() => {
    const d = document.getElementById('casierDialog');
    return { ouvert: d && d.open, texte: document.getElementById('casierDialogCorps').innerText };
  });
  ok(!!fiche.ouvert, 'le dialogue s’ouvre');
  ok(/B-003/.test(fiche.texte), 'il nomme le casier');
  ok(/Amina Diallo/.test(fiche.texte), 'et montre l’ancien titulaire dans l’historique');
  ok(/relogée/.test(fiche.texte), 'avec le motif de la libération');

  ok(!/[Ss]upprimer les données|[Ee]ffacer le registre/.test(fiche.texte),
    'aucune action destructrice n’est proposée depuis un casier');

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
