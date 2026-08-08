/* Bureau du Courrier — ce que partagent les vérifications de navigateur.
 *
 * Ces scripts existent parce que `node --test` ne peut pas ouvrir `app.js` :
 * il lui faut un DOM. Tout ce qui est **pur** est sorti dans des modules
 * chargeables sous Node et vérifié par la suite ordinaire ; ce qui reste ici
 * est ce qui ne peut pas s'en passer — un écran, des clics, un rendu.
 *
 * Chaque script énonce ce qu'il garde fermé. Ce ne sont pas des démonstrations :
 * chacun correspond à un défaut réel qui a été corrigé, et qui reviendrait sans
 * eux.
 */
'use strict';

const { chromium } = require('playwright');

/* Chromium : celui que Playwright a installé, sauf indication contraire.
   Ne jamais coder en dur le chemin d'une machine — ces scripts doivent tourner
   ailleurs que là où ils ont été écrits. */
const CHROME = process.env.CHROME || '';

function lancerNavigateur() {
  return chromium.launch(CHROME ? { executablePath: CHROME } : {});
}

/** L'adresse du serveur d'essai, donnée par le lanceur. */
function base() {
  return process.env.BASE || 'http://127.0.0.1:3000';
}

/* Un compteur de constats, et la façon de les dire. Un script rend un code de
   sortie non nul dès qu'un constat est faux : c'est ce qui permet de tout
   enchaîner sans lire. */
function verificateur() {
  const etat = { echecs: 0 };
  return {
    ok: function (condition, quoi) {
      console.log((condition ? '  ok   ' : '  RATÉ ') + quoi);
      if (!condition) etat.echecs++;
      return !!condition;
    },
    titre: function (texte) {
      console.log('\n' + texte);
    },
    echecs: function () {
      return etat.echecs;
    },
    ajouterEchec: function () {
      etat.echecs++;
    }
  };
}

/** Ouvre une page en collectant les erreurs JavaScript : elles comptent. */
async function nouvellePage(navigateur, options) {
  const page = await navigateur.newPage();
  const erreurs = [];
  page.on('pageerror', function (e) {
    erreurs.push('pageerror: ' + e);
  });
  page.on('console', function (m) {
    if (m.type() === 'error') erreurs.push('console: ' + m.text());
  });
  if (options && options.avantChargement) await page.addInitScript(options.avantChargement);
  page.erreursJs = erreurs;
  return page;
}

/** Premier démarrage : créer le compte responsable et entrer. */
async function ouvrirLeBureau(page) {
  await page.goto(base(), { waitUntil: 'load' });
  await page.waitForSelector('#authGate', { state: 'visible', timeout: 20000 });
  if (await page.isVisible('#signupForm')) {
    await page.fill('#signupName', 'Akram');
    await page.fill('#signupEmail', 'responsable@bureau.org');
    await page.fill('#signupPassword', 'mot-de-passe-du-bureau');
    await page.click('#signupForm button[type=submit]');
  } else {
    await page.fill('#loginEmail', 'responsable@bureau.org');
    await page.fill('#loginPassword', 'mot-de-passe-du-bureau');
    await page.click('#loginForm button[type=submit]');
  }
  await page.waitForTimeout(1500);
  if (await page.isVisible('#skipAssociateBtn')) await page.click('#skipAssociateBtn');
  await page.waitForSelector('#authGate', { state: 'hidden', timeout: 20000 });
  await page.waitForFunction(
    function () {
      return window.BC && window.BC.store && window.BC.store.state.mode === 'serveur';
    },
    null,
    { timeout: 20000 }
  );
  await page.waitForTimeout(900);
  return page;
}

/** Inscrit un destinataire depuis l'écran du registre. */
async function inscrire(page, fiche) {
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(700);
  await page.fill('#newName', fiche.nom);
  if (fiche.telephone) await page.fill('#newTelephone', fiche.telephone);
  if (fiche.courriel) await page.fill('#newEmail', fiche.courriel);
  if (fiche.boite) await page.fill('#newBox', fiche.boite);
  if (fiche.domicilieDepuis) {
    await page.check('#newDomicilie');
    await page.waitForTimeout(300);
    await page.fill('#newDomicilieDepuis', fiche.domicilieDepuis);
  }
  await page.click('#addContactBtn');
  await page.waitForTimeout(1400);
}

/** Un courrier arrive pour cette personne. */
async function courrierPour(page, nom) {
  await page.evaluate(async function (n) {
    const c = window.BC.store.state.contacts.find(function (x) {
      return x.name === n;
    });
    await window.BC.store.sendViaServer(c, { subject: 'Un courrier vous attend', body: '.' });
  }, nom);
  await page.waitForTimeout(1300);
}

/* Une capture n'est utile qu'à qui regarde. Par défaut elle va dans le dossier
   temporaire du système : un script de vérification ne doit pas laisser de
   fichiers dans le dépôt. CAPTURES=./quelque-part pour les garder. */
async function capture(page, nom) {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dossier = process.env.CAPTURES || path.join(os.tmpdir(), 'bdc-captures');
  fs.mkdirSync(dossier, { recursive: true });
  const chemin = path.join(dossier, nom + '.png');
  await page.screenshot({ path: chemin });
  if (process.env.CAPTURES) console.log('       capture : ' + chemin);
}

/** Bilan et code de sortie — la seule chose que le lanceur regarde. */
async function conclure(navigateur, page, v) {
  const erreurs = (page && page.erreursJs) || [];
  console.log('\nerreurs JS : ' + (erreurs.length ? '\n  ' + erreurs.join('\n  ') : 'aucune'));
  if (erreurs.length) v.ajouterEchec();
  await navigateur.close();
  const n = v.echecs();
  console.log(n === 0 ? '\nTOUT PASSE' : '\n' + n + ' PROBLÈME(S)');
  process.exit(n === 0 ? 0 : 1);
}

module.exports = {
  lancerNavigateur: lancerNavigateur,
  base: base,
  verificateur: verificateur,
  nouvellePage: nouvellePage,
  ouvrirLeBureau: ouvrirLeBureau,
  inscrire: inscrire,
  courrierPour: courrierPour,
  capture: capture,
  conclure: conclure
};
