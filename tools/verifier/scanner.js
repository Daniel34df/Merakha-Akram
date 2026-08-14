/* Vérification : le scanner.
 *
 * Ce que ce script garde fermé, et qu'aucun test unitaire ne voit :
 *
 *   1. **La voie qui marche toujours est ouverte.** La douchette n'est pas un
 *      repli caché en bas de l'écran : c'est le champ, au centre, avec le
 *      curseur dedans. Un lecteur de comptoir tape et valide sans un clic.
 *
 *   2. **La caméra absente s'explique.** Ce script tourne en http, donc hors
 *      contexte sûr — exactement la situation d'un poste du bureau relié en
 *      réseau. L'écran doit dire pourquoi et quoi faire, pas laisser un bouton
 *      mort.
 *
 *   3. **Un code scanné mène au bon endroit.** Un numéro de casier ouvre le
 *      casier, un code de retrait ouvre la remise avec le code déjà saisi, un
 *      nom ambigu propose la liste au lieu de choisir.
 */
'use strict';

const C = require('./commun.js');

const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);
  await C.ouvrirLeBureau(page);

  /* ---- le décor ---- */
  await page.evaluate(async () => {
    const S = window.BC.store;
    await S.creerSerieBoites({ debut: 1, fin: 6, zone: 'Couloir A' });
    await S.addContact({ name: 'Amina Diallo', telephone: '06 12 34 56 78', box: 'B-002' });
    await S.addContact({ name: 'Amine Diallo', telephone: '07 00 00 00 00' });
    await S.loadServerState();
  });
  await page.waitForTimeout(900);

  /* ---- 1. la douchette, au centre ---- */
  console.log('\n1. La douchette est la voie principale, pas un repli');
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(500);
  ok(await page.isVisible('#panel-remise [data-ouvrir-scan]'),
    'le bouton « Scanner » est proposé à la remise');

  await page.click('#panel-remise [data-ouvrir-scan]');
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => document.getElementById('scanDialog').open), 'le scanner s’ouvre');
  ok(await page.isVisible('#scanChamp'), 'le champ de saisie est là');

  const focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok(focus === 'scanChamp',
    'et le curseur y est déjà : une douchette tape sans qu’on clique (focus : ' + focus + ')');

  /* ---- 2. la caméra : où elle marche, et ce qui est dit sinon ---- */
  console.log('\n2. La caméra là où elle marche, une explication ailleurs');

  /* Le poste qui héberge l'application est une origine de confiance —
     127.0.0.1 comme localhost. La caméra y est donc ouverte **sans aucun
     https à installer**, ce qui couvre le cas le plus fréquent : un bureau,
     un poste, un lecteur. C'est la bonne nouvelle de cette vérification. */
  const etat = await page.evaluate(() => ({
    sur: window.isSecureContext,
    message: document.getElementById('scanEtat').innerText,
    blocCamera: document.getElementById('scanCameraBloc').hidden
  }));
  ok(etat.sur === true, 'le poste qui héberge est une origine de confiance, sans https à poser');
  ok(etat.blocCamera === false, 'la caméra y est donc proposée');
  ok(etat.message === '', 'et rien à expliquer : ' + JSON.stringify(etat.message));

  /* L'autre cas — un poste du bureau relié en http — ne peut pas se produire
     dans ce script, qui tourne sur l'hôte. On interroge donc la même logique
     avec un faux contexte : c'est elle qui décide, et c'est elle qu'on veut
     voir dire quoi faire plutôt que laisser un bouton mort. */
  const ailleurs = await page.evaluate(() =>
    window.BC.scanner.capacites({
      isSecureContext: false,
      navigator: { mediaDevices: { getUserMedia: function () {} } }
    }));
  ok(ailleurs.camera === false, 'sur un poste en http, la caméra reste fermée');
  ok(/https/i.test(ailleurs.raison), 'et l’écran nomme la condition : ' +
    JSON.stringify(ailleurs.raison.slice(0, 50)));
  ok(/douchette/i.test(ailleurs.raison), 'en proposant la voie qui, elle, marche partout');
  ok(ailleurs.douchette === true && ailleurs.code39 === true,
    'la douchette et le décodeur maison ne dépendent d’aucun contexte sûr');

  /* ---- 3. un code mène au bon endroit ---- */
  console.log('\n3. Ce qu’on scanne ouvre ce qu’il faut');

  // Un numéro de casier → le plan, sur le bon casier.
  await page.fill('#scanChamp', 'b2');
  await page.press('#scanChamp', 'Enter');
  await page.waitForTimeout(900);
  const apresCasier = await page.evaluate(() => ({
    scanFerme: !document.getElementById('scanDialog').open,
    casierOuvert: document.getElementById('casierDialog').open,
    texte: document.getElementById('casierDialogCorps').innerText
  }));
  ok(apresCasier.scanFerme, 'le scanner se referme sur un résultat sûr');
  ok(apresCasier.casierOuvert, '« b2 » ouvre la fiche du casier');
  ok(/B-002/.test(apresCasier.texte), 'le bon casier : ' + apresCasier.texte.split('\n')[0]);
  ok(/Amina Diallo/.test(apresCasier.texte), 'avec son titulaire');

  await page.evaluate(() => document.getElementById('casierDialog').close());
  await page.waitForTimeout(300);

  // Un nom ambigu → la liste, jamais un choix fait à notre place.
  // Le scan précédent a mené au Registre : on revient au comptoir.
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(400);
  await page.click('#panel-remise [data-ouvrir-scan]');
  await page.waitForTimeout(400);
  await page.fill('#scanChamp', 'Diallo');
  await page.press('#scanChamp', 'Enter');
  await page.waitForTimeout(600);
  const ambigu = await page.evaluate(() => ({
    encoreOuvert: document.getElementById('scanDialog').open,
    texte: document.getElementById('scanResultat').innerText,
    choix: document.querySelectorAll('[data-scan-fiche]').length
  }));
  ok(ambigu.encoreOuvert, 'sur une ambiguïté, le scanner reste ouvert');
  ok(ambigu.choix === 2, 'et propose les deux personnes (' + ambigu.choix + ')');
  ok(/2 personnes/.test(ambigu.texte), 'en le disant : ' + JSON.stringify(ambigu.texte.split('\n')[0]));

  // Un code inconnu se dit inconnu.
  await page.fill('#scanChamp', 'ZZZZZZ');
  await page.press('#scanChamp', 'Enter');
  await page.waitForTimeout(500);
  const inconnu = await page.evaluate(() => document.getElementById('scanResultat').innerText);
  ok(/Aucun/.test(inconnu), 'un code inconnu le dit plutôt que d’ouvrir au hasard');

  /* ---- 4. le décodeur maison, sur une vraie image ---- */
  console.log('\n4. Le décodeur lit les étiquettes que l’application imprime');
  const lu = await page.evaluate(() => {
    /* On dessine l'étiquette avec l'encodeur de l'application, puis on la
       relit avec son décodeur — le tour complet, dans le navigateur. */
    const els = window.BC.codebarres.elements('B-002');
    const e = 3;
    const c = document.createElement('canvas');
    c.height = 40;
    c.width = 40 + els.reduce((n, el) => n + (el.large ? 3 : 1) * e, 0);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    let x = 20;
    els.forEach((el) => {
      const w = (el.large ? 3 : 1) * e;
      if (el.barre) { ctx.fillStyle = '#000'; ctx.fillRect(x, 0, w, c.height); }
      x += w;
    });
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return window.BC.scanner.lireImage(d.data, c.width, c.height);
  });
  ok(lu === 'B-002', 'une étiquette dessinée puis relue dans le navigateur : ' + JSON.stringify(lu));

  await C.conclure(b, page, v);
})().catch(function (e) { console.error('PLANTAGE', e); process.exit(1); });
