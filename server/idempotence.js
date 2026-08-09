/* Bureau du Courrier — les opérations déjà vues.

   Le problème. Le guichet travaille hors ligne : chaque écriture est mise de
   côté et rejouée au retour du réseau (`assets/js/attente.js`). Le rejeu
   suppose que le serveur n'a rien reçu — or il a pu recevoir la requête,
   l'exécuter, et voir la réponse se perdre en route. Le poste, lui, n'a rien
   vu revenir : il garde l'intention en file et la rejoue.

   Ce qui se passe alors ne fait pas de bruit. Une remise de courrier comptée
   deux fois, une fiche de domiciliation créée en double, un même destinataire
   présent deux fois dans le registre avec deux boîtes. Rien ne plante, rien
   n'alerte : le registre est simplement faux, et personne ne sait quand ça a
   commencé.

   Le remède. Chaque intention porte déjà un identifiant, stable d'un rejeu à
   l'autre. Il voyage jusqu'au serveur dans un en-tête ; le serveur tient la
   liste des identifiants qu'il a menés à bien, et rend au second passage le
   résultat du premier au lieu de refaire le travail.

   Ce qu'on garde, et ce qu'on ne garde pas. **Jamais le corps de la réponse.**
   Il contient des noms, des dates de naissance, des numéros de téléphone de
   gens qui n'ont pas de logement — parfois de gens qui se cachent de
   quelqu'un. Une entrée retient quatre choses : la clé, l'instant, le code
   HTTP, et l'identifiant attribué. Le poste qui reçoit un rejeu recharge
   l'état complet juste après, comme il le fait déjà après tout rejeu réussi ;
   il n'a donc besoin que de l'identifiant, pour substituer le vrai au
   provisoire dans ce qui attend encore.

   Ce que ce module ne prétend pas faire. Deux requêtes portant la même clé et
   parties **en même temps** peuvent encore s'exécuter toutes les deux : la
   première n'est inscrite qu'une fois terminée. Ce n'est pas le cas qu'on
   traite — un poste rejoue sa file une intention à la fois, et deux postes ne
   partagent jamais un identifiant d'intention. Le cas réel est séquentiel : la
   réponse perdue, puis le rejeu. Fermer aussi le cas simultané demanderait de
   réserver la clé avant d'exécuter, donc de savoir défaire la réservation
   quand l'exécution échoue — beaucoup de mécanique pour un cas qui ne se
   produit pas ici.

   Ce module ne touche ni au disque ni au réseau : il calcule sur un tableau.
   C'est ce qui le rend vérifiable. */
'use strict';

/* L'en-tête. Minuscules : Node donne les en-têtes reçus en minuscules. */
const ENTETE = 'x-operation-id';

/* Sept jours. Une file hors ligne peut traverser un long week-end férié ou une
   panne de box ; au-delà d'une semaine, un poste qui rejoue enfin a de toute
   façon un registre trop vieux pour que le rejeu ait un sens. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/* Plafond. Le registre vit dans le fichier JSON du bureau : il n'a pas à
   grossir sans fin. Deux mille opérations, c'est plusieurs semaines d'un
   guichet chargé, et environ cent kilo-octets. */
const MAX = 2000;

/* Une clé vient du poste : elle est reçue, donc suspecte. On accepte ce que
   `attente.js` produit (« local-a1b2c3d4 », un UUID) et rien qui puisse
   surprendre plus loin — pas d'espace, pas de quoi fabriquer un chemin. */
function estCle(v) {
  return typeof v === 'string' && v.length >= 4 && v.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(v);
}

/* La clé d'une requête, ou `null`. Une lecture n'a rien à dédoublonner : elle
   ne laisse pas de trace, et la rejouer ne coûte que sa réponse. */
function lireCle(req) {
  if (!req || req.method === 'GET' || req.method === 'HEAD') return null;
  const brut = req.headers ? req.headers[ENTETE] : null;
  // Un en-tête envoyé deux fois arrive en tableau : c'est déjà anormal.
  if (Array.isArray(brut)) return null;
  return estCle(brut) ? brut : null;
}

function retrouver(registre, cle) {
  if (!Array.isArray(registre) || !estCle(cle)) return null;
  for (let i = registre.length - 1; i >= 0; i--) {
    if (registre[i] && registre[i].cle === cle) return registre[i];
  }
  return null;
}

/* L'identifiant attribué par le serveur, s'il y en a un. Les réponses de
   l'application le portent de trois façons selon l'appel — `record` pour un
   courrier, `contact` pour un destinataire, ou l'objet lui-même. */
function extraireId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const source = payload.record || payload.contact || payload;
  const id = source && source.id;
  return typeof id === 'string' && id ? id : null;
}

/* Une opération n'est retenue que si elle a abouti. Un refus (4xx) se
   reproduira à l'identique tout seul, et une panne (5xx) n'a rien laissé
   derrière elle qu'il faille éviter de refaire — la retenir empêcherait au
   contraire le rejeu de réussir plus tard. */
function estRetenu(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/* Supprime ce qui est trop vieux, puis ce qui dépasse le plafond — les plus
   anciennes entrées d'abord, qui sont aussi les moins susceptibles d'être
   rejouées. Modifie le tableau sur place : c'est celui du registre, et
   l'appelant compte sur le fait que l'écriture différée verra le résultat. */
function purger(registre, maintenant) {
  if (!Array.isArray(registre)) return [];
  const limite = (maintenant === undefined ? Date.now() : maintenant) - RETENTION_MS;
  const gardees = registre.filter(function (e) {
    if (!e || !estCle(e.cle)) return false;
    const t = new Date(e.at).getTime();
    return !isNaN(t) && t >= limite;
  });
  const trop = gardees.length - MAX;
  const finales = trop > 0 ? gardees.slice(trop) : gardees;
  registre.length = 0;
  Array.prototype.push.apply(registre, finales);
  return registre;
}

/* Inscrit une opération menée à bien. Rend `true` si quelque chose a été
   inscrit — l'appelant s'en sert pour ne déclencher une écriture disque que
   dans ce cas. */
function noter(registre, cle, entree, maintenant) {
  if (!Array.isArray(registre) || !estCle(cle)) return false;
  const status = entree && entree.status;
  if (!estRetenu(status)) return false;
  if (retrouver(registre, cle)) return false; // déjà là : on ne réécrit pas le premier résultat
  registre.push({
    cle: cle,
    at: new Date(maintenant === undefined ? Date.now() : maintenant).toISOString(),
    status: status,
    id: (entree && entree.id) || null
  });
  purger(registre, maintenant);
  return true;
}

/* Ce qu'on renvoie au rejeu. `rejoue` dit au poste de ne pas prendre cet objet
   pour la fiche elle-même : il n'en a que l'identifiant. */
function reponseRejeu(entree) {
  const out = { rejoue: true };
  if (entree && entree.id) out.id = entree.id;
  return out;
}

module.exports = {
  ENTETE: ENTETE,
  RETENTION_MS: RETENTION_MS,
  MAX: MAX,
  estCle: estCle,
  lireCle: lireCle,
  retrouver: retrouver,
  extraireId: extraireId,
  estRetenu: estRetenu,
  purger: purger,
  noter: noter,
  reponseRejeu: reponseRejeu
};
