/* Vérification : le calendrier des échéances, et l'export PDF.
 *
 * `assets/js/calendrier.js` et `assets/js/pdf.js` sont purs et couverts par
 * `node --test`. Ce que ce script-ci garde fermé :
 *
 *   1. **La grille se peint, et se déplace de mois en mois.** Un calendrier
 *      bloqué sur le mois courant ne sert pas à prévoir, ce qui est sa seule
 *      raison d'être.
 *
 *   2. **Une journée chargée se voit, et le nombre est écrit.** Douze
 *      renouvellements le même mardi, ce sont des attestations qui expirent —
 *      une domiciliation se renouvelle en présence de la personne.
 *
 *   3. **Une case mène à sa fiche.** Un calendrier qui montre douze noms sans
 *      y mener oblige à les rechercher un par un dans le registre, et on ne le
 *      fait pas.
 *
 *   4. **Le PDF produit est un vrai PDF.** C'est la vérification qui compte le
 *      plus ici : le module écrit le format à la main, sans bibliothèque. Un
 *      fichier structurellement correct mais refusé par les lecteurs est
 *      exactement le défaut qui est arrivé — page blanche, aucun message, et
 *      la personne repart de la CAF sans son attestation.
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

  /* ---- 0. des dossiers avec des échéances ---- */
  console.log('\n0. Sept domiciliations, dont cinq le même jour');
  await page.evaluate(async () => {
    const S = window.BC.store;
    const ilya = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < 5; i++) {
      await S.addContact({ name: 'Personne ' + i, telephone: '060000000' + i,
        domicilie: true, domicilieDepuis: ilya(353) });
    }
    await S.addContact({ name: 'Amina Diallo', telephone: '0611111111',
      domicilie: true, domicilieDepuis: ilya(200) });
    await S.loadServerState();
    window.BC.ui.ecrans.app.renderAll();
  });
  await page.waitForTimeout(1200);
  await page.click('nav button[data-panel="domiciliation"]');
  await page.waitForTimeout(700);

  /* ---- 1. la grille ---- */
  console.log('\n1. La grille du mois se peint');
  ok(await page.isVisible('#calGrille'), 'le calendrier est là');
  const cases = await page.$$eval('.cal-case', (e) => e.length);
  ok(cases >= 28 && cases % 7 === 0, cases + ' cases, en semaines entières');

  const noms = await page.$$eval('.cal-jour-nom abbr', (e) => e.map((x) => x.textContent));
  ok(noms[0] === 'lun', 'la semaine commence le lundi (' + noms[0] + ')');
  ok(noms.length === 7, 'sept colonnes');

  const vides = await page.$$eval('.cal-case:not(.cal-hors)', (els) =>
    els.filter((e) => !e.querySelector('.cal-compte')).length);
  ok(vides > 20, 'les jours sans rien gardent leur place (' + vides + ') — ce sont eux qui servent à étaler');

  /* ---- 2. la journée chargée ---- */
  console.log('\n2. La journée chargée se voit, et son nombre est écrit');
  const chargees = await page.$$eval('.cal-charge', (els) =>
    els.map((e) => ({
      compte: (e.querySelector('.cal-compte') || {}).textContent,
      noms: e.querySelectorAll('[data-cal-fiche]').length
    })));
  ok(chargees.length === 1, 'une journée chargée repérée (' + chargees.length + ')');
  ok(/5 échéances/.test(chargees[0].compte || ''),
    'le nombre est écrit, pas seulement peint : ' + JSON.stringify(chargees[0].compte));

  const phrase = await page.$eval('#calPhrase', (e) => e.textContent);
  ok(/chargée/.test(phrase), 'et la phrase du haut le dit : ' + JSON.stringify(phrase));

  /* ---- 3. une case mène à sa fiche ---- */
  console.log('\n3. Un nom du calendrier ouvre sa fiche');
  await page.click('.cal-charge [data-cal-fiche]');
  await page.waitForTimeout(700);
  const fiche = await page.evaluate(() => {
    const d = document.getElementById('ficheDialog');
    return d && d.open ? d.innerText : '';
  });
  ok(/Personne/.test(fiche), 'la fiche s’ouvre sur la bonne personne');
  await page.evaluate(() => {
    const d = document.getElementById('ficheDialog');
    if (d && d.open) d.close();
  });
  await page.waitForTimeout(300);

  /* ---- 4. changer de mois ---- */
  console.log('\n4. On peut regarder devant, et revenir');
  const moisCourant = await page.$eval('#calMois', (e) => e.textContent);
  await page.click('#calSuivant');
  await page.waitForTimeout(400);
  const moisSuivant = await page.$eval('#calMois', (e) => e.textContent);
  ok(moisSuivant !== moisCourant, 'le mois suivant s’affiche (' + moisSuivant + ')');
  await page.click('#calPrecedent');
  await page.click('#calPrecedent');
  await page.waitForTimeout(400);
  const moisAvant = await page.$eval('#calMois', (e) => e.textContent);
  ok(moisAvant !== moisCourant && moisAvant !== moisSuivant,
    'et le mois précédent aussi (' + moisAvant + ')');
  await page.click('#calAujourdhui');
  await page.waitForTimeout(400);
  ok(await page.$eval('#calMois', (e) => e.textContent) === moisCourant,
    '« Ce mois-ci » ramène au mois en cours');

  /* ---- 5. le PDF est un vrai PDF ---- */
  console.log('\n5. Le PDF produit s’ouvre dans un lecteur');
  const octets = await page.evaluate(() => {
    const S = window.BC.store;
    const c = S.state.contacts.find((x) => x.name === 'Amina Diallo');
    const blocs = window.BC.impression.attestationBlocs(c);
    return Array.from(window.BC.pdf.document(blocs));
  });
  ok(octets.length > 400, 'le fichier a du contenu (' + octets.length + ' octets)');

  const tete = String.fromCharCode.apply(null, octets.slice(0, 9));
  ok(tete === '%PDF-1.4\n', 'l’en-tête PDF : ' + JSON.stringify(tete));
  /* La marque binaire de la deuxième ligne : sans elle le fichier est
     structurellement valable et pourtant refusé — page blanche, sans message. */
  ok(octets.slice(10, 14).every((o) => o > 127),
    'la marque binaire de la deuxième ligne est là');

  const texte = String.fromCharCode.apply(null, octets.slice(-200));
  ok(/%%EOF/.test(texte), 'la marque de fin');
  ok(/startxref/.test(texte), 'et la position de la table');

  /* Le contenu doit être celui de la personne, pas un gabarit vide. */
  const tout = octets.map((o) => String.fromCharCode(o)).join('');
  ok(tout.indexOf('Amina Diallo') > 0, 'le nom de la personne y est');
  ok(tout.indexOf('Attestation') > 0, 'et le titre du document');
  /* Les accents en un seul octet : deux octets voudraient dire de l'UTF-8, et
     l'administration recevrait « Ã© ». */
  ok(tout.indexOf('Ã') === -1, 'aucun accent mal encodé');

  /* ---- 6. une attestation échue ne part pas en PDF non plus ---- */
  console.log('\n6. Ce qui ne s’imprime pas ne se télécharge pas davantage');
  const refus = await page.evaluate(() => {
    const S = window.BC.store;
    const c = S.state.contacts.find((x) => x.name === 'Amina Diallo');
    /* On la fait expirer artificiellement pour éprouver le refus.

       `domicilieJusqua` doit être écrasé aussi : le serveur le pose à
       l'ouverture du dossier, et `domiciliation.etat` le préfère à la date
       d'élection. Ne changer que « depuis » ne périme rien du tout — c'est
       d'ailleurs ce qui a fait échouer ce constat la première fois. */
    const copie = Object.assign({}, c, {
      domicilieDepuis: '2020-01-01',
      domicilieJusqua: '2021-01-01'
    });
    return window.BC.impression.refusAttestation(copie);
  });
  ok(!!refus && /renouvelez/i.test(refus),
    'un dossier échu est refusé, avec la raison : ' + JSON.stringify((refus || '').slice(0, 50)));

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
