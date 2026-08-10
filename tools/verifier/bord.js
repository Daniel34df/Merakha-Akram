/* Vérification : le relevé du jour, en haut du Guichet.
 *
 * `assets/js/bord.js` est pur et couvert par `node --test`. Ce que ce
 * script-ci garde fermé, c'est ce qui ne se voit qu'à l'écran :
 *
 *   1. **La bande se peint, et au bon endroit.** Le calcul peut être juste et
 *      la bande rester invisible — un `hidden` jamais retiré, un module absent
 *      de la page. Elle doit aussi rester **au-dessus** du champ de saisie du
 *      Guichet : c'est là qu'on la lit sans y penser, et c'est tout son objet.
 *
 *   2. **Le champ de saisie reste à portée.** Le Guichet a été allégé exprès.
 *      Une bande qui repousse « Nom inscrit sur la lettre » hors de l'écran
 *      rendrait le relevé plus coûteux que ce qu'il rapporte.
 *
 *   3. **Chaque chiffre mène quelque part.** Un tableau de bord qui affiche
 *      « 2 domiciliations expirées » sans mener aux deux dossiers oblige à les
 *      chercher à la main, et on ne le fait pas. C'est la différence entre un
 *      chiffre et une action, et elle ne se vérifie qu'en cliquant.
 *
 *   4. **Le mot est écrit à côté du chiffre** (§33, §54). Entre « expirée » et
 *      « à renouveler » il y a la différence entre un droit perdu et un
 *      rendez-vous à prendre, et deux teintes voisines ne la disent pas à tout
 *      le monde.
 *
 *   5. **Un bureau calme voit quelque chose de calme.** Une bande qui crie
 *      tous les matins cesse d'être lue le matin où elle a raison.
 */
'use strict';

const C = require('./commun.js');

const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);

  /* ---- 1. un bureau qui n'a rien à faire ---- */
  console.log('\n1. Un bureau calme voit quelque chose de calme');
  await page.waitForTimeout(500);
  ok(await page.isVisible('#bord'), 'la bande est là dès le premier écran');
  const calme = await page.evaluate(() => ({
    etat: document.getElementById('bord').dataset.calme,
    phrase: document.getElementById('bordPhrase').textContent,
    puces: document.querySelectorAll('#bord [data-bord]').length
  }));
  ok(calme.etat === 'oui', 'elle se dit calme');
  ok(calme.puces === 0, 'et ne montre aucune puce (' + calme.puces + ')');
  ok(/Rien/.test(calme.phrase), 'la phrase le dit en toutes lettres : ' + JSON.stringify(calme.phrase));

  /* ---- 2. la bande est au-dessus du champ de saisie, et le laisse à portée ---- */
  console.log('\n2. Elle est au-dessus du champ, sans le repousser hors de l’écran');
  const places = await page.evaluate(() => {
    const bande = document.getElementById('bord').getBoundingClientRect();
    const champ = document.getElementById('nameInput').getBoundingClientRect();
    return { bandeBas: bande.bottom, champHaut: champ.top, hauteurBande: bande.height };
  });
  ok(places.bandeBas <= places.champHaut, 'la bande précède le champ de saisie');
  ok(places.hauteurBande < 160,
    'et reste une bande, pas une page (' + Math.round(places.hauteurBande) + ' px)');

  /* ---- 3. un bureau qui a du travail ---- */
  console.log('\n3. Ce qui presse apparaît, et le plus grave en tête');
  await page.evaluate(async () => {
    const S = window.BC.store;
    /* Une domiciliation ouverte il y a plus de deux ans : elle a expiré. */
    await S.addContact({ name: 'Amina Diallo', telephone: '06 12 34 56 78',
      domicilie: true, domicilieDepuis: '2023-01-10' });
    await S.addContact({ name: 'Marc Petit', telephone: '07 00 11 22 33' });
    // Un courrier sans courriel : personne ne l'a encore prévenu.
    await fetch('/api/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Marc Petit', email: '' })
    });
    await S.loadServerState();
    window.BC.ui.ecrans.app.renderAll();
  });
  await page.waitForTimeout(800);

  const puces = await page.$$eval('#bord [data-bord]', (els) =>
    els.map((e) => ({
      cle: e.dataset.bord,
      classe: e.className,
      n: (e.querySelector('.bord-n') || {}).textContent,
      mot: (e.querySelector('.bord-mot') || {}).textContent,
      titre: e.getAttribute('title')
    })));
  ok(puces.length > 0, puces.length + ' puce(s) après une matinée chargée');
  ok(await page.evaluate(() => document.getElementById('bord').dataset.calme) === 'non',
    'la bande ne se dit plus calme');
  ok(puces[0].cle === 'domiExpirees',
    'la domiciliation expirée passe en tête — c’est un droit perdu maintenant (' + puces[0].cle + ')');
  ok(/bord-danger/.test(puces[0].classe), 'et elle est la seule à porter le niveau « danger »');

  /* ---- 4. le mot est écrit, la couleur ne porte pas seule ---- */
  console.log('\n4. Chaque puce écrit son mot à côté de son chiffre');
  const muettes = puces.filter((p) => !p.mot);
  ok(muettes.length === 0,
    'aucune puce ne repose sur la seule couleur (' + muettes.length + ' en défaut)');
  const sansExplication = puces.filter((p) => !p.titre || p.titre.length < 20);
  ok(sansExplication.length === 0, 'et chacune dit ce qui est en jeu au survol');
  ok(/domiciliation/.test(puces[0].mot), 'le mot nomme la chose : ' + JSON.stringify(puces[0].mot));

  /* ---- 5. le chiffre mène au dossier ---- */
  console.log('\n5. Cliquer un chiffre ouvre l’écran concerné');
  await page.click('#bord [data-bord="domiExpirees"]');
  await page.waitForTimeout(700);
  const ouvert = await page.evaluate(() => {
    const actif = document.querySelector('.panel.active');
    return actif ? actif.id : '';
  });
  ok(ouvert === 'panel-domiciliation',
    'la puce des domiciliations expirées ouvre la Domiciliation (' + ouvert + ')');

  /* Et le retour au Guichet ne perd pas la bande : elle se repeint avec le
     reste, sinon elle afficherait le relevé d'il y a dix minutes. */
  await page.click('nav button[data-panel="guichet"]');
  await page.waitForTimeout(500);
  ok(await page.isVisible('#bord'), 'la bande est toujours là au retour');

  /* ---- 6. elle suit les données ---- */
  console.log('\n6. Le relevé suit ce qui se passe');
  const avant = await page.$$eval('#bord [data-bord]', (e) => e.length);
  await page.evaluate(async () => {
    const S = window.BC.store;
    /* On prévient Marc : la puce « personne à prévenir » doit tomber. */
    const h = S.state.history.find((x) => x.name === 'Marc Petit');
    if (h) await S.noterAppel(h.id, { joint: true, note: 'prévenu au téléphone' });
    await S.loadServerState();
    window.BC.ui.ecrans.app.renderAll();
  });
  await page.waitForTimeout(800);
  const apres = await page.$$eval('#bord [data-bord]', (e) =>
    e.map((x) => x.dataset.bord));
  ok(!apres.includes('aPrevenir'),
    'une fois la personne prévenue, la puce disparaît (restent : ' + apres.join(', ') + ')');
  ok(apres.length < avant || avant === 0, 'le relevé s’allège quand le travail est fait');

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
