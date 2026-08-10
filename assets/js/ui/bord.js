/* Bureau du Courrier — le relevé du jour, en haut du Guichet.

   Pourquoi ici et pas ailleurs. Le Guichet est l'écran sur lequel
   l'application s'ouvre : c'est le seul endroit où un relevé sera vu tous les
   matins sans qu'on ait à y penser. Un septième onglet aurait coûté une
   troisième ligne à la barre de navigation sur un écran de 360 px, et surtout
   il aurait fallu aller le consulter — c'est-à-dire, en pratique, ne pas le
   consulter.

   Pourquoi il reste petit. Le Guichet a été allégé exprès : trois réglages sur
   quatre y ont été repliés parce qu'ils occupaient l'écran en permanence sans
   servir au courrier ordinaire. Remettre un tableau de bord complet par-dessus
   annulerait ce travail. Donc une bande, pas une page : une phrase, et une
   ligne de chiffres — **et seulement ceux qui appellent une action**. Un
   bureau dont la journée est calme voit une ligne calme, et le champ de saisie
   reste à portée de main.

   Ce qui n'est pas négociable ici :

     · **chaque chiffre mène quelque part.** « 4 domiciliations expirées » sans
       moyen d'atteindre les quatre dossiers oblige à les rechercher à la main,
       et on ne le fait pas. Cliquer ouvre l'écran concerné.

     · **le mot est écrit à côté du chiffre** (§33, §54). Une pastille rouge et
       une pastille orange ne se distinguent pas pour tout le monde, et la
       différence entre « expirée » et « à renouveler » est exactement celle
       entre un droit perdu et un rendez-vous à prendre.

   Le calcul est ailleurs, dans `assets/js/bord.js`, et se vérifie sans
   navigateur. Ici, on peint. */
(function (root) {
  'use strict';

  const BC = root.BC;
  const ui = BC.ui;
  const store = BC.store;
  const bord = BC.bord;
  const S = store.state;
  const $ = ui.$;
  const esc = ui.esc;
  const ecrans = ui.ecrans;

  function render() {
    const bande = $('bord');
    if (!bande) return;

    /* Pas de garde de connexion ici : l'écran de connexion (`#authGate`)
       recouvre l'application entière quand une session manque, et la bande est
       dessous. Ajouter une seconde condition, c'est se donner deux réponses à
       la même question — et celle d'ici serait la plus facile à oublier le
       jour où la première change. */
    const r = bord.resume(
      { history: S.history, contacts: S.contacts, boites: S.boites, settings: S.settings },
      {}
    );
    bande.hidden = false;
    bande.dataset.calme = r.calme ? 'oui' : 'non';

    $('bordPhrase').textContent = bord.phrase(r);

    $('bordAlertes').innerHTML = r.alertes
      .map(function (a) {
        /* Le chiffre et le mot dans le même bouton : ils se lisent ensemble,
           et c'est la paire entière qui est cliquable — viser une pastille de
           douze pixels au guichet, debout, ne marche pas. */
        return (
          '<button type="button" class="bord-chip bord-' + esc(a.niveau) + '"' +
          ' data-bord="' + esc(a.cle) + '" title="' + esc(a.phrase) + '">' +
          (a.n ? '<span class="bord-n">' + a.n + '</span>' : '') +
          '<span class="bord-mot">' + esc(a.libelle) + '</span>' +
          '</button>'
        );
      })
      .join('');

    /* Les destinations sont retenues telles quelles : reconstruire le résumé
       au moment du clic donnerait un autre relevé si un collègue a inscrit un
       courrier entre-temps, et le clic ne mènerait pas où le chiffre promettait. */
    bande.__ou = {};
    r.alertes.forEach(function (a) {
      bande.__ou[a.cle] = a.ou;
    });
  }

  function aller(ou) {
    if (!ou) return;
    ecrans.app.showPanel(ou.panneau);
    /* Les écrans à sections — le Registre, la Domiciliation — savent s'ouvrir
       sur l'une d'elles. Un écran qui ne connaît pas la section demandée
       s'ouvre normalement plutôt que de refuser d'aller quelque part. */
    if (ou.section) {
      const cible = ecrans[ou.panneau];
      if (cible && typeof cible.ouvrirSection === 'function') cible.ouvrirSection(ou.section);
    }
  }

  function init() {
    const bande = $('bord');
    if (!bande) return;
    /* Un seul écouteur pour toute la bande : elle se réécrit à chaque
       changement, et des écouteurs posés sur chaque bouton s'accumuleraient. */
    bande.addEventListener('click', function (e) {
      const chip = e.target.closest && e.target.closest('[data-bord]');
      if (!chip) return;
      aller(bande.__ou && bande.__ou[chip.dataset.bord]);
    });
  }

  ui.inscrire('bord', { init: init, render: render });
})(typeof globalThis !== 'undefined' ? globalThis : this);
