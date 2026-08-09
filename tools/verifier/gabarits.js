/* Vérification : le numéro de boîte dans les messages, et la seconde langue.
 *
 * Garde fermés deux manques. Les gabarits n'offraient pas {boite} — le
 * renseignement le plus utile du message, celui qui évite une question au
 * guichet. Et un message partait dans une seule langue : la personne qui le
 * montre à un travailleur social, ou l'agent qui l'envoie, ne pouvaient pas le
 * relire. */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

const apercu = (page) => page.evaluate(() => document.getElementById('setBody').value);

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);

  /* ---- 1. l'aide dit la vérité ---- */
  console.log('\n1. Les variables annoncées');
  await page.click('nav button[data-panel="reglages"]');
  await page.waitForTimeout(800);
  await page.click('#reglagesSections button:text-is("Les messages")');
  await page.waitForTimeout(700);

  const annoncees = await page.evaluate(() =>
    [...document.querySelectorAll('#variablesGabarit li code')].map((c) => c.textContent));
  ok(annoncees.includes('{boite}'), '{boite} est proposée — ' + annoncees.join(' '));
  ok(annoncees.length >= 10, annoncees.length + ' variables listées');

  const offertes = await page.evaluate(() =>
    Object.keys(BC.util.variablesMessage({ contact: {} })).map((k) => '{' + k + '}'));
  ok(
    annoncees.slice().sort().join() === offertes.slice().sort().join(),
    'la liste affichée est exactement celle que le code offre'
  );

  /* ---- 2. {boite} arrive vraiment dans le message ---- */
  console.log('\n2. Le numéro de boîte dans le message');
  await page.fill('#setBody', 'Bonjour {nom}, votre courrier vous attend à la boîte {boite}.');
  await page.click('#saveSettingsBtn');
  await page.waitForSelector('#settingsMsg .msg.ok', { timeout: 8000 });

  await C.inscrire(page, { nom: 'Amina Diallo', telephone: '06 12 34 56 78', boite: 'B-12' });
  const message = await page.evaluate(() => {
    const c = BC.store.state.contacts.find((x) => x.name === 'Amina Diallo');
    return BC.notify.compose(c, BC.store.state.settings, {}).body;
  });
  ok(/boîte B-12/.test(message), 'le message porte le numéro : ' + message.replace(/\s+/g, ' '));
  ok(!/\{boite\}/.test(message), 'la variable est bien remplacée');

  /* ---- 3. la seconde langue ---- */
  console.log('\n3. Le message dans deux langues');
  const bilingue = await page.evaluate(() => {
    const S = BC.store.state.settings;
    const reglages = Object.assign({}, S, {
      bilingue: true,
      langues: { ar: { subject: 'بريد', body: 'مرحبا {nom}، لديك بريد في الصندوق {boite}.' } }
    });
    const c = BC.store.state.contacts.find((x) => x.name === 'Amina Diallo');
    return {
      arabe: BC.notify.compose(Object.assign({}, c, { langue: 'ar' }), reglages, {}),
      francais: BC.notify.compose(Object.assign({}, c, { langue: 'fr' }), reglages, {})
    };
  });
  ok(bilingue.arabe.bilingue === true, 'le message arabe est doublé');
  ok(/لديك بريد/.test(bilingue.arabe.body), 'sa langue vient en premier');
  ok(/votre courrier vous attend/.test(bilingue.arabe.body), 'et le français suit');
  ok(/B-12/.test(bilingue.arabe.body), 'la boîte figure dans les deux');
  ok(bilingue.francais.bilingue === false, 'un francophone ne reçoit pas deux fois le même texte');

  /* ---- 4. la case se règle et se retient ---- */
  console.log('\n4. Le réglage se retient');
  await page.click('nav button[data-panel="reglages"]');
  await page.waitForTimeout(600);
  await page.click('#reglagesSections button:text-is("Les messages")');
  await page.waitForTimeout(600);
  ok((await page.isChecked('#setBilingue')) === false, 'la case part décochée');
  await page.check('#setBilingue');
  await page.click('#saveSettingsBtn');
  await page.waitForSelector('#settingsMsg .msg.ok', { timeout: 8000 });

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.BC && BC.store && BC.store.state.mode === 'serveur', null, {
    timeout: 15000
  });
  await page.waitForTimeout(1200);
  await page.click('nav button[data-panel="reglages"]');
  await page.waitForTimeout(700);
  await page.click('#reglagesSections button:text-is("Les messages")');
  await page.waitForTimeout(700);
  ok(await page.isChecked('#setBilingue'), 'le réglage a survécu au rechargement');
  ok(
    await page.evaluate(() => BC.store.state.settings.bilingue === true),
    'et le serveur l’a bien enregistré'
  );

  await C.capture(page, 'gabarits');
  await C.conclure(b, page, v);
})().catch((e) => {
  console.error('PLANTAGE', e);
  process.exit(1);
});
