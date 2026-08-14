/* Vérification : la référence de courrier, et l'avertissement avant un doublon.
 *
 * Les deux modules sont purs et couverts par `node --test`. Ce que ce
 * script-ci garde fermé, c'est ce que les tests unitaires ne voient pas :
 *
 *   1. **L'avertissement paraît pendant la saisie.** Le calcul peut être juste
 *      et l'emplacement rester caché — un `hidden` jamais retiré, un module
 *      absent de la page, un `root.BC.doublons` indéfini qui fait taire la
 *      fonction sans rien casser d'autre. C'est le mode d'échec le plus
 *      probable, et il est silencieux : la fiche en double se crée, et
 *      personne n'apprend qu'elle existe avant que le courrier commence à se
 *      répartir entre les deux.
 *
 *   2. **Il prévient sans bloquer.** Le bouton d'ajout reste actif, et la
 *      fiche se crée quand même. Deux frères d'un même foyer portent le même
 *      nom ; refuser serait pire que le doublon.
 *
 *   3. **Le motif est écrit.** « même courriel » et « nom très proche »
 *      n'appellent pas la même prudence, et la couleur ne dit pas la
 *      différence (§33, §54).
 *
 *   4. **La référence est là et se voit.** Un courrier inscrit repart avec son
 *      « COUR-2026-000001 » — c'est ce qu'on dicte au téléphone six mois plus
 *      tard, quand le code de retrait à quatre chiffres ne veut plus rien dire.
 */
'use strict';

const C = require('./commun.js');

const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);

  /* ---- 0. le registre de départ ---- */
  console.log('\n0. Une fiche existe déjà');
  await page.evaluate(async () => {
    await window.BC.store.addContact({
      name: 'Jean Dupont',
      email: 'jean@exemple.org',
      telephone: '06 12 34 56 78'
    });
    await window.BC.store.loadServerState();
  });
  await page.waitForTimeout(600);

  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(600);

  /* ---- 1. l'avertissement paraît pendant la saisie ---- */
  console.log('\n1. Taper un nom proche fait paraître l’avertissement');
  ok(!(await page.isVisible('#addDoublons')), 'rien ne s’affiche tant qu’on n’a rien tapé');

  // Une lettre d'écart : c'est la faute de frappe ordinaire au guichet.
  await page.fill('#newName', 'Jean Dupond');
  await page.waitForTimeout(400);
  ok(await page.isVisible('#addDoublons'), 'l’avertissement paraît sans quitter le champ');

  const texte = await page.$eval('#addDoublons', (el) => el.innerText);
  ok(/Jean Dupont/.test(texte), 'il nomme la fiche qui ressemble');
  ok(/doublon/i.test(texte), 'et dit de quoi il s’agit : ' + JSON.stringify(texte.slice(0, 60)));

  /* ---- 2. le motif est écrit, pas seulement peint ---- */
  console.log('\n2. Le motif du rapprochement est en toutes lettres');
  const motif = await page.$eval('#addDoublons .doublon-sur', (el) => el.textContent);
  ok(/nom tr[eè]s proche/i.test(motif), 'un nom approchant se dit tel quel (' + motif + ')');

  await page.fill('#newName', 'Quelqu’un d’Autre');
  await page.fill('#newEmail', 'JEAN@Exemple.ORG');
  await page.waitForTimeout(400);
  const motifCourriel = await page.$eval('#addDoublons .doublon-sur', (el) => el.textContent);
  ok(/m[eê]me courriel/i.test(motifCourriel),
    'le courriel identique se distingue du nom approchant (' + motifCourriel + ')');

  /* Le signal le plus sûr en tête : l'agent ne lira peut-être que la première
     ligne, et c'est celle-là qui doit valoir la peine d'être lue. */
  const premier = await page.$eval('#addDoublons .doublons-liste li', (el) => el.innerText);
  ok(/Jean Dupont/.test(premier), 'et il vient en premier');

  /* ---- 3. l'avertissement s'efface quand il n'a plus lieu d'être ---- */
  console.log('\n3. Il disparaît dès qu’il n’y a plus de ressemblance');
  await page.fill('#newEmail', 'sansrapport@exemple.org');
  await page.waitForTimeout(400);
  ok(!(await page.isVisible('#addDoublons')),
    'un avertissement qui reste après coup finit par ne plus être lu');

  /* ---- 4. il prévient, il ne bloque pas ---- */
  console.log('\n4. La fiche se crée quand même');
  await page.fill('#newName', 'Jean Dupond');
  await page.fill('#newEmail', '');
  await page.fill('#newTelephone', '07 11 22 33 44');
  await page.waitForTimeout(400);
  ok(await page.isVisible('#addDoublons'), 'l’avertissement est bien là');
  ok(await page.isEnabled('#addContactBtn'),
    'et le bouton d’ajout reste actif — c’est l’agent qui a la personne devant lui');

  await page.click('#addContactBtn');
  await page.waitForTimeout(900);
  const cree = await page.evaluate(() =>
    window.BC.store.state.contacts.some((c) => c.name === 'Jean Dupond'));
  ok(cree, 'la fiche est créée malgré l’avertissement');

  /* ---- 5. « Voir la fiche » ouvre celle qu'on montre ---- */
  console.log('\n5. On peut aller regarder la fiche signalée');
  await page.fill('#newName', 'Jean Dupont');
  await page.waitForTimeout(400);
  const boutons = await page.$$('#addDoublons [data-doublon]');
  ok(boutons.length > 0, 'chaque ligne mène à sa fiche');
  await boutons[0].click();
  await page.waitForTimeout(700);
  const fiche = await page.evaluate(() => {
    const d = document.getElementById('ficheDialog');
    return d && d.open ? d.innerText : '';
  });
  ok(/Jean Dup/.test(fiche), 'et la fiche s’ouvre sur la bonne personne');

  /* ---- 6. la référence de courrier ---- */
  console.log('\n6. Un courrier inscrit porte sa référence');
  const ref = await page.evaluate(async () => {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jean Dupont', email: 'jean@exemple.org' })
    });
    return (await res.json()).reference;
  });
  ok(/^[A-Z]{2,6}-\d{4}-\d{6}$/.test(ref || ''), 'elle se dicte au téléphone : ' + ref);
  ok(/-000001$/.test(ref || ''), 'et le premier courrier de l’année porte le numéro un');

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
