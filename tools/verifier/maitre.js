/* Vérification : le code de reprise.

   Publié avec le code source, il ouvrait le compte du responsable à tout le
   réseau local. Ce script garde fermé ce que le responsable doit voir — et ce
   qu'un agent ne doit pas apprendre. */
'use strict';

const C = require('./commun.js');

const BASE = C.base();
const v = C.verificateur();
const ok = v.ok;

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b);

  await C.ouvrirLeBureau(page);

  console.log('\n1. Le responsable voit l’avertissement');
  await page.click('nav button[data-panel="reglages"]');
  await page.waitForTimeout(800);
  await page.click('#reglagesSections button:text-is("Les accès")');
  await page.waitForTimeout(900);

  const carte = page.locator('#codeMaitreCard');
  ok(await carte.isVisible(), 'la carte d’alerte est affichée');
  const texte = await carte.innerText();
  ok(/public/i.test(texte), 'elle dit que le code est public');
  ok(/MASTER_CODE/.test(texte), 'elle dit quoi changer');
  ok(/depuis ce poste/i.test(texte), 'elle dit ce qui protège en attendant');
  ok(!texte.includes('26366686806'), 'et ne réimprime pas le code lui-même');

  /* Le drapeau ne doit pas transporter le code. */
  const etat = await page.evaluate(() => ({
    drapeau: BC.store.state.codeMaitreParDefaut,
    contientCode: JSON.stringify(BC.store.state).includes('26366686806')
  }));
  ok(etat.drapeau === true, 'l’état porte le drapeau');
  ok(etat.contientCode === false, 'le code n’est nulle part dans l’état du navigateur');

  await carte.scrollIntoViewIfNeeded();
  await C.capture(page, 'code-maitre');

  console.log('\n2. Un agent ne l’apprend pas');
  const agentInfo = await page.evaluate(async () => {
    const r = await fetch('/api/auth/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ name: 'Accueil' })
    });
    return r.json();
  });
  const ctx = await b.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(BASE, { waitUntil: 'load' });
  await p2.waitForSelector('#authGate', { state: 'visible', timeout: 15000 });
  await p2.click('#gateTabs button:has-text("agent"), #gateTabs button:nth-child(2)').catch(() => {});
  await p2.waitForTimeout(500);
  await p2.fill('#agentIdentifiant', agentInfo.agent.identifiant);
  await p2.fill('#agentCode', agentInfo.code);
  await p2.click('#agentForm button[type=submit]');
  await p2.waitForTimeout(2000);
  const vuAgent = await p2.evaluate(() => BC.store.state.codeMaitreParDefaut);
  ok(vuAgent === false, 'l’agent ne reçoit pas le drapeau (' + vuAgent + ')');

  await C.conclure(b, page, v);
})().catch(e => { console.error('PLANTAGE', e); process.exit(1); });
