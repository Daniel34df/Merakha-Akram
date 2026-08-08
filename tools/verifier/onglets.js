/* Vérification : les six onglets et les quatre documents.

   Le filet du code non couvert par `node --test`. Après tout déplacement de
   code, c'est lui qui dit si un écran est resté en état. */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b, {
    // L'impression ouvrirait une boîte de dialogue native : on la neutralise.
    avantChargement: function () {
      window.__imprime = 0;
      window.print = function () { window.__imprime++; };
    }
  });
  const erreurs = page.erreursJs;

  await C.ouvrirLeBureau(page);

  /* Le socle et l'impression sont-ils bien là, et distincts ? */
  console.log('\n1. Les modules sont chargés');
  const modules = await page.evaluate(() => ({
    ui: !!(window.BC && BC.ui && BC.ui.toast && BC.ui.antennes),
    impression: !!(window.BC && BC.impression && BC.impression.attestationHtml),
    store: !!(window.BC && BC.store)
  }));
  ok(modules.ui, 'BC.ui — le socle');
  ok(modules.impression, 'BC.impression — le papier');
  ok(modules.store, 'BC.store — inchangé');

  /* Un dossier de travail : une personne domiciliée, un courrier en attente. */
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(700);
  await page.fill('#newName', 'Amina Diallo');
  await page.fill('#newTelephone', '06 12 34 56 78');
  await page.fill('#newBox', 'B-12');
  await page.check('#newDomicilie');
  await page.waitForTimeout(300);
  await page.fill('#newDomicilieDepuis', new Date().toISOString().slice(0, 10));
  await page.click('#addContactBtn');
  await page.waitForTimeout(1300);
  await page.evaluate(async () => {
    const c = BC.store.state.contacts.find(x => x.name === 'Amina Diallo');
    await BC.store.sendViaServer(c, { subject: 'Un courrier vous attend', body: '.' });
  });
  await page.waitForTimeout(1200);

  /* ---- 2. les six onglets ---- */
  console.log('\n2. Les six onglets');
  const onglets = await page.evaluate(() =>
    [...document.querySelectorAll('nav button[data-panel]')].map(b => b.dataset.panel));
  for (const nom of onglets) {
    const avant = erreurs.length;
    await page.click('nav button[data-panel="' + nom + '"]');
    await page.waitForTimeout(1100);
    ok(erreurs.length === avant,
       'onglet « ' + nom + ' » — ' + (erreurs.length === avant ? 'aucune erreur' : erreurs.slice(avant).join(' | ')));
  }

  /* ---- 3. les quatre impressions ---- */
  console.log('\n3. Les quatre documents');

  const imprime = async (quoi, action) => {
    const avantErr = erreurs.length;
    const avantN = await page.evaluate(() => window.__imprime);
    await action();
    await page.waitForTimeout(900);
    const apresN = await page.evaluate(() => window.__imprime);
    const contenu = await page.evaluate(() => document.getElementById('feuilleCasier').innerHTML.length);
    ok(apresN > avantN && contenu > 0 && erreurs.length === avantErr,
       quoi + ' — imprimé (' + contenu + ' car.)' +
       (erreurs.length > avantErr ? ' MAIS : ' + erreurs.slice(avantErr).join(' | ') : ''));
  };

  await page.click('nav button[data-panel="suivi"]');
  await page.waitForTimeout(900);
  await imprime('feuille de casier', async () => {
    /* Deux boutons portent ce geste, dans deux sections : on prend celui qui
       est effectivement à l'écran. */
    const visible = page.locator('#feuilleCasierBtn, #feuilleCasierBtn2').locator('visible=true').first();
    if (await visible.count()) return visible.click();
    await page.evaluate(() => document.getElementById('feuilleCasierBtn').click());
  });

  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(800);
  await imprime('attestation d’élection de domicile', async () => {
    await page.locator('#contactsTable tbody tr', { hasText: 'Amina' }).first()
      .locator('button[data-fiche]').click();
    await page.waitForTimeout(600);
    await page.click('#ficheAttestationBtn');
  });

  await page.click('nav button[data-panel="domiciliation"]');
  await page.waitForTimeout(1000);
  await imprime('liste des personnes domiciliées', async () => {
    await page.click('#activesImprimerBtn');
  });
  await imprime('rapport annuel', async () => {
    await page.click('#rapportImprimerBtn');
  });

  /* ---- 4. la feuille est bien rangée après coup ---- */
  console.log('\n4. Après impression');
  await page.waitForTimeout(900);
  const range = await page.evaluate(() => ({
    cachee: document.getElementById('feuilleCasier').hidden,
    classe: document.body.classList.contains('impression-casier')
  }));
  ok(range.cachee, 'la feuille se recache');
  ok(!range.classe, 'la page revient du mode impression');

  await C.capture(page, 'onglets');

  await C.conclure(b, page, v);
})().catch(e => { console.error('PLANTAGE', e); process.exit(1); });
