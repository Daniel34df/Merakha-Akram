#!/usr/bin/env node
/* Bureau du Courrier — le parcours complet, joué dans un vrai navigateur.
 *
 *   node tools/parcours.js                  (sur http://localhost:3000)
 *   PORT=5480 node tools/parcours.js        (sur un autre port)
 *   CAPTURES=./captures node tools/parcours.js
 *
 * Il sert deux fois.
 *
 * D'abord de vérification : il suit le courrier d'une personne domiciliée du
 * début à la fin — inscription, arrivée du courrier, notification, retrait,
 * relance, passage, attestation. Si une étape casse, elle casse ici, sur une
 * ligne numérotée, plutôt que devant quelqu'un au guichet.
 *
 * Ensuite de procédure : la sortie est numérotée et se lit sans connaître le
 * code. Imprimez-la, affichez-la au guichet, elle forme une remplaçante.
 *
 * Il joue exprès **deux personnes** : l'une avec une adresse électronique,
 * l'autre avec seulement un téléphone. La seconde est le cas le plus fréquent
 * dans un bureau de domiciliation, et longtemps l'application ne savait pas la
 * traiter — ce script existe surtout pour qu'elle ne le réoublie jamais.
 *
 * Il demande Playwright, qui n'est installé qu'en développement : ce script
 * n'est pas nécessaire au fonctionnement de l'application.
 */
'use strict';

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE || 'http://127.0.0.1:' + PORT;
const CAPTURES = process.env.CAPTURES || '';
const LENT = Number(process.env.LENT || 0); // millisecondes ajoutées entre les gestes

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('\n  Playwright est absent. Installez-le :  npm install -D playwright\n');
  process.exit(1);
}

const CHEMIN_CHROME = process.env.CHROME || undefined;

/* ---------- mise en forme de la procédure ---------- */

let etape = 0;
const soucis = [];

function titre(texte) {
  etape++;
  console.log('\n[1m  ' + etape + '. ' + texte + '[0m');
}
function dit(texte) {
  console.log('     ' + texte);
}
function verifie(condition, attendu) {
  if (condition) {
    console.log('     [32m✓[0m ' + attendu);
  } else {
    console.log('     [31m✗[0m ' + attendu);
    soucis.push(etape + '. ' + attendu);
  }
}

const pause = (p) => (LENT ? p.waitForTimeout(LENT) : Promise.resolve());

async function capture(p, nom) {
  if (!CAPTURES) return;
  const fs = require('node:fs');
  fs.mkdirSync(CAPTURES, { recursive: true });
  await p.screenshot({ path: CAPTURES + '/' + nom + '.png' });
}

/** Les réglages sont rangés en sections : ouvrir la bonne avant d'y cliquer. */
async function section(p, libelle) {
  await p.click('#reglagesSections button:text-is("' + libelle + '")');
  await p.waitForTimeout(400);
}

async function pret(p) {
  await p.waitForFunction(
    () => window.BC && BC.store && BC.store.state.mode === 'serveur' && !BC.store.state.auth.required,
    null,
    { timeout: 15000 }
  );
}

/* ---------- le parcours ---------- */

async function main() {
  const navigateur = await chromium.launch({ executablePath: CHEMIN_CHROME });
  const erreursJs = [];
  const page = await navigateur.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', (e) => erreursJs.push('responsable : ' + e.message));
  // L'impression bloquerait le script : on la compte au lieu de l'ouvrir.
  await page.addInitScript(() => {
    window.__imprime = 0;
    window.print = () => { window.__imprime++; };
  });

  console.log('\n[1m  BUREAU DU COURRIER — le parcours d’un courrier, du guichet à la personne[0m');
  console.log('  ' + BASE + '\n  ' + '─'.repeat(70));

  // ── 1 ──────────────────────────────────────────────────────────────────
  titre('Le bureau s’installe');
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#authGate', { state: 'visible', timeout: 15000 });
  if (await page.isVisible('#signupForm')) {
    await page.fill('#signupName', 'Akram');
    await page.fill('#signupEmail', 'responsable@bureau.org');
    await page.fill('#signupPassword', 'mot-de-passe-du-bureau');
    await page.click('#signupForm button[type=submit]');
    dit('Premier démarrage : le compte responsable est créé.');
  } else {
    await page.fill('#loginEmail', 'responsable@bureau.org');
    await page.fill('#loginPassword', 'mot-de-passe-du-bureau');
    await page.click('#loginForm button[type=submit]');
    dit('Le responsable se connecte.');
  }
  await page.waitForTimeout(1500);
  if (await page.isVisible('#skipAssociateBtn')) await page.click('#skipAssociateBtn');
  await page.waitForSelector('#authGate', { state: 'hidden', timeout: 10000 });
  await pret(page);
  verifie(true, 'Le registre est ouvert.');
  await pause(page);

  // ── 2 ──────────────────────────────────────────────────────────────────
  titre('Il déclare l’identité du bureau');
  await page.click('nav button[data-panel="reglages"]');
  await page.waitForTimeout(700);
  await section(page, 'Le bureau');
  await page.fill('#setOffice', 'Association Solidarité Accueil');
  await page.fill('#setAdresse', '12 rue des Lilas, 75011 Paris');
  await page.fill('#setVille', 'Paris');
  await page.fill('#setAgrement', 'Agrément préfectoral n° 2024-137 du 3 mars 2024');
  await page.click('#saveOrganismeBtn');
  await page.waitForSelector('#organismeMsg .msg.ok', { timeout: 8000 });
  dit('Nom, adresse et agrément : ils signeront les attestations.');
  verifie(true, 'Identité enregistrée.');
  await capture(page, '01-identite');

  // ── 3 ──────────────────────────────────────────────────────────────────
  titre('Il remet un accès à l’agent d’accueil');
  await section(page, 'Les accès');
  await page.click('#nouvelAgentBtn');
  await page.waitForTimeout(300);
  await page.fill('#agentNom', 'Accueil');
  await page.click('#creerAgentBtn');
  await page.waitForSelector('#agentsMsg .msg.ok', { timeout: 8000 });
  const acces = await page.evaluate(() => ({
    identifiant: document.querySelector('#agentsMsg .identifiant-pill').textContent.trim(),
    code: document.querySelector('#agentsMsg .code-pill').textContent.trim()
  }));
  dit('Identifiant ' + acces.identifiant + ', code à usage du poste d’accueil.');
  dit('L’agent n’a ni courriel ni mot de passe à retenir, et ne voit pas les codes de retrait.');
  verifie(!!acces.identifiant, 'Accès agent créé.');
  await capture(page, '02-acces-agent');

  // ── le poste de l'agent ────────────────────────────────────────────────
  const contexte = await navigateur.newContext({ viewport: { width: 1200, height: 1000 } });
  const agent = await contexte.newPage();
  agent.on('pageerror', (e) => erreursJs.push('agent : ' + e.message));
  await agent.addInitScript(() => {
    window.__imprime = 0;
    window.print = () => { window.__imprime++; };
  });
  await agent.goto(BASE, { waitUntil: 'load' });
  await agent.waitForSelector('#loginForm', { state: 'visible' });
  await agent.click('.gate-tabs button[data-form="agent"]');
  await agent.fill('#agentIdentifiant', acces.identifiant);
  await agent.fill('#agentCode', acces.code);
  await agent.click('#agentForm button[type=submit]');
  await agent.waitForSelector('#authGate', { state: 'hidden', timeout: 10000 });
  await pret(agent);
  await agent.waitForTimeout(600);

  // ── 4 ──────────────────────────────────────────────────────────────────
  titre('Deux personnes se domicilient au bureau');
  const gens = [
    { nom: 'DIALLO', prenom: 'Awa', courriel: 'awa@exemple.org', tel: '', boite: 'D-07' },
    { nom: 'BENALI', prenom: 'Omar', courriel: '', tel: '06 11 22 33 44', boite: 'D-08' }
  ];
  await agent.click('nav button[data-panel="domiciliation"]');
  await agent.waitForTimeout(500);
  for (const g of gens) {
    await agent.click('#ouvrirFormDomiBtn');
    await agent.waitForTimeout(300);
    await agent.fill('#domNom', g.nom);
    await agent.fill('#domPrenom', g.prenom);
    await agent.fill('#domNaissance', '1990-04-12');
    if (g.courriel) await agent.fill('#domCourriel', g.courriel);
    if (g.tel) await agent.fill('#domTelephone', g.tel);
    await agent.fill('#domBoite', g.boite);
    await agent.click('#enregistrerDomiBtn');
    await agent.waitForSelector('#domiMsg .msg.ok', { timeout: 8000 });
    await agent.waitForTimeout(500);
    dit(g.prenom + ' ' + g.nom + ' — ' + (g.courriel || 'sans courriel, téléphone ' + g.tel));
  }
  const inscrits = await agent.evaluate(() => BC.store.state.contacts.length);
  verifie(inscrits >= 2, 'Les deux dossiers sont ouverts, avec ou sans adresse électronique.');
  dit('Une personne sans courriel est inscrite comme les autres : c’est le cas le plus fréquent ici.');
  await capture(agent, '03-domiciliations');

  // ── 5 ──────────────────────────────────────────────────────────────────
  titre('Du courrier arrive pour chacune');
  for (const g of gens) {
    await agent.click('nav button[data-panel="guichet"]');
    await agent.waitForTimeout(400);
    await agent.fill('#nameInput', g.prenom);
    await agent.click('#validerBtn');
    await agent.waitForTimeout(800);
    await agent.click('#searchResults button[data-send]');
    await agent.waitForTimeout(1400);
    dit(g.prenom + ' : courrier enregistré.');
  }
  const etatCourriers = await agent.evaluate(() =>
    BC.store.state.history.map((h) => ({ nom: h.name, statut: h.status, tel: h.telephone || '' }))
  );
  etatCourriers.forEach((c) =>
    dit('   ' + c.nom + ' → ' + c.statut + (c.tel ? ' (' + c.tel + ')' : ''))
  );
  verifie(etatCourriers.length === 2, 'Les deux courriers sont au registre.');
  verifie(
    etatCourriers.some((c) => c.statut === 'à prévenir'),
    'Celui de la personne sans courriel est marqué « à prévenir ».'
  );

  // ── 6 ──────────────────────────────────────────────────────────────────
  titre('L’agent appelle la personne qu’il ne peut pas écrire');
  await agent.click('nav button[data-panel="remise"]');
  await agent.waitForTimeout(700);
  const listeAppels = await agent.evaluate(() => {
    const c = document.getElementById('appelsCard');
    return c && !c.hidden ? c.innerText.replace(/\s+/g, ' ').slice(0, 160) : '(carte absente)';
  });
  dit(listeAppels);
  verifie(!listeAppels.startsWith('('), 'La liste « À prévenir par téléphone » montre qui appeler, avec le numéro.');
  await capture(agent, '04-a-prevenir');

  await agent.click('#appelsCard button[data-appel-joint]');
  await agent.waitForTimeout(1200);
  const resteAAppeler = await agent.evaluate(() => {
    const c = document.getElementById('appelsCard');
    return c ? c.hidden : true;
  });
  verifie(resteAAppeler, 'Une fois l’appel noté, la personne sort de la liste.');
  dit('Sans ce geste, le guichet la rappellerait tous les matins.');

  /* Mais sortir de la liste ne doit pas vouloir dire disparaître. On demande
     directement à la règle ce qu'elle dira dans huit jours — plutôt que de
     truquer l'horloge de la page, qui ne prouverait rien de plus. */
  const dansUneSemaine = await agent.evaluate(() => {
    const h = BC.store.state.history;
    const plusTard = Date.now() + 8 * 86400000;
    return {
      demain: BC.appels.aRappeler(h, { maintenant: Date.now() + 86400000 }).length,
      huitJours: BC.appels.aRappeler(h, { maintenant: plusTard }).map((x) => x.name)
    };
  });
  verifie(dansUneSemaine.demain === 0, 'Appelée hier, on ne la rappelle pas dès demain.');
  verifie(
    dansUneSemaine.huitJours.length === 1,
    'Mais si elle n’est pas venue, elle revient au bout d’une semaine, marquée « à rappeler ».'
  );
  dit(
    'Sans ce retour, une personne sans courriel serait appelée une seule fois, ' +
      'quand une personne joignable par écrit est relancée trois fois.'
  );

  // ── 7 ──────────────────────────────────────────────────────────────────
  titre('Les personnes viennent chercher leur courrier');
  const codes = await page.evaluate(() =>
    BC.store.state.history.map((h) => ({ nom: h.name, code: h.pickupCode }))
  );
  codes.forEach((c) => dit(c.nom + ' — code ' + c.code));
  verifie(
    codes.every((c) => /^\d{4}$/.test(String(c.code))),
    'Chaque courrier a son code de retrait, même celui annoncé au téléphone.'
  );
  const masque = await agent.evaluate(() => BC.store.state.history[0].pickupCode);
  verifie(masque === '••••', 'L’agent ne voit pas les codes : il saisit celui que la personne présente.');

  await agent.click('nav button[data-panel="remise"]');
  await agent.waitForTimeout(400);
  await agent.fill('#pickupCode', String(codes[0].code));
  await agent.waitForTimeout(1300);
  const fiche = await agent.evaluate(() => {
    const d = document.getElementById('pickupDetail');
    return d ? d.innerText.replace(/\s+/g, ' ').slice(0, 200) : '';
  });
  dit(fiche);
  verifie(await agent.isVisible('#ficheConfirmer'), 'La fiche s’affiche : à vérifier avant de remettre.');
  await capture(agent, '05-fiche-remise');
  dit('La remise se termine par une signature, sur le pavé tactile ou à la souris.');

  // ── 8 ──────────────────────────────────────────────────────────────────
  titre('Quelqu’un passe sans qu’il y ait de courrier');
  await agent.click('nav button[data-panel="domiciliation"]');
  await agent.waitForTimeout(700);
  const avantPassage = await agent.evaluate(
    () => document.querySelectorAll('#activesTable button[data-passage]').length
  );
  if (avantPassage) {
    await agent.click('#activesTable button[data-passage]');
    await agent.waitForTimeout(1200);
    dit('Le passage est noté.');
  }
  verifie(avantPassage > 0, 'Une visite sans courrier s’enregistre depuis le registre des domiciliés.');
  dit('Sans cette trace, la personne paraîtrait disparue après trois mois — et risquerait la radiation.');

  /* Et quand elle ne peut pas venir mais qu'elle téléphone : c'est aussi une
     manifestation. La loi dit « présentée **ou manifestée** » ; le registre ne
     comptait que les venues, et poussait vers la radiation ceux qui appellent
     sans pouvoir se déplacer. */
  await agent.click('nav button[data-panel="remise"]');
  await agent.waitForTimeout(800);
  const carteAppel = await agent.evaluate(() => {
    const c = document.getElementById('appelEntrantCard');
    return c ? !c.hidden : false;
  });
  verifie(carteAppel, 'Et si elle téléphone au lieu de venir, l’appel se note depuis la Remise.');
  if (carteAppel) {
    const qui = await agent.evaluate(
      () => (document.querySelector('#domicilieListe option') || {}).value || ''
    );
    await agent.fill('#appelEntrantNom', qui);
    await agent.click('#appelEntrantBtn');
    await agent.waitForTimeout(1500);
    const bilan = await agent.evaluate(() =>
      document.getElementById('appelEntrantMsg').innerText.replace(/\s+/g, ' ')
    );
    dit(bilan);
    const compte = await agent.evaluate((nom) => {
      const c = BC.store.state.contacts.find((x) => x.name === nom);
      const e = BC.domiciliation.etat(c, BC.store.state.history);
      return { jours: e.joursSansPassage, moyen: e.dernierMoyen };
    }, qui);
    verifie(
      compte.jours === 0 && compte.moyen === 'telephone',
      'Son appel repart le compteur des trois mois, et le registre retient que c’était un appel.'
    );
    dit('Un appel compte autant qu’une venue : c’est la loi, et c’est souvent tout ce qui est possible.');
  }
  // On revient au registre des domiciliés : la suite s'y déroule.
  await agent.click('nav button[data-panel="domiciliation"]');
  await agent.waitForTimeout(900);

  // ── 9 ──────────────────────────────────────────────────────────────────
  titre('L’attestation d’élection de domicile s’imprime');
  await agent.click('#activesTable button[data-attestation]');
  await agent.waitForTimeout(900);
  const imprimee = await agent.evaluate(() => window.__imprime);
  verifie(imprimee > 0, 'L’attestation part à l’impression, sous l’en-tête de l’organisme.');
  dit('Elle porte l’adresse que la personne recopiera sur ses formulaires.');
  dit('Rien ne s’imprime pour une domiciliation close ou une attestation échue.');
  await agent.evaluate(() => {
    document.getElementById('feuilleCasier').hidden = false;
    document.body.classList.add('impression-casier');
  });
  await agent.waitForTimeout(300);
  await capture(agent, '06-attestation');
  await agent.evaluate(() => {
    document.getElementById('feuilleCasier').hidden = true;
    document.body.classList.remove('impression-casier');
  });

  // ── 10 ─────────────────────────────────────────────────────────────────
  titre('Le responsable regarde où en est le bureau');
  await page.reload({ waitUntil: 'load' });
  await pret(page);
  await page.waitForTimeout(800);
  await page.click('nav button[data-panel="suivi"]');
  await page.waitForTimeout(900);
  const suivi = await page.evaluate(() =>
    [...document.querySelectorAll('#suiviSections button')].map((b) => b.textContent.trim())
  );
  dit('Suivi : ' + suivi.join(' · '));
  verifie(suivi.length >= 2, 'À traiter, historique et statistiques sont réunis sous un seul onglet.');
  await page.click('nav button[data-panel="domiciliation"]');
  await page.waitForTimeout(900);
  const rapport = await page.evaluate(() => {
    const c = document.getElementById('rapportCorps');
    return c ? c.innerText.replace(/\s+/g, ' ').slice(0, 140) : '';
  });
  dit('Rapport annuel : ' + rapport);
  verifie(rapport.length > 0, 'Le rapport annuel est prêt pour la préfecture.');
  await capture(page, '07-rapport');

  // ── 11 ─────────────────────────────────────────────────────────────────
  titre('Une attestation arrive à échéance : on la renouvelle');
  /* Une attestation vaut douze mois. Périmée, elle coupe l'accès aux droits —
     souvent sans que personne ne s'en aperçoive avant le refus d'un guichet.
     On avance la date d'élection d'un an pour rejouer ce moment. */
  const echu = await page.evaluate(async () => {
    const c = BC.store.state.contacts.find((x) => x.domicilie && !x.domiciliationCloseLe);
    if (!c) return null;
    const veille = new Date();
    veille.setFullYear(veille.getFullYear() - 1);
    const jour = veille.toISOString().slice(0, 10);
    await BC.store.updateContact(c.id, {
      domicilie: true,
      domicilieDepuis: jour,
      domicilieJusqua: jour
    });
    return { id: c.id, nom: c.name, avant: jour };
  });
  await page.waitForTimeout(900);
  await page.click('nav button[data-panel="domiciliation"]');
  await page.waitForTimeout(1000);

  const signale = await page.evaluate(() => {
    const t = document.getElementById('renouvelerTable');
    return t ? t.innerText.replace(/\s+/g, ' ').slice(0, 120) : '';
  });
  dit('À renouveler : ' + signale);
  verifie(
    !!(echu && signale.includes(echu.nom.split(' ')[0])),
    'L’écran signale l’attestation qui arrive à échéance.'
  );

  const bouton = page.locator('button[data-renouveler]').first();
  verifie(await bouton.count(), 'Et propose de la renouveler sur place.');
  if (await bouton.count()) {
    await bouton.click();
    await page.waitForTimeout(1300);
    /* Le renouvellement propose l'attestation dans la foulée : la personne est
       venue pour elle. Ici on décline, la 9e étape l'a déjà imprimée. */
    if (await page.locator('#confirmDialog[open]').count()) {
      await page.locator('#confirmDialog button[value=cancel]').click();
      await page.waitForTimeout(500);
    }
  }
  const apresR = await page.evaluate(
    (id) => BC.store.state.contacts.find((x) => x.id === id) || {},
    echu && echu.id
  );
  dit('Échéance reportée au ' + (apresR.domicilieJusqua || '—'));
  verifie(
    apresR.domicilieJusqua && apresR.domicilieJusqua !== (echu && echu.avant),
    'L’échéance est reportée de douze mois.'
  );
  verifie(
    apresR.domicilieDepuis === (echu && echu.avant),
    'La date d’élection d’origine ne bouge pas : l’ancienneté compte.'
  );
  await capture(page, '08-renouvellement');
  await pause(page);

  // ── 12 ─────────────────────────────────────────────────────────────────
  titre('La personne est relogée : la domiciliation se clôt');
  const aClore = page.locator('button[data-clore]').first();
  verifie(await aClore.count(), 'Chaque dossier en cours peut être clos depuis le registre.');
  if (await aClore.count()) {
    await aClore.click();
    await page.waitForTimeout(700);
    /* Le motif est choisi, pas deviné : c'est lui que le rapport annuel
       ventile, et lui qui justifie la fin d'une adresse administrative. */
    const motifs = await page.evaluate(() =>
      [...document.querySelectorAll('#clotureMotif option')].map((o) => o.textContent.trim())
    );
    dit('Motifs proposés : ' + motifs.join(' · '));
    verifie(motifs.length >= 4, 'Le motif est choisi dans la liste que le rapport annuel attend.');
    await page.selectOption('#clotureMotif', 'relogée');
    await page.click('#clotureDialog button[value=ok]');
    await page.waitForTimeout(1500);
  }

  const close = await page.evaluate(
    (id) => BC.store.state.contacts.find((x) => x.id === id) || {},
    echu && echu.id
  );
  verifie(!!close.domiciliationCloseLe, 'Le dossier porte sa date de clôture.');
  verifie(close.domiciliationMotif === 'relogée', 'Et son motif : ' + (close.domiciliationMotif || '—'));

  await page.waitForTimeout(600);
  const rapport2 = await page.evaluate(() => {
    const c = document.getElementById('rapportCorps');
    return c ? c.innerText.replace(/\s+/g, ' ') : '';
  });
  dit('Rapport annuel après clôture : ' + rapport2.slice(0, 140));
  verifie(
    /CLOSES DANS L’ANNÉE 1/i.test(rapport2) || /CLOSES DANS L'ANNÉE 1/i.test(rapport2),
    'Le rapport annuel compte enfin la clôture — cette case affichait 0 pour toujours.'
  );
  await capture(page, '09-cloture');
  dit('Une domiciliation close sort des dossiers en cours et n’imprime plus d’attestation.');

  // ── bilan ──────────────────────────────────────────────────────────────
  console.log('\n  ' + '─'.repeat(70));
  if (erreursJs.length) {
    console.log('  [31mErreurs JavaScript :[0m');
    erreursJs.slice(0, 5).forEach((e) => console.log('    ' + e));
  } else {
    console.log('  [32mAucune erreur JavaScript.[0m');
  }
  if (soucis.length) {
    console.log('  [31m' + soucis.length + ' étape(s) en défaut :[0m');
    soucis.forEach((s) => console.log('    ' + s));
  } else {
    console.log('  [32mLes ' + etape + ' étapes du parcours sont passées.[0m');
  }
  console.log('');

  await navigateur.close();
  process.exit(soucis.length || erreursJs.length ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n  Le parcours s’est interrompu :', err.message, '\n');
  process.exit(1);
});
