#!/usr/bin/env node
/* Enregistre tools/guide-nodejs.html en vidéo.

       npm i --no-save playwright && npx playwright install chromium
       node tools/enregistrer-guide.js [dossier-de-sortie]

   Playwright filme la page pendant qu'elle se joue et produit un .webm. Si un
   ffmpeg est disponible (CHROMIUM_FFMPEG ou celui du système), un .mp4 est
   également produit — plus commode à ouvrir sous Windows.

   Outil de développement : ni le serveur ni l'application n'en dépendent. */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PAGE = 'file://' + path.join(__dirname, 'guide-nodejs.html');
const DUREE_MAX = 120000;

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    console.error(
      'Playwright est introuvable. Installez-le le temps de l’enregistrement :\n' +
        '  npm i --no-save playwright && npx playwright install chromium'
    );
    process.exit(1);
  }
}

function trouverFfmpeg() {
  const candidats = [process.env.CHROMIUM_FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const bin of candidats) {
    const essai = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    if (!essai.error && essai.status === 0) return bin;
  }
  return null;
}

async function main() {
  const sortie = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'video'));
  await fs.mkdir(sortie, { recursive: true });

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sortie, size: { width: 1280, height: 720 } }
  });

  const page = await context.newPage();
  await page.goto(PAGE, { waitUntil: 'load' });
  // La page signale sa fin elle-même : inutile de deviner une durée.
  // Le deuxième paramètre est l'argument passé à la fonction, pas les options :
  // l'omettre ramènerait le délai d'attente à sa valeur par défaut.
  await page.waitForFunction(
    function () {
      return document.body.dataset.fini === '1';
    },
    null,
    { timeout: DUREE_MAX }
  );
  await page.waitForTimeout(700);

  const video = page.video();
  // L'ordre compte : la vidéo n'est finalisée qu'à la fermeture du contexte, et
  // saveAs a encore besoin du navigateur ouvert pour la récupérer.
  await context.close();
  const webm = path.join(sortie, 'installer-nodejs.webm');
  await video.saveAs(webm);
  await video.delete().catch(function () {});
  await browser.close();
  console.log('  ' + path.relative(ROOT, webm));

  const ffmpeg = trouverFfmpeg();
  if (!ffmpeg) {
    console.log('  (ffmpeg absent : pas de conversion en mp4)');
    return;
  }
  const mp4 = path.join(sortie, 'installer-nodejs.mp4');
  const conv = spawnSync(
    ffmpeg,
    ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4],
    { stdio: 'ignore' }
  );
  if (conv.status === 0) {
    console.log('  ' + path.relative(ROOT, mp4));
  } else {
    console.log('  (conversion mp4 échouée — le .webm reste utilisable)');
  }
}

main().catch(function (err) {
  console.error('Enregistrement impossible :', err);
  process.exit(1);
});
