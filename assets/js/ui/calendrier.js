/* Bureau du Courrier — le calendrier des échéances, à l'écran.

   Il vit en tête de l'onglet Domiciliation, avant le formulaire et avant la
   liste des dossiers. C'est l'ordre de la question qu'on se pose en ouvrant
   cet onglet : « qu'est-ce qui vient » avant « qui dois-je inscrire ».

   Ce que l'écran ajoute au calcul :

     · **une case se clique** et ouvre la fiche de la personne. Un calendrier
       qui montre douze noms sans y mener oblige à les rechercher un par un
       dans le registre, et on ne le fait pas.

     · **le nombre est écrit dans la case**, à côté de sa couleur. Une journée
       chargée et une journée dépassée ne se distinguent pas par la teinte pour
       tout le monde, et la différence est celle entre « à étaler » et « en
       retard ».

   Le calcul est dans `assets/js/calendrier.js`, vérifiable sans navigateur. */
(function (root) {
  'use strict';

  const BC = root.BC;
  const ui = BC.ui;
  const store = BC.store;
  const cal = BC.calendrier;
  const S = store.state;
  const $ = ui.$;
  const esc = ui.esc;
  const view = ui.view;
  const ecrans = ui.ecrans;

  function render() {
    const grille = $('calGrille');
    if (!grille) return;

    const m = cal.mois(
      { contacts: S.contacts, history: S.history, settings: S.settings },
      { mois: view.calMois || undefined }
    );
    view.calMois = m.mois;

    $('calMois').textContent = m.libelle;
    $('calPhrase').textContent = cal.phrase(m);

    grille.innerHTML =
      '<div class="cal-entete">' +
      cal.JOURS.map(function (j) {
        /* Le nom du jour est abrégé à l'écran mais reste entier pour les
           lecteurs d'écran : « lun » ne se prononce pas. */
        return '<div class="cal-jour-nom"><abbr title="' + esc(j) + '">' +
          esc(j.slice(0, 3)) + '</abbr></div>';
      }).join('') +
      '</div>' +
      m.semaines.map(function (semaine) {
        return '<div class="cal-semaine">' + semaine.map(function (c) {
          const classes = ['cal-case'];
          if (c.hors) classes.push('cal-hors');
          if (c.aujourdhui) classes.push('cal-aujourdhui');
          if (c.expirees) classes.push('cal-expiree');
          else if (c.charge) classes.push('cal-charge');
          else if (c.n) classes.push('cal-remplie');

          return '<div class="' + classes.join(' ') + '">' +
            '<div class="cal-numero">' + c.numero + '</div>' +
            (c.n
              ? '<div class="cal-compte">' + c.n + ' échéance' + (c.n > 1 ? 's' : '') + '</div>' +
                '<ul class="cal-noms">' +
                c.echeances.slice(0, 4).map(function (e) {
                  return '<li><button type="button" class="link-btn" data-cal-fiche="' +
                    esc(e.contact.id) + '"' +
                    (e.expiree ? ' title="échéance dépassée"' : '') + '>' +
                    esc(e.contact.name) + (e.expiree ? ' ⚠' : '') + '</button></li>';
                }).join('') +
                (c.n > 4 ? '<li class="cal-reste">et ' + (c.n - 4) + ' de plus</li>' : '') +
                '</ul>'
              : '') +
            '</div>';
        }).join('') + '</div>';
      }).join('');
  }

  function allerAuMois(n) {
    view.calMois = cal.decalerMois(view.calMois || cal.moisDe(cal.jourLocal(new Date())), n);
    render();
  }

  function init() {
    const grille = $('calGrille');
    if (!grille) return;

    $('calPrecedent').addEventListener('click', function () { allerAuMois(-1); });
    $('calSuivant').addEventListener('click', function () { allerAuMois(1); });
    $('calAujourdhui').addEventListener('click', function () {
      view.calMois = cal.moisDe(cal.jourLocal(new Date()));
      render();
    });

    /* Un seul écouteur : la grille se réécrit à chaque changement de mois, et
       des écouteurs posés sur chaque nom s'accumuleraient. */
    grille.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('[data-cal-fiche]');
      if (!btn) return;
      ecrans.registre.ouvrirFiche(btn.dataset.calFiche);
    });
  }

  ui.inscrire('calendrier', { init: init, render: render });
})(typeof globalThis !== 'undefined' ? globalThis : this);
