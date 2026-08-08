/* Bureau du Courrier — le bureau sur plusieurs postes.

   Le cas courant : quatre ordinateurs à l'accueil, reliés par le même wifi ou
   le même câble. L'application ne s'installe pas quatre fois avec quatre
   registres séparés — cela donnerait quatre vérités différentes sur le même
   courrier. Elle s'installe sur **un** poste, celui du responsable, qui garde
   le registre ; les autres l'ouvrent dans leur navigateur en tapant son
   adresse sur le réseau local.

   Ce module ne fait qu'une chose : trouver, parmi les cartes réseau de la
   machine, celles qui portent une adresse joignable par les autres postes du
   bureau, pour pouvoir l'afficher. Personne ne devrait avoir à ouvrir une
   invite de commandes pour savoir quoi taper sur le poste d'à côté. */
'use strict';

const os = require('node:os');

/* Une adresse privée : celle d'un réseau domestique ou de bureau. Les plages
   viennent de la RFC 1918 (v4), de la RFC 6598 pour les réseaux d'opérateur,
   et de fc00::/7 (v6).

   On s'en sert pour **classer**, pas pour exclure. Une machine peut très bien
   n'avoir qu'une adresse hors de ces plages — réseau d'entreprise particulier,
   machine virtuelle, tunnel — et lui répondre « aucune adresse réseau » serait
   faux et sans recours. On montre alors ce qu'on a, en le signalant. */
function estPrivee(adresse, famille) {
  const a = String(adresse || '');
  if (famille === 'IPv6' || a.includes(':')) {
    // fc00::/7 — adresses locales uniques.
    return /^f[cd]/i.test(a);
  }
  /* La forme d'abord, les plages ensuite : « 10.0.0 » commence bien par
     « 10. » sans être pour autant une adresse. */
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return false;
  const octets = a.split('.').map(Number);
  if (octets.some(function (n) { return n > 255; })) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  // 100.64.0.0/10 : partagée par certains opérateurs et par les réseaux maillés.
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  return false;
}

/* Le lien-local ne se tape pas dans un navigateur : en IPv6 il exige un
   identifiant de zone, et en IPv4 (169.254.x.x) il signale justement que la
   machine n'a **pas** obtenu d'adresse — le wifi n'a pas abouti. */
function estLienLocal(adresse) {
  const a = String(adresse || '');
  return /^fe80:/i.test(a) || /^169\.254\./.test(a);
}

/* Le nom de la carte trahit souvent sa nature. On s'en sert pour ordonner, pas
   pour exclure : un câble avant un wifi, un wifi avant le reste — c'est
   l'ordre de fiabilité, et donc celui dans lequel on veut le lire. */
function rang(nom) {
  const n = String(nom || '').toLowerCase();
  if (/^(eth|en[ospx]|ethernet|lan)/.test(n)) return 0;
  if (/(wl|wi-?fi|wlan|sans.?fil)/.test(n)) return 1;
  return 2;
}

function typeCarte(nom) {
  const r = rang(nom);
  return r === 0 ? 'câble' : r === 1 ? 'wifi' : 'réseau';
}

/**
 * Les adresses de cette machine sur le réseau local, la plus utile d'abord.
 * @param {object} [interfaces] résultat de os.networkInterfaces(), injectable
 *   pour les tests — on ne peut pas donner deux cartes réseau à une machine
 *   d'intégration continue.
 * @returns {Array<{adresse,carte,type,famille,privee}>}
 */
function adressesLocales(interfaces) {
  const cartes = interfaces || os.networkInterfaces();
  const out = [];
  Object.keys(cartes).forEach(function (nom) {
    (cartes[nom] || []).forEach(function (info) {
      if (info.internal) return; // 127.0.0.1 : ne sort pas de la machine
      if (estLienLocal(info.address)) return;
      const famille = info.family === 4 || info.family === 'IPv4' ? 'IPv4' : 'IPv6';
      out.push({
        adresse: info.address,
        carte: nom,
        type: typeCarte(nom),
        famille: famille,
        privee: estPrivee(info.address, famille)
      });
    });
  });
  out.sort(function (a, b) {
    // Une adresse de réseau local d'abord : c'est celle des postes du bureau.
    if (a.privee !== b.privee) return a.privee ? -1 : 1;
    // Puis l'IPv4 : c'est ce qui se dicte et se tape sans erreur.
    if ((a.famille === 'IPv4') !== (b.famille === 'IPv4')) return a.famille === 'IPv4' ? -1 : 1;
    return rang(a.carte) - rang(b.carte) || a.adresse.localeCompare(b.adresse);
  });
  return out;
}

/** L'adresse à taper sur les autres postes, mise en forme. */
function url(hote, port, protocole) {
  const h = String(hote).includes(':') ? '[' + hote + ']' : hote;
  return (protocole || 'http') + '://' + h + ':' + port;
}

/* Le nom du poste ne change pas quand le wifi redistribue les adresses : c'est
   la seule chose stable à écrire sur un papier collé aux trois autres écrans.
   Windows le résout par NetBIOS, macOS et la plupart des Linux par mDNS. Ça ne
   marche pas partout — d'où l'adresse en secours, juste à côté. */
function nomUtilisable(nom) {
  const propre = String(nom || '').trim().split('.')[0];
  return /^[a-zA-Z0-9-]{1,63}$/.test(propre) ? propre : '';
}

/**
 * Ce qu'on affiche au responsable, prêt à recopier.
 * @returns {{port,protocole,nomPoste,recommandee,adresses,principale,aucuneAdresse}}
 */
function resume(options) {
  const opts = options || {};
  const liste = adressesLocales(opts.interfaces);
  const port = Number(opts.port || 3000);
  const protocole = opts.protocole || 'http';
  const nomPoste = nomUtilisable(opts.nomPoste || os.hostname());
  const adresses = liste.map(function (a) {
    return Object.assign({ url: url(a.adresse, port, protocole) }, a);
  });
  return {
    port: port,
    protocole: protocole,
    nomPoste: nomPoste,
    // À taper en premier : le nom, qui survit à un changement d'adresse.
    recommandee: nomPoste ? url(nomPoste, port, protocole) : (adresses[0] && adresses[0].url) || null,
    adresses: adresses,
    principale: (adresses[0] && adresses[0].url) || null,
    /* Aucune adresse : câble débranché ou wifi coupé. Les autres postes ne
       peuvent alors rien joindre, et il faut le dire plutôt que d'afficher une
       adresse qui ne répondra pas. */
    aucuneAdresse: adresses.length === 0,
    // Aucune adresse de réseau local reconnue : on montre ce qu'on a, mais
    // l'interface doit prévenir que ce n'est peut-être pas la bonne.
    adresseInhabituelle: adresses.length > 0 && !adresses[0].privee
  };
}

/* Le serveur n'écoute-t-il que sur lui-même ?

   C'est le piège du bureau à plusieurs postes : l'application affiche fièrement
   une adresse, les trois autres PC la tapent, et rien ne répond — parce que le
   serveur est lié à la boucle locale et ne sort pas de la machine. Aucun
   message d'erreur ne dit ça ; on cherche du côté du wifi ou du pare-feu
   pendant une heure. Autant le détecter et le dire. */
function ecouteFermee(hote) {
  const h = String(hote || '').trim().toLowerCase();
  if (!h) return false;
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/** Vrai si la liste d'adresses a changé depuis la dernière fois. */
function aChange(avant, maintenant) {
  const cle = function (liste) {
    return (liste || [])
      .map(function (a) {
        return a.adresse;
      })
      .sort()
      .join(',');
  };
  return cle(avant) !== cle(maintenant);
}

module.exports = {
  estPrivee: estPrivee,
  estLienLocal: estLienLocal,
  ecouteFermee: ecouteFermee,
  typeCarte: typeCarte,
  nomUtilisable: nomUtilisable,
  adressesLocales: adressesLocales,
  url: url,
  resume: resume,
  aChange: aChange
};
