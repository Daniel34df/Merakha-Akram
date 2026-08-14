'use strict';

/* Écrire un PDF sans dépendance.

   Ce que ces tests gardent fermé : un fichier qu'aucun lecteur n'ouvre. Une
   attestation de domiciliation part à la CAF ou à l'assurance maladie ; si le
   fichier est refusé, la personne repart sans son adresse — et elle ne
   comprendra pas pourquoi, parce que chez nous il s'affichait.

   Deux pièges précis, et tous deux se déclenchent sur des noms ordinaires :

     · les accents. Sortis en UTF-8, ils deviennent « Ã© » à l'écran ; sur un
       document destiné à une administration, c'est disqualifiant ;
     · les parenthèses et la barre oblique inverse. Elles délimitent les
       chaînes dans le format PDF — « O'Brien (dit Paul) » suffit à produire un
       fichier illisible.

   Un PDF est un tableau d'octets, et un tableau d'octets se relit ici, sans
   navigateur. */

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../assets/js/pdf.js');

function texte(octets) {
  return Buffer.from(octets).toString('latin1');
}

/* ── la structure minimale qu'un lecteur exige ── */

test('le fichier commence par l’en-tête PDF et finit par sa marque de fin', function () {
  const s = texte(P.document([{ type: 'titre', texte: 'Attestation' }]));
  assert.ok(s.startsWith('%PDF-1.4'), 'l’en-tête : ' + JSON.stringify(s.slice(0, 12)));
  assert.ok(s.trimEnd().endsWith('%%EOF'), 'la marque de fin');
});

test('la deuxième ligne marque le fichier comme binaire', function () {
  /* Ce défaut-ci n'a été trouvé qu'en ouvrant le fichier dans un vrai lecteur.
     Sans cette ligne, tout le reste était juste — `file` reconnaissait le PDF,
     la table des positions tombait au bon octet, les longueurs de flux étaient
     exactes — et le lecteur de Chromium affichait une page blanche, sans le
     moindre message. Aucune vérification de structure ne peut le voir.

     La norme demande un commentaire d'au moins quatre octets au-dessus de 127
     dès que le fichier contient du binaire, et le nôtre en contient au premier
     accent. */
  const octets = P.document([{ type: 'texte', texte: 'a' }]);
  assert.equal(octets[8], 10, 'l’en-tête tient sur la première ligne');
  assert.equal(octets[9], 37, 'la deuxième ligne est un commentaire (%)');
  const marque = Array.from(octets.slice(10, 14));
  assert.ok(marque.every(function (o) { return o > 127; }),
    'quatre octets binaires, pas moins : ' + marque.join(' '));
});

test('la table des positions est présente, complète et cohérente', function () {
  /* C'est elle qu'un lecteur consulte en premier. Un décalage d'un octet, et
     le fichier est refusé sans autre explication. */
  const octets = P.document([{ type: 'texte', texte: 'Bonjour' }]);
  const s = texte(octets);

  const startxref = s.lastIndexOf('startxref');
  assert.ok(startxref > 0, 'startxref est là');
  const debutXref = Number(s.slice(startxref + 9).trim().split('\n')[0]);
  assert.equal(s.slice(debutXref, debutXref + 4), 'xref',
    'la position annoncée tombe bien sur la table');

  const entete = /xref\n0 (\d+)\n/.exec(s.slice(debutXref));
  const total = Number(entete[1]);
  const objets = s.match(/^\d+ 0 obj$/gm) || [];
  assert.equal(objets.length, total - 1, 'autant d’objets que la table en annonce');

  /* Chaque position doit tomber sur le début d'un objet — c'est la seule
     vérification qui prouve que la table n'a pas glissé.

     La table s'ouvre sur « xref », puis « 0 N », puis l'entrée de l'objet 0
     qui est toujours libre. Les objets réels commencent donc à la quatrième
     ligne : compter à partir de la troisième décalerait tout d'un cran et
     ferait échouer un fichier parfaitement valable. */
  const lignes = s.slice(debutXref).split('\n').slice(3, 2 + total);
  assert.equal(lignes.length, total - 1, 'une entrée par objet');
  lignes.forEach(function (l, i) {
    const pos = Number(l.slice(0, 10));
    assert.match(s.slice(pos, pos + 12), new RegExp('^' + (i + 1) + ' 0 obj'),
      'l’objet ' + (i + 1) + ' commence bien à ' + pos);
  });
});

test('les renvois entre objets pointent sur des objets qui existent', function () {
  const s = texte(P.document([{ type: 'texte', texte: 'Bonjour' }]));
  const total = Number(/xref\n0 (\d+)\n/.exec(s)[1]) - 1;
  const renvois = s.match(/(\d+) 0 R/g) || [];
  renvois.forEach(function (r) {
    const n = Number(r.split(' ')[0]);
    assert.ok(n >= 1 && n <= total, 'renvoi ' + r + ' hors des ' + total + ' objets');
  });
});

/* ── les deux pièges qui cassent tout ── */

test('les accents sortent en WinAnsi, pas en UTF-8', function () {
  /* En UTF-8, « é » devient deux octets et le lecteur affiche « Ã© ». */
  const octets = P.encoder('éàçùôÉÈ');
  assert.deepEqual(Array.from(octets), [233, 224, 231, 249, 244, 201, 200]);
  const s = texte(P.document([{ type: 'texte', texte: 'Élodie Trémblay' }]));
  assert.ok(s.indexOf('Élodie') > 0, 'le É est un seul octet');
  assert.equal(s.indexOf('Ã'), -1, 'aucune trace d’UTF-8 mal encodé');
});

test('parenthèses et barre oblique sont échappées', function () {
  /* « O'Brien (dit Paul) » suffit à produire un fichier illisible. */
  assert.deepEqual(Array.from(P.encoder('(a)')), [92, 40, 97, 92, 41]);
  assert.deepEqual(Array.from(P.encoder('a\\b')), [97, 92, 92, 98]);
  assert.equal(P.chaine('O(Brien)'), '(O\\(Brien\\))');

  const s = texte(P.document([{ type: 'texte', texte: 'Jean O(Brien) \\ Dupont' }]));
  /* Le compte de parenthèses non échappées doit rester équilibré : c'est ce
     qui casse quand l'échappement manque. */
  const ouvertes = (s.match(/(^|[^\\])\(/g) || []).length;
  const fermees = (s.match(/(^|[^\\])\)/g) || []).length;
  assert.equal(ouvertes, fermees, 'les délimiteurs restent équilibrés');
});

test('un caractère hors table devient « ? » plutôt que de corrompre le fichier', function () {
  /* Un idéogramme collé depuis un formulaire ne doit pas rendre l'attestation
     inouvrable — mieux vaut un point d'interrogation visible. */
  assert.deepEqual(Array.from(P.encoder('a漢b')), [97, 63, 98]);
  assert.doesNotThrow(function () { P.document([{ type: 'texte', texte: '漢字 test' }]); });
});

test('l’euro et les apostrophes typographiques passent', function () {
  /* « L'élection de domicile » avec une apostrophe courbe est ce que produit
     un traitement de texte, et c'est ce que l'agent colle. */
  assert.deepEqual(Array.from(P.encoder('€’–')), [128, 146, 150]);
});

/* ── la mise en page ── */

test('un long paragraphe est coupé en lignes qui tiennent dans la page', function () {
  const long = 'mot '.repeat(300);
  const lignes = P.couper(long, 480, 10.5);
  assert.ok(lignes.length > 10, 'il est bien coupé (' + lignes.length + ' lignes)');
  lignes.forEach(function (l) {
    assert.ok(l.length <= 92, 'ligne trop longue (' + l.length + ') : ' + l.slice(0, 40));
  });
});

test('un mot plus long que la ligne est coupé net plutôt que de déborder', function () {
  /* Une adresse électronique ou un numéro de suivi. Mieux vaut une coupure
     laide qu’un texte qui sort de la feuille. */
  const lignes = P.couper('x'.repeat(400), 200, 10);
  assert.ok(lignes.length > 1);
  lignes.forEach(function (l) { assert.ok(l.length <= 40, l.length); });
});

test('les retours à la ligne du texte sont respectés', function () {
  assert.deepEqual(P.couper('un\ndeux', 480, 10.5), ['un', 'deux']);
});

test('un texte long produit plusieurs pages', function () {
  /* Un rapport annuel ou une liste de casiers dépasse une page. Tout écrire
     sur la première reviendrait à perdre la suite en silence. */
  const blocs = [];
  for (let i = 0; i < 200; i++) blocs.push({ type: 'texte', texte: 'Ligne numéro ' + i });
  const s = texte(P.document(blocs));
  const pages = (s.match(/\/Type \/Page[^s]/g) || []).length;
  assert.ok(pages >= 3, pages + ' pages');
  const kids = /\/Kids \[([^\]]+)\]/.exec(s)[1].trim().split(/\s+\d+ 0 R|\s*0 R/).filter(Boolean);
  assert.equal(/\/Count (\d+)/.exec(s)[1], String(pages), 'le compte annoncé correspond');
});

test('un tableau écrit ses en-têtes et ses lignes', function () {
  const s = texte(P.document([{
    type: 'tableau',
    entetes: ['Nom', 'Boîte', 'Échéance'],
    lignes: [['Amina Diallo', 'B-012', '20/08/2026']]
  }]));
  assert.ok(s.indexOf('(Nom)') > 0);
  assert.ok(s.indexOf('(Amina Diallo)') > 0);
  assert.ok(s.indexOf('(B-012)') > 0);
});

test('une cellule trop longue est tronquée, pas repliée', function () {
  /* Un tableau dont les lignes n'ont pas la même hauteur devient illisible, et
     c'est un tableau qu'on lit en diagonale. */
  const s = texte(P.document([{
    type: 'tableau',
    entetes: ['A', 'B', 'C', 'D'],
    lignes: [['x'.repeat(200), 'b', 'c', 'd']]
  }]));
  /* Les points de suspension sortent en WinAnsi — un seul octet, 133 — et pas
     en UTF-8 : c'est tout l'intérêt de la table d'encodage. On les cherche donc
     comme un octet, pas comme un caractère. */
  const cellule = /\(x+([^)]*)\)/.exec(s);
  assert.ok(cellule, 'la cellule est écrite');
  assert.equal(cellule[1].charCodeAt(0), 133, 'les points de suspension, en WinAnsi');
  assert.ok(cellule[0].length < 60, 'et la cellule est bien plus courte que ses 200 signes');
});

/* ── les cas limites ── */

test('un document vide reste un PDF valide', function () {
  /* Un rapport sans données ne doit pas produire un fichier cassé : l'agent
     l'ouvrirait et croirait à une panne plutôt qu'à un mois sans activité. */
  const s = texte(P.document([]));
  assert.ok(s.startsWith('%PDF'));
  assert.ok(s.indexOf('/Type /Page') > 0, 'une page, même vide');
  assert.ok(s.trimEnd().endsWith('%%EOF'));
});

test('des blocs abîmés ne font pas tomber la génération', function () {
  assert.doesNotThrow(function () { P.document(null); });
  assert.doesNotThrow(function () { P.document([null, undefined, {}]); });
  assert.doesNotThrow(function () { P.document([{ type: 'tableau' }]); });
  assert.doesNotThrow(function () { P.document([{ type: 'texte', texte: null }]); });
});

test('le format est A4, en points', function () {
  const s = texte(P.document([{ type: 'texte', texte: 'a' }]));
  assert.match(s, /\/MediaBox \[0 0 595\.28 841\.89\]/);
});

test('le résultat est un tableau d’octets, prêt à écrire tel quel', function () {
  const octets = P.document([{ type: 'texte', texte: 'é' }]);
  assert.ok(octets instanceof Uint8Array);
  assert.ok(Array.from(octets).every(function (o) { return o >= 0 && o <= 255; }),
    'chaque valeur tient dans un octet');
});
