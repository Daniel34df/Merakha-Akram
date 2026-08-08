/* Vérification : sortir du registre, ou effacer.

   Deux gestes que « Supprimer » confondait. Sortir garde le courrier passé ;
   effacer ne laisse ni fiche, ni courrier, ni nom au journal. */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

const ligne = (page, nom) => page.locator('#contactsTable tbody tr', { hasText: nom }).first();

async function ajouter(page, nom, tel) {
  await page.fill('#newName', nom);
  await page.fill('#newTelephone', tel);
  await page.click('#addContactBtn');
  await page.waitForTimeout(1200);
}

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);

  await C.ouvrirLeBureau(page);

  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(700);
  await ajouter(page, 'Amina Diallo', '06 12 34 56 78');
  await ajouter(page, 'Omar Benali', '06 99 88 77 66');

  // Un courrier pour chacune, annoncé par téléphone.
  await page.evaluate(async () => {
    for (const nom of ['Amina Diallo', 'Omar Benali']) {
      const c = window.BC.store.state.contacts.find(x => x.name === nom);
      await window.BC.store.sendViaServer(c, { subject: 'Un courrier vous attend', body: '.' });
    }
  });
  await page.waitForTimeout(1200);
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(800);

  /* ---- 1. les deux boutons disent ce qu'ils font ---- */
  console.log('\n1. Deux boutons, deux gestes');
  const actions = await ligne(page, 'Amina').locator('td.actions').innerText();
  ok(/Sortir/.test(actions), '« Sortir » est proposé — ' + actions.replace(/\s+/g, ' '));
  ok(/Effacer/.test(actions), '« Effacer » est proposé');
  ok(!/^Supprimer/m.test(actions), 'plus de « Supprimer » ambigu');

  /* ---- 2. sortir du registre garde le courrier ---- */
  console.log('\n2. Sortir du registre');
  await ligne(page, 'Omar').locator('button[data-del]').click();
  await page.waitForTimeout(600);
  const texteSortir = await page.innerText('#confirmDialog');
  ok(/reste à l’historique/.test(texteSortir), 'le dialogue annonce que le courrier reste');
  ok(/06 99 88 77 66/.test(texteSortir), 'il désigne la personne par son téléphone, pas par « ( ) »');
  await page.click('#confirmOk');
  await page.waitForTimeout(1500);

  const etat2 = await page.evaluate(() => ({
    contacts: window.BC.store.state.contacts.map(c => c.name),
    courriers: window.BC.store.state.history.map(h => h.name)
  }));
  ok(!etat2.contacts.includes('Omar Benali'), 'Omar quitte le registre');
  ok(etat2.courriers.includes('Omar Benali'), 'son courrier reste à l’historique');

  /* ---- 3. effacer ne laisse rien ---- */
  console.log('\n3. Effacer définitivement');
  await ligne(page, 'Amina').locator('button[data-effacer]').click();
  await page.waitForTimeout(600);
  const texteEffacer = await page.innerText('#confirmDialog');
  ok(/irréversible/.test(texteEffacer), 'le dialogue annonce l’irréversible');
  ok(/1 courrier\(s\)/.test(texteEffacer), 'il annonce combien de courriers partent — ' +
     texteEffacer.replace(/\s+/g, ' ').slice(0, 180));
  await page.click('#confirmOk');
  await page.waitForTimeout(1800);

  const etat3 = await page.evaluate(() => ({
    contacts: window.BC.store.state.contacts.map(c => c.name),
    courriers: window.BC.store.state.history.map(h => h.name)
  }));
  ok(!etat3.contacts.includes('Amina Diallo'), 'la fiche est partie');
  ok(!etat3.courriers.includes('Amina Diallo'), 'son courrier aussi');
  ok(etat3.courriers.includes('Omar Benali'), 'celui d’Omar est intact');

  /* ---- 4. le journal ne la nomme plus ---- */
  console.log('\n4. Le journal');
  const journal = await page.evaluate(async () => {
    const j = await window.BC.store.loadJournal();
    return JSON.stringify(j);
  });
  ok(!journal.includes('Amina Diallo'), 'le journal ne la nomme plus');
  ok(!journal.includes('06 12 34 56 78'), 'ni son numéro');
  ok(journal.includes('destinataire effacé'), 'mais garde la trace de l’effacement');
  ok(journal.includes('Akram'), 'et de qui l’a fait');

  await C.capture(page, 'effacer');

  await C.conclure(b, page, v);
})().catch(e => { console.error('PLANTAGE', e); process.exit(1); });
