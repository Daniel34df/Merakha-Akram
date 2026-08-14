/* Bureau du Courrier — le relevé de journée et la santé de l'installation.

   Deux écrans que rien ne relie dans les données, mais qui répondent à la même
   question : **est-ce que je peux partir tranquille ?** L'un pour le service
   qui se termine, l'autre pour la machine qui reste allumée. Ils tiennent dans
   un même module parce qu'ils font la même chose — recevoir un calcul fait
   ailleurs et le peindre — et qu'en écrire deux garantirait qu'ils divergent.

   Les calculs sont dans `assets/js/journee.js` et `assets/js/diagnostic.js`,
   tous deux vérifiables sans navigateur. Ici, on peint et on imprime.

   Une différence de fond entre les deux : le relevé de journée se calcule sur
   le poste, à partir de ce que le registre contient déjà. Le diagnostic, lui,
   **doit passer par le serveur** — un navigateur ne sait pas si un disque est
   plein ni si un fichier est écrivable, et prétendre le deviner ferait dire à
   l'écran des choses fausses sur la seule page où il ne le faut pas. */
(function (root) {
  'use strict';

  const BC = root.BC;
  const ui = BC.ui;
  const store = BC.store;
  const journee = BC.journee;
  const diagnostic = BC.diagnostic;
  const util = BC.util;
  const S = store.state;
  const $ = ui.$;
  const esc = ui.esc;
  const view = ui.view;

  /* ═════════════ le relevé de journée ═════════════ */

  function renderJournee() {
    const carte = $('journeeCompte');
    if (!carte) return;

    const jour = ($('journeeDate') && $('journeeDate').value) || journee.jourLocal(new Date());
    const r = journee.releve(
      { history: S.history, contacts: S.contacts, settings: S.settings },
      { jour: jour }
    );

    $('journeePhrase').textContent = journee.phrase(r);

    /* Les chiffres d'abord, parce qu'ils répondent à « est-ce qu'on a bien
       tout saisi ? » — la question qu'on se pose en fermant. */
    carte.innerHTML = [
      ['Entrés', r.compte.entres],
      ['Remis', r.compte.sortis],
      ['Classés', r.compte.clos],
      ['Dont colis', r.compte.colis],
      ['Dont urgents', r.compte.urgents],
      ['En attente ce soir', r.compte.enAttente]
    ].map(function (paire) {
      return '<div class="journee-case"><span class="journee-n">' + paire[1] + '</span>' +
        '<span class="journee-mot">' + esc(paire[0]) + '</span></div>';
    }).join('');

    /* Le suspens ensuite : c'est la seule partie qui ne peut pas attendre
       demain, et elle porte la consigne, pas seulement le constat. */
    $('journeeSuspens').innerHTML = r.suspens.length
      ? '<h3 class="journee-titre">À passer au suivant</h3>' +
        r.suspens.map(function (s) {
          return '<div class="msg' + (s.gravite === 'haute' ? ' error' : '') + '">' +
            '<strong>' + esc(s.quoi) + '</strong><br>' + esc(s.faire) +
            (s.entrees && s.entrees.length
              ? '<ul>' + s.entrees.slice(0, 8).map(function (h) {
                  return '<li>' + esc(h.name) +
                    (h.reference ? ' <span class="muted">' + esc(h.reference) + '</span>' : '') +
                    '</li>';
                }).join('') + '</ul>'
              : '') +
            '</div>';
        }).join('')
      : '';

    $('journeeEcheances').innerHTML = r.echeances.length
      ? '<h3 class="journee-titre">Échéances à venir</h3><ul class="journee-echeances">' +
        r.echeances.map(function (d) {
          const j = d.etat.joursRestants;
          return '<li><strong>' + esc(d.contact.name) + '</strong> — ' +
            (d.etat.etat === 'expiree'
              ? 'expirée'
              : 'dans ' + j + ' jour' + (j > 1 ? 's' : '')) +
            '</li>';
        }).join('') + '</ul>'
      : '';
  }

  /* ═════════════ le diagnostic ═════════════ */

  /* Il n'est **pas** rejoué à chaque rendu : il sonde le disque, et une sonde
     d'écriture relancée à chaque frappe dans les Réglages serait un fichier
     créé et effacé cent fois par minute. Il se demande, comme on demande un
     bilan. */
  async function renderDiagnostic(force) {
    const liste = $('diagnosticListe');
    if (!liste) return;
    if (!force && !view.diagnostic) {
      $('diagnosticPhrase').textContent = '';
      liste.innerHTML =
        '<p class="hint">L’installation n’a pas encore été vérifiée. ' +
        '« Vérifier » regarde les sauvegardes, le disque, l’écriture du registre, ' +
        'le code de reprise et la liaison réseau.</p>';
      $('diagnosticChiffres').textContent = '';
      return;
    }

    if (force) {
      liste.innerHTML = '<div class="squelette" aria-hidden="true">' +
        '<div class="squelette-ligne" style="width:80%"></div>' +
        '<div class="squelette-ligne" style="width:64%"></div></div>';
      try {
        view.diagnostic = await store.diagnostic();
      } catch (e) {
        $('diagnosticPhrase').textContent = '';
        /* On ne remplace pas un diagnostic manqué par un diagnostic vide :
           ce serait exactement le mensonge que le module refuse de faire. */
        liste.innerHTML = '<div class="msg error">La vérification n’a pas abouti : ' +
          esc(e.message || 'le serveur n’a pas répondu') +
          '. Rien n’a pu être observé — cela ne veut pas dire que tout va bien.</div>';
        return;
      }
    }

    const d = view.diagnostic;
    $('diagnosticPhrase').textContent = d.phrase || diagnostic.phrase(d.constats);
    liste.innerHTML = '<dl class="status-list">' + d.constats.map(function (c) {
      /* Le mot d'état est écrit dans la ligne, pas seulement peint : « grave »
         et « attention » ne se distinguent pas pour tout le monde par la
         couleur, et la différence est celle entre « agir maintenant » et
         « y penser cette semaine ». */
      return '<div class="diag-ligne diag-' + esc(c.niveau) + '">' +
        '<dt>' + esc(c.titre) + ' <span class="diag-mot">' + esc(motDe(c.niveau)) + '</span></dt>' +
        '<dd>' + esc(c.dit) + (c.faire ? '<br><span class="diag-faire">' + esc(c.faire) + '</span>' : '') + '</dd>' +
        '</div>';
    }).join('') + '</dl>';

    const ch = d.chiffres || {};
    $('diagnosticChiffres').textContent =
      [ch.destinataires + ' destinataires', ch.courriers + ' courriers',
       ch.casiers + ' casiers', 'version ' + ch.version, 'Node ' + ch.node]
        .join(' · ');
  }

  function motDe(niveau) {
    return niveau === 'grave' ? 'à traiter'
      : niveau === 'attention' ? 'à surveiller'
      : niveau === 'inconnu' ? 'non vérifié'
      : 'en ordre';
  }

  /* ═════════════ branchements ═════════════ */

  function init() {
    if (!$('journeeCompte')) return;

    /* Le champ de date part sur aujourd'hui : c'est le cas de très loin le
       plus fréquent, et une date vide afficherait un relevé vide qu'on
       prendrait pour une journée sans mouvement. */
    $('journeeDate').value = journee.jourLocal(new Date());
    $('journeeDate').addEventListener('change', renderJournee);
    $('journeeAujourdhuiBtn').addEventListener('click', function () {
      $('journeeDate').value = journee.jourLocal(new Date());
      renderJournee();
    });
    $('journeeImprimerBtn').addEventListener('click', function () {
      /* Le relevé s'imprime pour être posé sur le comptoir : celui qui ouvre
         demain matin n'allumera pas forcément l'écran avant de commencer. */
      window.print();
    });

    $('diagnosticBtn').addEventListener('click', function () {
      renderDiagnostic(true);
    });
    renderDiagnostic(false);
  }

  ui.inscrire('pilotage', {
    init: init,
    render: renderJournee,
    diagnostic: function () { return renderDiagnostic(true); }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
