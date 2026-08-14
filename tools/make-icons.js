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
  { file: 'apple-touch-icon.png', size: 180, scale: 1 },
  // Source du favicon.ico : Windows s'en sert pour le raccourci du Bureau.
  { file: 'icon-256.png', size: 256, scale: 1 }
];

/* Un fichier .ico peut contenir un PNG tel quel depuis Windows Vista : en-tête
   de six octets, une entrée de seize, puis les octets du PNG. C'est tout ce
   qu'il faut pour l'icône du raccourci, et cela évite une dépendance. */
function icoDepuisPng(png) {
  // La taille se lit dans l'en-tête IHDR du PNG : pas de valeur à tenir à jour.
  const largeur = png.readUInt32BE(16);
  const hauteur = png.readUInt32BE(20);

  const entete = Buffer.alloc(6);
  entete.writeUInt16LE(0, 0); // réservé
  entete.writeUInt16LE(1, 2); // type : icône
  entete.writeUInt16LE(1, 4); // une seule image

  const entree = Buffer.alloc(16);
  // Un octet par dimension : 256 s'y note 0, seule taille qui déborde.
  entree[0] = largeur >= 256 ? 0 : largeur;
  entree[1] = hauteur >= 256 ? 0 : hauteur;
  entree[2] = 0; // palette : aucune
  entree[3] = 0; // réservé
  entree.writeUInt16LE(1, 4); // plans
  entree.writeUInt16LE(32, 6); // bits par pixel
  entree.writeUInt32LE(png.length, 8);
  entree.writeUInt32LE(entete.length + entree.length, 12);

  return Buffer.concat([entete, entree, png]);
}

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
  const png = await fs.readFile(path.join(ICONS, 'icon-256.png'));
  await fs.writeFile(path.join(ICONS, 'favicon.ico'), icoDepuisPng(png));
  console.log('  favicon.ico  256×256 (raccourci Windows)');

  console.log('Icônes régénérées depuis ' + path.relative(ROOT, SOURCE) + '.');
}

main().catch(function (err) {
  console.error('Génération impossible :', err);
  process.exit(1);
});
