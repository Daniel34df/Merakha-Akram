'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('../assets/js/util.js');

test('normalize retire accents, casse et espaces superflus', function () {
  assert.equal(util.normalize('  Élodie   TREMBLAY '), 'elodie tremblay');
  assert.equal(util.normalize('Jean-François'), 'jean-francois');
  assert.equal(util.normalize(null), '');
});

test('escapeHtml neutralise les caractères actifs', function () {
  assert.equal(util.escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(util.escapeHtml("l'ami & co"), 'l&#39;ami &amp; co');
  assert.equal(util.escapeHtml(undefined), '');
});

test('isValidEmail accepte les adresses plausibles et refuse le reste', function () {
  assert.ok(util.isValidEmail('marie.tremblay@exemple.com'));
  assert.ok(util.isValidEmail('m+courrier@sous.domaine.qc.ca'));
  assert.ok(!util.isValidEmail('marie@exemple'));
  assert.ok(!util.isValidEmail('marie exemple.com'));
  assert.ok(!util.isValidEmail('a@b.c'));
  assert.ok(!util.isValidEmail(''));
});

test('extractEmail lit la forme « Nom <adresse> » comme l’adresse seule', function () {
  assert.equal(util.extractEmail('Bureau du Courrier <courrier@exemple.com>'), 'courrier@exemple.com');
  assert.equal(util.extractEmail('  courrier@exemple.com  '), 'courrier@exemple.com');
  assert.ok(util.isValidAddress('Bureau du Courrier <courrier@exemple.com>'));
  assert.ok(!util.isValidAddress('Bureau du Courrier <pas-une-adresse>'));
});

test('parseAddressList sépare, valide et dédoublonne les adresses', function () {
  const res = util.parseAddressList('a@ex.com, b@ex.com; A@EX.COM\nc@ex.com');
  assert.deepEqual(res.entries, ['a@ex.com', 'b@ex.com', 'c@ex.com'], 'doublon insensible à la casse retiré');
  assert.equal(res.errors.length, 0);
  assert.equal(util.formatAddressList(res.entries), 'a@ex.com, b@ex.com, c@ex.com');
});

test('parseAddressList signale les adresses fautives sans perdre les bonnes', function () {
  const res = util.parseAddressList('bon@ex.com, mauvais, autre@ex.com');
  assert.deepEqual(res.entries, ['bon@ex.com', 'autre@ex.com']);
  assert.deepEqual(res.errors, ['mauvais']);
});

test('parseAddressList accepte une liste vide', function () {
  assert.deepEqual(util.parseAddressList('').entries, []);
  assert.deepEqual(util.parseAddressList(null).errors, []);
});

test('suggestSmtpHost devine le serveur d’envoi des messageries courantes', function () {
  assert.equal(util.suggestSmtpHost('marie@gmail.com'), 'smtp.gmail.com');
  assert.equal(util.suggestSmtpHost('Marie <MARIE@Hotmail.FR>'), 'smtp-mail.outlook.com');
  assert.equal(util.suggestSmtpHost('accueil@orange.fr'), 'smtp.orange.fr');
  assert.equal(util.suggestSmtpHost('accueil@mon-organisation.org'), '', 'domaine inconnu : à saisir à la main');
  assert.equal(util.suggestSmtpHost('pas-une-adresse'), '');
});

test('isGoogleAddress ne reconnaît que les adresses Google', function () {
  assert.ok(util.isGoogleAddress('marie@gmail.com'));
  assert.ok(util.isGoogleAddress('Marie <marie@googlemail.com>'));
  assert.ok(!util.isGoogleAddress('marie@outlook.com'));
  assert.ok(!util.isGoogleAddress('marie@mon-organisation.org'));
});

test('matchesQuery cherche sur le nom et le courriel, accents ignorés', function () {
  const c = { name: 'Élodie Tremblay', email: 'elo@exemple.com' };
  assert.ok(util.matchesQuery(c, 'elodie'));
  assert.ok(util.matchesQuery(c, 'ELODIE tremblay'));
  assert.ok(util.matchesQuery(c, 'tremblay elodie'), 'ordre des mots indifférent');
  assert.ok(util.matchesQuery(c, 'exemple.com'));
  assert.ok(!util.matchesQuery(c, 'tremblay martin'));
  assert.ok(!util.matchesQuery(c, '   '));
});

test('un courrier se retrouve par sa référence, collée telle quelle dans le filtre', function () {
  /* C'est le geste au téléphone : la personne lit le numéro qu'elle a noté,
     l'agent le colle dans le filtre du Suivi. Sans ça, la référence s'affiche
     partout et ne sert à rien — elle ne ramène pas son propre courrier. */
  const h = { name: 'Jean Dupont', email: 'jean@exemple.org', reference: 'COUR-2026-000042' };
  assert.ok(util.matchesQuery(h, 'COUR-2026-000042'));
  assert.ok(util.matchesQuery(h, 'cour-2026-000042'), 'la casse ne compte pas quand on la dicte');
  assert.ok(!util.matchesQuery(h, 'COUR-2026-000043'));
  /* En recherche par nom, la référence ne compte pas : ce mode-là sert à
     trouver une personne, et un numéro qui répondrait sur un nom brouillerait
     la liste des suggestions proches. */
  assert.ok(!util.matchesQuery(h, 'COUR-2026-000042', 'nom'));
  // Une fiche de destinataire n'a pas de référence, et rien ne change pour elle.
  assert.ok(util.matchesQuery({ name: 'Jean Dupont', email: '' }, 'dupont'));
});

test('renderTemplate remplace les variables connues et laisse les autres', function () {
  const out = util.renderTemplate('Bonjour {nom}, le {date}. {inconnu}', { nom: 'Marie', date: '3 mai' });
  assert.equal(out, 'Bonjour Marie, le 3 mai. {inconnu}');
});

test('toCsv échappe guillemets, virgules et sauts de ligne', function () {
  const csv = util.toCsv([{ nom: 'Dupont, Jean', note: 'dit "Jeannot"' }], ['nom', 'note']);
  assert.equal(csv, 'sep=;\r\nnom;note\r\n"Dupont, Jean";"dit ""Jeannot"""');
  assert.equal(util.toCsv([{ a: 'x' }], ['a'], { declareSeparator: false }), 'a\r\nx');
});

test('parseContactsCsv lit un fichier avec en-tête', function () {
  const res = util.parseContactsCsv('nom,courriel\r\nMarie Tremblay,marie@exemple.com\r\nJean Roy,jean@exemple.com\r\n');
  assert.equal(res.errors.length, 0);
  assert.deepEqual(res.contacts, [
    { name: 'Marie Tremblay', email: 'marie@exemple.com', box: '' },
    { name: 'Jean Roy', email: 'jean@exemple.com', box: '' }
  ]);
});

test('parseContactsCsv accepte un fichier sans en-tête et signale les lignes fautives', function () {
  const res = util.parseContactsCsv('Marie Tremblay,marie@exemple.com\nJean Roy,pas-une-adresse\n,orphelin@exemple.com');
  assert.deepEqual(res.contacts, [{ name: 'Marie Tremblay', email: 'marie@exemple.com', box: '' }]);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0], /Ligne 2/);
  assert.match(res.errors[1], /Ligne 3/);
});

test('parseCsv gère les champs entre guillemets contenant des sauts de ligne', function () {
  const rows = util.parseCsv('a,"multi\nligne"\nb,c');
  assert.deepEqual(rows, [['a', 'multi\nligne'], ['b', 'c']]);
});

test('sortByName trie selon les règles françaises', function () {
  const sorted = util.sortByName([{ name: 'Étienne' }, { name: 'Adam' }, { name: 'eve' }]);
  assert.deepEqual(sorted.map(function (c) { return c.name; }), ['Adam', 'Étienne', 'eve']);
});

test('isSameDay compare une date ISO à une date de calendrier locale', function () {
  const iso = new Date(2026, 4, 3, 14, 30).toISOString();
  assert.ok(util.isSameDay(iso, '2026-05-03'));
  assert.ok(!util.isSameDay(iso, '2026-05-04'));
  assert.ok(!util.isSameDay('pas une date', '2026-05-03'));
});

test('matchesQuery en mode boîte ne répond que sur le numéro', function () {
  const c = { name: 'Élodie Tremblay', email: 'elo@exemple.com', box: 'B-12' };
  assert.ok(util.matchesQuery(c, 'b12', 'boite'));
  assert.ok(util.matchesQuery(c, 'B 12', 'boite'), 'espaces et tirets ignorés');
  assert.ok(util.matchesQuery(c, 'b-1', 'boite'), 'un début de numéro suffit');
  assert.ok(!util.matchesQuery(c, 'elodie', 'boite'), 'le nom ne répond pas en mode boîte');
  assert.ok(!util.matchesQuery({ name: 'Sans boîte', email: 'x@y.com' }, 'b12', 'boite'));
});

test('matchesQuery en mode nom ignore le numéro de boîte', function () {
  const c = { name: 'Élodie Tremblay', email: 'elo@exemple.com', box: 'B-12' };
  assert.ok(util.matchesQuery(c, 'elodie', 'nom'));
  assert.ok(!util.matchesQuery(c, 'b12', 'nom'));
  assert.ok(util.matchesQuery(c, 'b-12', 'tout'), 'le mode « tout » couvre les deux');
});

test('le CSV s’ouvre en colonnes dans un Excel français', function () {
  const csv = util.toCsv([{ nom: 'Dupont, Jean', courriel: 'j@ex.com' }], ['nom', 'courriel']);
  assert.ok(csv.startsWith('sep=;\r\n'), 'le séparateur est annoncé à Excel');
  assert.ok(csv.includes('nom;courriel'), 'colonnes séparées par des points-virgules');
  assert.ok(csv.includes('"Dupont, Jean"'), 'une virgule dans une valeur reste protégée');
});

test('un CSV exporté se réimporte tel quel', function () {
  const csv = util.toCsv(
    [{ boite: 'B-12', nom: 'Élodie Tremblay', courriel: 'elo@exemple.com' }],
    ['boite', 'nom', 'courriel']
  );
  const relu = util.parseContactsCsv(csv);
  assert.equal(relu.errors.length, 0);
  assert.deepEqual(relu.contacts, [{ name: 'Élodie Tremblay', email: 'elo@exemple.com', box: 'B-12' }]);
});

test('parseContactsCsv accepte aussi les fichiers séparés par des virgules', function () {
  const relu = util.parseContactsCsv('nom,courriel\r\nMarie Tremblay,marie@exemple.com');
  assert.deepEqual(relu.contacts, [{ name: 'Marie Tremblay', email: 'marie@exemple.com', box: '' }]);
});

/* ---------- gabarits par type de courrier ---------- */

test('gabaritPour retombe sur le modèle général tant qu’il n’y a rien de propre', function () {
  const general = { subject: 'Un courrier', body: 'Bonjour {nom}.' };
  assert.deepEqual(util.gabaritPour(general, 'colis'), { subject: 'Un courrier', body: 'Bonjour {nom}.' });
  assert.deepEqual(util.gabaritPour({}, 'colis'), { subject: '', body: '' });

  // Un registre écrit avant cette option n'a pas de champ « templates ».
  assert.equal(util.gabaritPour(general, 'lettre').subject, 'Un courrier');
});

test('gabaritPour applique le modèle propre au type', function () {
  const settings = {
    subject: 'Un courrier',
    body: 'Bonjour {nom}.',
    templates: { colis: { subject: 'Un colis vous attend', body: 'Bonjour {nom}, un colis encombre le casier.' } }
  };
  const colis = util.gabaritPour(settings, 'colis');
  assert.equal(colis.subject, 'Un colis vous attend');
  assert.equal(colis.propre, true);
  // Les autres types ne sont pas touchés.
  assert.equal(util.gabaritPour(settings, 'recommande').subject, 'Un courrier');
});

test('un gabarit à moitié rempli est ignoré plutôt qu’appliqué', function () {
  const settings = {
    subject: 'Général',
    body: 'Corps général',
    templates: { colis: { subject: 'Sujet seul', body: '   ' } }
  };
  assert.equal(util.gabaritPour(settings, 'colis').subject, 'Général', 'mieux vaut le général qu’un corps vide');
});

test('nettoyerGabarits ne garde que les modèles complets sur des types connus', function () {
  const propre = util.nettoyerGabarits({
    colis: { subject: 'S', body: 'B' },
    recommande: { subject: '', body: 'B' },
    inconnu: { subject: 'S', body: 'B' },
    lettre: null
  });
  assert.deepEqual(Object.keys(propre), ['colis']);
  assert.deepEqual(propre.colis, { subject: 'S', body: 'B' });
  assert.deepEqual(util.nettoyerGabarits(undefined), {});
  assert.deepEqual(util.nettoyerGabarits('n’importe quoi'), {});
});

/* ---------- antennes ---------- */

test('les antennes incomplètes ou en double sont écartées', function () {
  const a = util.nettoyerAntennes([
    { id: 'nord', nom: 'Nord', adresse: 'ici' },
    { id: 'nord', nom: 'Doublon' },
    { id: '', nom: 'Sans id' },
    { id: 'vide', nom: '   ' },
    null
  ]);
  assert.deepEqual(a.map(function (x) { return x.id; }), ['nord']);
  assert.deepEqual(util.nettoyerAntennes('rien'), []);
});

test('l’identifiant d’antenne se déduit du nom', function () {
  assert.equal(util.idAntenne('Antenne Nord'), 'antenne-nord');
  assert.equal(util.idAntenne('Accueil — Bd Saint-Michel'), 'accueil-bd-saint-michel');
  assert.equal(util.idAntenne(''), '');
});

test('un objet antérieur aux antennes appartient à la première', function () {
  const liste = [{ id: 'nord', nom: 'Nord' }, { id: 'sud', nom: 'Sud' }];
  // Sans antenneId, un destinataire existant ne doit pas devenir invisible.
  assert.equal(util.antenneDe({ name: 'Ancien' }, liste).id, 'nord');
  assert.equal(util.antenneDe({ antenneId: 'sud' }, liste).id, 'sud');
  assert.equal(util.antenneDe({ antenneId: 'disparue' }, liste).id, 'nord');
  assert.equal(util.antenneDe({}, []), null, 'sans antenne déclarée, la notion n’existe pas');
});

test('dansAntenne laisse tout passer quand aucune antenne n’est demandée', function () {
  const liste = [{ id: 'nord', nom: 'Nord' }, { id: 'sud', nom: 'Sud' }];
  assert.equal(util.dansAntenne({ antenneId: 'sud' }, '', liste), true);
  assert.equal(util.dansAntenne({ antenneId: 'sud' }, 'sud', liste), true);
  assert.equal(util.dansAntenne({ antenneId: 'sud' }, 'nord', liste), false);
  assert.equal(util.dansAntenne({}, 'nord', liste), true, 'l’ancien relève de la première');
});

/* ═══════════ les variables d'un message ═══════════

   Elles étaient construites en trois endroits — l'interface, la relance
   automatique, la route d'envoi — chacun avec sa copie. Trois listes à tenir
   d'accord, donc trois occasions de diverger. {boite} manquait aux trois. */

const CONTACT = { name: 'Amina Diallo', email: '', box: 'B-12', telephone: '06 12 34 56 78' };

test('le numéro de boîte est offert aux gabarits', function () {
  const v = util.variablesMessage({ contact: CONTACT, type: 'colis', bureau: 'Accueil', code: '4821' });
  assert.equal(v.boite, 'B-12', 'c’est le renseignement le plus utile du message');
  assert.equal(v.nom, 'Amina Diallo');
  assert.equal(v.telephone, '06 12 34 56 78');
  assert.equal(v.code, '4821');
  assert.equal(v.type, 'Colis');
  assert.equal(v.article, 'Un colis');
  assert.equal(v.article_min, 'un colis');
});

test('une fiche sans boîte ne laisse pas « undefined » dans le message', function () {
  const v = util.variablesMessage({ contact: { name: 'Omar' } });
  assert.equal(v.boite, '');
  assert.equal(v.courriel, '');
  assert.equal(v.echeance, '');
  assert.equal(v.jours, '');
});

test('l’appelant peut imposer un nom et une adresse', function () {
  // La relance travaille sur une ligne d'historique, pas sur la fiche.
  const v = util.variablesMessage({ contact: CONTACT, nom: 'Nom du courrier', courriel: 'a@ex.org' });
  assert.equal(v.nom, 'Nom du courrier');
  assert.equal(v.courriel, 'a@ex.org');
  assert.equal(v.boite, 'B-12', 'le reste vient toujours de la fiche');
});

test('un gabarit qui emploie {boite} rend le numéro', function () {
  const v = util.variablesMessage({ contact: CONTACT });
  assert.equal(
    util.renderTemplate('Votre courrier vous attend à la boîte {boite}.', v),
    'Votre courrier vous attend à la boîte B-12.'
  );
});

test('l’aide des réglages annonce exactement les variables qui existent', function () {
  /* Si l'une des deux listes bouge sans l'autre, l'aide ment — et c'est le
     genre de mensonge qu'on ne découvre qu'en écrivant un gabarit qui ne
     marche pas. */
  const offertes = Object.keys(util.variablesMessage({ contact: CONTACT })).sort();
  const annoncees = util.VARIABLES_MESSAGE.map(function (v) { return v[0]; }).sort();
  assert.deepEqual(annoncees, offertes);
});

/* ═══════════ le message dans deux langues ═══════════ */

const REGLAGES = {
  subject: 'Un courrier vous attend',
  body: 'Bonjour {nom}, un courrier vous attend.',
  langues: {
    ar: { subject: 'بريد في انتظارك', body: 'مرحبا {nom}، لديك بريد.' }
  }
};

test('sans l’option, le message part dans la seule langue du destinataire', function () {
  const v = util.variablesMessage({ contact: CONTACT });
  const m = util.messagePour(REGLAGES, 'lettre', 'ar', v);
  assert.equal(m.body, 'مرحبا Amina Diallo، لديك بريد.');
  assert.ok(!m.bilingue);
});

test('avec l’option, le français est joint dessous', function () {
  /* La personne montre souvent le message à quelqu'un qui ne lit pas sa
     langue — et l'agent doit pouvoir relire ce qu'il envoie. */
  const v = util.variablesMessage({ contact: CONTACT });
  const m = util.messagePour(REGLAGES, 'lettre', 'ar', v, { bilingue: true });
  assert.ok(m.bilingue);
  assert.ok(m.body.includes('لديك بريد'), 'la langue du destinataire vient en premier');
  assert.ok(m.body.includes('Bonjour Amina Diallo'), 'le français suit');
  assert.ok(m.body.indexOf('لديك بريد') < m.body.indexOf('Bonjour'), 'dans cet ordre');
  assert.ok(m.body.includes(util.SEPARATEUR_LANGUES.trim()), 'séparés par un trait');
});

test('un destinataire francophone ne reçoit pas le message en double', function () {
  const v = util.variablesMessage({ contact: CONTACT });
  const m = util.messagePour(REGLAGES, 'lettre', 'fr', v, { bilingue: true });
  assert.equal(m.body, 'Bonjour Amina Diallo, un courrier vous attend.');
  assert.ok(!m.bilingue, 'le cas courant reste intact');
});

test('sans gabarit dans sa langue, le message n’est pas répété deux fois', function () {
  /* Les deux retombent alors sur le modèle général : joindre « le français »
     reviendrait à écrire deux fois la même chose. */
  const v = util.variablesMessage({ contact: CONTACT });
  const m = util.messagePour(REGLAGES, 'lettre', 'uk', v, { bilingue: true });
  assert.equal(m.body, 'Bonjour Amina Diallo, un courrier vous attend.');
  assert.ok(!m.bilingue);
});

test('l’option se lit aussi dans les réglages du bureau', function () {
  const v = util.variablesMessage({ contact: CONTACT });
  const avec = util.messagePour(Object.assign({ bilingue: true }, REGLAGES), 'lettre', 'ar', v);
  assert.ok(avec.bilingue, 'pas besoin de le repréciser à chaque envoi');
});

test('le gabarit d’un type l’emporte, dans les deux langues', function () {
  const reglages = Object.assign({}, REGLAGES, {
    templates: { colis: { subject: 'Un colis', body: 'Un colis vous attend, {nom}.' } }
  });
  const v = util.variablesMessage({ contact: CONTACT, type: 'colis' });
  const m = util.messagePour(reglages, 'colis', 'ar', v, { bilingue: true });
  assert.ok(m.body.includes('لديك بريد'), 'la langue garde son texte');
  assert.ok(m.body.includes('Un colis vous attend'), 'et le français prend celui du type');
});

/* ── l'état d'un courrier ── */

test('l’état d’un courrier suit un ordre, et l’ordre a des raisons', function () {
  /* Cette règle vivait en double — une copie dans `app.js`, une dans
     `server/reminders.js` — et n’avait aucun test des deux côtés. Elle décide
     pourtant du filtre du Suivi, du compteur d’onglet, de la couleur d’une
     ligne et de la liste des relances : si les deux copies divergeaient, le
     serveur relançait un courrier que l’écran ne montrait pas comme à
     relancer. */
  const base = { date: '2026-08-01T10:00:00.000Z', status: 'envoyé', reminderCount: 0 };
  assert.equal(util.etatCourrier(base), 'attente');
  assert.equal(util.etatCourrier(Object.assign({}, base, { reminderCount: 2 })), 'relance');
  assert.equal(util.etatCourrier(Object.assign({}, base, { flaggedAt: '2026-08-05' })), 'signale');
  assert.equal(util.etatCourrier(Object.assign({}, base, { status: 'échec' })), 'echec');
  assert.equal(util.etatCourrier(Object.assign({}, base, { pickedUpAt: '2026-08-06' })), 'recupere');
  assert.equal(util.etatCourrier(Object.assign({}, base, { closedAt: '2026-08-07' })), 'clos');
});

test('« clos » l’emporte sur tout : un courrier classé n’est plus rien d’autre', function () {
  const h = {
    closedAt: '2026-08-09', pickedUpAt: '2026-08-06', flaggedAt: '2026-08-05',
    status: 'échec', reminderCount: 3
  };
  assert.equal(util.etatCourrier(h), 'clos');
});

test('remis en main propre l’emporte sur un envoi qui a échoué', function () {
  /* Un courrier dont la notification a échoué mais que la personne est venue
     chercher est remis, point. L’ordre inverse le compterait « en échec » pour
     toujours, et il ressortirait à chaque relance. */
  const h = { status: 'échec', pickedUpAt: '2026-08-06', reminderCount: 1 };
  assert.equal(util.etatCourrier(h), 'recupere');
});

test('un courrier abîmé ne fait pas tomber le classement', function () {
  assert.equal(util.etatCourrier(null), 'attente');
  assert.equal(util.etatCourrier({}), 'attente');
});
