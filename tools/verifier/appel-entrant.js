/* Vérification : la personne appelle le bureau.

   Un appel de sa part est une manifestation au sens du décompte des trois
   mois. Sans cela, qui téléphone sans pouvoir se déplacer glissait vers la
   radiation. */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);

  await C.ouvrirLeBureau(page);

  /* Une personne domiciliée depuis longtemps, jamais revenue : c'est
     exactement le dossier que le registre poussait vers la radiation. */
  console.log('\n1. Une domiciliée qui n’est jamais revenue');
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(700);
  await page.fill('#newName', 'Amina Diallo');
  await page.fill('#newTelephone', '06 12 34 56 78');
  await page.fill('#newBox', 'B-12');
  await page.check('#newDomicilie');
  await page.waitForTimeout(300);
  const vieux = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  await page.fill('#newDomicilieDepuis', vieux);
  await page.click('#addContactBtn');
  await page.waitForTimeout(1400);
  await page.evaluate(async () => {
    const c = BC.store.state.contacts.find(x => x.name === 'Amina Diallo');
    await BC.store.sendViaServer(c, { subject: 'Un courrier vous attend', body: '.' });
  });
  await page.waitForTimeout(1300);

  const avant = await page.evaluate(() => {
    const c = BC.store.state.contacts.find(x => x.name === 'Amina Diallo');
    return BC.domiciliation.etat(c, BC.store.state.history);
  });
  ok(avant.risqueRadiation === true, 'elle est signalée en risque de radiation');
  ok(avant.dernierMoyen === 'ouverture', 'aucun signe de vie depuis l’ouverture (' + avant.dernierMoyen + ')');

  /* ---- 2. la carte est là, et elle sert ---- */
  console.log('\n2. Elle téléphone au bureau');
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(1000);
  const carte = page.locator('#appelEntrantCard');
  ok(await carte.isVisible(), 'la carte « La personne appelle » est proposée');

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('#domicilieListe option')].map(o => o.value));
  ok(options.includes('Amina Diallo'), 'la liste propose les personnes domiciliées');

  // Un nom inconnu ne doit rien inscrire, et le dire.
  await page.fill('#appelEntrantNom', 'Quelqu’un qui n’existe pas');
  await page.click('#appelEntrantBtn');
  await page.waitForTimeout(800);
  const refus = await page.innerText('#appelEntrantMsg');
  ok(/introuvable/i.test(refus), 'un nom inconnu est refusé : ' + refus.slice(0, 80));

  await page.fill('#appelEntrantNom', 'Amina Diallo');
  await page.click('#appelEntrantBtn');
  await page.waitForTimeout(1800);
  const msg = await page.innerText('#appelEntrantMsg');
  ok(/noté/i.test(msg), 'l’appel est noté — ' + msg.replace(/\s+/g, ' ').slice(0, 110));
  ok(/courrier/i.test(msg), 'et le message parle de son courrier');
  ok((await page.inputValue('#appelEntrantNom')) === '', 'le champ se vide pour l’appel suivant');

  /* ---- 3. ce que ça change ---- */
  console.log('\n3. Ce que l’appel change');
  const apres = await page.evaluate(() => {
    const c = BC.store.state.contacts.find(x => x.name === 'Amina Diallo');
    const h = BC.store.state.history.find(x => x.contactId === c.id);
    return {
      etat: BC.domiciliation.etat(c, BC.store.state.history),
      passages: (c.passages || []).map(p => p.moyen),
      statutCourrier: h && h.status
    };
  });
  ok(apres.etat.risqueRadiation === false, 'elle n’est plus en risque de radiation');
  ok(apres.etat.joursSansPassage === 0, 'le compteur d’absence repart de zéro');
  ok(apres.etat.dernierMoyen === 'telephone', 'et le canal est retenu : ' + apres.etat.dernierMoyen);
  ok(apres.passages[0] === 'telephone', 'le passage est inscrit comme un appel');
  ok(apres.statutCourrier === 'prévenu', 'son courrier passe à « annoncé » (' + apres.statutCourrier + ')');

  const listeAppels = await page.evaluate(() => document.getElementById('appelsCard').hidden);
  ok(listeAppels, 'elle ne figure plus parmi les appels à passer');

  /* ---- 4. le registre dit « appel », pas « passage » ---- */
  console.log('\n4. La fiche fait la différence');
  /* C'est sur la fiche, et sur la liste des risques de radiation, que
     l'équipe a besoin de savoir si on a vu la personne ou seulement entendue.
     Le tableau des dossiers en cours, lui, parle d'échéances. */
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(900);
  await page.locator('#contactsTable tbody tr', { hasText: 'Amina' })
    .first().locator('button[data-fiche]').click();
  await page.waitForTimeout(800);
  const fiche = await page.innerText('#ficheCorps');
  ok(/appel de sa part/i.test(fiche), 'la fiche dit « appel de sa part »');
  ok(/signe de vie/i.test(fiche), 'sous un intitulé qui ne parle plus de « passage » seul');
  await page.click('#ficheFermer');
  await page.waitForTimeout(400);

  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(700);
  await C.capture(page, 'appel-entrant');

  await C.conclure(b, page, v);
})().catch(e => { console.error('PLANTAGE', e); process.exit(1); });
