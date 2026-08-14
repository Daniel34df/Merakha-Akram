/* Bureau du Courrier — l'écran des casiers.

   Le plan du local, tel qu'on le parcourt : une case par porte, dans l'ordre
   des numéros, groupée par zone. Cliquer une case ouvre sa fiche — titulaire,
   historique, et les gestes.

   Deux règles portées par cet écran plutôt que par la feuille de style, parce
   qu'elles se perdraient là-bas :

     · **la couleur ne porte jamais seule l'information** (§33, §54). Chaque
       case écrit son état en toutes lettres à côté de sa couleur. Un casier
       hors service pris pour un casier libre, c'est un courrier rangé derrière
       une serrure cassée ;

     · **rien n'est attribué sans un geste.** Le champ « N° de boîte » du
       formulaire d'inscription propose la première boîte libre et le dit ;
       l'agent la garde ou en saisit une autre. Une fiche créée par erreur ne
       doit pas immobiliser un casier.

   Comme les autres modules d'écran : il s'inscrit auprès du socle et appelle
   ses voisins **au moment de l'appel**, jamais au chargement. */
(function (root) {
  'use strict';

  const BC = root.BC;
  const ui = BC.ui;
  const store = BC.store;
  const util = BC.util;
  const boites = BC.boites;
  const roles = BC.roles;
  const S = store.state;
  const $ = ui.$;
  const esc = ui.esc;
  const view = ui.view;
  const ecrans = ui.ecrans;
  const tableau = BC.tableau.tableau;
  const toast = ui.toast;

  /* Ce que l'écran retient pour lui : le filtre, et la boîte ouverte. */
  const local = { filtre: '', ouverte: null };

  function plan() {
    return S.boites || [];
  }

  /* Les périodes d'un casier portent un horodatage complet — l'heure compte
     quand deux attributions se suivent dans la même journée. `util.formatJour`
     attend une date nue : on la lui donne, plutôt que d'élargir son contrat
     pour un seul appelant. */
  function jour(iso) {
    return iso ? util.formatJour(String(iso).slice(0, 10)) : '—';
  }

  function peut() {
    return !S.auth.user || roles.peut(S.auth.user, 'casiers');
  }

  function filtrees() {
    const q = util.normalize(local.filtre);
    if (!q) return plan();
    return plan().filter(function (b) {
      const t = boites.titulaireCourant(b);
      return (
        util.normalizeBox(b.numero).includes(util.normalizeBox(local.filtre)) ||
        util.normalize(b.numero).includes(q) ||
        util.normalize(b.zone).includes(q) ||
        (t && util.normalize(t.nom).includes(q))
      );
    });
  }

  /* ── le plan ── */

  function caseHtml(b, comptes) {
    const t = boites.titulaireCourant(b);
    const e = boites.etat(b, comptes[b.id] || 0);
    return (
      '<button type="button" class="casier casier-' + esc(b.statut) + '" data-casier="' + esc(b.id) + '"' +
      ' aria-label="' + esc(b.numero + ' — ' + e.label + (t ? ', ' + t.nom : '')) + '">' +
      '<span class="casier-num">' + esc(b.numero) + '</span>' +
      '<span class="casier-nom">' + esc(t ? t.nom : '—') + '</span>' +
      /* Le mot, à côté de la couleur. C'est lui qui rend la case lisible sans
         distinguer le vert du rouge. */
      '<span class="casier-mot">' + esc(e.mot) + '</span>' +
      (e.courriers
        ? '<span class="casier-jauge' + (e.seuil === 'ok' ? '' : ' ' + e.seuil) + '">' +
          '<i style="width:' + Math.min(100, e.taux) + '%"></i>' +
          '</span><span class="casier-compte">' + e.courriers + '/' + e.capacite + '</span>'
        : '') +
      '</button>'
    );
  }

  function renderPlan() {
    const boite = $('casierPlan');
    if (!boite) return;
    const liste = filtrees();
    const comptes = boites.comptesEnAttente(plan(), S.history);

    $('countCasiers').textContent = String(plan().length);

    const libres = plan().filter(boites.estLibre).length;
    const occupees = plan().filter(function (b) { return !!boites.titulaireCourant(b); }).length;
    const pleines = plan().filter(function (b) {
      return boites.etat(b, comptes[b.id] || 0).seuil !== 'ok';
    }).length;
    $('casierResume').textContent = plan().length
      ? libres + ' libre(s) · ' + occupees + ' occupée(s) · ' + pleines + ' presque pleine(s) ou pleine(s)'
      : 'Aucun casier au plan. « Créer une série » équipe le local d’un coup.';

    /* Les numéros portés par deux fiches, relevés à la migration. On les montre
       plutôt que de trancher à la place de l'équipe : c'est soit un casier
       repris sans mise à jour, soit un couple qui le partage. */
    const conflits = S.conflitsBoites || [];
    $('casierConflits').innerHTML = conflits.length
      ? '<div class="msg error" style="margin-bottom:12px;"><strong>' +
        conflits.length + ' casier(s) portés par plusieurs fiches.</strong> ' +
        'Le plus récemment inscrit est titulaire ; les autres fiches gardent le numéro sans occuper la boîte.<ul>' +
        conflits.map(function (c) {
          return '<li>' + esc(c.numero) + ' — titulaire ' + esc(c.titulaire) + ', aussi sur ' +
            c.autres.map(function (a) { return esc(a.nom); }).join(', ') + '</li>';
        }).join('') +
        '</ul></div>'
      : '';

    if (!liste.length) {
      boite.innerHTML = '<div class="empty">' +
        (plan().length ? 'Aucun casier ne correspond à ce filtre.' : 'Le plan du local est vide.') +
        '</div>';
      renderListe(liste, comptes);
      return;
    }

    boite.innerHTML = boites.plan(liste).map(function (z) {
      return (
        (z.zone ? '<h3 class="casier-zone">' + esc(z.zone) + '</h3>' : '') +
        '<div class="casier-grille">' + z.boites.map(function (b) {
          return caseHtml(b, comptes);
        }).join('') + '</div>'
      );
    }).join('');

    renderListe(liste, comptes);
  }

  function renderListe(liste, comptes) {
    const cible = $('casierTable');
    if (!cible) return;
    cible.innerHTML = tableau({
      colonnes: [
        { titre: 'N°', classe: 'box-cell' },
        'Zone', 'État', 'Titulaire',
        { titre: 'Courrier', classe: 'attente-cell' },
        'Depuis',
        { titre: '', classe: 'actions' }
      ],
      lignes: boites.trier(liste),
      vide: 'Aucun casier.',
      ligne: function (b) {
        const t = boites.titulaireCourant(b);
        const e = boites.etat(b, comptes[b.id] || 0);
        return [
          esc(b.numero),
          b.zone ? esc(b.zone) : '<span class="hint">—</span>',
          '<span class="etat-' + esc(b.statut) + '">' + esc(e.label) + '</span>' +
            (b.motif ? ' <span class="hint">' + esc(b.motif) + '</span>' : ''),
          t ? esc(t.nom) : '<span class="hint">—</span>',
          e.courriers ? e.courriers + '/' + e.capacite : '<span class="hint">—</span>',
          t && t.depuis ? esc(jour(t.depuis)) : '<span class="hint">—</span>',
          '<button class="link-btn" data-casier="' + esc(b.id) + '">Ouvrir</button>'
        ];
      }
    });
  }

  /* ── la fiche d'un casier ── */

  function ficheHtml(b) {
    const comptes = boites.comptesEnAttente([b], S.history);
    const e = boites.etat(b, comptes[b.id] || 0);
    const t = boites.titulaireCourant(b);
    const periodes = (b.periodes || []).slice().reverse();

    return (
      '<h3>Casier ' + esc(b.numero) + '</h3>' +
      '<dl class="status-list">' +
      '<div><dt>État</dt><dd>' + esc(e.label) + '</dd></div>' +
      (b.zone ? '<div><dt>Zone</dt><dd>' + esc(b.zone) + '</dd></div>' : '') +
      (b.motif ? '<div><dt>Motif</dt><dd>' + esc(b.motif) + '</dd></div>' : '') +
      '<div><dt>Titulaire</dt><dd>' + esc(t ? t.nom : '—') + '</dd></div>' +
      '<div><dt>Courrier en attente</dt><dd>' + e.courriers + ' / ' + e.capacite + '</dd></div>' +
      '</dl>' +

      (periodes.length
        ? '<h4>Les titulaires successifs</h4>' +
          tableau({
            colonnes: ['Nom', 'Depuis', 'Jusqu’à', 'Motif'],
            lignes: periodes,
            defilement: false,
            ligne: function (p) {
              return [
                esc(p.nom || '—'),
                esc(jour(p.depuis)),
                p.jusqua ? esc(jour(p.jusqua)) : '<strong>en cours</strong>',
                esc(p.motif || '')
              ];
            }
          })
        : '<p class="hint">Ce casier n’a jamais été attribué.</p>') +

      (peut()
        ? '<div class="row-actions" style="margin-top:14px;">' +
          (t
            ? '<button class="btn ghost" data-liberer="' + esc(b.id) + '">Libérer</button>' +
              '<button class="link-btn" data-voir-fiche="' + esc(t.contactId || '') + '">Voir la fiche</button>'
            : '<button class="btn" data-attribuer="' + esc(b.id) + '">Attribuer</button>') +
          '<button class="link-btn" data-statut="' + esc(b.id) + '">Changer l’état</button>' +
          '</div><div id="casierFicheMsg"></div>'
        : '')
    );
  }

  function ouvrir(id) {
    const b = plan().find(function (x) { return x.id === id; });
    if (!b) return;
    local.ouverte = id;
    const dlg = $('casierDialog');
    $('casierDialogCorps').innerHTML = ficheHtml(b);
    if (typeof dlg.showModal === 'function') dlg.showModal();
  }

  async function rafraichir() {
    await store.loadServerState().catch(function () {});
    renderPlan();
    if (local.ouverte) {
      const b = plan().find(function (x) { return x.id === local.ouverte; });
      if (b) $('casierDialogCorps').innerHTML = ficheHtml(b);
    }
  }

  /* ── les gestes ── */

  async function attribuer(id) {
    const noms = util.sortByName(
      S.contacts.filter(function (c) { return !String(c.box || '').trim(); })
    );
    if (!noms.length) {
      toast('Tout le monde a déjà un casier.', 'error');
      return;
    }
    const choix = root.prompt(
      'Attribuer ce casier à qui ?\n\n' +
        noms.slice(0, 30).map(function (c, i) { return (i + 1) + '. ' + c.name; }).join('\n'),
      '1'
    );
    const i = parseInt(choix, 10);
    if (!i || i < 1 || i > noms.length) return;
    try {
      await store.attribuerBoite(id, noms[i - 1].id);
      toast('Casier attribué à ' + noms[i - 1].name + '.', 'ok');
      await rafraichir();
      ecrans.app.renderAll();
    } catch (e) {
      ui.setMsg('casierFicheMsg', 'error', esc(e.message));
    }
  }

  async function liberer(id) {
    const b = plan().find(function (x) { return x.id === id; });
    const t = b && boites.titulaireCourant(b);
    const ok = await ui.confirmDialog(
      'Libérer le casier ' + (b ? b.numero : ''),
      (t ? t.nom + ' n’en sera plus titulaire. ' : '') +
        'Son passage reste inscrit à l’historique du casier — c’est ce qui permet de savoir ' +
        'à qui il était si un courrier arrive plus tard.',
      'Libérer'
    );
    if (!ok) return;
    const motif = root.prompt('Motif (facultatif) : relogée, partie, changement de boîte…', '') || '';
    try {
      await store.libererBoite(id, motif);
      toast('Casier libéré.', 'ok');
      await rafraichir();
      ecrans.app.renderAll();
    } catch (e) {
      ui.setMsg('casierFicheMsg', 'error', esc(e.message));
    }
  }

  async function changerStatut(id) {
    const b = plan().find(function (x) { return x.id === id; });
    if (!b) return;
    const choix = root.prompt(
      'Nouvel état du casier ' + b.numero + ' :\n\n' +
        boites.STATUTS.map(function (s, i) { return (i + 1) + '. ' + s.label; }).join('\n'),
      '1'
    );
    const i = parseInt(choix, 10);
    if (!i || i < 1 || i > boites.STATUTS.length) return;
    const statut = boites.STATUTS[i - 1].id;
    const motif = statut === 'libre' || statut === 'occupee'
      ? ''
      : root.prompt('Motif (serrure cassée, réservée pour…) :', b.motif || '') || '';
    try {
      await store.majBoite(id, { statut: statut, motif: motif });
      await rafraichir();
    } catch (e) {
      ui.setMsg('casierFicheMsg', 'error', esc(e.message));
    }
  }

  /* ── le formulaire d'inscription : proposer, jamais imposer ── */

  function proposerBoite() {
    const champ = $('newBox');
    const aide = $('newBoxAide');
    if (!champ || !aide) return;
    // On ne touche jamais à ce que quelqu'un a commencé à écrire.
    if (champ.value.trim()) { aide.textContent = ''; return; }
    const libre = boites.premiereLibre(plan());
    if (!libre) { aide.textContent = ''; return; }
    aide.textContent = libre.numero + ' est libre.';
    aide.dataset.propose = libre.numero;
  }

  /* ── mise en place ── */

  function init() {
    const plan_ = $('casierPlan');
    if (!plan_) return;

    /* Un seul écouteur pour tout le plan et toute la liste : les cases sont
       redessinées à chaque écriture d'un autre poste, et rebrancher trois cents
       écouteurs à chaque fois coûterait plus que tout le rendu. */
    ['casierPlan', 'casierTable'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        const b = e.target.closest('[data-casier]');
        if (b) ouvrir(b.dataset.casier);
      });
    });

    $('casierDialogCorps').addEventListener('click', function (e) {
      const att = e.target.closest('[data-attribuer]');
      if (att) return attribuer(att.dataset.attribuer);
      const lib = e.target.closest('[data-liberer]');
      if (lib) return liberer(lib.dataset.liberer);
      const st = e.target.closest('[data-statut]');
      if (st) return changerStatut(st.dataset.statut);
      const fiche = e.target.closest('[data-voir-fiche]');
      if (fiche && fiche.dataset.voirFiche) {
        $('casierDialog').close();
        ecrans.registre.ouvrirFiche(fiche.dataset.voirFiche);
      }
    });

    $('casierFiltre').addEventListener('input', function (e) {
      local.filtre = e.target.value;
      renderPlan();
    });

    $('casierAjouterBtn').addEventListener('click', async function () {
      const numero = root.prompt(
        'Numéro du casier — laissez vide pour que le serveur attribue le suivant :', ''
      );
      if (numero === null) return;
      try {
        const b = await store.creerBoite({ numero: numero.trim() });
        toast('Casier ' + b.numero + ' ajouté.', 'ok');
        await rafraichir();
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    $('casierSerieBtn').addEventListener('click', async function () {
      const debut = parseInt(root.prompt('Du numéro :', '1'), 10);
      if (!debut && debut !== 0) return;
      const fin = parseInt(root.prompt('Au numéro :', String(debut + 19)), 10);
      if (!fin && fin !== 0) return;
      const zone = root.prompt('Zone (facultatif) : couloir, étage…', '') || '';
      try {
        const r = await store.creerSerieBoites({ debut: debut, fin: fin, zone: zone });
        toast(r.creees + ' casier(s) ajouté(s).', 'ok');
        await rafraichir();
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    /* La proposition au guichet : elle se recalcule quand le registre change,
       et s'efface dès que quelqu'un tape. */
    const champ = $('newBox');
    if (champ) champ.addEventListener('input', proposerBoite);
  }

  function render() {
    const carte = $('casiersPlanCard');
    if (!carte) return;
    // L'écran n'existe que pour qui peut s'en servir, et que sur serveur : en
    // mode local il n'y a pas de plan partagé à tenir.
    const ouvert = peut() && S.mode === 'serveur';
    carte.hidden = !ouvert;
    $('casiersListeCard').hidden = !ouvert;
    if (!ouvert) return;
    renderPlan();
    proposerBoite();
  }

  ui.inscrire('casiers', { init: init, render: render, ouvrir: ouvrir, rafraichir: rafraichir });
})(globalThis);
