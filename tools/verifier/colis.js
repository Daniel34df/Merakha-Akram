/* Vérification : le colis, au guichet.
 *
 * `assets/js/colis.js` est pur et couvert par `node --test`. Ce que ce
 * script-ci garde fermé :
 *
 *   1. **Les champs n'apparaissent que pour un colis.** Sept champs de plus
 *      sur chaque lettre repousseraient le bouton « Valider » hors de l'écran,
 *      et le Guichet a été allégé exprès.
 *
 *   2. **L'emplacement est demandé quand — et seulement quand — le colis ne
 *      tient pas dans un casier.** C'est la seule information sans laquelle un
 *      colis encombrant devient introuvable : il reste au registre, avec son
 *      code de retrait, mais personne ne sait où il est posé. À l'inverse,
 *      demander « où l'avez-vous mis » pour une boîte qui tient dans B-012 est
 *      une question pour rien — et une question pour rien apprend à ne pas
 *      répondre.
 *
 *   3. **Le transporteur se devine du numéro, et le dit.** L'agent lit
 *      l'étiquette ; il ne devrait pas avoir à retrouver dans une liste ce que
 *      le numéro dit déjà. Mais la phrase doit tenir : écrite au moment où l'on
 *      devine, elle disparaissait à la frappe suivante.
 *
 *   4. **Rien n'est appelé chez le transporteur.** Un suivi consulté
 *      automatiquement dirait à un tiers, à chaque affichage, que telle
 *      personne domiciliée à telle adresse attend tel colis.
 *
 *   5. **Le colis arrive jusqu'à la fiche de remise**, emplacement en tête :
 *      quelqu'un attend au comptoir, et ce qu'il faut d'abord c'est savoir où
 *      aller le chercher.
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

  /* ---- 1. les champs n'existent que pour un colis ---- */
  console.log('\n1. Les champs du colis ne paraissent que pour un colis');
  ok(!(await page.isVisible('#colisChamps')), 'une lettre ne les montre pas');
  await page.click('#typeCourrier button[data-type="colis"]');
  await page.waitForTimeout(300);
  ok(await page.isVisible('#colisChamps'), 'un colis les montre');
  await page.click('#typeCourrier button[data-type="lettre"]');
  await page.waitForTimeout(300);
  ok(!(await page.isVisible('#colisChamps')), 'et revenir à la lettre les referme');
  await page.click('#typeCourrier button[data-type="colis"]');
  await page.waitForTimeout(300);

  /* ---- 2. le transporteur deviné, et la phrase qui tient ---- */
  console.log('\n2. Le transporteur se devine du numéro, et la phrase reste');
  await page.fill('#colisSuivi', '6A 1234 5678 9FR');
  await page.waitForTimeout(350);
  let etat = await page.evaluate(() => ({
    transporteur: document.getElementById('colisTransporteur').value,
    aide: document.getElementById('colisSuiviAide').textContent
  }));
  ok(etat.transporteur === 'colissimo', 'reconnu depuis l’étiquette (' + etat.transporteur + ')');
  ok(/reconnu/.test(etat.aide), 'et l’application le dit : ' + JSON.stringify(etat.aide));

  /* La frappe suivante ne doit pas effacer la phrase : sinon l'agent ne sait
     plus si le transporteur affiché vient de lui ou de l'application. */
  await page.fill('#colisPoids', '1,2');
  await page.waitForTimeout(350);
  etat = await page.evaluate(() => document.getElementById('colisSuiviAide').textContent);
  ok(/reconnu/.test(etat), 'elle tient après une autre frappe : ' + JSON.stringify(etat));

  /* ---- 3. l'emplacement, seulement quand il compte ---- */
  console.log('\n3. L’emplacement n’est demandé que pour ce qui ne rentre pas');
  ok(!(await page.isVisible('#colisEmplacementBloc')),
    'un colis d’un kilo va au casier : aucune question');

  await page.fill('#colisPoids', '12,5');
  await page.waitForTimeout(350);
  ok(await page.isVisible('#colisEmplacementBloc'), 'douze kilos : la question paraît');
  const aideEmpl = await page.$eval('#colisEmplacementAide', (e) => e.textContent);
  ok(/retrouver/.test(aideEmpl), 'et elle dit pourquoi : ' + JSON.stringify(aideEmpl.slice(0, 50)));

  /* Une seule cote suffit : un tube d'un mètre pèse deux kilos et ne rentre
     dans aucun casier. Raisonner sur le volume laisserait passer ce cas-là. */
  await page.fill('#colisPoids', '2');
  await page.fill('#colisL', '120');
  await page.waitForTimeout(350);
  ok(await page.isVisible('#colisEmplacementBloc'),
    'un tube d’un mètre aussi, même léger');

  /* ---- 4. rien n'est appelé chez le transporteur ---- */
  console.log('\n4. Aucun appel n’est fait chez le transporteur');
  const sorties = [];
  page.on('request', function (r) {
    const u = r.url();
    if (!/^https?:\/\/127\.0\.0\.1|^https?:\/\/localhost/.test(u)) sorties.push(u);
  });
  await page.fill('#colisSuivi', '1Z999AA10123456784');
  await page.waitForTimeout(900);
  ok(sorties.length === 0,
    'le numéro de suivi ne sort pas de la machine (' + sorties.join(', ') + ')');

  /* ---- 5. le colis arrive jusqu'à la fiche de remise ---- */
  console.log('\n5. Le colis se retrouve sur la fiche, emplacement en tête');
  const fiche = await page.evaluate(async () => {
    const S = window.BC.store;
    await S.addContact({ name: 'Amina Diallo', telephone: '06 12 34 56 78' });
    const res = await fetch('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Amina Diallo', type: 'colis',
        colis: { poids: '14', suivi: 'XY123456789FR', emplacement: 'étagère du fond, à droite' }
      })
    });
    const rec = await res.json();
    await S.loadServerState();
    return rec;
  });
  ok(fiche.colis && fiche.colis.emplacement === 'étagère du fond, à droite',
    'le serveur garde l’emplacement');
  ok(fiche.colis.transporteur === 'chronopost', 'et le transporteur deviné du numéro');

  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(500);
  await page.fill('#pickupCode', fiche.pickupCode);
  await page.click('#pickupCodeBtn');
  await page.waitForTimeout(900);
  const texte = await page.$eval('#pickupDetail', (e) => e.innerText);
  ok(/étagère du fond/.test(texte), 'la fiche de remise dit où il est rangé');
  ok(texte.indexOf('étagère du fond') < texte.indexOf('Chronopost'),
    'et le dit avant qui l’a livré — c’est ce dont l’agent a besoin en premier');
  ok(/XY123456789FR/.test(texte), 'le numéro de suivi y est, pour répondre au téléphone');

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
