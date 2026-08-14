/* Vérification : corriger une fiche après coup.

   Garde fermés trois défauts réels : un téléphone corrigé qui repartait
   inchangé, une personne sans courriel impossible à corriger, et une
   correction qui annulait silencieusement le dernier renouvellement. */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

const notre = (page, sel) =>
  page.locator('#contactsTable tbody tr', { hasText: 'Amina' }).first().locator(sel);

async function refuser(page) {
  // « Voulez-vous l'imprimer maintenant ? » — non : le dialogue bloquerait la suite.
  if (await page.locator('#confirmDialog[open]').count()) {
    await page.locator('#confirmDialog button[value=cancel]').click();
    await page.waitForTimeout(500);
  }
}

const fiche = page => page.evaluate(
  () => window.BC.store.state.contacts.find(c => c.name.startsWith('Amina')) || {});

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);

  await C.ouvrirLeBureau(page);

  /* ---- 1. inscription d'une personne SANS courriel ---- */
  console.log('\n1. Inscription d’une personne sans courriel');
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(600);
  await page.fill('#newName', 'Amina Diallo');
  await page.fill('#newTelephone', '06 12 34 56 78');
  await page.fill('#newBox', 'B-12');
  await page.check('#newDomicilie');
  await page.waitForTimeout(300);
  await page.fill('#newDomicilieDepuis', '2026-01-10');
  await page.click('#addContactBtn');
  await page.waitForTimeout(1500);

  const c0 = await fiche(page);
  ok(c0.name === 'Amina Diallo', 'la fiche sans courriel est au registre');
  ok(c0.telephone === '06 12 34 56 78', 'le téléphone est enregistré : ' + c0.telephone);

  const colonnes = await page.locator('#contactsTable thead th').allInnerTexts();
  ok(colonnes.some(t => t.toLowerCase().trim() === 'téléphone'),
     'le registre a une colonne Téléphone — ' + JSON.stringify(colonnes));
  const ligne = await page.locator('#contactsTable tbody tr', { hasText: 'Amina' }).first().innerText();
  ok(ligne.includes('06 12 34 56 78'), 'le numéro est visible dans la liste');

  /* ---- 2. fiche → Corriger → changer le téléphone ---- */
  console.log('\n2. Fiche → Corriger → nouveau téléphone');
  await notre(page, 'button[data-fiche]').click();
  await page.waitForTimeout(700);
  ok(await page.locator('#ficheModifierBtn').isVisible(), '« Corriger » est proposé');
  ok(await page.locator('#ficheAttestationBtn').isVisible(), 'l’attestation est proposée');
  await page.click('#ficheModifierBtn');
  await page.waitForTimeout(500);
  ok(await page.locator('#ficheEdition').isVisible(), 'le formulaire de correction s’ouvre');
  ok(!(await page.locator('#ficheAttestationBtn').isVisible()), 'l’attestation se retire pendant la correction');
  ok((await page.inputValue('#fedTelephone')) === '06 12 34 56 78', 'le téléphone est prérempli');
  ok((await page.inputValue('#fedDepuis')) === '2026-01-10', 'la date d’élection est préremplie');

  await page.fill('#fedTelephone', '07 98 76 54 32');
  await page.fill('#fedNaissance', '1988-04-02');
  await page.fill('#fedNotes', 'Passe le mardi');
  await page.click('#fedEnregistrerBtn');
  await page.waitForTimeout(1500);

  const c1 = await fiche(page);
  ok(c1.telephone === '07 98 76 54 32', 'le nouveau numéro est enregistré : ' + c1.telephone);
  ok(c1.naissance === '1988-04-02', 'la date de naissance aussi : ' + c1.naissance);
  ok(c1.notes === 'Passe le mardi', 'les observations aussi : ' + c1.notes);

  await notre(page, 'button[data-fiche]').click();
  await page.waitForTimeout(700);
  ok((await page.innerText('#ficheCorps')).includes('07 98 76 54 32'), 'la fiche affiche le nouveau numéro');
  ok(!(await page.locator('#ficheEdition').isVisible()), 'la fiche se rouvre en lecture, pas en correction');
  await page.click('#ficheFermer');
  await page.waitForTimeout(400);

  /* ---- 3. renouveler, puis corriger : l'échéance doit survivre ---- */
  console.log('\n3. Renouvellement, puis correction');
  const avant = (await fiche(page)).domicilieJusqua;
  await page.click('nav button[data-panel="domiciliation"]');
  await page.waitForTimeout(1200);
  const boutonR = page.locator('button[data-renouveler]').first();
  if (await boutonR.count()) {
    await boutonR.click();
    await page.waitForTimeout(1300);
    await refuser(page);
    console.log('       (renouvelé par le bouton de l’écran)');
  } else {
    await page.evaluate(async () => {
      const c = window.BC.store.state.contacts.find(x => x.name.startsWith('Amina'));
      await window.BC.store.actionDomiciliation(c.id, 'renouveler');
    });
    await page.waitForTimeout(1000);
    console.log('       (pas encore à échéance : renouvelé par l’API)');
  }
  const apresR = await fiche(page);
  ok(apresR.domicilieJusqua !== avant, 'l’échéance est reportée : ' + avant + ' → ' + apresR.domicilieJusqua);
  ok(apresR.domicilieDepuis === '2026-01-10', 'la date d’élection ne bouge pas');
  ok((apresR.renouvellements || []).length === 1, 'le renouvellement est consigné');
  const renouvelee = apresR.domicilieJusqua;

  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(800);
  await notre(page, 'button[data-fiche]').click();
  await page.waitForTimeout(700);
  await page.click('#ficheModifierBtn');
  await page.waitForTimeout(500);
  ok((await page.inputValue('#fedJusqua')) === renouvelee, 'la correction montre l’échéance renouvelée');
  await page.fill('#fedNom', 'Amina Diallo-Sow');
  await page.click('#fedEnregistrerBtn');
  await page.waitForTimeout(1500);

  const c2 = await fiche(page);
  ok(c2.name === 'Amina Diallo-Sow', 'le nom est corrigé');
  ok(c2.domicilieJusqua === renouvelee, 'le renouvellement survit : ' + c2.domicilieJusqua);
  ok(c2.domicilieDepuis === '2026-01-10', 'l’ancienneté est intacte');
  ok(c2.telephone === '07 98 76 54 32', 'le téléphone est intact');

  /* ---- 4. édition rapide d'une fiche sans courriel ---- */
  console.log('\n4. Édition rapide d’une fiche sans courriel');
  await notre(page, 'button[data-edit]').click();
  await page.waitForTimeout(600);
  ok((await page.locator('.edit-telephone').count()) > 0, 'la ligne modifiable a un champ téléphone');
  await page.fill('.edit-box', 'B-20');
  /* En mode modification le nom est dans un <input> : « hasText » ne le voit
     pas. Une seule ligne est modifiable à la fois, on vise donc directement. */
  await page.click('#contactsTable button[data-save]');
  await page.waitForTimeout(1600);
  const c3 = await fiche(page);
  ok(c3.box === 'B-20', 'elle enregistre sans exiger de courriel (boîte = ' + c3.box + ')');
  ok(c3.telephone === '07 98 76 54 32', 'elle n’a pas effacé le téléphone');
  ok(c3.domicilie === true && c3.domicilieJusqua === renouvelee, 'elle n’a pas touché la domiciliation');
  ok(c3.naissance === '1988-04-02' && c3.notes === 'Passe le mardi', 'ni la naissance ni les observations');

  /* ---- 5. domiciliation close : plus d'attestation ---- */
  console.log('\n5. Une domiciliation close n’imprime plus d’attestation');
  await page.evaluate(async () => {
    const c = window.BC.store.state.contacts.find(x => x.name.startsWith('Amina'));
    await window.BC.store.actionDomiciliation(c.id, 'clore', { motif: 'relogée' });
  });
  await page.waitForTimeout(1200);
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(800);
  await notre(page, 'button[data-fiche]').click();
  await page.waitForTimeout(700);
  ok(!(await page.locator('#ficheAttestationBtn').isVisible()), 'pas d’attestation sur une domiciliation close');
  await page.click('#ficheModifierBtn');
  await page.waitForTimeout(400);
  await page.click('#fedAnnulerBtn');
  await page.waitForTimeout(400);
  ok(!(await page.locator('#ficheAttestationBtn').isVisible()), 'toujours pas après un aller-retour');
  ok(await page.locator('#ficheModifierBtn').isVisible(), '« Corriger » revient après annulation');

  await C.capture(page, 'corriger-fiche');

  await C.conclure(b, page, v);
})().catch(e => { console.error('PLANTAGE', e); process.exit(1); });
