'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const xlsx = require('../assets/js/xlsx.js');

test('crc32 correspond aux valeurs de référence', function () {
  const enc = new TextEncoder();
  assert.equal(xlsx.crc32(enc.encode('')), 0);
  assert.equal(xlsx.crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(xlsx.crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('colName numérote les colonnes comme un tableur', function () {
  assert.equal(xlsx.colName(1), 'A');
  assert.equal(xlsx.colName(26), 'Z');
  assert.equal(xlsx.colName(27), 'AA');
  assert.equal(xlsx.colName(52), 'AZ');
  assert.equal(xlsx.colName(53), 'BA');
});

test('le classeur produit est une archive ZIP valide et complète', function () {
  const bytes = xlsx.build({
    sheetName: 'Destinataires',
    columns: [
      { key: 'boite', label: 'N° de boîte', width: 12 },
      { key: 'nom', label: 'Nom', width: 30 }
    ],
    rows: [{ boite: 'B-12', nom: 'Élodie Tremblay' }]
  });

  // Signature d'un fichier ZIP, puis fin d'archive.
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  const texte = Buffer.from(bytes).toString('latin1');
  ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'].forEach(function (partie) {
    assert.ok(texte.includes(partie), 'contient ' + partie);
  });

  const utf8 = Buffer.from(bytes).toString('utf8');
  assert.ok(utf8.includes('Élodie Tremblay'), 'les accents sont conservés');
  assert.ok(utf8.includes('state="frozen"'), 'en-tête figé');
  assert.ok(utf8.includes('autoFilter'), 'filtres actifs');
});

test('les caractères réservés du XML sont échappés', function () {
  const utf8 = Buffer.from(
    xlsx.build({ columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'Dupont & <Fils> "Cie"' }] })
  ).toString('utf8');
  assert.ok(utf8.includes('Dupont &amp; &lt;Fils&gt;'), 'aucun XML brisé par les données');
  assert.ok(!utf8.includes('<Fils>'));
});

test('un classeur vide reste ouvrable', function () {
  const bytes = xlsx.build({ columns: [{ key: 'a', label: 'Vide' }], rows: [] });
  assert.ok(bytes.length > 0);
  assert.ok(Buffer.from(bytes).toString('utf8').includes('A1:A1'), 'la plage reste cohérente');
});

test('les dates sont écrites au format des tableurs', function () {
  // 1900-01-01 est le jour 1 dans la numérotation d'Excel.
  const jour = xlsx.toExcelDate(new Date(2026, 0, 1, 12, 0));
  assert.ok(Math.abs(jour - 46023.5) < 0.01, 'valeur attendue pour le 1er janvier 2026 à midi, obtenu ' + jour);
});

test('le fichier produit se relit avec un outil tiers', function (t) {
  let python;
  try {
    execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'ignore' });
    python = 'python3';
  } catch (e) {
    t.skip('openpyxl absent : relecture non vérifiée ici');
    return;
  }

  const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-xlsx-')), 'test.xlsx');
  fs.writeFileSync(
    fichier,
    Buffer.from(
      xlsx.build({
        sheetName: 'Destinataires',
        columns: [
          { key: 'boite', label: 'N° de boîte', width: 12 },
          { key: 'nom', label: 'Nom', width: 30 },
          { key: 'date', label: 'Date', width: 20, type: 'date' }
        ],
        rows: [{ boite: 'B-12', nom: 'Élodie Tremblay', date: new Date(2026, 4, 3, 14, 30) }]
      })
    )
  );

  const sortie = execFileSync(python, [
    '-c',
    'import openpyxl,sys;w=openpyxl.load_workbook(sys.argv[1]);s=w.active;' +
      'print(s.title, s.max_row, s.max_column, s.freeze_panes, s.auto_filter.ref, ' +
      'list(s.iter_rows(min_row=2,max_row=2,values_only=True))[0], sep="|")',
    fichier
  ]).toString();

  const champs = sortie.trim().split('|');
  assert.equal(champs[0], 'Destinataires');
  assert.equal(champs[1], '2', 'en-tête + une ligne');
  assert.equal(champs[2], '3');
  assert.equal(champs[3], 'A2', 'volet figé sous l’en-tête');
  assert.equal(champs[4], 'A1:C2');
  assert.match(champs[5], /Élodie Tremblay/);
  assert.match(champs[5], /datetime\.datetime\(2026, 5, 3, 14, 30\)/, 'la date est bien une date');
});
