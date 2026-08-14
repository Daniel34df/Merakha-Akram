/* Quelle adresse taper sur les trois autres postes du bureau.

   On injecte de fausses cartes réseau : une machine d'intégration continue n'a
   ni wifi ni câble, et de toute façon on veut éprouver des configurations
   qu'on ne peut pas fabriquer à la demande. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reseau = require('../server/reseau.js');

const carte = function (address, extra) {
  return Object.assign(
    { address: address, family: address.includes(':') ? 'IPv6' : 'IPv4', internal: false },
    extra || {}
  );
};

test('les plages de réseau local sont reconnues', function () {
  ['10.0.0.4', '192.168.1.10', '172.16.0.1', '172.31.255.254', '100.64.0.1'].forEach(function (a) {
    assert.equal(reseau.estPrivee(a, 'IPv4'), true, a + ' est une adresse de réseau local');
  });
  // 172.15 et 172.32 sont hors de la plage privée, contrairement à ce qu'on croit souvent.
  ['8.8.8.8', '172.15.0.1', '172.32.0.1', '203.0.113.7'].forEach(function (a) {
    assert.equal(reseau.estPrivee(a, 'IPv4'), false, a + ' n’est pas une adresse de réseau local');
  });
  assert.equal(reseau.estPrivee('fd12::1', 'IPv6'), true);
  assert.equal(reseau.estPrivee('2001:db8::1', 'IPv6'), false);
});

test('une adresse mal formée ne passe pas pour privée', function () {
  ['10.0.0', '999.1.1.1', '172.16', '', 'bonjour'].forEach(function (a) {
    assert.equal(reseau.estPrivee(a, 'IPv4'), false, JSON.stringify(a));
  });
});

test('le lien-local est écarté : il ne se tape pas dans un navigateur', function () {
  const liste = reseau.adressesLocales({
    wlan0: [carte('169.254.11.2'), carte('fe80::1'), carte('192.168.1.10')]
  });
  assert.deepEqual(liste.map(function (a) { return a.adresse; }), ['192.168.1.10']);
});

test('la boucle locale n’est pas proposée aux autres postes', function () {
  const liste = reseau.adressesLocales({
    lo: [carte('127.0.0.1', { internal: true })],
    eth0: [carte('192.168.1.10')]
  });
  assert.equal(liste.length, 1);
  assert.equal(liste[0].adresse, '192.168.1.10');
});

test('le câble passe avant le wifi, et l’IPv4 avant l’IPv6', function () {
  const liste = reseau.adressesLocales({
    wlan0: [carte('192.168.1.50')],
    eth0: [carte('192.168.1.10'), carte('fd00::10')]
  });
  assert.deepEqual(
    liste.map(function (a) { return a.adresse; }),
    ['192.168.1.10', '192.168.1.50', 'fd00::10']
  );
  assert.equal(liste[0].type, 'câble');
  assert.equal(liste[1].type, 'wifi');
});

test('une adresse de réseau local passe devant une adresse inhabituelle', function () {
  const liste = reseau.adressesLocales({
    eth0: [carte('203.0.113.7')],
    wlan0: [carte('192.168.1.50')]
  });
  assert.equal(liste[0].adresse, '192.168.1.50', 'le wifi privé passe devant le câble public');
  assert.equal(liste[0].privee, true);
  assert.equal(liste[1].privee, false);
});

test('l’IPv6 se met entre crochets, sinon le port ne se distingue pas', function () {
  assert.equal(reseau.url('fd00::10', 3000, 'https'), 'https://[fd00::10]:3000');
  assert.equal(reseau.url('192.168.1.10', 3000), 'http://192.168.1.10:3000');
});

test('le nom du poste est recommandé en premier : il survit au changement d’adresse', function () {
  const r = reseau.resume({
    interfaces: { eth0: [carte('192.168.1.10')] },
    port: 3000,
    nomPoste: 'accueil-pc'
  });
  assert.equal(r.recommandee, 'http://accueil-pc:3000');
  assert.equal(r.principale, 'http://192.168.1.10:3000', 'l’adresse reste en secours');
  assert.equal(r.aucuneAdresse, false);
  assert.equal(r.adresseInhabituelle, false);
});

test('un nom de poste inutilisable retombe sur l’adresse', function () {
  const r = reseau.resume({
    interfaces: { eth0: [carte('192.168.1.10')] },
    nomPoste: 'poste de l’accueil'
  });
  assert.equal(r.nomPoste, '');
  assert.equal(r.recommandee, 'http://192.168.1.10:3000');
});

test('un nom de domaine complet est réduit au nom court', function () {
  assert.equal(reseau.nomUtilisable('accueil-pc.local'), 'accueil-pc');
  assert.equal(reseau.nomUtilisable('ACCUEIL01'), 'ACCUEIL01');
});

test('sans aucune carte, on le dit plutôt que d’inventer une adresse', function () {
  const r = reseau.resume({ interfaces: { lo: [carte('127.0.0.1', { internal: true })] }, nomPoste: 'pc' });
  assert.equal(r.aucuneAdresse, true);
  assert.equal(r.principale, null);
  assert.deepEqual(r.adresses, []);
});

test('une adresse hors des plages connues est montrée, mais signalée', function () {
  /* Le contraire — ne rien afficher — laisserait sans recours un bureau dont
     le réseau ne ressemble pas à ce qu'on attendait. */
  const r = reseau.resume({ interfaces: { eth0: [carte('203.0.113.7')] }, nomPoste: 'pc' });
  assert.equal(r.aucuneAdresse, false);
  assert.equal(r.adresseInhabituelle, true);
  assert.equal(r.principale, 'http://203.0.113.7:3000');
});

test('le changement d’adresse se remarque, l’ordre ne compte pas', function () {
  const avant = [{ adresse: '192.168.1.10' }, { adresse: 'fd00::10' }];
  assert.equal(reseau.aChange(avant, [{ adresse: 'fd00::10' }, { adresse: '192.168.1.10' }]), false);
  assert.equal(reseau.aChange(avant, [{ adresse: '192.168.1.42' }, { adresse: 'fd00::10' }]), true);
  assert.equal(reseau.aChange(avant, []), true);
  assert.equal(reseau.aChange(undefined, []), false);
});

test('une écoute limitée à la machine est reconnue', function () {
  /* Le piège du bureau à plusieurs postes : le serveur affiche une adresse,
     les autres PC la tapent, et rien ne répond — parce qu'il est lié à la
     boucle locale. Aucune erreur ne le dit ; il faut le détecter. */
  ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '127.0.1.1'].forEach(function (h) {
    assert.equal(reseau.ecouteFermee(h), true, h + ' n’écoute que sur la machine');
  });
  ['0.0.0.0', '::', '192.168.1.10', ''].forEach(function (h) {
    assert.equal(reseau.ecouteFermee(h), false, JSON.stringify(h) + ' laisse passer les autres postes');
  });
});

test('le protocole demandé se retrouve dans toutes les adresses', function () {
  const r = reseau.resume({
    interfaces: { eth0: [carte('192.168.1.10')] },
    protocole: 'https',
    nomPoste: 'accueil-pc'
  });
  assert.equal(r.recommandee, 'https://accueil-pc:3000');
  assert.equal(r.adresses[0].url, 'https://192.168.1.10:3000');
});
