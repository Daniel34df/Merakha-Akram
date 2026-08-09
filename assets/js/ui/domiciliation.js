/* Bureau du Courrier — l'écran Domiciliation.

   Deux listes de travail, un formulaire d'élection de domicile et le rapport
   annuel. C'est l'écran qui décide de l'accès aux droits : une attestation
   périmée coupe la CAF, France Travail et la préfecture, souvent sans que
   personne ne s'en aperçoive avant le refus d'un guichet.

   Il ne calcule rien lui-même. Les échéances, les seuils d'absence et le
   rapport viennent de `domiciliation.js`, que le serveur charge aussi : deux
   postes ne peuvent donc pas afficher deux vérités différentes sur une même
   échéance, et la règle se teste sans navigateur.

   Ce qu'il demande aux autres écrans passe par `ui.ecrans`, résolu au moment
   de l'appel : deux liens seulement, la fiche d'un destinataire et le rendu
   général. Ils se retrouvent d'un coup de grep, ce qui n'était pas le cas
   quand tout vivait dans le même fichier de cinq mille lignes. */
(function (root) {
  'use strict';

  const util = root.BC.util;
  const store = root.BC.store;
  const domi = root.BC.domiciliation;
  const ui = root.BC.ui;
  const impression = root.BC.impression;
  const tableau = root.BC.tableau.tableau;

  const S = store.state;
  const $ = ui.$;
  const esc = ui.esc;
  const view = ui.view;
  const toast = ui.toast;
  const stamp = ui.stamp;
  const confirmDialog = ui.confirmDialog;
  const setMsg = ui.setMsg;
  const downloadBytes = ui.downloadBytes;
  const MIME_XLSX = ui.MIME_XLSX;
  const antennes = ui.antennes;
  const ecrans = ui.ecrans;


    /* ═════════════ formulaire de domiciliation ═════════════ */

    /* Ouvrir un dossier d'élection de domicile, et inscrire la personne au
       registre du même geste. Sans ce formulaire, l'accueil saisissait deux fois
       — une fois sur papier, une fois dans l'application — et les notifications
       de courrier ne partaient qu'après la seconde saisie, quand elle avait lieu. */


    function apercuEcheanceDomi() {
      const d = $('domDebut').value;
      $('domEcheance').textContent = d
        ? 'Attestation valable jusqu’au ' + util.formatJour(domi.echeance(d)) + '.'
        : 'L’échéance sera calculée à douze mois.';
    }
    $('domDebut').addEventListener('input', apercuEcheanceDomi);

    function ouvrirFormDomiciliation() {
      const f = $('formDomiciliation');
      f.hidden = false;
      ['domNom', 'domPrenom', 'domNaissance', 'domCourriel', 'domTelephone', 'domBoite', 'domNotes'].forEach(
        function (id) {
          $(id).value = '';
          $(id).classList.remove('invalid');
        }
      );
      $('domLangue').value = 'fr';
      $('domDebut').value = new Date().toISOString().slice(0, 10);
      apercuEcheanceDomi();
      const liste = antennes();
      $('domAntenneBloc').hidden = liste.length === 0;
      if (liste.length) {
        $('domAntenne').innerHTML = liste
          .map(function (a) {
            return '<option value="' + esc(a.id) + '">' + esc(a.nom) + '</option>';
          })
          .join('');
        if (view.antenneActive) $('domAntenne').value = view.antenneActive;
      }
      setMsg('domiMsg', '', '');
      $('domNom').focus();
    }

    $('ouvrirFormDomiBtn').addEventListener('click', ouvrirFormDomiciliation);
    $('annulerDomiBtn').addEventListener('click', function () {
      $('formDomiciliation').hidden = true;
      setMsg('domiMsg', '', '');
    });

    /** Ce que le formulaire produit : un destinataire du registre, domicilié. */
    function lireFormDomiciliation() {
      const nom = $('domNom').value.trim();
      const prenom = $('domPrenom').value.trim();
      const courriel = $('domCourriel').value.trim();
      const debut = $('domDebut').value;

      $('domNom').classList.toggle('invalid', !nom);
      $('domPrenom').classList.toggle('invalid', !prenom);
      $('domDebut').classList.toggle('invalid', !debut);
      $('domCourriel').classList.toggle('invalid', !!courriel && !util.isValidEmail(courriel));

      if (!nom || !prenom) return { erreur: 'Le nom et le prénom sont nécessaires pour ouvrir un dossier.' };
      if (!debut) return { erreur: 'Indiquez la date d’élection de domicile.' };
      if (courriel && !util.isValidEmail(courriel)) return { erreur: 'Cette adresse électronique n’est pas valide.' };
      /* Sans adresse, la personne ne peut pas être notifiée par courriel : le
         registre l'accepte, mais il faut le dire plutôt que de le laisser
         découvrir le jour où un courrier arrive. */
      if (!courriel && !$('domTelephone').value.trim()) {
        return { erreur: 'Donnez au moins un courriel ou un téléphone : sans cela, personne ne pourra la prévenir.' };
      }

      return {
        contact: {
          // « Prénom NOM » : l'ordre sous lequel on cherche quelqu'un au guichet.
          name: prenom + ' ' + nom,
          email: courriel,
          telephone: $('domTelephone').value.trim(),
          naissance: $('domNaissance').value,
          box: $('domBoite').value.trim(),
          langue: $('domLangue').value,
          antenneId: antennes().length ? $('domAntenne').value : '',
          notes: $('domNotes').value.trim(),
          domicilie: true,
          domicilieDepuis: debut
        }
      };
    }

    $('formDomiciliation').addEventListener('submit', async function (e) {
      e.preventDefault();
      const lu = lireFormDomiciliation();
      if (lu.erreur) {
        setMsg('domiMsg', 'error', esc(lu.erreur));
        return;
      }
      const dejaLa = lu.contact.email ? store.findByEmail(lu.contact.email) : null;
      if (dejaLa) {
        setMsg('domiMsg', 'error', 'Cette adresse est déjà au registre sous « ' + esc(dejaLa.name) + ' ».');
        return;
      }

      const btn = $('enregistrerDomiBtn');
      btn.disabled = true;
      try {
        const c = await store.addContact(lu.contact);
        const e2 = domi.etat(c, S.history);
        $('formDomiciliation').hidden = true;
        stamp('Domicilié', c.name);
        setMsg(
          'domiMsg',
          'ok',
          '<strong>' + esc(c.name) + '</strong> est domicilié·e ici et inscrit·e au registre.<br>' +
            'Attestation valable jusqu’au <strong>' + esc(util.formatJour(e2.echeance)) + '</strong>.' +
            (c.box ? ' Boîte ' + esc(c.box) + '.' : '') +
            (c.email
              ? ' Les avis de courrier partiront à ' + esc(c.email) + '.'
              : ' <em>Sans adresse électronique : à prévenir par téléphone.</em>') +
            /* C'est maintenant que la personne est devant le guichet, et c'est
               l'attestation qu'elle est venue chercher. La proposer plus tard,
               c'est la faire revenir. */
            '<br><button class="link-btn" data-attestation="' + esc(c.id) + '">Imprimer son attestation</button>'
        );
        ecrans.app.renderAll();
      } catch (err) {
        setMsg('domiMsg', 'error', esc(err.message));
      } finally {
        btn.disabled = false;
      }
    });

    /* L'impression est dans ui/impression.js : elle ne connaît aucun écran,
       elle reçoit un contact et rend du papier. */

    /* Fiche papier reprenant la saisie, à faire signer et classer. */
    $('imprimerDomiBtn').addEventListener('click', function () {
      const lu = lireFormDomiciliation();
      if (lu.erreur) {
        setMsg('domiMsg', 'error', esc(lu.erreur));
        return;
      }
      impression.imprimerFeuille(impression.ficheDomiciliationHtml(lu.contact));
    });

    /* ═════════════ domiciliation ═════════════ */

    /* Deux listes de travail et un rapport. Tout est calculé par le serveur : le
       même code sert au navigateur et aux tests, et deux postes ne peuvent pas
       afficher deux vérités différentes sur une échéance. */

    const ETAT_DOMI = {
      expiree: ['failed', 'Expirée'],
      bientot: ['manual', 'À renouveler'],
      active: ['', 'Valable'],
      close: ['manual', 'Close'],
      aucune: ['manual', '—']
    };

    async function renderDomiciliation() {
      if (S.mode !== 'serveur' || ui.sessionManquante()) {
        view.domiciliation = null;
        ui.majCompteur($('tabCountDomiciliation'), 0);
        $('renouvelerTable').innerHTML =
          '<div class="empty">Le suivi des domiciliations demande le registre partagé.</div>';
        $('sansPassageTable').innerHTML = '';
        $('activesTable').innerHTML = '';
        $('rapportCorps').innerHTML = '';
        return;
      }
      try {
        view.domiciliation = await store.loadDomiciliation(view.rapportAnnee);
      } catch (err) {
        $('renouvelerTable').innerHTML = '<div class="empty">Suivi indisponible.</div>';
        return;
      }
      const d = view.domiciliation;

      // Le compteur de l'onglet additionne ce qui demande une action.
      ui.majCompteur($('tabCountDomiciliation'), d.aRenouveler.length + d.sansPassage.length);

      renderActives();

      $('countRenouveler').textContent = d.aRenouveler.length;
      $('renouvelerTable').innerHTML = d.aRenouveler.length
        ? tableauDomiciliation(d.aRenouveler, 'echeance')
        : '<div class="empty">Aucune attestation n’arrive à terme. Rien à faire.</div>';

      $('countSansPassage').textContent = d.sansPassage.length;
      $('sansPassageTable').innerHTML = d.sansPassage.length
        ? tableauDomiciliation(d.sansPassage, 'absence')
        : '<div class="empty">Tout le monde est passé récemment.</div>';

      renderRapport(d.rapport);
    }

    /* Le registre des domiciliations en cours. Contrairement aux deux listes
       d'alerte, celle-ci se filtre : passé quelques dizaines de dossiers, on
       cherche un nom, on ne parcourt plus. */
    function activesFiltrees() {
      const d = view.domiciliation;
      const toutes = (d && d.actives) || [];
      const q = util.normalize($('filtreActives').value || '');
      if (!q) return toutes;
      return toutes.filter(function (l) {
        return util.normalize(l.name).includes(q) || util.normalize(l.box).includes(q);
      });
    }

    function renderActives() {
      const d = view.domiciliation;
      const toutes = (d && d.actives) || [];
      const lignes = activesFiltrees();
      $('countActives').textContent = String(toutes.length);
      $('activesTable').innerHTML = toutes.length
        ? lignes.length
          ? tableauDomiciliation(lignes, 'echeance')
          : '<div class="empty">Aucune fiche ne correspond à cette recherche.</div>'
        : '<div class="empty">Aucune domiciliation en cours. Le formulaire ci-dessus en ouvre une.</div>';
    }

    $('filtreActives').addEventListener('input', renderActives);

    $('activesImprimerBtn').addEventListener('click', function () {
      const lignes = activesFiltrees();
      if (!lignes.length) return;
      impression.imprimerFeuille(
        '<h1>Personnes domiciliées</h1>' +
          '<p>' + esc(S.settings.officeName || 'Bureau du Courrier') + ' — ' +
          new Date().toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' }) +
          ' — ' + lignes.length + ' dossier(s)</p>' +
          '<table><thead><tr><th>N° boîte</th><th>Nom</th><th>Échéance</th></tr></thead><tbody>' +
          lignes
            .map(function (l) {
              return (
                '<tr><td>' + esc(l.box || '—') + '</td><td class="b">' + esc(l.name) + '</td><td>' +
                esc(l.etat && l.etat.echeance ? util.formatJour(l.etat.echeance) : '—') + '</td></tr>'
              );
            })
            .join('') +
          '</tbody></table>'
      );
    });

    /* Les étiquettes des casiers. On imprime ce que le filtre laisse voir :
       c'est déjà comme ça que fonctionnent l'export et l'impression de la liste,
       et c'est ce qui permet d'étiqueter une rangée sans refaire tout le local. */
    $('activesEtiquettesBtn').addEventListener('click', function () {
      impression.imprimerEtiquettes(
        activesFiltrees().map(function (l) {
          return { name: l.name, box: l.box };
        })
      );
    });

    $('activesXlsxBtn').addEventListener('click', function () {
      const lignes = activesFiltrees();
      if (!lignes.length) return;
      const bytes = root.BC.xlsx.build({
        sheetName: 'Domiciliations',
        columns: [
          { key: 'box', label: 'N° boîte', width: 12 },
          { key: 'nom', label: 'Nom', width: 30 },
          { key: 'email', label: 'Courriel', width: 30 },
          { key: 'echeance', label: 'Échéance', width: 14 },
          { key: 'etat', label: 'État', width: 16 }
        ],
        rows: lignes.map(function (l) {
          const e = l.etat || {};
          return {
            box: l.box || '',
            nom: l.name,
            email: l.email || '',
            echeance: e.echeance || '',
            etat: (ETAT_DOMI[e.etat] || ETAT_DOMI.aucune)[1]
          };
        })
      });
      downloadBytes('domiciliations.xlsx', bytes, MIME_XLSX);
    });

    function tableauDomiciliation(lignes, colonne) {
      /* Deux listes, deux façons de dire le temps qui passe : l'attestation qui
         expire, ou l'absence qui dure. Le reste des colonnes est le même. */
      const parEcheance = colonne === 'echeance';
      return tableau({
        colonnes: [
          { titre: 'N° boîte', classe: 'box-cell' },
          'Nom',
          parEcheance
            ? { titre: 'Échéance', classe: 'attente-cell' }
            : { titre: 'Dernier passage', classe: 'attente-cell' },
          parEcheance ? 'État' : 'Sans nouvelles',
          { titre: '', classe: 'actions' }
        ],
        lignes: lignes,
        ligne: function (l) {
          const e = l.etat;
          const pill = ETAT_DOMI[e.etat] || ETAT_DOMI.aucune;
          const deuxTiers = parEcheance
            ? [
                e.echeance ? esc(util.formatJour(e.echeance)) : '—',
                '<span class="status-pill ' + pill[0] + '">' + pill[1] + '</span>'
              ]
            : [
                (e.dernierPassage ? esc(util.formatJour(e.dernierPassage.slice(0, 10))) : '—') +
                  (domi.libelleMoyen(e.dernierMoyen)
                    ? '<span class="absence-tag">' + esc(domi.libelleMoyen(e.dernierMoyen)) + '</span>'
                    : ''),
                {
                  html: (e.joursSansPassage === null ? '—' : e.joursSansPassage + ' j') +
                    (e.absenceDepassee ? ' — seuil dépassé' : ''),
                  classe: 'attente-cell' + (e.absenceDepassee ? ' vieux' : '')
                }
              ];
          return [
            esc(l.box || '—'),
            esc(l.name),
            deuxTiers[0],
            deuxTiers[1],
            '<button class="link-btn" data-domifiche="' + esc(l.id) + '">Fiche</button>' +
              '<button class="link-btn" data-attestation="' + esc(l.id) + '">Attestation</button>' +
              '<button class="link-btn" data-renouveler="' + esc(l.id) + '">Renouveler</button>' +
              /* Prévenir la personne, pas seulement le signaler à l'équipe. Le
                 sujet suit la liste : échéance d'attestation ou absence. */
              '<button class="link-btn" data-avis="' + esc(l.id) + '" data-sujet="' +
              (parEcheance ? 'renouvellement' : 'absence') + '">Prévenir</button>' +
              '<button class="link-btn" data-passage="' + esc(l.id) + '">Noter un passage</button>' +
              '<button class="link-btn danger" data-clore="' + esc(l.id) + '">Clore</button>'
          ];
        }
      });
    }

    function renderRapport(r) {
      const select = $('rapportAnnee');
      if (!select.options.length) {
        const courante = new Date().getFullYear();
        let html = '';
        for (let a = courante; a >= courante - 6; a--) {
          html += '<option value="' + a + '"' + (a === view.rapportAnnee ? ' selected' : '') + '>' + a + '</option>';
        }
        select.innerHTML = html;
      }

      const motifs = Object.keys(r.motifs || {});
      $('rapportCorps').innerHTML =
        '<dl class="status-list">' +
        [
          ['Domiciliations actives', String(r.actives)],
          ['Ouvertes dans l’année', String(r.ouvertesDansLAnnee)],
          ['Closes dans l’année', String(r.closesDansLAnnee)],
          ['Courriers reçus pour des personnes domiciliées', String(r.courriersRecus)],
          ['Dont retirés', String(r.courriersRetires)]
        ]
          .map(function (l) {
            return '<div><dt>' + esc(l[0]) + '</dt><dd>' + esc(l[1]) + '</dd></div>';
          })
          .join('') +
        '</dl>' +
        (motifs.length
          ? '<h3 class="sous-titre">Motifs de clôture</h3><dl class="status-list">' +
            motifs
              .map(function (m) {
                return '<div><dt>' + esc(m) + '</dt><dd>' + r.motifs[m] + '</dd></div>';
              })
              .join('') +
            '</dl>'
          : '');
    }

    /* Un seul écouteur pour tout le panneau, posé une fois. Rebrancher bouton par
       bouton après chaque rendu doublait les liaisons dès qu'une des trois listes
       se redessinait seule — et un clic ouvrait alors deux fois la même fiche. */
    $('panel-domiciliation').addEventListener('click', function (e) {
      const fiche = e.target.closest('button[data-domifiche]');
      if (fiche) return ecrans.registre.ouvrirFiche(fiche.dataset.domifiche);
      const attestation = e.target.closest('button[data-attestation]');
      if (attestation) return impression.imprimerAttestation(attestation.dataset.attestation);
      const passage = e.target.closest('button[data-passage]');
      if (passage) return noterPassage(passage.dataset.passage, passage);
      const avis = e.target.closest('button[data-avis]');
      if (avis) return prevenirDomicilie(avis.dataset.avis, avis.dataset.sujet, avis);
      const renouveler = e.target.closest('button[data-renouveler]');
      if (renouveler) return renouvelerDomiciliation(renouveler.dataset.renouveler, renouveler);
      const clore = e.target.closest('button[data-clore]');
      if (clore) return clturerDomiciliation(clore.dataset.clore);
    });

    /* Renouveler : l'échéance repart d'aujourd'hui, la date d'élection d'origine
       ne bouge pas — c'est elle qui dit depuis quand la personne est domiciliée,
       et cette ancienneté compte pour ses droits. */
    async function renouvelerDomiciliation(id, bouton) {
      const c = S.contacts.find(function (x) {
        return x.id === id;
      });
      if (!c) return;
      if (bouton) bouton.disabled = true;
      try {
        const r = await store.actionDomiciliation(id, 'renouveler');
        const jusqua = (r && r.contact && r.contact.domicilieJusqua) || '';
        toast(
          'Attestation de ' + c.name + ' renouvelée' +
            (jusqua ? ' jusqu’au ' + util.formatJour(jusqua) : '') + '.',
          'ok'
        );
        await renderDomiciliation();
        /* La personne est venue chercher son attestation : on la propose tout de
           suite plutôt que de la faire revenir. */
        const encore = await confirmDialog(
          'Imprimer l’attestation ?',
          'L’attestation de ' + c.name + ' est renouvelée' +
            (jusqua ? ' jusqu’au ' + util.formatJour(jusqua) : '') +
            '. Voulez-vous l’imprimer maintenant ?',
          'Imprimer'
        );
        if (encore) impression.imprimerAttestation(id);
      } catch (err) {
        toast('Renouvellement impossible : ' + err.message, 'error');
        if (bouton) bouton.disabled = false;
      }
    }

    /* Prévenir quelqu'un au sujet de sa domiciliation.

       L'écran signalait les échéances à l'équipe ; l'intéressée, elle, ne savait
       rien et l'apprenait au refus d'un guichet. Avec une adresse, le message
       part ; sans adresse — le cas le plus fréquent ici — l'avis est noté et se
       dira au téléphone. Rien de tout cela n'entre au registre du courrier. */
    async function prevenirDomicilie(id, sujet, bouton) {
      const c = S.contacts.find(function (x) {
        return x.id === id;
      });
      if (!c) return;
      if (bouton) bouton.disabled = true;
      try {
        const r = await store.envoyerAvis(id, sujet);
        if (r.canal === 'courriel') {
          toast('Message envoyé à ' + c.name + '.', 'ok');
        } else {
          toast(
            c.name + ' n’a pas de courriel : avis noté, à lui dire de vive voix' +
              (c.telephone ? ' au ' + c.telephone : '') + '.',
            'ok'
          );
        }
        await renderDomiciliation();
      } catch (err) {
        toast('Impossible de prévenir : ' + err.message, 'error');
      } finally {
        if (bouton) bouton.disabled = false;
      }
    }

    /* Clore : le motif est choisi, pas deviné — c'est lui que le rapport annuel
       ventile, et c'est lui qui justifie la fin d'une adresse administrative. */
    async function clturerDomiciliation(id) {
      const c = S.contacts.find(function (x) {
        return x.id === id;
      });
      if (!c) return;
      const dlg = $('clotureDialog');
      $('clotureQui').textContent = c.name + (c.box ? ' — boîte ' + c.box : '');
      $('clotureNote').value = '';
      if (typeof dlg.showModal !== 'function') {
        toast('Ce navigateur ne sait pas ouvrir la fenêtre de clôture.', 'error');
        return;
      }
      const choix = await new Promise(function (resolve) {
        dlg.addEventListener(
          'close',
          function () {
            resolve(dlg.returnValue === 'ok');
          },
          { once: true }
        );
        dlg.showModal();
      });
      if (!choix) return;

      try {
        await store.actionDomiciliation(id, 'clore', {
          motif: $('clotureMotif').value,
          note: $('clotureNote').value.trim()
        });
        toast('Domiciliation de ' + c.name + ' close.', 'ok');
        await renderDomiciliation();
      } catch (err) {
        toast('Clôture impossible : ' + err.message, 'error');
      }
    }


    /* Noter un passage sans courrier : c'est ce qui empêche de croire disparue
       une personne qui est bel et bien venue. */
    async function noterPassage(id, bouton) {
      if (bouton) bouton.disabled = true;
      try {
        await store.enregistrerPassage(id, '');
        const c = S.contacts.find(function (x) {
          return x.id === id;
        });
        toast('Passage noté pour ' + ((c && c.name) || 'ce destinataire') + '.', 'ok');
        await renderDomiciliation();
      } catch (err) {
        toast('Enregistrement impossible : ' + err.message, 'error');
        if (bouton) bouton.disabled = false;
      }
    }

    $('rapportAnnee').addEventListener('change', function (e) {
      view.rapportAnnee = Number(e.target.value);
      renderDomiciliation();
    });

    $('rapportXlsxBtn').addEventListener('click', function () {
      const d = view.domiciliation;
      if (!d) return;
      const r = d.rapport;
      const lignes = [
        { poste: 'Domiciliations actives', valeur: r.actives },
        { poste: 'Ouvertes dans l’année', valeur: r.ouvertesDansLAnnee },
        { poste: 'Closes dans l’année', valeur: r.closesDansLAnnee },
        { poste: 'Courriers reçus', valeur: r.courriersRecus },
        { poste: 'Courriers retirés', valeur: r.courriersRetires }
      ].concat(
        Object.keys(r.motifs || {}).map(function (m) {
          return { poste: 'Clôture — ' + m, valeur: r.motifs[m] };
        })
      );
      const bytes = root.BC.xlsx.build({
        sheetName: 'Domiciliation ' + r.annee,
        columns: [
          { key: 'poste', label: 'Poste', width: 46 },
          { key: 'valeur', label: 'Nombre', width: 12 }
        ],
        rows: lignes
      });
      downloadBytes('domiciliation-' + r.annee + '.xlsx', bytes, MIME_XLSX);
    });

    $('rapportImprimerBtn').addEventListener('click', function () {
      const d = view.domiciliation;
      if (!d) return;
      impression.imprimerRapport(d.rapport);
    });


  /* Le remplissage du sélecteur de langues appartient au registre : il ne peut
     donc pas se faire au chargement, l'ordre des balises <script> ne le
     garantissant pas. `init()` est appelé par app.js une fois tout le monde
     inscrit. */
  function init() {
    ecrans.registre.remplirLangues($('domLangue'), 'fr');
  }

  ui.inscrire('domiciliation', {
    init: init,
    render: renderDomiciliation
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
