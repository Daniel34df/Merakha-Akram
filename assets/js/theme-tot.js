/* Le thème choisi, posé avant le premier pixel.
 *
 * Ce fichier tient en dix lignes et il a une raison d'être séparé de tout le
 * reste : il doit s'exécuter **avant** que le navigateur ne peigne quoi que ce
 * soit. Chargé depuis app.js, ou même en fin de <head>, la page se peindrait
 * d'abord en clair puis basculerait — un éclair blanc en pleine figure à chaque
 * ouverture, dans un bureau où l'on travaille aussi le soir.
 *
 * Et il est dans un fichier plutôt qu'en <script> dans la page parce que le
 * serveur envoie « Content-Security-Policy: script-src 'self' » (server/app.js).
 * Un script en ligne y est refusé net : la version précédente ne s'exécutait
 * pas du tout sur une installation servie, et ne marchait qu'en ouvrant le
 * fichier à la main. C'est la vérification d'apparence qui l'a montré.
 *
 * Il ne fait qu'une chose, et laisse tout le reste — le tour des trois états,
 * la persistance, la barre du navigateur — au socle (assets/js/ui/noyau.js).
 * Les deux couleurs ci-dessous sont celles de `--bg` dans les deux thèmes ;
 * test/noyau.test.js vérifie qu'elles ne divergent pas de la feuille de style.
 */
(function () {
  'use strict';
  try {
    var choix = localStorage.getItem('bdc-theme');
    if (choix !== 'clair' && choix !== 'sombre') return;
    document.documentElement.setAttribute('data-theme', choix);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', choix === 'sombre' ? '#0B0F1A' : '#F7F8FC');
  } catch (e) {
    /* Navigation privée, stockage refusé : on suit le système, comme par défaut. */
  }
})();
