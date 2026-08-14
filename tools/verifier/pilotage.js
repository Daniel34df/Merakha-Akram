/* Vérification : le relevé de journée et la santé de l'installation.
 *
 * `assets/js/journee.js` et `assets/js/diagnostic.js` sont purs et couverts
 * par `node --test`. Ce que ce script-ci garde fermé :
 *
 *   1. **Le relevé se peint, et une journée passée se relit.** Un relevé qui
 *      ne saurait montrer qu'aujourd'hui obligerait à croire de mémoire ce
 *      qui s'est passé hier.
 *
 *   2. **Le suspens porte la consigne, pas seulement le constat.** Une
 *      passation qui dit « un colis sans emplacement » sans dire quoi faire
 *      oblige le suivant à redécouvrir la consigne, et il ne la redécouvre
 *      pas.
 *
 *   3. **Le diagnostic ne se lance pas tout seul.** Il sonde le disque en
 *      écrivant un fichier ; rejoué à chaque rendu, il en créerait et
 *      effacerait cent par minute. Il se demande.
 *
 *   4. **Une vérification qui échoue ne dit pas « tout va bien ».** C'est la
 *      seule façon de rendre cet écran nuisible : il empêcherait quelqu'un
 *      d'aller voir. Un diagnostic manqué doit le dire.
 *
 *   5. **Le code de reprise d'usine est signalé.** Il est publié avec le code
 *      source ; tant qu'il n'est pas changé, il ouvre le compte responsable et
 *      avec lui tout le registre des personnes domiciliées.
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

  /* ---- 0. une journée avec du travail ---- */
  console.log('\n0. Une matinée chargée');
  await page.evaluate(async () => {
    const S = window.BC.store;
    await S.addContact({ name: 'Amina Diallo', telephone: '06 12 34 56 78' });
    await S.addContact({ name: 'Marc Petit', telephone: '07 00 11 22 33' });
    const p = (body) => fetch('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    // Un colis encombrant dont personne n'a noté où il est posé.
    await p({ name: 'Amina Diallo', type: 'colis', colis: { poids: 14, emplacement: '' } });
    await p({ name: 'Marc Petit', urgent: true });
    await p({ name: 'Marc Petit' });
    await S.loadServerState();
    window.BC.ui.ecrans.app.renderAll();
  });
  await page.waitForTimeout(900);

  await page.click('nav button[data-panel="suivi"]');
  await page.waitForTimeout(400);
  await page.click('#suiviSections button[data-section="journee"]');
  await page.waitForTimeout(600);

  /* ---- 1. le relevé se peint ---- */
  console.log('\n1. Le relevé de la journée s’affiche');
  ok(await page.isVisible('#journeeCompte'), 'la section s’ouvre');
  const compte = await page.$eval('#journeeCompte', (e) => e.innerText);
  ok(/3\s*\n?\s*Entrés/i.test(compte) || /Entrés/.test(compte), 'les entrées sont comptées');

  const cases = await page.$$eval('.journee-case', (els) =>
    els.map((e) => ({
      n: (e.querySelector('.journee-n') || {}).textContent,
      mot: (e.querySelector('.journee-mot') || {}).textContent
    })));
  const entres = cases.find((c) => /Entrés/.test(c.mot || ''));
  ok(entres && entres.n === '3', 'trois courriers entrés (' + (entres && entres.n) + ')');
  const urgents = cases.find((c) => /urgents/i.test(c.mot || ''));
  ok(urgents && urgents.n === '1',
    'et l’urgence n’est pas perdue en route (' + (urgents && urgents.n) + ')');

  /* ---- 2. le suspens porte la consigne ---- */
  console.log('\n2. Ce qui reste en plan dit quoi faire');
  const suspens = await page.$eval('#journeeSuspens', (e) => e.innerText);
  ok(/colis encombrant/i.test(suspens), 'le colis sans emplacement remonte');
  ok(/notez/i.test(suspens), 'et la consigne est écrite : ' + JSON.stringify(suspens.slice(0, 60)));
  ok(/Amina Diallo/.test(suspens), 'avec le nom, pour savoir lequel aller chercher');

  /* ---- 3. une journée passée se relit ---- */
  console.log('\n3. Une journée antérieure se relit telle qu’elle a été');
  await page.fill('#journeeDate', '2020-01-15');
  await page.waitForTimeout(500);
  const vieux = await page.$$eval('.journee-case', (els) =>
    els.map((e) => (e.querySelector('.journee-n') || {}).textContent));
  ok(vieux[0] === '0', 'aucun mouvement ce jour-là (' + vieux[0] + ')');
  const phrase = await page.$eval('#journeePhrase', (e) => e.textContent);
  ok(/Aucun mouvement/.test(phrase), 'et la phrase le dit : ' + JSON.stringify(phrase));

  await page.click('#journeeAujourdhuiBtn');
  await page.waitForTimeout(500);
  const revenu = await page.$$eval('.journee-case', (els) =>
    els.map((e) => (e.querySelector('.journee-n') || {}).textContent));
  ok(revenu[0] === '3', '« Aujourd’hui » ramène au jour en cours');

  /* ---- 4. le diagnostic ne se lance pas tout seul ---- */
  console.log('\n4. Le diagnostic se demande, il ne se lance pas seul');
  await page.click('nav button[data-panel="reglages"]');
  await page.waitForTimeout(400);
  await page.click('#reglagesSections button[data-section="controle"]');
  await page.waitForTimeout(500);

  const avant = await page.$eval('#diagnosticListe', (e) => e.innerText);
  ok(/pas encore été vérifiée/i.test(avant),
    'avant qu’on le demande, il dit qu’il n’a rien regardé');
  ok(!/en ordre/i.test(avant), 'et surtout, il ne dit pas que tout va bien');

  /* ---- 5. ce qu'il trouve ---- */
  console.log('\n5. Ce qu’il trouve, et le mot qui va avec');
  await page.click('#diagnosticBtn');
  await page.waitForTimeout(1500);

  const lignes = await page.$$eval('.diag-ligne', (els) =>
    els.map((e) => ({
      classe: e.className,
      titre: (e.querySelector('dt') || {}).innerText,
      mot: (e.querySelector('.diag-mot') || {}).textContent,
      corps: (e.querySelector('dd') || {}).innerText
    })));
  ok(lignes.length >= 6, lignes.length + ' points examinés');

  const muets = lignes.filter((l) => !l.mot);
  ok(muets.length === 0,
    'chaque point écrit son état, la couleur ne le porte pas seule (' + muets.length + ' en défaut)');

  const code = lignes.find((l) => /code de reprise/i.test(l.titre || ''));
  ok(!!code, 'le code de reprise est examiné');
  ok(/diag-grave/.test(code.classe),
    'et le code d’usine est signalé comme grave — il est publié avec le code source');
  ok(/MASTER_CODE/.test(code.corps), 'avec la variable à poser : ' + JSON.stringify((code.corps || '').slice(0, 50)));

  const ecriture = lignes.find((l) => /écriture/i.test(l.titre || ''));
  ok(ecriture && /diag-bon/.test(ecriture.classe),
    'l’écriture du registre est vérifiée en écrivant, pas en lisant des droits');

  const phraseDiag = await page.$eval('#diagnosticPhrase', (e) => e.textContent);
  ok(/grave/.test(phraseDiag), 'la phrase du haut annonce le plus grave : ' + JSON.stringify(phraseDiag));

  /* Les chiffres bruts sont là, mais à part : on ne peut rien en faire, ils
     n'ont donc pas à encombrer la liste des constats. */
  const chiffres = await page.$eval('#diagnosticChiffres', (e) => e.textContent);
  ok(/version/.test(chiffres) && /Node/.test(chiffres), 'les chiffres bruts restent en marge');

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
