/* Les scripts PowerShell doivent pouvoir être *lus* par Windows.

   Deux pièges nous ont coûté une installation entièrement rouge sur le poste
   de l'utilisateur, sans qu'une seule ligne du script n'ait tourné. Ils sont
   invisibles à la relecture : le fichier paraît parfait dans un éditeur.

   1. **L'encodage.** Un .ps1 en UTF-8 sans BOM est lu par Windows PowerShell
      5.1 — celui livré avec Windows — comme du Windows-1252. Le tiret cadratin
      « — » (E2 80 94) s'y termine par l'octet 0x94, qui vaut « ” » : un
      guillemet. Dans une chaîne à guillemets doubles, il la ferme treize
      caractères trop tôt, le reste de la ligne redevient du code, et l'analyse
      déraille pour tout le fichier.

   2. **Les apostrophes typographiques.** PowerShell traite « ’ » (U+2019) comme
      un délimiteur de chaîne à part entière, quel que soit l'encodage. Un
      « s’ouvrir » dans une chaîne à guillemets simples la termine sur place.
      Le BOM ne protège pas de celui-là.

   Ces deux contrôles se font sur les octets, sans PowerShell : ils tournent
   partout, y compris sur la machine d'intégration continue. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function scriptsPowerShell() {
  const dossiers = [RACINE, path.join(RACINE, 'tools')];
  const out = [];
  dossiers.forEach(function (d) {
    fs.readdirSync(d).forEach(function (f) {
      if (f.toLowerCase().endsWith('.ps1')) out.push(path.join(d, f));
    });
  });
  return out;
}

test('il y a bien des scripts PowerShell à vérifier', function () {
  /* Sans cette garde, tous les contrôles ci-dessous passeraient sur une liste
     vide le jour où les fichiers seraient déplacés. */
  assert.ok(scriptsPowerShell().length >= 3, 'au moins installer, certificat et confiance');
});

test('chaque script PowerShell commence par un BOM UTF-8', function () {
  scriptsPowerShell().forEach(function (p) {
    const debut = fs.readFileSync(p).subarray(0, 3);
    assert.ok(
      debut.equals(BOM),
      path.relative(RACINE, p) +
        ' n’a pas de BOM UTF-8 : Windows PowerShell 5.1 le lira en Windows-1252 ' +
        'et ses accents casseront l’analyse du fichier.'
    );
  });
});

test('aucune apostrophe ni guillemet typographique dans le code PowerShell', function () {
  /* Dans un commentaire, ces caractères sont sans danger — PowerShell les
     ignore. On ne signale donc que le code, pour ne pas interdire une
     ponctuation correcte là où elle ne nuit pas. */
  const INTERDITS = { '’': '’', '‘': '‘', '“': '“', '”': '”' };
  scriptsPowerShell().forEach(function (p) {
    const texte = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    let dansBloc = false;
    texte.split('\n').forEach(function (ligne, i) {
      if (ligne.includes('<#')) dansBloc = true;
      if (dansBloc) {
        if (ligne.includes('#>')) dansBloc = false;
        return;
      }
      const code = ligne.split('#')[0];
      Object.keys(INTERDITS).forEach(function (ch) {
        assert.ok(
          !code.includes(ch),
          path.relative(RACINE, p) + ':' + (i + 1) + ' contient « ' + INTERDITS[ch] +
            ' » dans du code. PowerShell le prend pour un délimiteur de chaîne. ' +
            'Écrivez une apostrophe droite, doublée dans une chaîne simple : ' +
            "'s''ouvrir'."
        );
      });
    });
  });
});

test('relu en Windows-1252, aucun script ne gagne de guillemet', function () {
  /* Le contrôle de fond, qui ne dépend pas du BOM : on redécode les octets
     comme le ferait un PowerShell 5.1 mal encodé, et on vérifie qu'aucun
     caractère de la classe « guillemet » n'apparaît là où il n'y en avait pas.
     Un fichier qui perdrait son BOM échouerait ici même si le premier test
     était modifié. */
  scriptsPowerShell().forEach(function (p) {
    const octets = fs.readFileSync(p);
    const corps = octets.subarray(octets.subarray(0, 3).equals(BOM) ? 3 : 0);
    const enUtf8 = corps.toString('utf8');
    const en1252 = corps.toString('latin1');

    const compter = function (s) {
      return (s.match(/["'‘’“”]/g) || []).length;
    };
    assert.equal(
      compter(en1252),
      compter(enUtf8),
      path.relative(RACINE, p) +
        ' : relu en Windows-1252, ce fichier gagne des caractères de guillemet. ' +
        'Sans BOM, Windows PowerShell 5.1 y verrait des chaînes non terminées.'
    );
  });
});

test('les fichiers .cmd n’ont pas de BOM', function () {
  /* L'inverse du précédent : cmd.exe imprimerait le BOM tel quel en tête de
     sortie. Ils déclarent déjà « chcp 65001 », qui suffit. */
  fs.readdirSync(RACINE)
    .filter(function (f) {
      return f.toLowerCase().endsWith('.cmd');
    })
    .forEach(function (f) {
      const debut = fs.readFileSync(path.join(RACINE, f)).subarray(0, 3);
      assert.ok(!debut.equals(BOM), f + ' porte un BOM : cmd.exe l’afficherait à l’écran.');
    });
});
