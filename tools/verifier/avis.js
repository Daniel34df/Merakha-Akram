/* Vérification : prévenir une personne au sujet de sa domiciliation.
 *
 * Le registre calculait deux échéances qui pèsent sur elle — son attestation
 * qui expire, son absence qui peut y mettre fin — et les signalait à l'équipe.
 * L'intéressée n'était prévenue par rien, et l'apprenait au refus d'un guichet.
 *
 * Ce script garde aussi la règle qui compte : un avis n'est pas un courrier. */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

const jourIlYa = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);

  /* Une attestation qui expire, et quelqu'un dont on est sans nouvelles :
     c'est la même personne dans ce cas, domiciliée il y a presque un an. */
  console.log('\n1. Une attestation qui arrive à échéance');
  await C.inscrire(page, {
    nom: 'Amina Diallo',
    telephone: '06 12 34 56 78',
    boite: 'B-12',
    domicilieDepuis: jourIlYa(350)
  });

  await page.click('nav button[data-panel="domiciliation"]');
  await page.waitForTimeout(1300);

  const boutons = await page.locator('button[data-avis]').count();
  ok(boutons > 0, 'un bouton « Prévenir » est proposé sur les listes (' + boutons + ')');

  /* ---- 2. sans courriel : l'avis se note ---- */
  console.log('\n2. Sans courriel, l’avis se note');
  await page.locator('button[data-avis]').first().click();
  await page.waitForTimeout(1800);

  const apres = await page.evaluate(() => {
    const c = BC.store.state.contacts.find((x) => x.name === 'Amina Diallo');
    return {
      avis: (c.avis || []).map((a) => ({ sujet: a.sujet, canal: a.canal })),
      courriers: BC.store.state.history.length
    };
  });
  ok(apres.avis.length === 1, 'l’avis est noté sur la fiche');
  ok(apres.avis[0].canal === 'telephone', 'à dire de vive voix : ' + apres.avis[0].canal);
  ok(apres.courriers === 0, 'et RIEN au registre du courrier — c’est la règle qui compte');

  const toast = await page.evaluate(() => {
    const t = document.querySelector('.toast');
    return t ? t.textContent : '';
  });
  ok(/vive voix|courriel/i.test(toast), 'l’agent est renseigné : ' + toast.slice(0, 90));

  /* ---- 3. avec un courriel : le message part ---- */
  console.log('\n3. Avec un courriel, le message part');
  await page.evaluate(async () => {
    const c = BC.store.state.contacts.find((x) => x.name === 'Amina Diallo');
    await BC.store.updateContact(c.id, { name: c.name, email: 'amina@exemple.org' });
  });
  await page.waitForTimeout(1200);

  const envoi = await page.evaluate(async () => {
    const c = BC.store.state.contacts.find((x) => x.name === 'Amina Diallo');
    return BC.store.envoyerAvis(c.id, 'renouvellement');
  });
  ok(envoi.canal === 'courriel', 'le message part par courriel');
  ok(/échéance/i.test(envoi.message.subject), 'sujet : ' + envoi.message.subject);
  ok(/Amina Diallo/.test(envoi.message.body), 'le message la nomme');
  ok(!/\{\w+\}/.test(envoi.message.body), 'aucune variable non remplacée');

  const finalCourriers = await page.evaluate(() => BC.store.state.history.length);
  ok(finalCourriers === 0, 'toujours rien au registre du courrier');

  /* ---- 4. le journal garde la trace ---- */
  console.log('\n4. Le journal');
  const journal = await page.evaluate(async () => JSON.stringify(await BC.store.loadJournal()));
  ok(/avis de domiciliation/.test(journal), 'l’avis est consigné');
  ok(/Amina Diallo/.test(journal), 'avec le nom de la personne');

  await C.capture(page, 'avis');
  await C.conclure(b, page, v);
})().catch((e) => {
  console.error('PLANTAGE', e);
  process.exit(1);
});
