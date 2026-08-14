/* Vérification : appelée, pas venue, rappelée.

   Une personne sans courriel était appelée une seule fois, puis son courrier
   glissait vers le rebut. On ne peut pas attendre huit jours : on décale
   l'horloge de la page, qui ne lit le temps que par Date.now(). */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

const listeAppels = page => page.evaluate(() => {
  const c = document.getElementById('appelsCard');
  return {
    cachee: c.hidden || c.offsetParent === null,
    compte: document.getElementById('countAppels').textContent,
    resume: document.getElementById('appelsResume').textContent,
    texte: document.getElementById('appelsTable').innerText.replace(/\s+/g, ' ')
  };
});

/** Avancer l'horloge de la page de N jours, puis recharger. */
async function avancerDe(page, jours) {
  await page.evaluate(j => localStorage.setItem('__decalage', String(j * 86400000)), jours);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    () => window.BC && BC.store && BC.store.state.mode === 'serveur',
    null, { timeout: 15000 }
  );
  await page.waitForTimeout(1400);
}

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);

  await page.addInitScript(() => {
    const vrai = Date.now.bind(Date);
    Date.now = function () {
      return vrai() + (Number(localStorage.getItem('__decalage')) || 0);
    };
  });

  await C.ouvrirLeBureau(page);

  console.log('\n1. Un courrier pour une personne sans courriel');
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(700);
  await page.fill('#newName', 'Amina Diallo');
  await page.fill('#newTelephone', '06 12 34 56 78');
  await page.fill('#newBox', 'B-12');
  await page.click('#addContactBtn');
  await page.waitForTimeout(1300);
  await page.evaluate(async () => {
    const c = BC.store.state.contacts.find(x => x.name === 'Amina Diallo');
    await BC.store.sendViaServer(c, { subject: 'Un courrier vous attend', body: '.' });
  });
  await page.waitForTimeout(1200);
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(1100);

  let vue = await listeAppels(page);
  ok(!vue.cachee && vue.compte === '1', 'elle est à prévenir (' + vue.compte + ')');
  ok(/Prévenue/.test(vue.texte), 'le bouton dit « Prévenue »');

  console.log('\n2. L’agent l’appelle — elle sort de la liste');
  await page.click('button[data-appel-joint]');
  await page.waitForTimeout(1600);
  vue = await listeAppels(page);
  ok(vue.cachee || vue.compte === '0', 'la liste est vide juste après l’appel');

  console.log('\n3. Huit jours passent, elle n’est pas venue');
  await avancerDe(page, 8);
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(900);
  vue = await listeAppels(page);
  ok(!vue.cachee && vue.compte === '1', 'elle revient dans la liste (' + vue.compte + ')');
  ok(/à rappeler/i.test(vue.texte), 'marquée « à rappeler » — ' + vue.texte.slice(0, 140));
  ok(/Rappelée/.test(vue.texte), 'et le bouton dit « Rappelée »');
  ok(/1 appel/.test(vue.texte), 'avec le nombre d’appels déjà passés');
  ok(/rappeler/i.test(vue.resume), 'le résumé les compte : « ' + vue.resume + ' »');

  await C.capture(page, 'rappel');

  console.log('\n4. On la rappelle : elle repart pour une semaine');
  await page.click('button[data-appel-joint]');
  await page.waitForTimeout(1600);
  await avancerDe(page, 0);
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(900);
  vue = await listeAppels(page);
  ok(vue.cachee || vue.compte === '0', 'elle ressort de la liste');
  const n = await page.evaluate(() => {
    const h = BC.store.state.history.find(x => !x.email);
    return (h.appels || []).length;
  });
  ok(n === 2, 'les deux appels sont consignés (' + n + ')');

  console.log('\n5. Elle vient chercher son courrier');
  await avancerDe(page, 16);
  await page.evaluate(async () => {
    const h = BC.store.state.history.find(x => !x.email);
    await BC.store.setPickedUp(h.id, true, null, {});
  });
  await page.waitForTimeout(1400);
  await page.click('nav button[data-panel="remise"]');
  await page.waitForTimeout(900);
  vue = await listeAppels(page);
  ok(vue.cachee || vue.compte === '0', 'retiré : plus aucun appel à passer');

  await C.conclure(b, page, v);
})().catch(e => { console.error('PLANTAGE', e); process.exit(1); });
