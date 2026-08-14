/* Vérification : les observations et les étiquettes d'une fiche.
 *
 * `assets/js/etiquettes.js` est pur et couvert par `node --test`. Ce que ce
 * script-ci garde fermé :
 *
 *   1. **Les observations paraissent au moment de la remise.** C'est le seul
 *      instant où elles servent : quelqu'un est devant le comptoir, et la
 *      consigne — « ne pas remettre à un tiers », « passe toujours
 *      accompagnée » — dort dans une fiche que l'agent n'ouvrira pas s'il n'a
 *      pas de raison de l'ouvrir. C'est exactement pour ne pas avoir à
 *      l'ouvrir qu'on les affiche là.
 *
 *   2. **Les suggestions proposent ce que le bureau emploie déjà.** C'est ce
 *      qui empêche « tutelle », « Tutelle » et « mise sous tutelle » de
 *      cohabiter : la normalisation rattrape les deux premières, pas la
 *      troisième. Seule la proposition la rattrape.
 *
 *   3. **On peut retrouver un groupe.** « Montre-moi les dossiers sous
 *      tutelle » est la question à laquelle aucune recherche par nom ne répond,
 *      et c'est la seule raison d'avoir des étiquettes plutôt que des notes.
 *
 *   4. **Rien de tout cela ne part dans un courriel.** « tutelle » ou
 *      « expulsion » dans un message à la personne, c'est une information qui
 *      blesse et qui ne la regarde pas sous cette forme.
 */
'use strict';

const C = require('./commun.js');

const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);
  await page.waitForTimeout(500);

  /* ---- 0. deux fiches, dont une avec des consignes ---- */
  console.log('\n0. Deux destinataires, dont un suivi particulier');
  await page.evaluate(async () => {
    const S = window.BC.store;
    await S.addContact({
      name: 'Amina Diallo', telephone: '06 12 34 56 78',
      notes: 'Sous tutelle — ne rien remettre à un tiers sans appeler M. Roy.',
      etiquettes: 'Tutelle, Suivi Social'
    });
    await S.addContact({ name: 'Marc Petit', telephone: '07 00 11 22 33',
      etiquettes: 'suivi social' });
    await fetch('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Amina Diallo' })
    });
    await S.loadServerState();
    window.BC.ui.ecrans.app.renderAll();
  });
  await page.waitForTimeout(1000);

  const posees = await page.evaluate(() => {
    const c = window.BC.store.state.contacts.find((x) => x.name === 'Amina Diallo');
    return c.etiquettes;
  });
  ok(JSON.stringify(posees) === JSON.stringify(['tutelle', 'suivi-social']),
    'le serveur normalise ce qu’on lui donne : ' + JSON.stringify(posees));

  /* ---- 1. les observations au moment de la remise ---- */
  console.log('\n1. Les observations paraissent quand la personne est au guichet');
  const code = await page.evaluate(() => {
    const h = window.BC.store.state.history.find((x) => x.name === 'Amina Diallo');
    return h.pickupCode;
  });
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(400);
  await page.fill('#pickupCode', code);
  await page.click('#pickupCodeBtn');
  await page.waitForTimeout(900);

  const fiche = await page.$eval('#pickupDetail', (e) => e.innerText);
  ok(/ne rien remettre à un tiers/i.test(fiche),
    'la consigne est sous les yeux de l’agent, sans qu’il ait à ouvrir la fiche');
  /* « suivi-social » et non « tutelle » : le mot « tutelle » figure aussi dans
     les observations, et le constat passerait alors sans rien prouver sur les
     étiquettes. C'est ce qui est arrivé la première fois. */
  ok(/suivi-social/i.test(fiche), 'et les étiquettes aussi, sous leur forme normalisée');

  /* ---- 2. les suggestions ---- */
  console.log('\n2. On propose ce que le bureau emploie déjà');
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const c = window.BC.store.state.contacts.find((x) => x.name === 'Marc Petit');
    window.BC.ui.ecrans.registre.ouvrirFiche(c.id);
  });
  await page.waitForTimeout(700);
  /* La fiche s'ouvre en lecture ; le formulaire ne se remplit qu'en passant en
     correction. Le sauter laissait le champ vide et le constat sans objet. */
  await page.click('#ficheModifierBtn');
  await page.waitForTimeout(500);

  const champ = await page.$eval('#fedEtiquettes', (e) => e.value);
  ok(champ === 'suivi-social', 'la fiche montre ses étiquettes (' + champ + ')');

  const suggestions = await page.$$eval('#fedEtiquettesSuggestions [data-etiq]',
    (els) => els.map((e) => e.textContent));
  ok(suggestions.indexOf('tutelle') !== -1,
    'ce que le bureau emploie déjà est proposé : ' + suggestions.slice(0, 5).join(', '));
  ok(suggestions.indexOf('suivi-social') === -1,
    'et ce qui est déjà posé n’est pas reproposé');

  await page.click('#fedEtiquettesSuggestions [data-etiq="tutelle"]');
  await page.waitForTimeout(300);
  const apres = await page.$eval('#fedEtiquettes', (e) => e.value);
  ok(/tutelle/.test(apres) && /suivi-social/.test(apres),
    'un clic l’ajoute sans effacer les autres (' + apres + ')');
  const encore = await page.$$eval('#fedEtiquettesSuggestions [data-etiq]',
    (els) => els.map((e) => e.textContent));
  ok(encore.indexOf('tutelle') === -1, 'et elle cesse aussitôt d’être proposée');

  await page.evaluate(() => {
    const d = document.getElementById('ficheDialog');
    if (d && d.open) d.close();
  });
  await page.waitForTimeout(300);

  /* ---- 3. retrouver un groupe ---- */
  console.log('\n3. « Montre-moi les dossiers sous tutelle »');
  await page.fill('#contactFilter', '#tutelle');
  await page.waitForTimeout(500);
  const filtres = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#contactsTable tbody tr'))
      .map((tr) => tr.innerText).filter(Boolean));
  ok(filtres.length === 1, 'une seule fiche répond (' + filtres.length + ')');
  ok(/Amina/.test(filtres[0] || ''), 'et c’est la bonne : ' + (filtres[0] || '').slice(0, 30));

  await page.fill('#contactFilter', '#suivi-social');
  await page.waitForTimeout(500);
  const deux = await page.evaluate(() =>
    document.querySelectorAll('#contactsTable tbody tr').length);
  ok(deux === 2, 'l’étiquette commune en ramène deux (' + deux + ')');

  await page.fill('#contactFilter', '');
  await page.waitForTimeout(400);

  /* ---- 4. rien de tout cela ne part dans un message ---- */
  console.log('\n4. Ces mots ne sortent jamais dans un courriel');
  const message = await page.evaluate(() => {
    const S = window.BC.store;
    const c = S.state.contacts.find((x) => x.name === 'Amina Diallo');
    const m = window.BC.notify.compose(c, S.state.settings, { type: 'lettre' });
    return (m.subject || '') + '\n' + (m.body || '');
  });
  ok(!/tutelle/i.test(message),
    'aucune étiquette dans le message composé : ' + JSON.stringify(message.slice(0, 60)));
  ok(!/tiers|M\. Roy/i.test(message), 'et aucune observation non plus');

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
