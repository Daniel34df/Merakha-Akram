/* Bureau du Courrier — ce qui part sur papier.

   Quatre documents, un seul mécanisme : la feuille cachée « feuilleCasier »
   reçoit le contenu, la page bascule en mode impression, on imprime, on
   rétablit tout. Ce module existe surtout pour l'attestation d'élection de
   domicile — le document que la personne emporte au guichet de la CAF, de
   France Travail ou de la préfecture. Un papier qui sort d'ici finit entre les
   mains de quelqu'un dont l'accès aux droits en dépend ; il mérite un fichier
   qu'on puisse ouvrir seul.

   Rien ici ne connaît les écrans : ce module reçoit un contact ou un rapport
   et rend du papier. C'est ce qui en fait la seule partie de l'interface
   réellement détachable — une seule référence sortante, contre une vingtaine
   pour les réglages ou le registre. */
(function (root, factory) {
  const enNode = typeof module === 'object' && module.exports;
  const api = factory(
    enNode ? require('../util.js') : root.BC.util,
    enNode ? require('../store.js') : root.BC.store,
    enNode ? require('../domiciliation.js') : root.BC.domiciliation,
    enNode ? require('./noyau.js') : root.BC.ui,
    root
  );
  if (enNode) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.impression = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util, store, domi, ui, root) {
  'use strict';

  const S = store.state;
  const $ = ui.$;
  const esc = ui.esc;

  /* Effacer l'application, imprimer la feuille, tout remettre en place. Le
     même geste pour la feuille de casier, la fiche d'élection de domicile,
     l'attestation et le rapport annuel.

     Les trois autres fonctions passent toutes par ici. Elles recopiaient
     chacune ces cinq lignes ; une seule copie suffit, et la feuille de style
     d'impression n'a qu'un seul interlocuteur. */
  function imprimerFeuille(html) {
    $('feuilleCasier').innerHTML = html;
    $('feuilleCasier').hidden = false;
    document.body.classList.add('impression-casier');
    root.print();
    // Le retour d'impression n'est pas fiable partout : on rétablit tout de suite.
    setTimeout(function () {
      document.body.classList.remove('impression-casier');
      $('feuilleCasier').hidden = true;
    }, 500);
  }

  const leJour = function () {
    return new Date().toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  const leBureau = function () {
    return S.settings.officeName || 'Bureau du Courrier';
  };

  /* ── la fiche d'élection de domicile ──

     Reprise papier de la saisie : de quoi la faire signer et la classer, sans
     imiter le formulaire officiel — celui-ci se remplit à part. */
  function ficheDomiciliationHtml(c) {
    const lignes = [
      ['Nom et prénom', c.name],
      ['Date de naissance', c.naissance ? util.formatJour(c.naissance) : '—'],
      ['Courriel', c.email || '—'],
      ['Téléphone', c.telephone || '—'],
      ['Langue de correspondance', util.langue(c.langue).label],
      ['Date d’élection de domicile', util.formatJour(c.domicilieDepuis)],
      ['Échéance de l’attestation', util.formatJour(domi.echeance(c.domicilieDepuis))],
      ['Numéro de boîte', c.box || '—'],
      ['Observations', c.notes || '—']
    ];
    return (
      '<h1>Élection de domicile</h1>' +
      '<p>' + esc(leBureau()) + ' — ' + leJour() + '</p>' +
      '<table><tbody>' +
      lignes
        .map(function (l) {
          return '<tr><td>' + esc(l[0]) + '</td><td class="b">' + esc(l[1]) + '</td></tr>';
        })
        .join('') +
      '</tbody></table>' +
      '<p style="margin-top:36px;">Signature de la personne domiciliée :</p>' +
      '<p style="margin-top:48px;">Signature de l’organisme :</p>'
    );
  }

  /* ── l'attestation d'élection de domicile ──

     C'est le document que la personne présente au guichet de la CAF, de France
     Travail ou de la préfecture. Il n'imite aucun formulaire officiel : c'est
     l'attestation de l'organisme, sous son propre en-tête et son agrément.

     Une seule règle de fond, et elle compte : **on n'atteste pas une
     domiciliation close ni une attestation périmée.** Imprimer un papier qui
     dit le contraire du registre reviendrait à envoyer quelqu'un se faire
     refuser à un guichet, avec un document de notre main à l'appui. */
  function adresseDomiciliation(contact) {
    const liste = ui.antennes();
    const a =
      contact && contact.antenneId
        ? liste.find(function (x) {
            return x.id === contact.antenneId;
          })
        : null;
    return (a && a.adresse) || S.settings.officeAdresse || '';
  }

  function trait(valeur, largeur) {
    return valeur
      ? '<span class="attest-valeur">' + esc(valeur) + '</span>'
      : '<span class="attest-trait" style="min-width:' + (largeur || 180) + 'px;"></span>';
  }

  function attestationHtml(contact) {
    const e = domi.etat(contact, S.history);
    const bureau = leBureau();
    const adresse = adresseDomiciliation(contact);
    const ville = S.settings.officeVille || '';

    return (
      '<div class="attestation">' +
      '<div class="attest-entete">' +
      '<div class="attest-organisme">' + esc(bureau) + '</div>' +
      (adresse ? '<div>' + esc(adresse) + '</div>' : '') +
      (S.settings.officeAgrement ? '<div>' + esc(S.settings.officeAgrement) + '</div>' : '') +
      '</div>' +
      '<h1>Attestation d’élection de domicile</h1>' +
      '<p class="attest-corps">Je soussigné·e, représentant l’organisme désigné ci-dessus, atteste que :</p>' +
      '<p class="attest-corps attest-identite">' +
      trait(contact.name, 240) +
      (contact.naissance ? ', né·e le ' + esc(util.formatJour(contact.naissance)) : ', né·e le ' + trait('', 140)) +
      '</p>' +
      '<p class="attest-corps">a élu domicile auprès de notre organisme depuis le ' +
      trait(contact.domicilieDepuis ? util.formatJour(contact.domicilieDepuis) : '', 150) +
      '.</p>' +
      '<p class="attest-corps">L’adresse à laquelle son courrier peut lui être adressé est :</p>' +
      '<p class="attest-corps attest-adresse">' +
      esc(bureau) + (adresse ? '<br>' + esc(adresse) : '<br>' + trait('', 320)) +
      (contact.box ? '<br>Boîte ' + esc(contact.box) : '') +
      '</p>' +
      '<p class="attest-corps">La présente attestation est valable jusqu’au ' +
      trait(e.echeance ? util.formatJour(e.echeance) : '', 150) +
      '.</p>' +
      '<p class="attest-corps attest-fait">Fait à ' + trait(ville, 140) + ', le ' + esc(leJour()) + '.</p>' +
      '<div class="attest-signature"><p>Signature et cachet de l’organisme</p></div>' +
      '</div>'
    );
  }

  /** Rend un refus motivé, ou null si l'attestation peut s'imprimer. */
  function refusAttestation(c) {
    if (!c.domicilie) return 'Cette personne n’est pas domiciliée ici : il n’y a rien à attester.';
    if (c.domiciliationCloseLe) {
      return 'Domiciliation close le ' + util.formatJour(c.domiciliationCloseLe) + ' — pas d’attestation.';
    }
    const e = domi.etat(c, S.history);
    if (e.etat === 'expiree') {
      return (
        'Attestation échue depuis le ' +
        util.formatJour(e.echeance) +
        ' : renouvelez l’élection de domicile avant d’imprimer.'
      );
    }
    return null;
  }

  function imprimerAttestation(contactId) {
    const c = S.contacts.find(function (x) {
      return x.id === contactId;
    });
    if (!c) return;
    const refus = refusAttestation(c);
    if (refus) {
      ui.toast(refus, 'error');
      return;
    }
    imprimerFeuille(attestationHtml(c));
  }

  /* ── la feuille de casier ──

     La liste des courriers en attente, triée par numéro de boîte : c'est
     l'ordre dans lequel on parcourt le local. */
  function imprimerFeuilleCasier() {
    const attente = S.history.filter(ui.enAttente);
    if (attente.length === 0) {
      ui.toast('Aucun courrier en attente.', 'error');
      return;
    }
    const lignes = attente
      .map(function (h) {
        const contact = S.contacts.find(function (c) {
          return c.id === h.contactId;
        });
        return {
          boite: (contact && contact.box) || '',
          nom: h.name,
          jours: ui.joursDepuis(h.date),
          type: util.typeCourrier(h.type).label,
          code: h.pickupCode || ''
        };
      })
      .sort(function (a, b) {
        return util.normalizeBox(a.boite).localeCompare(util.normalizeBox(b.boite), 'fr', { numeric: true });
      });

    imprimerFeuille(
      '<h1>Courriers en attente</h1>' +
        '<p>' + leBureau() + ' — ' + leJour() + ' — ' + lignes.length + ' courrier(s)</p>' +
        '<table><thead><tr><th>Boîte</th><th>Nom</th><th>Type</th><th>Attente</th>' +
        '<th>Code</th><th>Retiré</th></tr></thead><tbody>' +
        lignes
          .map(function (l) {
            return (
              '<tr><td class="b">' +
              esc(l.boite || '—') +
              '</td><td>' +
              esc(l.nom) +
              '</td><td>' +
              esc(l.type) +
              '</td><td>' +
              l.jours +
              ' j</td><td class="b">' +
              esc(l.code) +
              '</td><td class="case"></td></tr>'
            );
          })
          .join('') +
        '</tbody></table>'
    );
  }

  /* ── le rapport annuel ──

     Celui que la préfecture demande à un organisme agréé. Les chiffres sortent
     du registre ; l'appréciation des situations reste à l'équipe. */
  function imprimerRapport(r) {
    const motifs = Object.keys(r.motifs || {});
    imprimerFeuille(
      '<h1>Domiciliation — rapport ' + r.annee + '</h1>' +
        '<p>' +
        esc(leBureau()) +
        ' — période du ' +
        esc(util.formatJour(r.debut)) +
        ' au ' +
        esc(util.formatJour(r.fin)) +
        '</p>' +
        '<table><thead><tr><th>Poste</th><th>Nombre</th></tr></thead><tbody>' +
        [
          ['Domiciliations actives au terme de la période', r.actives],
          ['Élections de domicile ouvertes dans l’année', r.ouvertesDansLAnnee],
          ['Domiciliations closes dans l’année', r.closesDansLAnnee],
          ['Courriers reçus pour des personnes domiciliées', r.courriersRecus],
          ['Dont retirés', r.courriersRetires]
        ]
          .concat(
            motifs.map(function (m) {
              return ['Clôture — ' + m, r.motifs[m]];
            })
          )
          .map(function (l) {
            return '<tr><td>' + esc(l[0]) + '</td><td class="b">' + l[1] + '</td></tr>';
          })
          .join('') +
        '</tbody></table>' +
        '<p style="margin-top:24px;">Établi le ' +
        leJour() +
        '. Chiffres extraits du registre ; l’appréciation des situations reste à l’équipe.</p>'
    );
  }

  return {
    imprimerFeuille: imprimerFeuille,
    ficheDomiciliationHtml: ficheDomiciliationHtml,
    adresseDomiciliation: adresseDomiciliation,
    trait: trait,
    attestationHtml: attestationHtml,
    refusAttestation: refusAttestation,
    imprimerAttestation: imprimerAttestation,
    imprimerFeuilleCasier: imprimerFeuilleCasier,
    imprimerRapport: imprimerRapport
  };
});
