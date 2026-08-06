#!/usr/bin/env node
/* Génère les icônes PNG de l'application installable à partir de assets/icons/logo.svg.

   À relancer après avoir remplacé le logo :

       npx playwright@1 install chromium   # une seule fois
       node tools/make-icons.js

   Playwright n'est qu'un outil de développement : ni le serveur ni l'interface
   n'en dépendent, et les PNG produits sont versionnés dans le dépôt pour que
   personne n'ait à exécuter ce script pour utiliser l'application.

   Les icônes « maskable » réservent la zone de sécurité imposée par Android :
   le dessin occupe 78 % du carré, le fond couvre le reste. */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'assets', 'icons');
const SOURCE = path.join(ICONS, 'logo.svg');
const BACKGROUND = '#16233F'; // fond des icônes maskable, identique au logo par défaut

const TARGETS = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  { file: 'icon-maskable-192.png', size: 192, scale: 0.78 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.78 },
  { file: 'apple-touch-icon.png', size: 180, scale: 1 }
];

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    console.error(
      'Playwright est introuvable. Installez-le le temps de la génération :\n' +
        '  npm i --no-save playwright && npx playwright install chromium\n' +
        'puis relancez « node tools/make-icons.js ».'
    );
    process.exit(1);
  }
}

async function main() {
  const { chromium } = loadPlaywright();
  const svg = await fs.readFile(SOURCE, 'utf8');
  const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

  // CHROMIUM_PATH permet de désigner un Chromium déjà présent sur la machine,
  // quand celui de Playwright n'est pas installé.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  try {
    for (const target of TARGETS) {
      const page = await browser.newPage({
        viewport: { width: target.size, height: target.size },
        deviceScaleFactor: 1
      });
      const inset = Math.round((target.size * (1 - target.scale)) / 2);
      await page.setContent(
        '<style>html,body{margin:0;padding:0;width:100%;height:100%;}' +
          'body{background:' +
          (target.scale < 1 ? BACKGROUND : 'transparent') +
          ';}' +
          'img{position:absolute;inset:' +
          inset +
          'px;width:' +
          (target.size - inset * 2) +
          'px;height:' +
          (target.size - inset * 2) +
          'px;}</style>' +
          '<img src="' +
          dataUri +
          '">',
        { waitUntil: 'load' }
      );
      await page.waitForFunction(function () {
        const img = document.querySelector('img');
        return img && img.complete && img.naturalWidth > 0;
      });
      await page.screenshot({
        path: path.join(ICONS, target.file),
        omitBackground: target.scale === 1
      });
      await page.close();
      console.log('  ' + target.file + '  ' + target.size + '×' + target.size);
    }
  } finally {
    await browser.close();
  }
  console.log('Icônes régénérées depuis ' + path.relative(ROOT, SOURCE) + '.');
}

main().catch(function (err) {
  console.error('Génération impossible :', err);
  process.exit(1);
});
