/* Bureau du Courrier — interface.

   Ce fichier tient les écrans : guichet, remise, registre, domiciliation,
   réglages. Deux morceaux en sont sortis :

     · ui/noyau.js      le socle partagé — messages, confirmation,
                        téléchargement, sélecteurs d'antenne ;
     · ui/impression.js ce qui part sur papier — attestation d'élection de
                        domicile, feuille de casier, rapport annuel.

   Le reste n'a pas suivi, et ce n'est pas un oubli. Découper les cinq écrans
   demanderait de rendre explicites soixante-huit références qui traversent les
   frontières naturelles du fichier — ici, dans le seul fichier du projet
   qu'aucun test unitaire ne couvre, faute d'être chargeable hors navigateur.
   La condition pour aller plus loin n'est donc pas du courage, c'est une
   couverture : le jour où ces écrans se vérifient sans navigateur, le
   découpage redevient bon marché. Avant, il n'échange qu'un fichier long
   contre une régression silencieuse. */
(function (root) {
  'use strict';

  const util = root.BC.util;
  const store = root.BC.store;
  const domi = root.BC.domiciliation;
  const roles = root.BC.roles;
  const notify = root.BC.notify;
  const ui = root.BC.ui;
  const impression = root.BC.impression;
  const S = store.state;

  /* Le socle, repris sous les noms courts que tout le fichier emploie déjà. */
  const $ = ui.$;
  const esc = ui.esc;
  const view = ui.view;
  const toast = ui.toast;
  const stamp = ui.stamp;
  const confirmDialog = ui.confirmDialog;
  const setMsg = ui.setMsg;
  const download = ui.download;
  const downloadBytes = ui.downloadBytes;
  const MIME_XLSX = ui.MIME_XLSX;
  const stampSuffix = ui.stampSuffix;
  const antennes = ui.antennes;
  const antenneImposee = ui.antenneImposee;
  const deLAntenne = ui.deLAntenne;
  const enAttente = ui.enAttente;
  const joursDepuis = ui.joursDepuis;

  /* ═════════════ navigation ═════════════ */

  function showPanel(name) {
    document.querySelectorAll('nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.panel === name);
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
    ui.glisseOnglet(name);
    if (root.location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
    }

    /* La carte « Postes du bureau » interroge le serveur, donc elle ne se
       charge que lorsqu'elle est à l'écran — sans quoi chaque écriture d'un
       autre poste déclencherait un appel pour une carte que personne ne
       regarde. Il faut donc la remplir en ouvrant l'onglet : rien d'autre ne
       le fera, et elle resterait vide. */
    if (name === 'reglages') {
      renderSectionsReglages();
      if (view.sectionReglages === 'bureau') renderPostes(true);
    }
  }

  document.querySelectorAll('nav button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showPanel(btn.dataset.panel);
    });
  });

  /* ═════════════ en-tête / état ═════════════ */

  const MODE_LABEL = {
    serveur: { cls: 'server', text: 'Registre partagé', title: 'Connecté au serveur : registre partagé et conservé.' },
    local: { cls: 'local', text: 'Ce poste', title: 'Registre conservé dans ce navigateur (localStorage).' },
    'mémoire': { cls: 'memory', text: 'Session seulement', title: 'Aucun stockage disponible : tout sera perdu à la fermeture.' }
  };

  function renderMode() {
    const info = MODE_LABEL[S.mode] || MODE_LABEL['mémoire'];
    const badge = $('modeBadge');
    badge.className = 'mode-badge ' + info.cls;
    badge.textContent = info.text;
    badge.title = info.title;

    const notes = [];
    if (store.canSendAutomatically()) {
      notes.push('Envoi automatique actif : le courriel part directement du serveur, sans ouvrir votre logiciel de courriel.');
    } else {
      notes.push(
        '« Envoyer la notification » ouvre votre logiciel de courriel avec le message déjà rédigé. ' +
          'Pour un envoi entièrement automatique, démarrez le serveur avec un compte SMTP configuré (voir README).'
      );
    }
    if (S.mode === 'local') {
      notes.push('Le registre est conservé dans ce navigateur, sur ce poste uniquement.');
    }
    if (S.mode === 'mémoire') {
      notes.push('Attention : aucun stockage n’est disponible ici, le registre sera vidé à la fermeture de la page.');
    }
    $('footerNote').textContent = notes.join(' ');
    renderFile();
  }

  /* ═════════════ file d'attente hors ligne ═════════════ */

  /* Le bandeau ne dit pas seulement « hors ligne » : il dit ce qui attend. Au
     guichet, ce qui compte est de savoir si la remise qu'on vient d'enregistrer
     est partie ou non. */
  function renderFile() {
    const bandeau = $('bandeauFile');
    const badge = $('ligneBadge');
    const resume = store.resumeFile();
    const bilan = S.dernierRejeu;

    badge.hidden = S.enLigne || S.mode !== 'serveur';

    if (!S.enLigne) {
      const depuis = resume.depuis ? ' depuis ' + util.formatDateTime(resume.depuis) : '';
      bandeau.hidden = false;
      bandeau.className = 'bandeau-file coupure';
      bandeau.innerHTML =
        '<strong>Serveur injoignable.</strong> ' +
        (resume.total === 0
          ? 'Vos prochaines actions seront enregistrées ici et envoyées au retour du réseau.'
          : resume.total +
            ' action(s) en attente d’envoi' + depuis + ' — rien n’est perdu. ' +
            '<button class="link-btn" id="fileVoirBtn">Voir</button> ' +
            '<button class="link-btn" id="fileRejouerBtn">Réessayer maintenant</button>');
      brancherFile();
      return;
    }

    if (resume.total > 0) {
      // En ligne mais la file n'est pas vide : un rejeu est en cours ou a calé.
      bandeau.hidden = false;
      bandeau.className = 'bandeau-file attente';
      bandeau.innerHTML =
        resume.total + ' action(s) restent à envoyer. ' +
        '<button class="link-btn" id="fileVoirBtn">Voir</button> ' +
        '<button class="link-btn" id="fileRejouerBtn">Envoyer maintenant</button>';
      brancherFile();
      return;
    }

    /* Rien n'attend. On annonce le bilan du dernier rejeu tant qu'il contient
       des refus : une action écartée par le serveur doit être vue. */
    if (bilan && bilan.echecs.length > 0) {
      bandeau.hidden = false;
      bandeau.className = 'bandeau-file echec';
      bandeau.innerHTML =
        '<strong>' + bilan.echecs.length + ' action(s) refusée(s) au retour du réseau :</strong>' +
        '<ul>' +
        bilan.echecs
          .map(function (e) {
            return '<li>' + esc(e.description) + ' — ' + esc(e.raison) + '</li>';
          })
          .join('') +
        '</ul>' +
        '<button class="link-btn" id="fileFermerBtn">J’ai vu</button>';
      const fermer = $('fileFermerBtn');
      if (fermer) {
        fermer.addEventListener('click', function () {
          S.dernierRejeu = null;
          renderFile();
        });
      }
      return;
    }
    bandeau.hidden = true;
  }

  function brancherFile() {
    const voir = $('fileVoirBtn');
    if (voir) {
      voir.addEventListener('click', function () {
        const resume = store.resumeFile();
        confirmDialog(
          'Actions en attente',
          resume.libelles.join('\n'),
          'Fermer'
        );
      });
    }
    const rejouer = $('fileRejouerBtn');
    if (rejouer) {
      rejouer.addEventListener('click', async function () {
        rejouer.disabled = true;
        const bilan = await store.viderFile();
        if (bilan.envoyees > 0) toast(bilan.envoyees + ' action(s) envoyée(s).', 'ok');
        else if (!S.enLigne) toast('Serveur toujours injoignable.', 'error');
        renderFile();
      });
    }
  }

  function renderStatus() {
    const rows = [
      ['Stockage', (MODE_LABEL[S.mode] || {}).text + ' (' + S.mode + ')'],
      [
        'Envoi automatique',
        store.canSendAutomatically()
          ? S.auth.user && S.auth.user.mailbox
            ? 'Actif — depuis votre boîte (' + S.auth.user.mailbox.address + ')'
            : 'Actif — compte du serveur'
          : 'Inactif — repli sur le logiciel de courriel'
      ],
      ['Destinataires', String(S.contacts.length)],
      ['Notifications', String(S.history.length)],
      ['Application', installStatusText()]
    ];
    if (S.lastError) rows.push(['Dernière erreur', S.lastError]);
    $('statusList').innerHTML = rows
      .map(function (r) {
        return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
      })
      .join('');

    const smtpOn = store.canSendAutomatically();
    $('smtpActions').innerHTML = smtpOn
      ? '<button class="btn ghost" id="testMailBtn">Envoyer un courriel de test</button>'
      : '';
    const testBtn = $('testMailBtn');
    if (testBtn) testBtn.addEventListener('click', testMail);

    // Tant que l'envoi automatique n'est pas actif, l'application ne fait que
    // préparer le message : autant dire ici, noir sur blanc, ce qui manque.
    setMsg(
      'smtpMsg',
      smtpOn ? 'ok' : '',
      smtpOn
        ? 'L’application envoie les courriels elle-même. Le bouton ci-dessus permet de le vérifier.'
        : '<strong>L’application ne peut pas envoyer les courriels elle-même pour l’instant.</strong> ' +
            'Chaque notification est préparée dans votre logiciel de courriel, où il faut cliquer sur <em>Envoyer</em>.' +
            '<br>Pour un envoi direct, sur le poste qui héberge l’application :' +
            '<ul>' +
            '<li><code>npm install</code></li>' +
            '<li>copier <code>.env.example</code> en <code>.env</code>, puis y renseigner ' +
            '<code>SMTP_HOST</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> et <code>MAIL_FROM</code></li>' +
            '<li>redémarrer avec <code>npm start</code></li>' +
            '</ul>' +
            (S.auth.user
              ? 'Plus simple : reliez votre propre boîte dans « Ma boîte d’envoi », juste au-dessus.'
              : 'Les valeurs SMTP sont celles de votre fournisseur de courriel (voir le README).')
    );
  }

  async function testMail() {
    const to = root.prompt('Adresse de destination pour le test :');
    if (!to) return;
    if (!util.isValidEmail(to)) {
      setMsg('smtpMsg', 'error', 'Adresse invalide.');
      return;
    }
    setMsg('smtpMsg', '', 'Envoi en cours…');
    try {
      await store.sendViaServer(
        { id: null, name: 'Test', email: to },
        {
          subject: '[Test] ' + S.settings.subject,
          body: 'Ceci est un envoi de test depuis le Bureau du Courrier.\n\n' + S.settings.body
        }
      );
      setMsg('smtpMsg', 'ok', 'Courriel de test envoyé à ' + esc(to) + '.');
    } catch (err) {
      setMsg('smtpMsg', 'error', 'Échec de l’envoi : ' + esc(err.message));
    }
  }

  /* ═════════════ guichet : suggestions ═════════════ */

  const nameInput = $('nameInput');
  const sugBox = $('suggestions');

  function hideSuggestions() {
    sugBox.hidden = true;
    sugBox.innerHTML = '';
    view.highlight = -1;
    view.suggestions = [];
    nameInput.setAttribute('aria-expanded', 'false');
  }

  function renderSuggestions() {
    const q = nameInput.value.trim();
    if (q.length < 2) {
      hideSuggestions();
      return;
    }
    const matches = util
      .sortByName(
        S.contacts.filter(function (c) {
          return util.matchesQuery(c, q, view.searchMode);
        })
      )
      .slice(0, 6);
    view.suggestions = matches;
    if (matches.length === 0) {
      hideSuggestions();
      return;
    }
    sugBox.innerHTML = matches
      .map(function (c, i) {
        return (
          '<li role="option" data-i="' +
          i +
          '"' +
          (i === view.highlight ? ' class="highlight" aria-selected="true"' : '') +
          '>' +
          (c.box ? '<em class="box-tag">' + esc(c.box) + '</em> ' : '') +
          esc(c.name) +
          '<span>' +
          esc(c.email) +
          '</span></li>'
        );
      })
      .join('');
    sugBox.hidden = false;
    nameInput.setAttribute('aria-expanded', 'true');
    sugBox.querySelectorAll('li').forEach(function (li) {
      li.addEventListener('mousedown', function (e) {
        e.preventDefault();
        const c = view.suggestions[Number(li.dataset.i)];
        nameInput.value = c.name;
        hideSuggestions();
        doSearch();
      });
    });
  }

  nameInput.addEventListener('input', function () {
    view.highlight = -1;
    renderSuggestions();
  });
  nameInput.addEventListener('blur', function () {
    setTimeout(hideSuggestions, 120);
  });
  nameInput.addEventListener('keydown', function (e) {
    if (!sugBox.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      view.highlight = (view.highlight + delta + view.suggestions.length) % view.suggestions.length;
      renderSuggestions();
      return;
    }
    if (e.key === 'Escape') {
      hideSuggestions();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (view.highlight >= 0 && view.suggestions[view.highlight]) {
        nameInput.value = view.suggestions[view.highlight].name;
      }
      hideSuggestions();
      doSearch();
    }
  });

  /* ═════════════ guichet : copies (Cc / Cci) ═════════════ */

  /** Aligne les champs de copies sur les réglages, sauf si l'employé·e les a modifiés. */
  function syncCopiesFromSettings(force) {
    if (view.copiesTouched && !force) {
      renderCopiesState();
      return;
    }
    $('sendCc').value = S.settings.cc || '';
    $('sendBcc').value = S.settings.bcc || '';
    view.copiesTouched = false;
    renderCopiesState();
  }

  /* Ce que le repli « Autres options » cache d'actif. Une case « urgent »
     laissée cochée et invisible enverrait des relances sous deux jours à tout
     le monde sans que personne ne comprenne pourquoi : le repli ne doit jamais
     dissimuler un réglage en vigueur. */
  function renderGuichetPlusState() {
    const actifs = [];
    if ($('courrierUrgent').checked) actifs.push('urgent');
    if ($('modeSerie').checked) actifs.push('série');
    const copies = util.parseAddressList($('sendCc').value).entries.length +
      util.parseAddressList($('sendBcc').value).entries.length;
    if (copies) actifs.push(copies + (copies > 1 ? ' copies' : ' copie'));
    const badge = $('guichetPlusState');
    if (badge) badge.textContent = actifs.length ? '· ' + actifs.join(' · ') : '';
    // Un réglage actif mérite d'être vu : on déplie plutôt que de se taire.
    const plus = $('guichetPlus');
    if (plus && actifs.length && !plus.open) plus.open = true;
  }

  ['courrierUrgent', 'modeSerie'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', renderGuichetPlusState);
  });

  function renderCopiesState() {
    const cc = util.parseAddressList($('sendCc').value);
    const bcc = util.parseAddressList($('sendBcc').value);
    const total = cc.entries.length + bcc.entries.length;
    const parts = [];
    if (total) parts.push('· ' + total + (total > 1 ? ' adresses' : ' adresse'));
    if (view.copiesTouched) parts.push('· modifié');
    $('copiesState').textContent = parts.join(' ');
    renderGuichetPlusState();
    setMsg('copiesMsg', '', '');
    if (cc.errors.length || bcc.errors.length) {
      setMsg(
        'copiesMsg',
        'error',
        'Adresse non reconnue : ' + esc(cc.errors.concat(bcc.errors).join(', ')) + '.'
      );
    }
  }

  /** Les copies retenues pour le prochain envoi, ou null si une adresse est fautive. */
  function currentCopies() {
    const cc = util.parseAddressList($('sendCc').value);
    const bcc = util.parseAddressList($('sendBcc').value);
    if (cc.errors.length || bcc.errors.length) {
      $('copiesBox').open = true;
      renderCopiesState();
      return null;
    }
    return { cc: util.formatAddressList(cc.entries), bcc: util.formatAddressList(bcc.entries) };
  }

  ['sendCc', 'sendBcc'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      view.copiesTouched = true;
      renderCopiesState();
    });
  });

  $('resetCopiesBtn').addEventListener('click', function () {
    syncCopiesFromSettings(true);
    toast('Copies remises aux valeurs des réglages.');
  });

  $('typeCourrier').innerHTML = util.TYPES_COURRIER.map(function (t, i) {
    return (
      '<button type="button" role="radio" data-type="' +
      t.id +
      '" aria-checked="' +
      (i === 0 ? 'true' : 'false') +
      '"' +
      (i === 0 ? ' class="active"' : '') +
      '>' +
      esc(t.label) +
      '</button>'
    );
  }).join('');

  $('typeCourrier')
    .querySelectorAll('button')
    .forEach(function (btn) {
      btn.addEventListener('click', function () {
        view.typeCourrier = btn.dataset.type;
        $('typeCourrier')
          .querySelectorAll('button')
          .forEach(function (b) {
            const actif = b === btn;
            b.classList.toggle('active', actif);
            b.setAttribute('aria-checked', actif ? 'true' : 'false');
          });
      });
    });

  /* ═════════════ signature de remise ═════════════ */

  /** Ouvre le pavé de signature. Résout avec l'image, '' si passée, null si annulée. */
  function demanderSignature(nom) {
    return new Promise(function (resolve) {
      const dlg = $('signatureDialog');
      const canvas = $('signaturePad');
      if (!dlg || typeof dlg.showModal !== 'function' || !canvas.getContext) {
        resolve('');
        return;
      }
      $('signatureQui').textContent = 'Remise à ' + nom + '.';

      const ctx = canvas.getContext('2d');
      const styles = getComputedStyle(document.body);
      const effacer = function () {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = styles.getPropertyValue('--card') || '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = styles.getPropertyValue('--navy') || '#16233F';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      };
      effacer();

      let dessine = false;
      let vide = true;
      const point = function (e) {
        const r = canvas.getBoundingClientRect();
        const src = e.touches ? e.touches[0] : e;
        return {
          x: ((src.clientX - r.left) / r.width) * canvas.width,
          y: ((src.clientY - r.top) / r.height) * canvas.height
        };
      };
      const debut = function (e) {
        e.preventDefault();
        dessine = true;
        vide = false;
        const p = point(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
      };
      const trace = function (e) {
        if (!dessine) return;
        e.preventDefault();
        const p = point(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      };
      const fin = function () {
        dessine = false;
      };

      canvas.addEventListener('mousedown', debut);
      canvas.addEventListener('mousemove', trace);
      root.addEventListener('mouseup', fin);
      canvas.addEventListener('touchstart', debut, { passive: false });
      canvas.addEventListener('touchmove', trace, { passive: false });
      canvas.addEventListener('touchend', fin);

      const terminer = function (valeur) {
        canvas.removeEventListener('mousedown', debut);
        canvas.removeEventListener('mousemove', trace);
        root.removeEventListener('mouseup', fin);
        canvas.removeEventListener('touchstart', debut);
        canvas.removeEventListener('touchmove', trace);
        canvas.removeEventListener('touchend', fin);
        dlg.close();
        resolve(valeur);
      };

      $('signatureEffacer').onclick = function () {
        effacer();
        vide = true;
      };
      $('signaturePasser').onclick = function () {
        terminer('');
      };
      $('signatureValider').onclick = function () {
        terminer(vide ? '' : canvas.toDataURL('image/png'));
      };
      dlg.addEventListener(
        'cancel',
        function () {
          terminer(null);
        },
        { once: true }
      );
      dlg.showModal();
    });
  }

  /* ═════════════ remise par code ═════════════ */

  /* Un code saisi n'emporte pas la remise : il ouvre d'abord une fiche de
     vérification. L'agent voit à qui il s'apprête à remettre, quelle boîte,
     quel type de courrier et depuis quand il attend — c'est ce contrôle qui
     évite de donner la lettre à la mauvaise personne. La remise n'a lieu
     qu'après confirmation explicite. */

  function effacerFiche() {
    $('pickupDetail').innerHTML = '';
  }

  function ligneFiche(cle, valeur, classe) {
    return (
      '<div><dt>' +
      esc(cle) +
      '</dt><dd' +
      (classe ? ' class="' + classe + '"' : '') +
      '>' +
      esc(valeur) +
      '</dd></div>'
    );
  }

  /** Affiche la fiche du courrier trouvé et attend la décision de l'agent. */
  function afficherFicheRetrait(fiche) {
    const record = fiche.record;
    const contact = fiche.contact || {};
    const autres = fiche.autres || [];
    const jours = joursDepuis(record.date);
    const type = util.typeCourrier(record.type);
    const abs = contact.email ? util.presence(contact) : { etat: 'present', message: '' };

    // Ce que l'agent doit sortir du casier : le total, pas seulement l'enveloppe
    // dont le code a été présenté.
    const total = 1 + autres.length;

    const lignes = [
      ligneFiche('Destinataire', record.name),
      ligneFiche('Numéro de boîte', contact.box || '—', 'box-cell'),
      ligneFiche(
        'Courriers à remettre',
        total === 1 ? '1 courrier' : total + ' courriers (celui-ci + ' + autres.length + ')'
      ),
      ligneFiche('Type de courrier', type.label),
      ligneFiche(
        'Reçu le',
        util.formatDateTime(record.date) +
          (jours === 0 ? ' (aujourd’hui)' : ' (' + jours + ' jour' + (jours > 1 ? 's' : '') + ')')
      ),
      /* Comment la personne a été prévenue — ou pas encore. Sans adresse, on
         montre le numéro : c'est ce dont l'agent a besoin sous les yeux, au
         moment précis où il a la fiche devant lui. */
      record.email
        ? ligneFiche('Courriel prévenu', record.email)
        : ligneFiche(
            'Téléphone',
            (record.telephone || (contact && contact.telephone) || 'aucun numéro au dossier') +
              (record.status === 'prévenu' ? ' — prévenue' : ' — à prévenir'),
            'tel-cell'
          ),
      ligneFiche(
        'Relances',
        record.reminderCount > 0
          ? record.reminderCount + ' relance(s) envoyée(s)'
          : 'aucune'
      )
    ];
    if (record.urgent) {
      lignes.push(ligneFiche('Urgence', 'Courrier signalé urgent à la réception'));
    }
    if (record.flaggedAt) {
      lignes.push(ligneFiche('Signalé', 'Courrier du dossier à traiter — ' + (record.flagReason || 'non retiré')));
    }
    if (abs.etat !== 'present') {
      lignes.push(ligneFiche('Présence', abs.message));
    }

    $('pickupDetail').innerHTML =
      '<div class="fiche-retrait" id="ficheRetrait">' +
      '<div class="fiche-retrait-tete">' +
      '<span class="code-pill">' + esc(record.pickupCode || '----') + '</span>' +
      '<strong>' + esc(record.name) + '</strong>' +
      (contact.box ? '<span class="box-cell">boîte ' + esc(contact.box) + '</span>' : '') +
      '<span class="compte-pill">' + total + ' courrier' + (total > 1 ? 's' : '') + '</span>' +
      '</div>' +
      '<dl class="status-list">' + lignes.join('') + '</dl>' +
      (autres.length
        ? '<div class="fiche-autres">' +
          '<p class="hint">Cette personne a ' +
          autres.length +
          ' autre' + (autres.length > 1 ? 's' : '') + ' courrier' + (autres.length > 1 ? 's' : '') +
          ' en attente. Cochez ce que vous remettez en même temps.</p>' +
          autres
            .map(function (h) {
              const j = joursDepuis(h.date);
              return (
                '<label class="check-row"><input type="checkbox" data-aussi="' +
                esc(h.id) +
                '" checked> ' +
                esc(util.typeCourrier(h.type).label) +
                ' — reçu le ' +
                esc(util.formatDateTime(h.date)) +
                ' (' + (j === 0 ? 'aujourd’hui' : j + ' j') + ')' +
                '</label>'
              );
            })
            .join('') +
          '</div>'
        : '') +
      /* Retrait par un tiers : le voisin, un collègue, un proche. Sans ce
         champ, le registre affirme que le destinataire est venu — ce qui est
         faux, et c'est justement la trace qui manque en cas de litige. */
      '<div class="fiche-porteur">' +
      '<label class="check-row"><input type="checkbox" id="ficheTiers"> ' +
      'Le courrier est retiré par une autre personne</label>' +
      '<div id="ficheTiersChamp" hidden>' +
      '<label for="fichePorteur">Nom de la personne qui se présente</label>' +
      '<input type="text" id="fichePorteur" autocomplete="off" placeholder="ex. Jean Roy, voisin">' +
      '</div>' +
      '</div>' +
      '<div class="fiche-retrait-actions">' +
      '<button class="btn" id="ficheConfirmer">Confirmer la remise</button>' +
      '<button class="btn ghost" id="ficheAnnuler">Annuler</button>' +
      '</div>' +
      '</div>';

    $('ficheAnnuler').addEventListener('click', function () {
      effacerFiche();
      setMsg('pickupMsg', '', '');
      $('pickupCode').value = '';
      $('pickupCode').focus();
    });
    $('ficheTiers').addEventListener('change', function (e) {
      $('ficheTiersChamp').hidden = !e.target.checked;
      if (e.target.checked) $('fichePorteur').focus();
      else $('fichePorteur').value = '';
    });
    $('ficheConfirmer').addEventListener('click', function () {
      confirmerRemise(fiche);
    });
    // La touche Entrée valide : au guichet, on ne quitte pas le clavier.
    $('ficheConfirmer').focus();
  }

  /** Signature puis remise effective, y compris les courriers cochés en plus. */
  async function confirmerRemise(fiche) {
    const bouton = $('ficheConfirmer');
    const aussi = Array.prototype.slice
      .call($('pickupDetail').querySelectorAll('input[data-aussi]:checked'))
      .map(function (input) {
        return input.dataset.aussi;
      });

    /* Un tiers annoncé sans nom ne vaut rien : autant ne pas cocher la case. */
    const tiers = $('ficheTiers') && $('ficheTiers').checked;
    const porteur = tiers ? $('fichePorteur').value.trim() : '';
    if (tiers && !porteur) {
      setMsg('pickupMsg', 'error', 'Indiquez le nom de la personne qui retire le courrier.');
      $('fichePorteur').focus();
      return;
    }

    // Le pavé de signature nomme celui qui signe, pas le destinataire absent.
    const signature = await demanderSignature(porteur || fiche.record.name);
    if (signature === null) return; // annulé : la fiche reste affichée

    if (bouton) bouton.disabled = true;
    const options = { porteur: porteur || null };
    try {
      const entree = await store.pickupByCode(fiche.record.pickupCode, signature, options);
      for (const id of aussi) {
        await store.setPickedUp(id, true, signature, options);
      }
      effacerFiche();
      $('pickupCode').value = '';
      stamp('Remis', entree.name);
      $('pickupCode').focus();
      setMsg(
        'pickupMsg',
        'ok',
        'Courrier remis à <strong>' +
          esc(entree.name) +
          '</strong> — marqué récupéré.' +
          (porteur ? ' Retiré par <strong>' + esc(porteur) + '</strong>.' : '') +
          (aussi.length ? ' ' + aussi.length + ' autre(s) courrier(s) remis également.' : '')
      );
    } catch (err) {
      if (bouton) bouton.disabled = false;
      setMsg('pickupMsg', 'error', esc(err.message));
    }
  }

  /** Cherche le courrier correspondant au code et ouvre sa fiche. */
  async function chercherParCode() {
    const code = $('pickupCode').value.replace(/\D/g, '');
    effacerFiche();
    if (code.length !== 4) {
      setMsg('pickupMsg', 'error', 'Le code compte quatre chiffres.');
      return;
    }
    setMsg('pickupMsg', 'info', 'Recherche du courrier…');
    try {
      const fiche = await store.lookupByCode(code);
      setMsg('pickupMsg', '', '');
      afficherFicheRetrait(fiche);
    } catch (err) {
      setMsg('pickupMsg', 'error', esc(err.message));
      $('pickupCode').select();
    }
  }

  $('pickupCodeBtn').addEventListener('click', chercherParCode);
  $('pickupCode').addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (e.target.value.length !== 4) effacerFiche();
    if (e.target.value.length === 4) chercherParCode();
  });
  $('pickupCode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      chercherParCode();
    }
  });

  document.querySelectorAll('.search-modes button[data-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      view.searchMode = btn.dataset.mode;
      document.querySelectorAll('.search-modes button[data-mode]').forEach(function (b) {
        const actif = b === btn;
        b.classList.toggle('active', actif);
        b.setAttribute('aria-checked', actif ? 'true' : 'false');
      });
      const parNom = view.searchMode === 'nom';
      $('searchLabel').textContent = parNom ? 'Nom inscrit sur la lettre' : 'Numéro de boîte';
      nameInput.placeholder = parNom ? 'ex. Marie Tremblay' : 'ex. B-12';
      nameInput.value = '';
      $('searchResults').innerHTML = '';
      hideSuggestions();
      nameInput.focus();
    });
  });

  $('validerBtn').addEventListener('click', doSearch);
  $('clearSearchBtn').addEventListener('click', function () {
    nameInput.value = '';
    $('searchResults').innerHTML = '';
    hideSuggestions();
    nameInput.focus();
  });

  /* ═════════════ guichet : recherche et envoi ═════════════ */

  function doSearch() {
    const raw = nameInput.value.trim();
    const box = $('searchResults');
    if (!raw) {
      box.innerHTML = '<div class="msg error">Veuillez inscrire un nom avant de valider.</div>';
      nameInput.focus();
      return;
    }
    const matches = util.sortByName(
      S.contacts.filter(function (c) {
        return deLAntenne(c) && util.matchesQuery(c, raw, view.searchMode);
      })
    );

    if (matches.length === 0) {
      renderUnknown(raw);
      return;
    }

    afficherResultats(matches);
  }

  /** Liste de destinataires trouvés, avec un en-tête libre. */
  function afficherResultats(matches, entete) {
    const box = $('searchResults');
    box.innerHTML =
      '<div class="card">' +
      (entete
        ? '<div class="msg">' + entete + '</div>'
        : '<h2>' + (matches.length === 1 ? '1 destinataire trouvé' : matches.length + ' destinataires trouvés') + '</h2>') +
      matches
        .map(function (c) {
          return (
            '<div class="result-row"><div class="who">' +
            (c.box ? '<em class="box-tag">' + esc(c.box) + '</em> ' : '') +
            esc(c.name) +
            (util.presence(c).etat !== 'present'
              ? '<span class="absence-tag">' + esc(util.presence(c).message) + '</span>'
              : '') +
            '<span>' +
            esc(c.email) +
            '</span></div>' +
            '<button class="btn" data-send="' +
            esc(c.id) +
            '">Envoyer la notification</button></div>'
          );
        })
        .join('') +
      '</div>';

    box.querySelectorAll('button[data-send]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const c = S.contacts.find(function (x) {
          return x.id === btn.dataset.send;
        });
        if (c) notifierEnTenantCompteDesAbsences(c, btn);
      });
    });
  }

  /** Prévient avant de notifier quelqu'un qui ne viendra pas, et propose son remplaçant. */
  async function notifierEnTenantCompteDesAbsences(contact, btn) {
    const etat = util.presence(contact);
    if (etat.etat === 'present') return sendNotification(contact, btn);

    const remplacant = etat.substituteId
      ? S.contacts.find(function (c) {
          return c.id === etat.substituteId;
        })
      : null;

    $('searchResults').innerHTML =
      '<div class="card"><div class="msg error"><strong>' +
      esc(contact.name) +
      '</strong> ' +
      esc(etat.message) +
      '.' +
      (remplacant
        ? '<br>Son courrier est à remettre à <strong>' + esc(remplacant.name) + '</strong>.'
        : '<br>Aucun remplaçant n’est désigné.') +
      '</div><div class="row-actions">' +
      (remplacant ? '<button class="btn" id="notifRemplacant">Notifier ' + esc(remplacant.name) + '</button>' : '') +
      '<button class="btn ghost" id="notifQuandMeme">Notifier ' + esc(contact.name) + ' quand même</button>' +
      '</div></div>';

    if (remplacant) {
      $('notifRemplacant').addEventListener('click', function () {
        sendNotification(remplacant, null, { pour: contact.name });
      });
    }
    $('notifQuandMeme').addEventListener('click', function () {
      sendNotification(contact, null);
    });
  }

  function renderUnknown(raw) {
    /* En mode boîte, la saisie peut être un nom : plutôt que d'annoncer un
       échec, on cherche dans l'autre mode et on le dit. C'est le cas courant
       — on tape ce qu'on lit sur l'enveloppe, sans penser au sélecteur. */
    if (view.searchMode === 'boite') {
      const parNom = util.sortByName(
        S.contacts.filter(function (c) {
          return util.matchesQuery(c, raw, 'nom');
        })
      );
      if (parNom.length) {
        afficherResultats(
          parNom,
          '« ' +
            esc(raw) +
            ' » ne correspond à aucun numéro de boîte, mais à ' +
            (parNom.length === 1 ? 'ce destinataire' : 'ces destinataires') +
            ' :'
        );
        return;
      }
    }

    // Avant de proposer une création, on regarde si le nom ressemble à quelqu'un.
    const proches = view.searchMode === 'nom' ? util.suggestionsProches(S.contacts, raw, 3) : [];
    if (proches.length) {
      $('searchResults').innerHTML =
        '<div class="card"><div class="msg">Aucun destinataire ne s’appelle exactement « ' +
        esc(raw) +
        ' ». Vouliez-vous dire :</div>' +
        proches
          .map(function (c) {
            return (
              '<div class="result-row"><div class="who">' +
              (c.box ? '<em class="box-tag">' + esc(c.box) + '</em> ' : '') +
              esc(c.name) +
              '<span>' +
              esc(c.email) +
              '</span></div><button class="btn" data-send="' +
              esc(c.id) +
              '">Envoyer la notification</button></div>'
            );
          })
          .join('') +
        '<div class="row-actions"><button class="btn ghost" id="quandMemeBtn">Non, ajouter « ' +
        esc(raw) +
        ' » au registre</button></div></div>';

      $('searchResults')
        .querySelectorAll('button[data-send]')
        .forEach(function (btn) {
          btn.addEventListener('click', function () {
            const c = S.contacts.find(function (x) {
              return x.id === btn.dataset.send;
            });
            if (c) sendNotification(c, btn);
          });
        });
      $('quandMemeBtn').addEventListener('click', function () {
        renderInconnuFranc(raw);
      });
      return;
    }
    renderInconnuFranc(raw);
  }

  function renderInconnuFranc(raw) {
    /* Le texte saisi n'est pas la même chose selon le mode : un nom d'un côté,
       un numéro de boîte de l'autre. Créer un destinataire nommé « B-12 »
       n'aurait aucun sens — le formulaire s'adapte. */
    const parBoite = view.searchMode === 'boite';

    $('searchResults').innerHTML =
      '<div class="card">' +
      '<div class="msg error">Aucun destinataire ' +
      (parBoite ? 'à la boîte' : 'trouvé pour') +
      ' « ' +
      esc(raw) +
      ' » dans le registre.</div>' +
      '<label>Ajouter ' +
      (parBoite ? 'un destinataire à la boîte « ' + esc(raw) + ' »' : '« ' + esc(raw) + ' » au registre') +
      ' et notifier</label>' +
      '<div class="copies-grid">' +
      (parBoite
        ? '<div><label for="quickName">Nom complet</label>' +
          '<input type="text" id="quickName" placeholder="Marie Tremblay" autocomplete="off"></div>'
        : '<div><label for="quickBox">N° de boîte (facultatif)</label>' +
          '<input type="text" id="quickBox" placeholder="B-12" autocomplete="off"></div>') +
      '<div><label for="quickEmail">Courriel</label>' +
      '<input type="email" id="quickEmail" placeholder="courriel@exemple.com" autocomplete="off"></div>' +
      // Un courriel OU un téléphone : la personne devant le guichet n'a pas
      // forcément d'adresse, et c'est ici qu'on l'inscrit.
      '<div><label for="quickTel">Téléphone</label>' +
      '<input type="text" id="quickTel" placeholder="06 12 34 56 78" autocomplete="off"></div>' +
      '</div>' +
      '<div class="row-actions"><button class="btn" id="quickAddBtn">Ajouter et notifier</button>' +
      '<button class="btn ghost" id="quickRegistreBtn">Ouvrir le registre</button></div>' +
      '<div id="quickMsg"></div></div>';

    const emailField = $('quickEmail');
    const nameField = parBoite ? $('quickName') : null;
    const boxField = parBoite ? null : $('quickBox');
    (nameField || emailField).focus();

    [nameField, boxField, emailField].forEach(function (champ) {
      if (!champ) return;
      champ.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          $('quickAddBtn').click();
        }
      });
    });

    $('quickRegistreBtn').addEventListener('click', function () {
      showPanel('registre');
      if (parBoite) {
        $('newBox').value = raw;
        $('newName').focus();
      } else {
        $('newName').value = raw;
        $('newEmail').focus();
      }
    });

    $('quickAddBtn').addEventListener('click', async function () {
      const email = emailField.value.trim();
      const nom = parBoite ? nameField.value.trim() : raw;
      const boite = parBoite ? raw : (boxField.value || '').trim();

      if (!nom) {
        nameField.classList.add('invalid');
        setMsg('quickMsg', 'error', 'Indiquez le nom du destinataire.');
        return;
      }
      const tel = ($('quickTel').value || '').trim();
      if (email && !util.isValidEmail(email)) {
        emailField.classList.add('invalid');
        setMsg('quickMsg', 'error', 'Cette adresse électronique n’est pas valide.');
        return;
      }
      if (!email && !tel) {
        setMsg('quickMsg', 'error', 'Indiquez un courriel ou un téléphone : sans cela, personne ne pourra la prévenir.');
        return;
      }
      const existing = email ? store.findByEmail(email) : null;
      if (existing) {
        setMsg('quickMsg', 'error', 'Ce courriel est déjà au registre sous « ' + esc(existing.name) + ' ».');
        return;
      }
      try {
        const contact = await store.addContact({ name: nom, email: email, telephone: tel, box: boite });
        toast('« ' + contact.name + ' » ajouté au registre.', 'ok');
        await sendNotification(contact);
      } catch (err) {
        setMsg('quickMsg', 'error', 'Impossible d’ajouter le destinataire : ' + esc(err.message));
      }
    });
  }

  async function sendNotification(contact, btn, options) {
    const opts = options || {};
    const copies = currentCopies();
    if (!copies) {
      toast('Corrigez les adresses en copie avant d’envoyer.', 'error');
      return;
    }
    const type = opts.type || view.typeCourrier;
    // Le type est passé à la composition : c'est lui qui choisit le gabarit.
    const message = notify.compose(contact, S.settings, Object.assign({ type: type }, copies));
    message.type = type;
    message.urgent = opts.urgent !== undefined ? !!opts.urgent : !!$('courrierUrgent').checked;
    if (opts.pour) {
      message.body += '\n\n(Ce courrier est adressé à ' + opts.pour + ', dont vous assurez le relais.)';
    }
    const mailto = notify.mailtoUrl(contact, message);
    if (btn) btn.disabled = true;

    let auto = false;
    let failure = null;
    /* Personne sans adresse : on n'ouvre surtout pas un client de messagerie
       sur un destinataire vide. Le serveur inscrit le courrier et le range
       dans la liste des appels à passer. */
    const sansCourriel = !(contact.email || '').trim();
    if (sansCourriel && S.mode === 'serveur') {
      try {
        await store.sendViaServer(contact, message);
        if (!opts.silencieux) {
          toast(
            'Courrier inscrit. ' + contact.name + ' n’a pas de courriel : à prévenir par téléphone.',
            'ok'
          );
        }
        auto = true;
      } catch (err) {
        failure = err.message;
        toast('Enregistrement impossible : ' + err.message, 'error');
      }
    } else if (store.canSendAutomatically()) {
      try {
        await store.sendViaServer(contact, message);
        auto = true;
      } catch (err) {
        failure = err.message;
      }
    }

    // Sans adresse, aucun client de messagerie à ouvrir : l'échec éventuel a
    // déjà été signalé, et un mailto vide ne mènerait nulle part.
    if (!auto && !sansCourriel) {
      notify.openMailClient(mailto);
      await store.addHistory({
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        subject: message.subject,
        cc: message.cc,
        bcc: message.bcc,
        method: 'manuel',
        status: failure ? 'échec' : 'préparé'
      });
    }

    if (!opts.silencieux) stamp(auto ? 'Envoyé' : 'Préparé', contact.name);
    nameInput.value = '';
    hideSuggestions();

    /* Saisie en série : le facteur pose vingt lettres d'un coup. On enchaîne
       sans quitter le champ, et le bilan s'allonge sous les yeux plutôt que de
       remplacer l'écran à chaque envoi. */
    if (!opts.silencieux && $('modeSerie').checked) {
      view.serie.unshift({
        nom: contact.name,
        auto: auto,
        urgent: !!message.urgent,
        type: util.typeCourrier(type).label
      });
      renderSerie();
      $('searchResults').innerHTML = '';
      $('courrierUrgent').checked = false;
      if (btn) btn.disabled = false;
      nameInput.focus();
      return;
    }
    // En traitement de pile, on ne remplace pas l'écran à chaque envoi.
    if (opts.silencieux) {
      if (btn) btn.disabled = false;
      return;
    }

    const full = notify.plainText(contact, message);
    $('searchResults').innerHTML =
      '<div class="msg ' +
      (auto ? 'ok' : '') +
      '">' +
      (auto
        ? 'Courriel envoyé automatiquement à ' +
          esc(contact.name) +
          ' (' +
          esc(contact.email) +
          ')' +
          (message.cc ? ', copie à ' + esc(message.cc) : '') +
          (message.bcc ? ', copie invisible à ' + esc(message.bcc) : '') +
          '.'
        : '<strong>Message préparé, pas encore envoyé.</strong><br>' +
          'Votre logiciel de courriel doit s’ouvrir avec le message adressé à ' +
          esc(contact.name) +
          ' : il reste à y cliquer sur <em>Envoyer</em>.<br>' +
          'Rien ne s’est ouvert ? <a href="' +
          esc(mailto) +
          '">réessayez ici</a>, ou copiez le message ci-dessous. ' +
          'Pour que l’application envoie elle-même, sans cette étape, ' +
          '<button type="button" class="link-btn" id="whyManualBtn">configurez l’envoi automatique</button>.') +
      (failure ? '<br><em>Envoi automatique impossible (' + esc(failure) + ') — repli sur le logiciel de courriel.</em>' : '') +
      '</div>' +
      '<div class="card" style="padding:14px;">' +
      '<label style="margin-bottom:8px;">Message' +
      (auto ? ' envoyé' : ' (au cas où)') +
      '</label>' +
      '<pre class="preview" style="margin-bottom:10px;">' +
      esc(full) +
      '</pre>' +
      '<div class="row-actions">' +
      '<button class="btn ghost" id="copyMsgBtn">Copier le message</button>' +
      (auto ? '' : '<a class="btn ghost" href="' + esc(mailto) + '">Ouvrir le logiciel de courriel</a>') +
      '</div></div>';

    const whyBtn = $('whyManualBtn');
    if (whyBtn) {
      whyBtn.addEventListener('click', function () {
        showPanel('reglages');
        $('statusList').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    $('copyMsgBtn').addEventListener('click', async function (e) {
      const ok = await notify.copyText(full);
      e.target.textContent = ok ? 'Copié ✓' : 'Copie impossible — sélectionnez le texte';
      setTimeout(function () {
        e.target.textContent = 'Copier le message';
      }, 2000);
    });

    if (btn) btn.disabled = false;
    nameInput.focus();
  }

  /* ═════════════ saisie en série ═════════════ */

  function renderSerie() {
    const boite = $('serieBilan');
    if (view.serie.length === 0) {
      boite.hidden = true;
      boite.innerHTML = '';
      return;
    }
    boite.hidden = false;
    boite.innerHTML =
      '<div class="serie-bilan"><div class="serie-tete">' +
      '<strong>' + view.serie.length + ' courrier(s) traité(s)</strong>' +
      '<button type="button" class="link-btn" id="serieViderBtn">Remettre à zéro</button>' +
      '</div><ol class="serie-liste">' +
      view.serie
        .map(function (e) {
          return (
            '<li>' +
            esc(e.nom) +
            ' <span class="serie-detail">' + esc(e.type) +
            (e.urgent ? ' · urgent' : '') +
            ' · ' + (e.auto ? 'envoyé' : 'préparé') + '</span></li>'
          );
        })
        .join('') +
      '</ol></div>';
    $('serieViderBtn').addEventListener('click', function () {
      view.serie = [];
      renderSerie();
      nameInput.focus();
    });
  }

  $('modeSerie').addEventListener('change', function (e) {
    if (!e.target.checked) {
      view.serie = [];
      renderSerie();
    } else {
      toast('Saisie en série : le champ reste actif après chaque envoi.', 'ok');
      nameInput.focus();
    }
  });

  /* ═════════════ recherche globale ═════════════ */

  /* Une seule barre pour tout le registre, appelée de n'importe quel onglet.
     Au guichet, savoir dans quel onglet chercher est une charge mentale de
     plus ; ici on tape ce qu'on a sous les yeux — un nom, une boîte, un code. */

  const palette = { ouverte: false, resultats: [], choix: 0 };

  function ouvrirPalette() {
    palette.ouverte = true;
    $('palette').hidden = false;
    $('paletteInput').value = '';
    $('paletteResultats').innerHTML =
      '<p class="hint" style="padding:12px 14px;">Tapez un nom, un numéro de boîte ou un code de retrait.</p>';
    palette.resultats = [];
    palette.choix = 0;
    $('paletteInput').focus();
  }

  function fermerPalette() {
    palette.ouverte = false;
    $('palette').hidden = true;
  }

  /** Cherche partout à la fois, et dit d'où vient chaque réponse. */
  function chercherPartout(requete) {
    const q = requete.trim();
    if (!q) return [];
    const out = [];

    // Un code à quatre chiffres est sans ambiguïté : il passe en tête.
    if (/^\d{4}$/.test(q)) {
      S.history.forEach(function (h) {
        if (h.pickupCode === q && enAttente(h)) {
          out.push({
            genre: 'code',
            titre: h.name,
            detail: 'Code ' + q + ' — ' + util.typeCourrier(h.type).label + ' en attente',
            action: function () {
              showPanel('remise');
              $('pickupCode').value = q;
              chercherParCode();
            }
          });
        }
      });
    }

    S.contacts.forEach(function (c) {
      if (!deLAntenne(c) || !util.matchesQuery(c, q, 'tout')) return;
      const enAttentePour = S.history.filter(function (h) {
        return enAttente(h) && (h.contactId === c.id || util.normalize(h.email) === util.normalize(c.email));
      }).length;
      out.push({
        genre: 'destinataire',
        titre: c.name,
        detail:
          (c.box ? 'boîte ' + c.box + ' · ' : '') +
          c.email +
          (enAttentePour ? ' · ' + enAttentePour + ' en attente' : ''),
        action: function () {
          ouvrirFiche(c.id);
        }
      });
    });

    S.history.forEach(function (h) {
      if (!enAttente(h)) return;
      if (!util.matchesQuery({ name: h.name, email: h.email, box: '' }, q, 'nom')) return;
      out.push({
        genre: 'courrier',
        titre: h.name,
        detail:
          util.typeCourrier(h.type).label +
          ' reçu le ' + util.formatJour(h.date.slice(0, 10)) +
          (h.pickupCode ? ' · code ' + h.pickupCode : ''),
        action: function () {
          showPanel('remise');
          view.attenteFilter = h.name;
          $('attenteFilter').value = h.name;
          renderPending();
        }
      });
    });

    // Trente lignes suffisent : au-delà, c'est la recherche qu'il faut préciser.
    return out.slice(0, 30);
  }

  const GENRE_PALETTE = {
    code: 'Code de retrait',
    destinataire: 'Destinataire',
    courrier: 'Courrier en attente'
  };

  function renderPalette() {
    const boite = $('paletteResultats');
    if (palette.resultats.length === 0) {
      boite.innerHTML = '<p class="hint" style="padding:12px 14px;">Aucun résultat.</p>';
      return;
    }
    boite.innerHTML = palette.resultats
      .map(function (r, i) {
        return (
          '<button type="button" class="palette-ligne' + (i === palette.choix ? ' actif' : '') + '" data-i="' + i + '">' +
          '<span class="palette-genre">' + esc(GENRE_PALETTE[r.genre]) + '</span>' +
          '<span class="palette-titre">' + esc(r.titre) + '</span>' +
          '<span class="palette-detail">' + esc(r.detail) + '</span>' +
          '</button>'
        );
      })
      .join('');
    boite.querySelectorAll('button[data-i]').forEach(function (b) {
      b.addEventListener('click', function () {
        lancerPalette(Number(b.dataset.i));
      });
    });
  }

  function lancerPalette(i) {
    const r = palette.resultats[i];
    if (!r) return;
    fermerPalette();
    r.action();
  }

  $('paletteInput').addEventListener('input', function (e) {
    palette.resultats = chercherPartout(e.target.value);
    palette.choix = 0;
    renderPalette();
  });

  $('paletteInput').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (palette.resultats.length === 0) return;
      palette.choix =
        (palette.choix + (e.key === 'ArrowDown' ? 1 : -1) + palette.resultats.length) % palette.resultats.length;
      renderPalette();
      const actif = $('paletteResultats').querySelector('.actif');
      if (actif && actif.scrollIntoView) actif.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      lancerPalette(palette.choix);
    }
  });

  $('palette').addEventListener('click', function (e) {
    if (e.target === $('palette')) fermerPalette();
  });

  /* ═════════════ courriers en attente ═════════════ */

  /* ═════════════ à prévenir par téléphone ═════════════

     Le courrier des personnes sans adresse électronique. Il est arrivé, aucun
     message n'a pu partir, et sans cette liste il dormirait dans le registre
     sans que personne ne sache qu'il attend quelqu'un. */
  function listeAppels() {
    return BC.appels.listeDuJour(S.history.filter(deLAntenne));
  }

  function renderAppels() {
    const carte = $('appelsCard');
    if (!carte) return;
    const liste = listeAppels();
    carte.hidden = liste.length === 0;
    $('countAppels').textContent = liste.length;
    if (!liste.length) return;

    /* Deux motifs dans la même liste, et il faut qu'ils se distinguent d'un
       coup d'œil : « à prévenir » ne sait rien, « à rappeler » a déjà été
       jointe et n'est pas venue. On ne dit pas la même chose au téléphone. */
    const combien = function (motif) {
      return liste.filter(function (l) {
        return l.motif === motif;
      }).length;
    };
    const rappels = combien('rappeler');
    $('appelsResume').textContent = rappels
      ? combien('prevenir') + ' à prévenir · ' + rappels + ' à rappeler'
      : '';

    $('appelsTable').innerHTML =
      '<div class="table-scroll"><table><thead><tr><th>Nom</th><th>Téléphone</th>' +
      '<th>Boîte</th><th>Arrivé</th><th>Appels</th><th></th></tr></thead><tbody>' +
      liste
        .map(function (l) {
          const h = l.entree;
          const c = S.contacts.find(function (x) {
            return x.id === h.contactId;
          });
          const tel = h.telephone || (c && c.telephone) || '';
          const jours = joursDepuis(h.date);
          const rappel = l.motif === 'rappeler';
          return (
            '<tr><td><strong>' + esc(h.name) + '</strong>' +
            (rappel
              ? '<span class="absence-tag">à rappeler — prévenue il y a ' + l.depuis + ' j</span>'
              : '') +
            '</td>' +
            // Le numéro en gros : c'est ce qu'on recopie sur le clavier.
            '<td class="tel-cell">' + (tel ? esc(tel) : '<em>aucun numéro</em>') + '</td>' +
            '<td class="box-cell">' + esc((c && c.box) || '—') + '</td>' +
            '<td class="attente-cell' + (jours >= 7 ? ' vieux' : '') + '">' +
            (jours === 0 ? 'aujourd’hui' : 'il y a ' + jours + ' j') + '</td>' +
            '<td class="attente-cell">' +
            (l.tentatives ? l.tentatives + ' appel(s)' : '—') +
            '</td>' +
            '<td class="actions">' +
            '<button class="link-btn" data-appel-joint="' + esc(h.id) + '">' +
            (rappel ? 'Rappelée' : 'Prévenue') + '</button>' +
            '<button class="link-btn" data-appel-vain="' + esc(h.id) + '">Sans réponse</button>' +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  }

  /* ── quand c'est la personne qui appelle ──────────────────────────────
     L'inverse de la carte précédente. Elle téléphone pour savoir si elle a du
     courrier ; c'est une manifestation au sens du décompte des trois mois, et
     rien ne permettait de l'inscrire. */
  /* Vu, ou seulement entendu : le décompte ne fait pas la différence, l'équipe
     si. Quelqu'un qu'on n'a pas vu depuis trois mois mais qui téléphone n'est
     pas dans la même situation que quelqu'un qui a disparu. */
  const MOYEN_LIBELLE = {
    place: 'passage',
    telephone: 'appel de sa part',
    retrait: 'courrier retiré',
    ouverture: 'ouverture du dossier'
  };

  function libelleMoyen(moyen) {
    return MOYEN_LIBELLE[moyen] || '';
  }

  function domicilieVises() {
    return S.contacts.filter(function (c) {
      return c.domicilie && !c.domiciliationCloseLe && deLAntenne(c);
    });
  }

  function renderAppelEntrant() {
    const carte = $('appelEntrantCard');
    if (!carte) return;
    const liste = domicilieVises();
    // Sans domiciliation, la notion de manifestation n'a pas d'objet.
    carte.hidden = liste.length === 0;
    if (carte.hidden) return;

    $('domicilieListe').innerHTML = util
      .sortByName(liste)
      .map(function (c) {
        // Le nom seul dans la valeur : c'est lui qu'on retape au téléphone.
        return '<option value="' + esc(c.name) + '">' + esc(c.box ? 'boîte ' + c.box : '') + '</option>';
      })
      .join('');
  }

  /** Retrouve la personne à partir de ce qui a été tapé : nom, ou numéro de boîte. */
  function contactAppelant(saisie) {
    const q = util.normalize(saisie);
    if (!q) return null;
    const liste = domicilieVises();
    return (
      liste.find(function (c) {
        return util.normalize(c.name) === q;
      }) ||
      liste.find(function (c) {
        return c.box && util.normalize(c.box) === q;
      }) ||
      null
    );
  }

  $('appelEntrantBtn').addEventListener('click', async function () {
    const champ = $('appelEntrantNom');
    const c = contactAppelant(champ.value);
    if (!c) {
      setMsg('appelEntrantMsg', 'error', 'Personne domiciliée introuvable sous ce nom ou cette boîte.');
      return;
    }

    /* Son courrier en attente : elle vient précisément d'apprendre qu'il est
       là. La laisser sur la liste des appels à passer reviendrait à la
       rappeler demain pour lui dire ce qu'elle sait déjà. */
    const siens = S.history.filter(function (h) {
      return enAttente(h) && h.contactId === c.id && !h.email && h.status !== 'prévenu';
    });

    const btn = $('appelEntrantBtn');
    btn.disabled = true;
    try {
      await store.enregistrerPassage(c.id, '', { moyen: 'telephone' });
      for (const h of siens) {
        await store.noterAppel(h.id, { joint: true, note: 'a appelé le bureau' });
      }
      champ.value = '';
      setMsg(
        'appelEntrantMsg',
        'ok',
        'Appel de ' + esc(c.name) + ' noté.' +
          (siens.length
            ? ' ' + siens.length + ' courrier(s) marqué(s) annoncé(s) : elle sait qu’ils l’attendent.'
            : ' Aucun courrier ne l’attend pour l’instant.')
      );
      renderAll();
    } catch (err) {
      setMsg('appelEntrantMsg', 'error', esc(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('appelEntrantNom').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('appelEntrantBtn').click();
    }
  });

  $('appelsCard').addEventListener('click', async function (e) {
    const joint = e.target.closest('button[data-appel-joint]');
    const vain = e.target.closest('button[data-appel-vain]');
    const b = joint || vain;
    if (!b) return;
    b.disabled = true;
    try {
      await store.noterAppel(b.dataset.appelJoint || b.dataset.appelVain, { joint: !!joint });
      toast(joint ? 'Appel noté : la personne est prévenue.' : 'Tentative notée — le courrier reste à annoncer.', 'ok');
      renderAll();
    } catch (err) {
      toast('Enregistrement impossible : ' + err.message, 'error');
      b.disabled = false;
    }
  });

  function renderPending() {
    const box = $('pendingCard');
    const attente = S.history.filter(function (h) {
      return enAttente(h) && deLAntenne(h);
    });
    $('countAttente').textContent = attente.length;
    ui.majCompteur($('tabCountAttente'), attente.length);

    if (attente.length === 0) {
      box.innerHTML = '<div class="empty">Aucun courrier en attente. Tout est retiré.</div>';
      return;
    }

    const filtre = view.attenteFilter.trim();
    const visibles = attente.filter(function (h) {
      if (!filtre) return true;
      const contact = S.contacts.find(function (c) {
        return c.id === h.contactId;
      });
      return util.matchesQuery({ name: h.name, email: h.email, box: (contact && contact.box) || '' }, filtre, 'tout');
    });

    if (visibles.length === 0) {
      box.innerHTML = '<div class="empty">Aucun courrier en attente ne correspond au filtre.</div>';
      return;
    }

    /* Les urgents en tête, puis du plus ancien au plus récent : un courrier
       urgent reçu ce matin passe avant une publicité qui traîne depuis un mois. */
    const anciens = visibles.slice().sort(function (a, b) {
      if (!!a.urgent !== !!b.urgent) return a.urgent ? -1 : 1;
      return new Date(a.date) - new Date(b.date);
    });
    const jourMax = joursDepuis(anciens[0].date);

    box.innerHTML =
      '<p class="hint" style="margin-bottom:12px;">' +
      (jourMax >= 7 ? 'Le plus ancien attend depuis ' + jourMax + ' jours.' : 'Rien de très ancien.') +
      '</p>' +
      '<div class="table-scroll"><table><thead><tr><th>Attente</th><th>N° boîte</th><th>Nom</th><th>Code</th><th></th></tr></thead><tbody>' +
      anciens
        .map(function (h) {
          const contact = S.contacts.find(function (c) {
            return c.id === h.contactId;
          });
          const jours = joursDepuis(h.date);
          return (
            '<tr' +
            (h.urgent ? ' class="urgent"' : jours >= 7 ? ' class="vieux"' : '') +
            '><td class="attente-cell">' +
            (jours === 0 ? 'aujourd’hui' : jours + ' j') +
            '</td><td class="box-cell">' +
            ((contact && contact.box) || '—') +
            '</td><td>' +
            esc(h.name) +
            (h.urgent ? '<span class="urgent-tag">urgent</span>' : '') +
            '</td><td class="box-cell">' +
            esc(h.pickupCode || '—') +
            '</td><td class="actions">' +
            '<button class="link-btn" data-pickup="' +
            esc(h.id) +
            '">Remettre</button>' +
            (store.canSendAutomatically()
              ? '<button class="link-btn" data-remind="' + esc(h.id) + '">Relancer</button>'
              : '') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
    brancherSuivi(box);
  }

  $('attenteFilter').addEventListener('input', function (e) {
    view.attenteFilter = e.target.value;
    renderPending();
  });

  /* ═════════════ fiche d'un destinataire ═════════════ */

  function ouvrirFiche(contactId) {
    const c = S.contacts.find(function (x) {
      return x.id === contactId;
    });
    if (!c) return;

    const courriers = S.history.filter(function (h) {
      return h.contactId === c.id || util.normalize(h.email) === util.normalize(c.email);
    });
    const retires = courriers.filter(function (h) {
      return h.pickedUpAt;
    });
    // Délai moyen de retrait : le chiffre qui dit si la personne vient vite.
    const delais = retires.map(function (h) {
      return (new Date(h.pickedUpAt) - new Date(h.date)) / 86400000;
    });
    const moyenne = delais.length
      ? Math.round((delais.reduce(function (a, b) { return a + b; }, 0) / delais.length) * 10) / 10
      : null;

    $('ficheTitre').textContent = c.name;
    $('ficheCorps').innerHTML =
      '<dl class="status-list">' +
      [
        ['Numéro de boîte', c.box || '—'],
        ['Courriel', c.email || '— sans adresse électronique'],
        ['Téléphone', c.telephone || '—'],
        ['Courriers reçus', String(courriers.length)],
        ['Retirés', String(retires.length)],
        ['En attente', String(courriers.filter(enAttente).length)],
        ['Délai moyen de retrait', moyenne === null ? '—' : moyenne + ' jour(s)'],
        [
          'Retirés par un tiers',
          String(
            retires.filter(function (h) {
              return h.remisA;
            }).length
          )
        ],
        [
          'Présence',
          util.presence(c).etat === 'present' ? 'présent·e' : util.presence(c).message
        ]
      ]
        .concat(blocDomiciliation(c))
        .map(function (r) {
          return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
        })
        .join('') +
      '</dl>' +
      (courriers.length
        ? '<h3 class="sous-titre">Ses courriers</h3><div class="table-scroll" style="max-height:38vh;">' +
          '<table><thead><tr><th>Reçu le</th><th>Type</th><th>État</th><th>Code</th></tr></thead><tbody>' +
          courriers
            .slice()
            .sort(function (a, b) {
              return new Date(b.date) - new Date(a.date);
            })
            .map(function (h) {
              const etat = etatCourrier(h);
              const libelle = {
                attente: 'En attente',
                relance: 'Relancé',
                signale: 'À traiter',
                recupere: 'Récupéré',
                clos: 'Classé',
                echec: 'Échec'
              }[etat];
              return (
                '<tr' +
                (etat === 'signale' ? ' class="vieux"' : '') +
                '><td>' +
                esc(util.formatDateTime(h.date)) +
                '</td><td>' +
                esc(util.typeCourrier(h.type).label) +
                '</td><td>' +
                esc(libelle) +
                (etat === 'attente' || etat === 'relance' ? ' (' + joursDepuis(h.date) + ' j)' : '') +
                '</td><td class="box-cell">' +
                (enAttente(h) && h.pickupCode ? esc(h.pickupCode) : '—') +
                '</td></tr>'
              );
            })
            .join('') +
          '</tbody></table></div>'
        : '<p class="hint">Aucun courrier reçu pour l’instant.</p>');

    /* L'attestation ne se propose que pour une domiciliation en cours : sur la
       fiche de quelqu'un qui n'est pas domicilié, le bouton n'aurait aucun
       sens. */
    const boutonAttestation = $('ficheAttestationBtn');
    /* Le drapeau reste sur le bouton : quand on sort du mode correction, il
       faut savoir s'il avait le droit d'être là avant, et « hidden » seul ne
       le dit plus. */
    boutonAttestation.dataset.possible = c.domicilie && !c.domiciliationCloseLe ? 'oui' : 'non';
    boutonAttestation.dataset.contact = c.id;

    /* Corriger touche au registre. Sans compte, tout est ouvert ; avec un
       compte limité, on ne propose pas un geste que le serveur refusera. */
    $('ficheModifierBtn').dataset.possible =
      !S.auth.user || roles.peut(S.auth.user, 'registre') ? 'oui' : 'non';

    // Toute fiche s'ouvre en lecture, même si la précédente était en correction.
    modeEditionFiche(false);

    const dlg = $('ficheDialog');
    dlg.dataset.contact = c.id;
    if (typeof dlg.showModal === 'function') dlg.showModal();
  }

  $('ficheAttestationBtn').addEventListener('click', function (e) {
    $('ficheDialog').close();
    impression.imprimerAttestation(e.currentTarget.dataset.contact);
  });

  /* ── corriger une fiche ──────────────────────────────────────────────
     La ligne du registre ne laissait corriger que le nom, le courriel et la
     boîte. Une faute de frappe sur une date de naissance, un numéro qui
     change : c'était définitif. Ici tout se reprend. */
  remplirLangues($('fedLangue'), 'fr');

  function modeEditionFiche(actif) {
    $('ficheEdition').hidden = !actif;
    $('ficheCorps').hidden = actif;
    $('fedEnregistrerBtn').hidden = !actif;
    $('fedAnnulerBtn').hidden = !actif;
    $('ficheModifierBtn').hidden = actif || $('ficheModifierBtn').dataset.possible !== 'oui';
    $('ficheAttestationBtn').hidden = actif || $('ficheAttestationBtn').dataset.possible !== 'oui';
  }

  function remplirEditionFiche(c) {
    $('fedNom').value = c.name || '';
    $('fedBoite').value = c.box || '';
    $('fedCourriel').value = c.email || '';
    $('fedTelephone').value = c.telephone || '';
    $('fedNaissance').value = c.naissance || '';
    $('fedLangue').value = util.langue(c.langue).id;
    $('fedNotes').value = c.notes || '';

    const liste = antennes();
    $('fedAntenneBloc').hidden = liste.length === 0;
    if (liste.length) {
      $('fedAntenne').innerHTML =
        '<option value="">—</option>' +
        liste
          .map(function (a) {
            return '<option value="' + esc(a.id) + '">' + esc(a.nom) + '</option>';
          })
          .join('');
      $('fedAntenne').value = c.antenneId || '';
    }

    $('fedDomiBloc').hidden = !c.domicilie;
    $('fedDepuis').value = c.domicilieDepuis || '';
    $('fedJusqua').value = c.domicilieJusqua || '';
    setMsg('fedMsg', '', '');
  }

  $('ficheModifierBtn').addEventListener('click', function () {
    const c = S.contacts.find(function (x) {
      return x.id === $('ficheDialog').dataset.contact;
    });
    if (!c) return;
    remplirEditionFiche(c);
    modeEditionFiche(true);
    $('fedNom').focus();
  });

  $('fedAnnulerBtn').addEventListener('click', function () {
    modeEditionFiche(false);
  });

  $('fedEnregistrerBtn').addEventListener('click', async function () {
    const id = $('ficheDialog').dataset.contact;
    const c = S.contacts.find(function (x) {
      return x.id === id;
    });
    if (!c) return;

    const nom = $('fedNom').value.trim();
    const courriel = $('fedCourriel').value.trim();
    const tel = $('fedTelephone').value.trim();

    if (!nom) return setMsg('fedMsg', 'error', 'Le nom ne peut pas être vide.');
    if (courriel && !util.isValidEmail(courriel)) {
      return setMsg('fedMsg', 'error', 'Cette adresse électronique n’est pas valide.');
    }
    if (!courriel && !tel) {
      return setMsg('fedMsg', 'error', 'Gardez au moins un courriel ou un téléphone.');
    }

    const btn = $('fedEnregistrerBtn');
    btn.disabled = true;
    try {
      await store.updateContact(id, {
        name: nom,
        email: courriel,
        telephone: tel,
        box: $('fedBoite').value.trim(),
        naissance: $('fedNaissance').value,
        langue: $('fedLangue').value,
        antenneId: antennes().length ? $('fedAntenne').value : '',
        notes: $('fedNotes').value.trim(),
        domicilie: !!c.domicilie,
        domicilieDepuis: c.domicilie ? $('fedDepuis').value : '',
        /* L'échéance courante voyage avec la modification : sans elle, le
           serveur la recalculerait depuis la date d'élection et annulerait
           silencieusement le dernier renouvellement. */
        domicilieJusqua: c.domicilie ? $('fedJusqua').value : '',
        domiciliationCloseLe: c.domiciliationCloseLe || '',
        domiciliationMotif: c.domiciliationMotif || '',
        absentUntil: c.absentUntil || ''
      });
      toast('Fiche de ' + nom + ' corrigée.', 'ok');
      $('ficheDialog').close();
      renderAll();
    } catch (err) {
      setMsg('fedMsg', 'error', esc(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('ficheFermer').addEventListener('click', function () {
    $('ficheDialog').close();
  });

  /* ═════════════ dossier des courriers signalés ═════════════ */

  function renderDossier() {
    const signales = S.history.filter(function (h) {
      return etatCourrier(h) === 'signale';
    });
    const classes = S.history.filter(function (h) {
      return etatCourrier(h) === 'clos';
    });
    $('countDossier').textContent = signales.length;
    ui.majCompteur($('tabCountDossier'), signales.length);

    /* Bilan des relances : c'est le chiffre qui dit si relancer sert à quelque
       chose, et qui répond à « qui a récupéré, qui n'a pas ». */
    const relances = S.history.filter(function (h) {
      return (h.reminderCount || 0) > 0;
    });
    const apresRelance = relances.filter(function (h) {
      return !!h.pickedUpAt;
    });
    $('relanceBilan').innerHTML = [
      ['Courriers relancés', String(relances.length)],
      ['Récupérés après relance', apresRelance.length + (relances.length ? ' sur ' + relances.length : '')],
      ['Toujours pas récupérés', String(relances.length - apresRelance.length)],
      ['Dans le dossier à traiter', String(signales.length)],
      ['Classés sans retrait', String(classes.length)]
    ]
      .map(function (r) {
        return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
      })
      .join('');

    $('dossierExplication').textContent =
      'Un courrier arrive ici quand il n’a pas été retiré après la relance. ' +
      'À vous de décider : le remettre en main propre, le renvoyer, ou le classer.';

    const box = $('dossierTable');
    if (signales.length === 0) {
      box.innerHTML = '<div class="empty">Aucun courrier à traiter. Tout est retiré ou en cours.</div>';
    } else {
      box.innerHTML =
        '<div class="table-scroll"><table><thead><tr><th>Attente</th><th>N° boîte</th><th>Nom</th><th>Courriel</th><th>Relances</th><th></th></tr></thead><tbody>' +
        signales
          .slice()
          .sort(function (a, b) {
            return new Date(a.date) - new Date(b.date);
          })
          .map(function (h) {
            const contact = S.contacts.find(function (c) {
              return c.id === h.contactId;
            });
            return (
              '<tr class="vieux"><td class="attente-cell">' +
              joursDepuis(h.date) +
              ' j</td><td class="box-cell">' +
              ((contact && contact.box) || '—') +
              '</td><td>' +
              esc(h.name) +
              '</td><td>' +
              esc(h.email) +
              '</td><td class="attente-cell">' +
              (h.reminderCount || 0) +
              '</td><td class="actions">' +
              '<button class="link-btn" data-pickup="' + esc(h.id) + '">Récupéré</button>' +
              (store.canSendAutomatically()
                ? '<button class="link-btn" data-remind="' + esc(h.id) + '">Relancer</button>'
                : '') +
              '<button class="link-btn danger" data-close="' + esc(h.id) + '">Classer</button>' +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
      brancherSuivi(box);
      brancherCloture(box);
    }

    const closBox = $('closedTable');
    closBox.innerHTML = classes.length
      ? '<div class="table-scroll"><table><thead><tr><th>Nom</th><th>Reçu le</th><th>Classé le</th><th>Motif</th><th></th></tr></thead><tbody>' +
        classes
          .map(function (h) {
            return (
              '<tr><td>' +
              esc(h.name) +
              '</td><td>' +
              esc(util.formatDateTime(h.date)) +
              '</td><td>' +
              esc(util.formatDateTime(h.closedAt)) +
              '</td><td>' +
              esc(h.closeReason || '—') +
              (h.closedBy ? ' <span class="hint">(' + esc(h.closedBy) + ')</span>' : '') +
              '</td><td class="actions"><button class="link-btn" data-unclose="' +
              esc(h.id) +
              '">Rouvrir</button></td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>'
      : '<div class="empty">Aucun courrier classé.</div>';
    brancherCloture(closBox);
  }

  function brancherCloture(racine) {
    racine.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const raison = root.prompt(
          'Qu’est-il advenu de ce courrier ?\n(retourné à l’expéditeur, remis en main propre, détruit…)'
        );
        if (!raison || !raison.trim()) return;
        try {
          await store.closeMail(btn.dataset.close, raison.trim());
          toast('Courrier classé.');
        } catch (err) {
          toast('Impossible : ' + err.message, 'error');
        }
      });
    });
    racine.querySelectorAll('[data-unclose]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          await store.closeMail(btn.dataset.unclose, null);
          toast('Courrier rouvert.');
        } catch (err) {
          toast('Impossible : ' + err.message, 'error');
        }
      });
    });
  }

  $('exportDossierXlsxBtn').addEventListener('click', function () {
    const lignes = S.history
      .filter(function (h) {
        return etatCourrier(h) === 'signale';
      })
      .map(function (h) {
        const contact = S.contacts.find(function (c) {
          return c.id === h.contactId;
        });
        return {
          jours: joursDepuis(h.date),
          boite: (contact && contact.box) || '',
          nom: h.name,
          courriel: h.email,
          recu: new Date(h.date),
          relances: h.reminderCount || 0,
          derniereRelance: h.remindedAt ? new Date(h.remindedAt) : '',
          signale: h.flaggedAt ? new Date(h.flaggedAt) : ''
        };
      });
    if (lignes.length === 0) {
      toast('Aucun courrier à traiter.', 'error');
      return;
    }
    downloadBytes(
      'a-traiter-' + stampSuffix() + '.xlsx',
      root.BC.xlsx.build({
        sheetName: 'À traiter',
        columns: [
          { key: 'jours', label: 'Jours d’attente', width: 15 },
          { key: 'boite', label: 'N° de boîte', width: 13 },
          { key: 'nom', label: 'Nom', width: 28 },
          { key: 'courriel', label: 'Courriel', width: 34 },
          { key: 'recu', label: 'Reçu le', width: 20, type: 'date' },
          { key: 'relances', label: 'Relances', width: 11 },
          { key: 'derniereRelance', label: 'Dernière relance', width: 20, type: 'date' },
          { key: 'signale', label: 'Signalé le', width: 20, type: 'date' }
        ],
        rows: lignes
      }),
      MIME_XLSX
    );
    toast('Dossier exporté.', 'ok');
  });

  /* Lignes de domiciliation ajoutées à la fiche du destinataire. Vide pour qui
     n'est pas domicilié : inutile d'encombrer la fiche d'un dispositif qui ne
     le concerne pas. */
  function blocDomiciliation(contact) {
    if (!contact.domicilie) return [];
    const e = domi.etat(contact, S.history);
    const lignes = [['Domiciliation', e.libelle]];
    if (e.etat !== 'close') {
      lignes.push([
        'Élection de domicile',
        e.debut ? util.formatJour(e.debut) : '—'
      ]);
      lignes.push([
        'Dernier signe de vie',
        e.dernierPassage
          ? util.formatJour(e.dernierPassage.slice(0, 10)) +
            ' (' + e.joursSansPassage + ' j)' +
            (libelleMoyen(e.dernierMoyen) ? ' — ' + libelleMoyen(e.dernierMoyen) : '') +
            (e.absenceDepassee ? ' — seuil de ' + e.seuilAbsenceJours + ' j dépassé' : '')
          : '—'
      ]);
    } else if (e.motif) {
      lignes.push(['Motif de clôture', e.motif]);
    }
    return lignes;
  }

  /* ═════════════ formulaire de domiciliation ═════════════ */

  /* Ouvrir un dossier d'élection de domicile, et inscrire la personne au
     registre du même geste. Sans ce formulaire, l'accueil saisissait deux fois
     — une fois sur papier, une fois dans l'application — et les notifications
     de courrier ne partaient qu'après la seconde saisie, quand elle avait lieu. */

  remplirLangues($('domLangue'), 'fr');

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
      renderAll();
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
    if (S.mode !== 'serveur' || sessionManquante()) {
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
    const entete =
      colonne === 'echeance'
        ? '<th>Échéance</th><th>État</th>'
        : '<th>Dernier passage</th><th>Sans nouvelles</th>';
    return (
      '<div class="table-scroll"><table><thead><tr><th>N° boîte</th><th>Nom</th>' +
      entete +
      '<th></th></tr></thead><tbody>' +
      lignes
        .map(function (l) {
          const e = l.etat;
          const pill = ETAT_DOMI[e.etat] || ETAT_DOMI.aucune;
          const cellules =
            colonne === 'echeance'
              ? '<td class="attente-cell">' +
                (e.echeance ? esc(util.formatJour(e.echeance)) : '—') +
                '</td><td><span class="status-pill ' + pill[0] + '">' + pill[1] + '</span></td>'
              : '<td class="attente-cell">' +
                (e.dernierPassage ? esc(util.formatJour(e.dernierPassage.slice(0, 10))) : '—') +
                (libelleMoyen(e.dernierMoyen)
                  ? '<span class="absence-tag">' + esc(libelleMoyen(e.dernierMoyen)) + '</span>'
                  : '') +
                '</td><td class="attente-cell' + (e.absenceDepassee ? ' vieux' : '') + '">' +
                (e.joursSansPassage === null ? '—' : e.joursSansPassage + ' j') +
                (e.absenceDepassee ? ' — seuil dépassé' : '') +
                '</td>';
          return (
            '<tr><td class="box-cell">' +
            esc(l.box || '—') +
            '</td><td>' +
            esc(l.name) +
            '</td>' +
            cellules +
            '<td class="actions">' +
            '<button class="link-btn" data-domifiche="' + esc(l.id) + '">Fiche</button>' +
            '<button class="link-btn" data-attestation="' + esc(l.id) + '">Attestation</button>' +
            '<button class="link-btn" data-renouveler="' + esc(l.id) + '">Renouveler</button>' +
            /* Prévenir la personne, pas seulement le signaler à l'équipe. Le
               sujet suit la liste : échéance d'attestation ou absence. */
            '<button class="link-btn" data-avis="' + esc(l.id) + '" data-sujet="' +
            (colonne === 'echeance' ? 'renouvellement' : 'absence') + '">Prévenir</button>' +
            '<button class="link-btn" data-passage="' + esc(l.id) + '">Noter un passage</button>' +
            '<button class="link-btn danger" data-clore="' + esc(l.id) + '">Clore</button>' +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>'
    );
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
    if (fiche) return ouvrirFiche(fiche.dataset.domifiche);
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

  /* ═════════════ statistiques ═════════════ */

  /* Vrai quand le serveur exigera une session que nous n'avons pas : inutile
     d'aller chercher des données qui reviendront en 401. */
  function sessionManquante() {
    return S.auth.accountsExist && !S.auth.user;
  }

  async function renderStats() {
    const box = $('statsCorps');
    if (S.mode !== 'serveur') {
      // Hors serveur, on calcule sur ce que ce poste connaît.
      box.innerHTML = '<p class="hint">Statistiques du registre de ce poste.</p>' + tableauStats(statsLocales());
      return;
    }
    if (sessionManquante()) {
      box.innerHTML = '';
      return;
    }
    try {
      box.innerHTML = tableauStats(await store.loadStats());
    } catch (err) {
      box.innerHTML = '<div class="empty">Statistiques indisponibles.</div>';
    }
  }

  function statsLocales() {
    const periode = function (jours) {
      const depuis = Date.now() - jours * 86400000;
      const recus = S.history.filter(function (h) {
        return new Date(h.date).getTime() >= depuis;
      });
      const retires = recus.filter(function (h) {
        return h.pickedUpAt;
      });
      return { recus: recus.length, retires: retires.length, taux: recus.length ? Math.round((retires.length / recus.length) * 100) : null };
    };
    return { total: S.history.length, semaine: periode(7), mois: periode(30), annee: periode(365), boitesActives: [], parType: {} };
  }

  function tableauStats(st) {
    const ligne = function (titre, p) {
      return (
        '<tr><td>' +
        titre +
        '</td><td class="attente-cell">' +
        p.recus +
        '</td><td class="attente-cell">' +
        p.retires +
        '</td><td class="attente-cell">' +
        (p.taux === null ? '—' : p.taux + ' %') +
        '</td></tr>'
      );
    };
    return (
      '<div class="table-scroll"><table><thead><tr><th>Période</th><th>Reçus</th><th>Retirés</th><th>Taux</th></tr></thead><tbody>' +
      ligne('7 derniers jours', st.semaine) +
      ligne('30 derniers jours', st.mois) +
      ligne('12 derniers mois', st.annee) +
      '</tbody></table></div>' +
      '<dl class="status-list" style="margin-top:16px;">' +
      [
        ['Total consigné', String(st.total)],
        ['Délai moyen de retrait', st.delaiMoyenJours == null ? '—' : st.delaiMoyenJours + ' jour(s)'],
        ['Courriers relancés', String(st.relances || 0)],
        ['À traiter', String(st.signales || 0)]
      ]
        .map(function (r) {
          return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
        })
        .join('') +
      '</dl>' +
      (st.boitesActives && st.boitesActives.length
        ? '<h3 class="sous-titre">Boîtes les plus actives</h3><div class="table-scroll"><table><tbody>' +
          st.boitesActives
            .map(function (b) {
              return '<tr><td class="box-cell">' + esc(b.boite) + '</td><td class="attente-cell">' + b.courriers + '</td></tr>';
            })
            .join('') +
          '</tbody></table></div>'
        : '')
    );
  }

  /* ═════════════ journal d'activité ═════════════ */

  async function renderJournal() {
    const carte = $('journalCard');
    carte.hidden = S.mode !== 'serveur' || sessionManquante();
    if (carte.hidden) return;
    try {
      const data = await store.loadJournal(100);
      $('journalTable').innerHTML = data.entrees.length
        ? '<div class="table-scroll"><table><thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Sur</th></tr></thead><tbody>' +
          data.entrees
            .map(function (e) {
              return (
                '<tr><td class="attente-cell">' +
                esc(util.formatDateTime(e.at)) +
                '</td><td>' +
                esc(e.qui || '—') +
                '</td><td>' +
                esc(e.action) +
                '</td><td>' +
                esc(e.cible) +
                (e.details ? ' <span class="hint">' + esc(e.details) + '</span>' : '') +
                '</td></tr>'
              );
            })
            .join('') +
          '</tbody></table></div>'
        : '<div class="empty">Aucune action consignée pour l’instant.</div>';
    } catch (err) {
      $('journalTable').innerHTML = '<div class="empty">Journal indisponible.</div>';
    }
  }

  $('rafraichirJournalBtn').addEventListener('click', renderJournal);

  /* ═════════════ feuille de casier ═════════════ */

  $('feuilleCasierBtn').addEventListener('click', impression.imprimerFeuilleCasier);
  $('feuilleCasierBtn2').addEventListener('click', impression.imprimerFeuilleCasier);

  /* ═════════════ pile de courrier ═════════════ */

  function renderPileState() {
    const lignes = $('pileInput')
      .value.split(/[\n;]+/)
      .map(function (l) {
        return l.trim();
      })
      .filter(Boolean);
    $('pileState').textContent = lignes.length ? '· ' + lignes.length + ' ligne(s)' : '';
    return lignes;
  }

  $('pileInput').addEventListener('input', function () {
    renderPileState();
    view.pile = [];
    $('pileSendBtn').disabled = true;
    $('pileResult').innerHTML = '';
  });

  $('pileResolveBtn').addEventListener('click', function () {
    const lignes = renderPileState();
    if (lignes.length === 0) {
      setMsg('pileResult', 'error', 'Écrivez au moins un nom ou un numéro de boîte.');
      return;
    }

    const trouves = [];
    const ambigus = [];
    const inconnus = [];
    lignes.forEach(function (ligne) {
      // Chaque ligne est cherchée d'abord comme numéro, puis comme nom : au
      // guichet on saisit indifféremment l'un ou l'autre.
      let candidats = S.contacts.filter(function (c) {
        return util.matchesQuery(c, ligne, 'boite');
      });
      if (candidats.length === 0) {
        candidats = S.contacts.filter(function (c) {
          return util.matchesQuery(c, ligne, 'nom');
        });
      }
      if (candidats.length === 1) {
        if (!trouves.some(function (t) {
            return t.contact.id === candidats[0].id;
          })) {
          trouves.push({ ligne: ligne, contact: candidats[0] });
        }
      } else if (candidats.length > 1) {
        ambigus.push({ ligne: ligne, nombre: candidats.length });
      } else {
        inconnus.push(ligne);
      }
    });

    view.pile = trouves;
    $('pileSendBtn').disabled = trouves.length === 0;

    let html = '';
    if (trouves.length) {
      html +=
        '<div class="msg ok"><strong>' +
        trouves.length +
        ' destinataire(s) prêt(s)</strong><ul>' +
        trouves
          .map(function (t) {
            return (
              '<li>' +
              (t.contact.box ? '<em class="box-tag">' + esc(t.contact.box) + '</em> ' : '') +
              esc(t.contact.name) +
              ' — ' +
              esc(t.contact.email) +
              '</li>'
            );
          })
          .join('') +
        '</ul></div>';
    }
    if (ambigus.length) {
      html +=
        '<div class="msg"><strong>À préciser</strong><ul>' +
        ambigus
          .map(function (a) {
            return '<li>« ' + esc(a.ligne) +' » correspond à ' + a.nombre + ' destinataires</li>';
          })
          .join('') +
        '</ul></div>';
    }
    if (inconnus.length) {
      html +=
        '<div class="msg error"><strong>Introuvables</strong><ul>' +
        inconnus
          .map(function (i) {
            return '<li>' + esc(i) + '</li>';
          })
          .join('') +
        '</ul></div>';
    }
    $('pileResult').innerHTML = html;
  });

  $('pileSendBtn').addEventListener('click', async function () {
    if (view.pile.length === 0) return;
    const ok = await confirmDialog(
      'Notifier la pile',
      'Envoyer une notification à ' + view.pile.length + ' destinataire(s) ?',
      'Tout notifier'
    );
    if (!ok) return;

    const btn = $('pileSendBtn');
    btn.disabled = true;
    let envoyes = 0;
    let echecs = 0;
    for (const entree of view.pile) {
      btn.textContent = 'Envoi ' + (envoyes + echecs + 1) + '/' + view.pile.length + '…';
      try {
        await sendNotification(entree.contact, null, { silencieux: true });
        envoyes++;
      } catch (err) {
        echecs++;
      }
    }
    btn.textContent = 'Tout notifier';
    stamp(envoyes + ' envoyé' + (envoyes > 1 ? 's' : ''), 'Pile traitée');
    setMsg(
      'pileResult',
      echecs ? 'error' : 'ok',
      envoyes + ' notification(s) envoyée(s)' + (echecs ? ', ' + echecs + ' en échec' : '') + '.'
    );
    $('pileInput').value = '';
    view.pile = [];
    renderPileState();
  });

  /* ═════════════ registre ═════════════ */

  /* L'échéance se calcule sous les yeux de qui saisit : personne n'a à compter
     douze mois de tête, et l'erreur se voit avant d'être enregistrée. */
  function apercuEcheance() {
    const depuis = $('newDomicilieDepuis').value;
    $('newEcheanceApercu').textContent = depuis
      ? 'Attestation valable jusqu’au ' + util.formatJour(domi.echeance(depuis)) + '.'
      : 'L’échéance sera calculée à douze mois.';
  }

  /* Listes de langues. Une notification qu'on ne peut pas lire ne notifie rien :
     la langue est une propriété du destinataire, choisie à l'inscription. */
  function remplirLangues(select, valeur) {
    select.innerHTML = util.LANGUES.map(function (l) {
      return '<option value="' + l.id + '"' + (l.id === valeur ? ' selected' : '') + '>' + esc(l.label) + '</option>';
    }).join('');
  }
  remplirLangues($('newLangue'), 'fr');
  remplirLangues($('gabaritLangue'), 'fr');

  $('gabaritLangue').addEventListener('change', function (e) {
    memoriserGabaritCourant();
    view.gabaritLangue = e.target.value;
    chargerGabaritActif();
  });

  $('newDomicilie').addEventListener('change', function (e) {
    $('newDomiciliationChamps').hidden = !e.target.checked;
    if (e.target.checked) {
      if (!$('newDomicilieDepuis').value) {
        $('newDomicilieDepuis').value = new Date().toISOString().slice(0, 10);
      }
      apercuEcheance();
      $('newDomicilieDepuis').focus();
    }
  });
  $('newDomicilieDepuis').addEventListener('input', apercuEcheance);

  $('addForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const nameField = $('newName');
    const emailField = $('newEmail');
    const name = nameField.value.trim();
    const email = emailField.value.trim();
    const box = $('newBox').value.trim();

    const telephone = $('newTelephone').value.trim();

    nameField.classList.toggle('invalid', !name);
    emailField.classList.toggle('invalid', !!email && !util.isValidEmail(email));
    if (!name) {
      setMsg('addMsg', 'error', 'Indiquez le nom du destinataire.');
      return;
    }
    if (email && !util.isValidEmail(email)) {
      setMsg('addMsg', 'error', 'Cette adresse électronique n’est pas valide.');
      return;
    }
    /* Un moyen de joindre la personne, au choix. Sans l'un des deux, le
       courrier arriverait et personne ne pourrait le lui dire. */
    if (!email && !telephone) {
      setMsg('addMsg', 'error', 'Indiquez un courriel ou un téléphone : sans cela, personne ne pourra la prévenir.');
      return;
    }
    const existing = email ? store.findByEmail(email) : null;
    if (existing) {
      setMsg('addMsg', 'error', 'Ce courriel est déjà au registre sous « ' + esc(existing.name) + ' ».');
      return;
    }
    const domicilie = $('newDomicilie').checked;
    const depuis = $('newDomicilieDepuis').value;
    if (domicilie && !depuis) {
      setMsg('addMsg', 'error', 'Indiquez la date d’élection de domicile.');
      $('newDomicilieDepuis').focus();
      return;
    }
    try {
      await store.addContact({
        name: name,
        email: email,
        telephone: telephone,
        box: box,
        langue: $('newLangue').value,
        antenneId: antennes().length ? $('newAntenne').value : '',
        domicilie: domicilie,
        domicilieDepuis: domicilie ? depuis : ''
      });
      nameField.value = '';
      emailField.value = '';
      $('newTelephone').value = '';
      $('newBox').value = '';
      $('newLangue').value = 'fr';
      $('newDomicilie').checked = false;
      $('newDomicilieDepuis').value = '';
      $('newDomiciliationChamps').hidden = true;
      $('newEcheanceApercu').textContent = '';
      nameField.focus();
      setMsg(
        'addMsg',
        S.mode === 'mémoire' ? 'error' : 'ok',
        S.mode === 'mémoire'
          ? 'Destinataire ajouté pour cette session seulement (aucun stockage disponible ici).'
          : 'Destinataire ajouté au registre.'
      );
    } catch (err) {
      setMsg('addMsg', 'error', 'Enregistrement impossible : ' + esc(err.message));
    }
  });

  $('contactFilter').addEventListener('input', function (e) {
    view.contactFilter = e.target.value;
    renderContacts();
  });

  function visibleContacts() {
    const q = view.contactFilter.trim();
    // L'antenne affichée filtre avant tout le reste.
    const duBureau = S.contacts.filter(deLAntenne);
    const list = q
      ? duBureau.filter(function (c) {
          return util.matchesQuery(c, q, 'tout');
        })
      : duBureau;
    return util.sortByName(list);
  }

  /** Lit la ligne d'absence associée à un destinataire en cours de modification. */
  function lireAbsence(id) {
    const ligne = document.querySelector('tr[data-absence="' + CSS.escape(id) + '"]');
    if (!ligne) return {};
    return {
      absentUntil: ligne.querySelector('.edit-absent').value || '',
      departed: ligne.querySelector('.edit-departed').checked,
      substituteId: ligne.querySelector('.edit-substitute').value || null
    };
  }

  function renderContacts() {
    const duBureau = S.contacts.filter(deLAntenne);
    $('countContacts').textContent = duBureau.length;
    ui.majCompteur($('tabCountContacts'), duBureau.length);
    const box = $('contactsTable');
    const list = visibleContacts();

    if (S.contacts.length === 0) {
      box.innerHTML = '<div class="empty">Le registre est vide. Ajoutez un premier destinataire ci-dessus.</div>';
      return;
    }
    if (list.length === 0) {
      box.innerHTML = '<div class="empty">Aucun destinataire ne correspond au filtre.</div>';
      return;
    }

    box.innerHTML =
      /* Le téléphone a sa colonne : pour une bonne part du public, c'est le
         seul moyen de joindre quelqu'un, et le registre ne le montrait nulle
         part — il fallait ouvrir la fiche pour savoir si la personne était
         joignable du tout. */
      '<div class="table-scroll"><table><thead><tr><th>N° boîte</th><th>Nom</th><th>Courriel</th>' +
      '<th>Téléphone</th><th></th></tr></thead><tbody>' +
      list
        .map(function (c) {
          if (c.id === view.editingId) {
            return (
              '<tr data-row="' +
              esc(c.id) +
              '">' +
              '<td><input type="text" class="edit-box" value="' +
              esc(c.box || '') +
              '"></td>' +
              '<td><input type="text" class="edit-name" value="' +
              esc(c.name) +
              '"></td>' +
              '<td><input type="email" class="edit-email" value="' +
              esc(c.email) +
              '"></td>' +
              '<td><input type="text" class="edit-telephone" value="' +
              esc(c.telephone || '') +
              '"></td>' +
              '<td class="actions">' +
              '<button class="link-btn" data-save="' +
              esc(c.id) +
              '">Enregistrer</button>' +
              '<button class="link-btn" data-cancel="1">Annuler</button></td></tr>' +
              '<tr data-absence="' +
              esc(c.id) +
              '"><td colspan="5" class="absence-edit">' +
              '<label>Absent·e jusqu’au</label>' +
              '<input type="date" class="edit-absent" value="' +
              esc(c.absentUntil || '') +
              '">' +
              '<label class="inline"><input type="checkbox" class="edit-departed"' +
              (c.departed ? ' checked' : '') +
              '> a quitté l’organisme</label>' +
              '<label>Remplaçant·e</label>' +
              '<select class="edit-substitute"><option value="">— aucun —</option>' +
              util
                .sortByName(
                  S.contacts.filter(function (autre) {
                    return autre.id !== c.id;
                  })
                )
                .map(function (autre) {
                  return (
                    '<option value="' +
                    esc(autre.id) +
                    '"' +
                    (c.substituteId === autre.id ? ' selected' : '') +
                    '>' +
                    esc(autre.name) +
                    '</option>'
                  );
                })
                .join('') +
              '</select></td></tr>'
            );
          }
          return (
            '<tr>' +
            '<td class="box-cell">' +
            (c.box ? esc(c.box) : '—') +
            '</td><td>' +
            esc(c.name) +
            (util.presence(c).etat !== 'present'
              ? '<span class="absence-tag">' + esc(util.presence(c).message) + '</span>'
              : '') +
            '</td><td>' +
            (c.email ? esc(c.email) : '<span class="hint">—</span>') +
            '</td><td>' +
            (c.telephone ? esc(c.telephone) : '<span class="hint">—</span>') +
            '</td>' +
            '<td class="actions">' +
            '<button class="link-btn" data-fiche="' +
            esc(c.id) +
            '">Fiche</button>' +
            '<button class="link-btn" data-notify="' +
            esc(c.id) +
            '">Notifier</button>' +
            '<button class="link-btn" data-edit="' +
            esc(c.id) +
            '">Modifier</button>' +
            '<button class="link-btn danger" data-del="' +
            esc(c.id) +
            '">Sortir</button>' +
            '<button class="link-btn danger" data-effacer="' +
            esc(c.id) +
            '" title="Efface la fiche, son courrier et son nom au journal">Effacer</button>' +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';

    box.querySelectorAll('button[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        view.editingId = btn.dataset.edit;
        renderContacts();
        const input = box.querySelector('.edit-name');
        if (input) input.focus();
      });
    });
    box.querySelectorAll('button[data-cancel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        view.editingId = null;
        renderContacts();
      });
    });
    box.querySelectorAll('button[data-save]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const row = box.querySelector('tr[data-row="' + CSS.escape(btn.dataset.save) + '"]');
        const name = row.querySelector('.edit-name').value.trim();
        const email = row.querySelector('.edit-email').value.trim();
        // Surtout pas « box » ici : le conteneur du tableau porte déjà ce nom,
        // et la redéclaration le rendait inaccessible dès la première ligne.
        const boite = row.querySelector('.edit-box').value.trim();
        const telephone = row.querySelector('.edit-telephone').value.trim();
        const absence = lireAbsence(btn.dataset.save);

        /* La même règle qu'à l'inscription : un courriel OU un téléphone.
           Exiger le courriel ici rendait toute personne sans adresse
           définitivement incorrigible — et c'est justement le public que ce
           bureau reçoit. */
        if (!name) {
          toast('Le nom ne peut pas être vide.', 'error');
          return;
        }
        if (email && !util.isValidEmail(email)) {
          toast('Cette adresse électronique n’est pas valide.', 'error');
          return;
        }
        if (!email && !telephone) {
          toast('Gardez au moins un courriel ou un téléphone pour la joindre.', 'error');
          return;
        }
        const clash = store.findByEmail(email);
        if (clash && clash.id !== btn.dataset.save) {
          toast('Ce courriel est déjà utilisé par « ' + clash.name + ' ».', 'error');
          return;
        }
        try {
          await store.updateContact(
            btn.dataset.save,
            Object.assign({ name: name, email: email, box: boite, telephone: telephone }, absence)
          );
          view.editingId = null;
          renderContacts();
          toast('Destinataire mis à jour.', 'ok');
        } catch (err) {
          toast('Modification impossible : ' + err.message, 'error');
        }
      });
    });
    box.querySelectorAll('button[data-del]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const c = S.contacts.find(function (x) {
          return x.id === btn.dataset.del;
        });
        if (!c) return;
        /* Le courriel entre parenthèses affichait « ( ) » pour une personne
           sans adresse : on annonce ce par quoi on peut la joindre. */
        const repere = c.email || c.telephone || 'sans courriel ni téléphone';
        const ok = await confirmDialog(
          'Sortir du registre',
          'Retirer « ' + c.name + ' » (' + repere + ') du registre ? ' +
            'Son courrier passé reste à l’historique — ce n’est pas un effacement.',
          'Sortir du registre'
        );
        if (!ok) return;
        try {
          await store.removeContact(c.id);
          toast('« ' + c.name + ' » retiré du registre.');
        } catch (err) {
          toast('Suppression impossible : ' + err.message, 'error');
        }
      });
    });

    /* Effacer, pour de bon. Ce registre porte les noms et les dates de
       naissance de personnes sans domicile stable ; quand l'une d'elles
       demande à disparaître des fichiers, il faut pouvoir le faire vraiment.
       Deux confirmations, et la seconde dit ce qui part. */
    box.querySelectorAll('button[data-effacer]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const c = S.contacts.find(function (x) {
          return x.id === btn.dataset.effacer;
        });
        if (!c) return;
        const courriers = S.history.filter(function (h) {
          return h.contactId === c.id || (c.email && util.normalize(h.email) === util.normalize(c.email));
        }).length;

        const ok = await confirmDialog(
          'Effacer définitivement',
          'Effacer « ' + c.name + ' » : la fiche, ' + courriers + ' courrier(s) de son historique, ' +
            'et son nom dans le journal d’activité. Seule reste la trace de l’effacement — ' +
            'qui l’a fait et quand. C’est irréversible.',
          'Effacer définitivement'
        );
        if (!ok) return;
        try {
          const bilan = await store.removeContact(c.id, { complet: true });
          toast(
            'Effacé. ' +
              (bilan
                ? bilan.courriersEfface + ' courrier(s), ' + bilan.lignesAnonymisees + ' ligne(s) du journal.'
                : ''),
            'ok'
          );
          renderAll();
        } catch (err) {
          toast('Effacement impossible : ' + err.message, 'error');
        }
      });
    });
    box.querySelectorAll('button[data-fiche]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        ouvrirFiche(btn.dataset.fiche);
      });
    });
    box.querySelectorAll('button[data-notify]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const c = S.contacts.find(function (x) {
          return x.id === btn.dataset.notify;
        });
        if (!c) return;
        showPanel('guichet');
        nameInput.value = c.name;
        notifierEnTenantCompteDesAbsences(c);
      });
    });
  }

  /* ---------- import / export ---------- */

  function lignesRegistre() {
    return util.sortByName(S.contacts).map(function (c) {
      return { boite: c.box || '', nom: c.name, courriel: c.email };
    });
  }

  $('etiquettesBtn').addEventListener('click', function () {
    // Les destinataires affichés, filtre compris — et seulement ceux qui ont
    // une boîte : une étiquette sans numéro n'irait sur aucun casier.
    impression.imprimerEtiquettes(
      visibleContacts().filter(function (c) {
        return String(c.box || '').trim();
      })
    );
  });

  $('exportContactsBtn').addEventListener('click', function () {
    if (S.contacts.length === 0) {
      toast('Le registre est vide.', 'error');
      return;
    }
    download('destinataires-' + stampSuffix() + '.csv', util.toCsv(lignesRegistre(), ['boite', 'nom', 'courriel']));
  });

  $('exportContactsXlsxBtn').addEventListener('click', function () {
    if (S.contacts.length === 0) {
      toast('Le registre est vide.', 'error');
      return;
    }
    const classeur = root.BC.xlsx.build({
      sheetName: 'Destinataires',
      columns: [
        { key: 'boite', label: 'N° de boîte', width: 14 },
        { key: 'nom', label: 'Nom', width: 30 },
        { key: 'courriel', label: 'Courriel', width: 38 }
      ],
      rows: lignesRegistre()
    });
    downloadBytes('destinataires-' + stampSuffix() + '.xlsx', classeur, MIME_XLSX);
    toast('Classeur Excel exporté.', 'ok');
  });

  $('importBtn').addEventListener('click', function () {
    $('importFile').click();
  });

  $('importFile').addEventListener('change', function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function () {
      const result = util.parseContactsCsv(String(reader.result));
      const fresh = [];
      let duplicates = 0;
      result.contacts.forEach(function (c) {
        if (store.findByEmail(c.email) || fresh.some(function (f) {
            return util.normalize(f.email) === util.normalize(c.email);
          })) {
          duplicates++;
        } else {
          fresh.push(c);
        }
      });
      try {
        if (fresh.length) await store.addContacts(fresh);
      } catch (err) {
        setMsg('importMsg', 'error', 'Import interrompu : ' + esc(err.message));
        return;
      }
      const parts = [fresh.length + ' destinataire(s) importé(s).'];
      if (duplicates) parts.push(duplicates + ' doublon(s) ignoré(s).');
      let html = parts.join(' ');
      if (result.errors.length) {
        html +=
          '<ul>' +
          result.errors
            .slice(0, 10)
            .map(function (m) {
              return '<li>' + esc(m) + '</li>';
            })
            .join('') +
          '</ul>';
        if (result.errors.length > 10) html += '<em>… et ' + (result.errors.length - 10) + ' autre(s).</em>';
      }
      setMsg('importMsg', result.errors.length ? 'error' : 'ok', html);
    };
    reader.onerror = function () {
      setMsg('importMsg', 'error', 'Lecture du fichier impossible.');
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  });

  /* ═════════════ historique ═════════════ */

  $('historyFilter').addEventListener('input', function (e) {
    view.historyFilter = e.target.value;
    renderHistory();
  });
  $('historyDate').addEventListener('input', function (e) {
    view.historyDate = e.target.value;
    renderHistory();
  });

  /** Même classement que le serveur : clos, récupéré, échec, signalé, relancé, attente. */
  function etatCourrier(h) {
    if (h.closedAt) return 'clos';
    if (h.pickedUpAt) return 'recupere';
    if (h.status === 'échec') return 'echec';
    if (h.flaggedAt) return 'signale';
    if (h.reminderCount > 0) return 'relance';
    return 'attente';
  }

  function visibleHistory() {
    return S.history.filter(function (h) {
      if (!deLAntenne(h)) return false;
      if (view.historyDate && !util.isSameDay(h.date, view.historyDate)) return false;
      if (view.historyFilter.trim() && !util.matchesQuery(h, view.historyFilter, 'tout')) return false;
      if (view.historyState !== 'tous' && etatCourrier(h) !== view.historyState) return false;
      return true;
    });
  }

  $('historyState').addEventListener('change', function (e) {
    view.historyState = e.target.value;
    renderHistory();
  });

  /* Deux cents lignes : de quoi couvrir plusieurs semaines de courrier sans
     jamais peindre un tableau qui fige le poste. */
  const LIGNES_HISTORIQUE = 200;

  const ETAT_PILL = {
    signale: ['failed', 'À traiter', 'Non retiré après la relance : voir l’onglet Dossier.'],
    clos: ['manual', 'Classé', 'Sorti du circuit sans avoir été retiré.'],
    relance: ['manual', 'Relancé', 'Une relance a été envoyée, le courrier attend toujours.']
  };

  const STATUS_PILL = {
    'envoyé': ['', 'Envoyé', 'Parti du serveur par SMTP.'],
    'préparé': ['manual', 'À envoyer', 'Remis à votre logiciel de courriel : il reste à y cliquer sur Envoyer.'],
    'échec': ['failed', 'Échec', 'Le serveur de courriel a refusé l’envoi.']
  };

  function renderHistory() {
    /* Un seul compteur sur l'onglet « Suivi », celui des courriers à traiter :
       le total de l'historique ne demande aucune action et ne mérite pas une
       pastille. Il reste affiché en tête de sa propre carte. */
    $('countHistory').textContent = S.history.length;
    const box = $('historyTable');
    const list = visibleHistory();

    if (S.history.length === 0) {
      box.innerHTML = '<div class="empty">Aucune notification envoyée pour le moment.</div>';
      return;
    }
    if (list.length === 0) {
      box.innerHTML = '<div class="empty">Aucune notification ne correspond aux filtres.</div>';
      return;
    }

    /* L'historique ne s'efface jamais tout seul : la conservation est à zéro
       par défaut, et un bureau qui reçoit du courrier tous les jours dépasse
       les dix mille lignes en deux ans. Tout dessiner coûtait alors une
       seconde et demie — à chaque saisie faite sur le poste d'à côté, puisque
       la moindre mise à jour distante redessine tout. Le guichet se figeait
       sous les doigts de quelqu'un en train de taper.

       On borne donc ce qu'on peint, pas ce qu'on cherche : les filtres
       s'appliquent avant, sur la totalité. Ce qui n'est pas affiché reste
       trouvable en tapant un nom. */
    const borne = ui.borner(list, LIGNES_HISTORIQUE, view.historyTout);
    const dessinees = borne.lignes;

    box.innerHTML =
      (borne.tronque
        ? '<p class="hint historique-tronque">' +
          LIGNES_HISTORIQUE + ' courriers les plus récents sur ' + borne.total +
          '. Cherchez un nom pour retrouver les autres, ou ' +
          '<button class="link-btn" id="historyToutBtn">affichez tout</button> — ' +
          'l’affichage sera plus lent.</p>'
        : '') +
      '<div class="table-scroll"><table><thead><tr><th>Nom</th><th>Type</th><th>Date</th><th>Attente</th><th>Suivi</th><th></th></tr></thead><tbody>' +
      dessinees
        .map(function (h) {
          const pill = ETAT_PILL[etatCourrier(h)] || STATUS_PILL[h.status] || STATUS_PILL['envoyé'];
          const copies = [];
          if (h.cc) copies.push('Cc : ' + h.cc);
          if (h.bcc) copies.push('Cci : ' + h.bcc);
          const attente = enAttente(h);
          const jours = joursDepuis(h.date);
          const relances = h.reminderCount || 0;

          return (
            '<tr' +
            (attente && jours >= 7 ? ' class="vieux"' : '') +
            '><td' +
            (copies.length ? ' title="' + esc(copies.join(' · ')) + '"' : '') +
            '>' +
            esc(h.name) +
            (relances ? '<span class="relance-tag">' + relances + ' relance' + (relances > 1 ? 's' : '') + '</span>' : '') +
            '</td><td>' +
            esc(util.typeCourrier(h.type).label) +
            '</td><td>' +
            esc(util.formatDateTime(h.date)) +
            '</td><td class="attente-cell">' +
            (attente ? (jours === 0 ? 'aujourd’hui' : jours + ' j') : '—') +
            '</td><td class="actions">' +
            (attente
              ? '<button class="link-btn" data-pickup="' + esc(h.id) + '">Marquer récupéré</button>' +
                (S.mode === 'serveur' && store.canSendAutomatically()
                  ? '<button class="link-btn" data-remind="' + esc(h.id) + '">Relancer</button>'
                  : '')
              : '<span class="status-pill">Récupéré</span>' +
                (h.remisA ? '<span class="porteur-tag" title="Retiré par un tiers">par ' + esc(h.remisA) + '</span>' : '') +
                '<button class="link-btn" data-unpickup="' + esc(h.id) + '">Annuler</button>') +
            '</td><td class="actions"><span class="status-pill ' +
            pill[0] +
            '" title="' +
            esc(pill[2]) +
            '">' +
            pill[1] +
            '</span></td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';

    /* Voir tout ce qui est là, quand on le demande vraiment. Le choix ne dure
       que le temps de la visite : au prochain chargement, l'affichage repart
       borné, sinon le poste hériterait d'une lenteur que personne n'a choisie
       ce jour-là. */
    const tout = $('historyToutBtn');
    if (tout) {
      tout.addEventListener('click', function () {
        view.historyTout = true;
        renderHistory();
      });
    }
    brancherSuivi(box);
  }

  function lignesHistorique(pourExcel) {
    return visibleHistory().map(function (h) {
      const contact = S.contacts.find(function (c) {
        return c.id === h.contactId;
      });
      return {
        date: pourExcel ? new Date(h.date) : util.formatDateTime(h.date),
        boite: (contact && contact.box) || '',
        nom: h.name,
        courriel: h.email,
        cc: h.cc || '',
        cci: h.bcc || '',
        voie: h.method === 'auto' ? 'automatique' : 'logiciel de courriel',
        statut: h.status || 'envoyé',
        expediteur: h.sentBy || '',
        operateur: h.operator || ''
      };
    });
  }

  const COLONNES_HISTORIQUE = [
    { key: 'date', label: 'Date', width: 20, type: 'date' },
    { key: 'boite', label: 'N° de boîte', width: 13 },
    { key: 'nom', label: 'Nom', width: 28 },
    { key: 'courriel', label: 'Courriel', width: 34 },
    { key: 'cc', label: 'Cc', width: 26 },
    { key: 'cci', label: 'Cci', width: 26 },
    { key: 'voie', label: 'Voie d’envoi', width: 22 },
    { key: 'statut', label: 'Statut', width: 12 },
    { key: 'expediteur', label: 'Expéditeur', width: 30 },
    { key: 'operateur', label: 'Opérateur', width: 22 }
  ];

  function brancherSuivi(racine) {
    racine.querySelectorAll('[data-pickup], [data-unpickup]').forEach(function (btn) {
      const id = btn.dataset.pickup || btn.dataset.unpickup;
      btn.addEventListener('click', async function () {
        try {
          let signature = '';
          if (btn.dataset.pickup) {
            const entree = S.history.find(function (h) {
              return h.id === id;
            });
            signature = await demanderSignature(entree ? entree.name : 'ce destinataire');
            if (signature === null) return;
          }
          await store.setPickedUp(id, !!btn.dataset.pickup, signature);
          toast(btn.dataset.pickup ? 'Courrier marqué récupéré.' : 'Retour en attente.');
        } catch (err) {
          toast('Impossible : ' + err.message, 'error');
        }
      });
    });
    racine.querySelectorAll('[data-remind]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        btn.textContent = 'Envoi…';
        try {
          const r = await store.relancer(btn.dataset.remind);
          toast('Relance envoyée depuis ' + r.sentBy + '.', 'ok');
        } catch (err) {
          toast('Relance impossible : ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Relancer';
        }
      });
    });
  }

  $('exportHistoryBtn').addEventListener('click', function () {
    if (S.history.length === 0) {
      toast('L’historique est vide.', 'error');
      return;
    }
    download(
      'historique-' + stampSuffix() + '.csv',
      util.toCsv(
        lignesHistorique(false),
        COLONNES_HISTORIQUE.map(function (c) {
          return c.key;
        })
      )
    );
  });

  $('exportHistoryXlsxBtn').addEventListener('click', function () {
    if (S.history.length === 0) {
      toast('L’historique est vide.', 'error');
      return;
    }
    downloadBytes(
      'historique-' + stampSuffix() + '.xlsx',
      root.BC.xlsx.build({ sheetName: 'Historique', columns: COLONNES_HISTORIQUE, rows: lignesHistorique(true) }),
      MIME_XLSX
    );
    toast('Classeur Excel exporté.', 'ok');
  });

  $('clearHistoryBtn').addEventListener('click', async function () {
    if (S.history.length === 0) return;
    const ok = await confirmDialog(
      'Vider l’historique',
      'Supprimer définitivement les ' + S.history.length + ' entrées de l’historique ?',
      'Vider'
    );
    if (!ok) return;
    try {
      await store.clearHistory();
      toast('Historique vidé.');
    } catch (err) {
      toast('Suppression impossible : ' + err.message, 'error');
    }
  });

  /* ═════════════ réglages ═════════════ */

  /* Gabarits par type de courrier.

     Un seul couple de champs sert à tous : l'onglet choisi dit lequel on est en
     train d'écrire. Les modifications non enregistrées vivent dans
     `view.gabarits`, pour qu'on puisse passer d'un type à l'autre sans perdre
     sa saisie ni écrire au serveur à chaque clic. */

  function ongletsGabarits() {
    const boite = $('gabaritOnglets');
    const onglets = [{ id: 'general', label: 'Général' }].concat(
      util.TYPES_COURRIER.map(function (t) {
        return { id: t.id, label: t.label };
      })
    );
    boite.innerHTML = onglets
      .map(function (o) {
        const jeu = jeuCourant();
        const propre =
          o.id === 'general'
            ? view.gabaritLangue !== 'fr' && !!(jeu.general.subject && jeu.general.body)
            : !!jeu.types[o.id];
        return (
          '<button type="button" role="tab" data-gabarit="' + o.id + '"' +
          (o.id === view.gabaritActif ? ' class="active" aria-selected="true"' : ' aria-selected="false"') +
          '>' + esc(o.label) + (propre ? '<span class="point-propre" title="modèle propre"></span>' : '') +
          '</button>'
        );
      })
      .join('');
    boite.querySelectorAll('button[data-gabarit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        memoriserGabaritCourant();
        view.gabaritActif = btn.dataset.gabarit;
        chargerGabaritActif();
      });
    });
  }

  /** Retient ce qui est affiché avant de changer d'onglet. */
  /* Où ranger ce qui est affiché : le français est le modèle de référence
     (`gabaritGeneral` + `gabarits`), chaque autre langue a son propre jeu dans
     `gabaritsLangues`. */
  function jeuCourant() {
    if (view.gabaritLangue === 'fr') {
      return { general: view.gabaritGeneral, types: view.gabarits };
    }
    if (!view.gabaritsLangues[view.gabaritLangue]) {
      view.gabaritsLangues[view.gabaritLangue] = { subject: '', body: '', templates: {} };
    }
    const l = view.gabaritsLangues[view.gabaritLangue];
    if (!l.templates) l.templates = {};
    return { general: l, types: l.templates };
  }

  function memoriserGabaritCourant() {
    const subject = $('setSubject').value;
    const body = $('setBody').value;
    const jeu = jeuCourant();

    if (view.gabaritActif === 'general') {
      jeu.general.subject = subject;
      jeu.general.body = body;
      return;
    }
    if (subject.trim() && body.trim()) {
      jeu.types[view.gabaritActif] = { subject: subject, body: body };
    } else {
      // Un type dont on vide les champs revient au modèle de la langue.
      delete jeu.types[view.gabaritActif];
    }
  }

  function chargerGabaritActif() {
    const enFrancais = view.gabaritLangue === 'fr';
    const jeu = jeuCourant();
    const propre = view.gabaritActif !== 'general' ? jeu.types[view.gabaritActif] : null;
    const courant =
      view.gabaritActif === 'general' ? jeu.general : propre || { subject: '', body: '' };

    /* L'invite montre ce qui partirait réellement si l'on n'écrit rien : le
       modèle français du même type, sinon le modèle français général. */
    const repli = enFrancais
      ? view.gabaritActif === 'general'
        ? { subject: '', body: '' }
        : view.gabaritGeneral
      : (view.gabaritActif !== 'general' && view.gabarits[view.gabaritActif]) ||
        (view.gabaritsLangues[view.gabaritLangue] && view.gabaritsLangues[view.gabaritLangue].subject
          ? view.gabaritsLangues[view.gabaritLangue]
          : view.gabaritGeneral);

    $('setSubject').value = courant.subject || '';
    $('setBody').value = courant.body || '';
    $('setSubject').placeholder = repli.subject || '';
    $('setBody').placeholder = repli.body || '';
    $('gabaritActions').hidden = enFrancais && view.gabaritActif === 'general';

    // Les langues qui s'écrivent de droite à gauche doivent s'afficher ainsi.
    const rtl = util.estRtl(view.gabaritLangue);
    $('setSubject').dir = rtl ? 'rtl' : 'ltr';
    $('setBody').dir = rtl ? 'rtl' : 'ltr';

    const langue = util.langue(view.gabaritLangue);
    const type = view.gabaritActif === 'general' ? null : util.typeCourrier(view.gabaritActif);
    const aQuelqueChose = !!(courant.subject && courant.body);

    $('gabaritEtat').textContent =
      view.gabaritActif === 'general'
        ? enFrancais
          ? 'Ce texte sert à tous les types qui n’ont pas de modèle propre.'
          : aQuelqueChose
            ? 'Message courant en ' + langue.label + '.'
            : 'Aucun texte en ' + langue.label + ' : ces destinataires recevront le message français.'
        : aQuelqueChose
          ? 'Modèle « ' + type.label +' » en ' + langue.label + '.'
          : '« ' + type.label + ' » en ' + langue.label + ' n’a pas de texte propre : le repli s’applique.';

    $('gabaritLangueEtat').textContent = enFrancais
      ? 'Le français est le modèle de référence : c’est lui qui sert quand une langue n’a pas de texte.'
      : 'Écrit par le bureau — l’application ne traduit rien.';

    ongletsGabarits();
    renderPreview();
  }

  /* L'aide des variables est construite depuis util.VARIABLES_MESSAGE plutôt
     qu'écrite dans la page : une liste en dur ment dès qu'une variable est
     ajoutée, et on ne s'en aperçoit qu'en écrivant un gabarit qui ne marche
     pas. Un test compare les deux listes. */
  function renderVariablesGabarit() {
    const ul = $('variablesGabarit');
    if (!ul) return;
    ul.innerHTML = util.VARIABLES_MESSAGE.map(function (v) {
      return '<li><code>{' + esc(v[0]) + '}</code> — ' + esc(v[1]) + '</li>';
    }).join('');
  }

  function fillSettingsForm() {
    renderVariablesGabarit();
    $('setBilingue').checked = !!S.settings.bilingue;
    $('setOffice').value = S.settings.officeName || '';
    $('setFrom').value = S.settings.from || '';
    $('setCc').value = S.settings.cc || '';
    $('setBcc').value = S.settings.bcc || '';
    $('conservationMois').value = String(S.settings.conservationMois || 0);
    $('setAdresse').value = S.settings.officeAdresse || '';
    $('setVille').value = S.settings.officeVille || '';
    $('setAgrement').value = S.settings.officeAgrement || '';
    view.gabaritGeneral = { subject: S.settings.subject || '', body: S.settings.body || '' };
    view.gabarits = JSON.parse(JSON.stringify(S.settings.templates || {}));
    view.gabaritsLangues = JSON.parse(JSON.stringify(S.settings.langues || {}));
    chargerGabaritActif();
  }

  $('gabaritEffacerBtn').addEventListener('click', function () {
    const jeu = jeuCourant();
    if (view.gabaritActif === 'general') {
      jeu.general.subject = '';
      jeu.general.body = '';
    } else {
      delete jeu.types[view.gabaritActif];
    }
    chargerGabaritActif();
    setMsg('settingsMsg', '', 'Ce cas reprendra le modèle de repli au prochain enregistrement.');
  });

  function renderPreview() {
    const sample = S.contacts[0] || { name: 'Marie Tremblay', email: 'marie@exemple.com' };
    // Un onglet de type sans texte propre montre ce qui partirait vraiment :
    // le modèle général.
    const subject = $('setSubject').value.trim() || $('setSubject').placeholder || view.gabaritGeneral.subject;
    const body = $('setBody').value.trim() || $('setBody').placeholder || view.gabaritGeneral.body;
    const type = view.gabaritActif === 'general' ? util.TYPES_COURRIER[0] : util.typeCourrier(view.gabaritActif);
    const message = notify.compose(sample, {
      officeName: $('setOffice').value,
      subject: subject,
      body: body,
      from: $('setFrom').value,
      cc: $('setCc').value,
      bcc: $('setBcc').value
    }, { type: type.id, langue: view.gabaritLangue, code: '4821' });
    $('settingsPreview').textContent = notify.plainText(sample, message);
  }

  ['setOffice', 'setSubject', 'setBody', 'setFrom', 'setCc', 'setBcc'].forEach(function (id) {
    $(id).addEventListener('input', renderPreview);
  });

  $('saveSettingsBtn').addEventListener('click', async function () {
    memoriserGabaritCourant();
    const subject = (view.gabaritGeneral.subject || '').trim();
    const body = (view.gabaritGeneral.body || '').trim();
    if (!subject || !body) {
      view.gabaritLangue = 'fr';
      setMsg(
        'settingsMsg',
        'error',
        'Le modèle général ne peut pas être vide : c’est lui qui sert quand un type n’a pas de texte propre.'
      );
      view.gabaritActif = 'general';
      chargerGabaritActif();
      return;
    }

    const from = $('setFrom').value.trim();
    if (from && !util.isValidAddress(from)) {
      setMsg('settingsMsg', 'error', 'Expéditeur invalide : attendu « adresse@exemple.com » ou « Nom &lt;adresse@exemple.com&gt; ».');
      return;
    }
    const cc = util.parseAddressList($('setCc').value);
    const bcc = util.parseAddressList($('setBcc').value);
    if (cc.errors.length || bcc.errors.length) {
      setMsg(
        'settingsMsg',
        'error',
        'Adresse en copie non reconnue : ' + esc(cc.errors.concat(bcc.errors).join(', ')) + '.'
      );
      return;
    }

    try {
      await store.saveSettings({
        officeName: $('setOffice').value.trim(),
        subject: subject,
        body: body,
        from: from,
        cc: util.formatAddressList(cc.entries),
        bcc: util.formatAddressList(bcc.entries),
        templates: view.gabarits,
        langues: view.gabaritsLangues,
        bilingue: $('setBilingue').checked
      });
      fillSettingsForm();
      syncCopiesFromSettings(!view.copiesTouched);
      setMsg('settingsMsg', 'ok', 'Réglages enregistrés.');
    } catch (err) {
      setMsg('settingsMsg', 'error', 'Enregistrement impossible : ' + esc(err.message));
    }
  });

  $('saveOrganismeBtn').addEventListener('click', async function () {
    const btn = $('saveOrganismeBtn');
    btn.disabled = true;
    try {
      await store.saveSettings({
        // Le nom du bureau a rejoint sa carte d'identité : il se range avec
        // l'adresse, pas avec le modèle de message.
        officeName: $('setOffice').value.trim() || store.DEFAULT_SETTINGS.officeName,
        officeAdresse: $('setAdresse').value.trim(),
        officeVille: $('setVille').value.trim(),
        officeAgrement: $('setAgrement').value.trim()
      });
      setMsg('organismeMsg', 'ok', 'Identité de l’organisme enregistrée. Les attestations la reprendront.');
    } catch (err) {
      setMsg('organismeMsg', 'error', 'Enregistrement impossible : ' + esc(err.message));
    } finally {
      btn.disabled = false;
    }
  });

  $('resetSettingsBtn').addEventListener('click', async function () {
    const ok = await confirmDialog('Rétablir le modèle', 'Revenir au message par défaut ?', 'Rétablir');
    if (!ok) return;
    await store.saveSettings(store.DEFAULT_SETTINGS);
    fillSettingsForm();
    setMsg('settingsMsg', 'ok', 'Modèle par défaut rétabli.');
  });

  /* ═════════════ comptes ═════════════ */

  function renderGate() {
    const gate = $('authGate');
    /* Trois situations mènent à l'écran de connexion :
       - une session est exigée et manque ;
       - le serveur n'a encore aucun compte : c'est l'installation, on propose
         de créer celui du bureau (avec la possibilité de s'en passer).
       Hors mode serveur, il n'y a pas de comptes du tout. */
    // On se fie à l'état, pas au DOM : le rendu peut être déclenché avant que
    // l'étape d'association ait été affichée, et refermerait l'écran.
    const associating = !!view.associateEmail;
    const firstRun = S.mode === 'serveur' && !S.auth.accountsExist && !view.skipAccount;
    const needed = S.mode === 'serveur' && (S.auth.required || firstRun || associating);
    gate.hidden = !needed;
    document.body.style.overflow = needed ? 'hidden' : '';
    $('gateSkip').hidden = !firstRun;

    /* Un écran de connexion sans aucun formulaire visible est une impasse :
       l'écran s'affiche, mais rien ne permet d'entrer. Cela survient quand la
       session tombe alors qu'une étape intermédiaire était ouverte. On retombe
       alors sur la connexion. */
    if (needed) {
      const formulaires = [
        'loginForm', 'signupForm', 'verifyForm', 'associateForm',
        'forgotForm', 'resetForm', 'agentForm', 'masterForm'
      ];
      const visible = formulaires.some(function (id) {
        return $(id) && !$(id).hidden;
      });
      if (!visible) showGateForm(S.auth.accountsExist ? 'login' : 'signup');
    }
    const notice = $('signupNotice');
    if (notice) {
      notice.textContent = S.auth.verifyEmail
        ? 'Un code de confirmation sera envoyé à cette adresse pour en vérifier l’accès.'
        : 'Ce serveur ne peut pas envoyer de courriel : l’adresse ne sera pas vérifiée.';
    }

    const bar = $('accountBar');
    bar.hidden = !S.auth.user;
    if (S.auth.user) $('whoBadge').textContent = S.auth.user.name;

    // Les comptes n'existent qu'en mode serveur : hors de ce mode, l'écran de
    // connexion n'a pas lieu d'être et ne doit rien réclamer.
    if (S.mode !== 'serveur') return;

    // Aucun compte encore : la première visite crée le compte du bureau.
    const signupTab = document.querySelector('.gate-tabs button[data-form="signup"]');
    if (signupTab) signupTab.hidden = !S.auth.signupOpen && S.auth.accountsExist;
    if (!S.auth.accountsExist && !view.gateFormChosen && !view.pendingEmail && !associating) {
      $('gateSubtitle').textContent = 'Créez le compte du bureau pour protéger le registre';
      showGateForm('signup');
    }
  }

  function showGateForm(which) {
    document.querySelectorAll('.gate-tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.form === which);
    });
    $('loginForm').hidden = which !== 'login';
    $('signupForm').hidden = which !== 'signup';
    $('verifyForm').hidden = which !== 'verify';
    $('associateForm').hidden = which !== 'associate';
    $('forgotForm').hidden = which !== 'forgot';
    $('resetForm').hidden = which !== 'reset';
    $('agentForm').hidden = which !== 'agent';
    $('masterForm').hidden = which !== 'master';
    // Seules les trois portes d'entrée sont des onglets : les étapes
    // intermédiaires (code, association, oubli, reprise) masquent la barre.
    $('gateTabs').hidden = which !== 'login' && which !== 'signup' && which !== 'agent';
    setMsg('gateMsg', '', '');
  }

  document.querySelectorAll('.gate-tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      view.gateFormChosen = true;
      showGateForm(btn.dataset.form);
    });
  });

  $('skipAccountBtn').addEventListener('click', function () {
    view.skipAccount = true;
    renderGate();
    toast('Registre ouvert sans compte. Créez-en un depuis les Réglages quand vous voudrez.');
    nameInput.focus();
  });

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    setMsg('gateMsg', '', 'Connexion…');
    try {
      await store.login({ email: $('loginEmail').value.trim(), password: $('loginPassword').value });
      $('loginPassword').value = '';
      setMsg('gateMsg', '', '');
      afterLogin();
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  /* ── mot de passe oublié ──
     Un mot de passe perdu ne doit pas condamner le registre. La reprise passe
     par l'adresse du compte ; le formulaire de saisie du code s'ouvre dans tous
     les cas, y compris pour une adresse sans compte — le serveur répond la même
     chose des deux côtés, et l'interface ne peut donc rien laisser filtrer. */

  function ouvrirOubli() {
    view.gateFormChosen = true;
    $('gateSubtitle').textContent = 'Retrouver l’accès à votre compte';
    $('forgotEmail').value = $('loginEmail').value.trim();
    showGateForm('forgot');
    $('forgotEmail').focus();
  }

  function revenirConnexion() {
    view.gateFormChosen = true;
    $('gateSubtitle').textContent = 'Connectez-vous pour accéder au registre';
    showGateForm('login');
    $('loginEmail').focus();
  }

  /* ── entrée par identifiant ── */

  $('agentIdentifiant').addEventListener('input', function (e) {
    // On met en forme pendant la frappe : « ab1234 » devient « AB-1234 ».
    const brut = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const lettres = brut.slice(0, 2).replace(/[^A-Z]/g, '');
    const chiffres = brut.slice(lettres.length).replace(/\D/g, '').slice(0, 4);
    e.target.value = chiffres ? lettres + '-' + chiffres : lettres;
    if (e.target.value.length === 7) $('agentCode').focus();
  });

  $('agentCode').addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  $('agentForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const identifiant = roles.normaliserIdentifiant($('agentIdentifiant').value);
    const code = $('agentCode').value;
    if (!roles.identifiantValide(identifiant)) {
      setMsg('gateMsg', 'error', 'L’identifiant s’écrit « AB-1234 ».');
      return;
    }
    if (!roles.codeAccesValide(code)) {
      setMsg('gateMsg', 'error', 'Le code d’accès compte six chiffres.');
      return;
    }
    setMsg('gateMsg', '', 'Ouverture…');
    try {
      await store.loginAgent(identifiant, code);
      $('agentCode').value = '';
      setMsg('gateMsg', '', '');
      afterLogin();
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
      $('agentCode').select();
    }
  });

  /* ── code de reprise du compte responsable ── */

  let codeMaitreSaisi = '';

  $('masterBtn').addEventListener('click', function () {
    view.gateFormChosen = true;
    $('gateSubtitle').textContent = 'Reprise du compte responsable';
    $('masterCode').value = '';
    $('masterZone').hidden = true;
    showGateForm('master');
    $('masterCode').focus();
  });

  $('masterRetourBtn').addEventListener('click', function () {
    codeMaitreSaisi = '';
    revenirConnexion();
  });

  $('masterForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    setMsg('gateMsg', '', 'Vérification…');
    try {
      const res = await store.codeMaitre($('masterCode').value, 'voir');
      codeMaitreSaisi = $('masterCode').value;
      setMsg('gateMsg', '', '');
      $('masterInfos').innerHTML =
        '<div><dt>Nom</dt><dd>' + esc(res.responsable.name) + '</dd></div>' +
        '<div><dt>Adresse</dt><dd>' + esc(res.responsable.email) + '</dd></div>';
      $('masterEmail').value = res.responsable.email;
      $('masterZone').hidden = false;
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
      $('masterCode').select();
    }
  });

  $('masterEmailBtn').addEventListener('click', async function () {
    try {
      const res = await store.codeMaitre(codeMaitreSaisi, 'email', { email: $('masterEmail').value.trim() });
      setMsg('gateMsg', 'ok', 'Adresse du responsable changée : ' + esc(res.email));
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  $('masterPasswordBtn').addEventListener('click', async function () {
    try {
      await store.codeMaitre(codeMaitreSaisi, 'password', { password: $('masterPassword').value });
      $('masterPassword').value = '';
      setMsg('gateMsg', 'ok', 'Mot de passe changé. Toutes les sessions du responsable sont fermées.');
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  $('masterDeleteBtn').addEventListener('click', async function () {
    const ok = await confirmDialog(
      'Supprimer le compte responsable',
      'L’application redemandera la création du compte du bureau au prochain démarrage. ' +
        'Le registre, l’historique et les accès des agents ne sont pas touchés.',
      'Supprimer'
    );
    if (!ok) return;
    try {
      await store.codeMaitre(codeMaitreSaisi, 'supprimer');
      toast('Compte responsable supprimé. Rechargez pour réinstaller.', 'ok');
      setTimeout(function () {
        root.location.reload();
      }, 1500);
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  $('forgotBtn').addEventListener('click', ouvrirOubli);
  $('backToLoginBtn').addEventListener('click', revenirConnexion);
  $('resetBackBtn').addEventListener('click', revenirConnexion);

  $('forgotForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = $('forgotEmail').value.trim();
    setMsg('gateMsg', '', 'Envoi du code…');
    try {
      const res = await store.forgotPassword(email);
      setMsg('gateMsg', '', '');
      $('gateSubtitle').textContent = 'Choisissez un nouveau mot de passe';
      $('resetEmail').textContent = email;
      $('resetCode').value = '';
      $('resetPassword').value = '';
      $('resetHint').textContent =
        'Le code est valable ' + (res.expiresInMinutes || 30) +
        ' minutes. Pensez à regarder dans les indésirables.';
      showGateForm('reset');
      $('resetCode').focus();
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  $('resetForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const code = $('resetCode').value.replace(/\D/g, '');
    if (code.length !== 6) {
      setMsg('gateMsg', 'error', 'Le code compte six chiffres.');
      return;
    }
    setMsg('gateMsg', '', 'Vérification…');
    try {
      await store.resetPassword($('resetEmail').textContent, code, $('resetPassword').value);
      $('resetPassword').value = '';
      setMsg('gateMsg', '', '');
      $('gateSubtitle').textContent = 'Connectez-vous pour accéder au registre';
      showGateForm('login');
      afterLogin();
      toast('Mot de passe changé. Vous êtes connecté·e.');
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
      $('resetCode').select();
    }
  });

  $('signupForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    setMsg('gateMsg', '', 'Création du compte…');
    try {
      const result = await store.signup({
        name: $('signupName').value.trim(),
        email: $('signupEmail').value.trim(),
        password: $('signupPassword').value
      });
      $('signupPassword').value = '';
      setMsg('gateMsg', '', '');
      if (result.pending) {
        view.pendingEmail = result.email;
        $('gateSubtitle').textContent = 'Confirmez votre adresse';
        $('verifyEmail').textContent = result.email;
        $('verifyCode').value = '';
        showGateForm('verify');
        $('verifyHint').textContent =
          'Le code est valable 15 minutes. Pensez à regarder dans les indésirables.';
        $('verifyCode').focus();
        return;
      }
      showAssociateStep(result.user.email);
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  $('verifyForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const code = $('verifyCode').value.replace(/\D/g, '');
    if (code.length !== 6) {
      setMsg('gateMsg', 'error', 'Le code compte six chiffres.');
      return;
    }
    setMsg('gateMsg', '', 'Vérification…');
    try {
      const user = await store.verifySignup(view.pendingEmail, code);
      setMsg('gateMsg', '', '');
      view.pendingEmail = null;
      showAssociateStep(user.email);
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
      $('verifyCode').select();
      // Code expiré ou trop d'essais : il faut repartir de l'inscription.
      if (err.status === 410 || err.status === 429) {
        view.pendingEmail = null;
        showGateForm('signup');
        setMsg('gateMsg', 'error', esc(err.message));
      }
    }
  });

  $('resendCodeBtn').addEventListener('click', async function () {
    if (!view.pendingEmail) return;
    setMsg('gateMsg', '', 'Envoi d’un nouveau code…');
    try {
      await store.resendCode(view.pendingEmail);
      setMsg('gateMsg', 'ok', 'Nouveau code envoyé à ' + esc(view.pendingEmail) + '.');
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  /* ═════════════ association de la boîte à l'inscription ═════════════ */

  /** L'adresse vient d'être prouvée : on propose de l'utiliser pour les envois. */
  function showAssociateStep(email) {
    view.associateEmail = email;
    $('associateEmail').textContent = email;
    $('associateHost').value = util.suggestSmtpHost(email);
    $('associatePassword').value = '';

    // Le bouton Google n'a de sens que pour une adresse Google, sur un serveur
    // où l'autorisation est configurée.
    const google = S.auth.googleOAuth && util.isGoogleAddress(email);
    $('associateGoogleBtn').hidden = !google;
    $('associateGoogleHint').hidden = !google;
    $('associateSmtp').open = !google;

    $('gateSubtitle').textContent = 'Dernière étape : votre adresse d’envoi';
    showGateForm('associate');
    renderGate();
    $('associatePassword').focus();
  }

  $('associateGoogleBtn').addEventListener('click', function () {
    root.location.href = '/api/auth/google/start';
  });

  $('associateForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const host = $('associateHost').value.trim();
    const password = $('associatePassword').value;
    if (!host || !password) {
      setMsg('gateMsg', 'error', 'Indiquez le serveur d’envoi et le mot de passe d’application.');
      return;
    }
    setMsg('gateMsg', '', 'Association…');
    try {
      await store.connectSmtpMailbox({ address: view.associateEmail, host: host, port: 587, password: password });
      $('associatePassword').value = '';
      setMsg('gateMsg', '', '');
      toast('Boîte associée : les notifications partiront de ' + view.associateEmail + '.', 'ok');
      afterLogin();
    } catch (err) {
      setMsg('gateMsg', 'error', esc(err.message));
    }
  });

  $('skipAssociateBtn').addEventListener('click', function () {
    setMsg('gateMsg', '', '');
    afterLogin();
  });

  $('cancelVerifyBtn').addEventListener('click', function () {
    view.pendingEmail = null;
    showGateForm('signup');
  });

  // Confort : coller un code envoie directement le formulaire.
  $('verifyCode').addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value.length === 6) $('verifyForm').requestSubmit();
  });

  $('logoutBtn').addEventListener('click', async function () {
    try {
      await store.logout();
      toast('Déconnecté.');
    } catch (err) {
      toast('Déconnexion impossible : ' + err.message, 'error');
    }
  });

  function afterLogin() {
    view.associateEmail = null;
    $('associateForm').hidden = true;
    $('gateTabs').hidden = false;
    fillSettingsForm();
    syncCopiesFromSettings(true);
    renderAll();
    toast('Bonjour ' + S.auth.user.name + '.', 'ok');
    nameInput.focus();
  }

  /* ═════════════ boîte d'envoi personnelle ═════════════ */

  function renderMailbox() {
    const card = $('mailboxCard');
    card.hidden = !S.auth.user;
    if (!S.auth.user) return;

    const mailbox = S.auth.user.mailbox;
    $('mailboxChoices').hidden = !!mailbox;

    if (mailbox) {
      setMsg(
        'mailboxState',
        'ok',
        'Les courriels partent de <strong>' +
          esc(mailbox.address) +
          '</strong> — votre boîte' +
          (mailbox.method === 'oauth2' ? ' (autorisation Google)' : ' (mot de passe d’application)') +
          '.<br><button type="button" class="link-btn danger" id="disconnectMailboxBtn">Déconnecter cette boîte</button>'
      );
      const btn = $('disconnectMailboxBtn');
      if (btn) {
        btn.addEventListener('click', async function () {
          const ok = await confirmDialog(
            'Déconnecter la boîte',
            'Les notifications repartiront du compte du serveur, ou seront préparées dans votre logiciel de courriel.',
            'Déconnecter'
          );
          if (!ok) return;
          try {
            await store.disconnectMailbox();
            toast('Boîte déconnectée.');
          } catch (err) {
            setMsg('mailboxMsg', 'error', esc(err.message));
          }
        });
      }
    } else {
      setMsg(
        'mailboxState',
        '',
        'Reliez votre boîte pour que les notifications partent de <strong>votre</strong> adresse : ' +
          'les destinataires vous répondent directement, et l’envoi ne dépend plus d’un compte partagé.'
      );
    }

    $('googleUnavailable').hidden = S.auth.googleOAuth;
    $('connectGoogleBtn').disabled = !S.auth.googleOAuth;
  }

  $('connectGoogleBtn').addEventListener('click', function () {
    // Navigation complète : l'écran de consentement Google refuse d'être
    // affiché dans une requête en arrière-plan.
    root.location.href = '/api/auth/google/start';
  });

  $('connectSmtpBtn').addEventListener('click', async function () {
    const address = $('mbAddress').value.trim();
    const host = $('mbHost').value.trim();
    const password = $('mbPassword').value;
    if (!util.isValidEmail(address) || !host || !password) {
      setMsg('mailboxMsg', 'error', 'Adresse, serveur SMTP et mot de passe d’application sont requis.');
      return;
    }
    try {
      await store.connectSmtpMailbox({
        address: address,
        host: host,
        port: Number($('mbPort').value) || 587,
        password: password
      });
      $('mbPassword').value = '';
      setMsg('mailboxMsg', 'ok', 'Boîte enregistrée. Essayez « Envoyer un courriel de test ».');
    } catch (err) {
      setMsg('mailboxMsg', 'error', esc(err.message));
    }
  });

  /** Retour de l'écran de consentement Google : /#reglages?boite=ok ou une raison. */
  function readMailboxReturn() {
    const hash = root.location.hash || '';
    const index = hash.indexOf('?');
    if (index === -1) return;
    const params = new URLSearchParams(hash.slice(index + 1));
    const result = params.get('boite');
    if (!result) return;
    showPanel('reglages');
    if (result === 'ok') {
      setMsg('mailboxMsg', 'ok', 'Boîte Gmail connectée.');
    } else if (result === 'session') {
      setMsg('mailboxMsg', 'error', 'Session expirée pendant l’autorisation — reconnectez-vous et réessayez.');
    } else if (result === 'etat') {
      setMsg('mailboxMsg', 'error', 'Autorisation refusée : la demande ne correspondait pas à cette session.');
    } else {
      setMsg('mailboxMsg', 'error', 'Connexion impossible : ' + esc(result));
    }
    history.replaceState(null, '', '#reglages');
  }

  /* ═════════════ où le registre est conservé ═════════════ */

  function renderRegistryChoice() {
    const pref = S.registryPreference || 'partage';
    $('registrePartage').checked = pref === 'partage';
    $('registreLocal').checked = pref === 'local';

    let note = '';
    if (pref === 'partage' && S.mode !== 'serveur') {
      note =
        '<div class="msg">Registre partagé demandé, mais aucun serveur ne répond : ' +
        'l’application fonctionne sur ce poste. Démarrez le serveur, puis rechargez la page.</div>';
    } else if (pref === 'local' && S.mode === 'local') {
      note = '<div class="msg">Ce poste conserve son propre registre. Les autres postes ne le voient pas.</div>';
    }
    $('registryMsg').innerHTML = note;
  }

  document.querySelectorAll('#registryChoice input[name=registre]').forEach(function (radio) {
    radio.addEventListener('change', async function () {
      if (!radio.checked) return;
      const cible = radio.value;
      const ok = await confirmDialog(
        'Changer de registre',
        cible === 'local'
          ? 'Ce poste utilisera son propre registre, séparé du registre partagé. Les données du serveur ne sont pas effacées : elles cessent simplement d’être affichées ici.'
          : 'Ce poste rejoindra le registre partagé du serveur. Le registre local reste enregistré dans ce navigateur, sans être affiché.',
        'Changer'
      );
      if (!ok) {
        renderRegistryChoice();
        return;
      }
      store.setRegistryPreference(cible);
      // Le mode se décide au démarrage : un rechargement est le moyen le plus
      // sûr de repartir sur le bon support, sans état à moitié migré.
      toast('Changement pris en compte — rechargement…');
      setTimeout(function () {
        root.location.reload();
      }, 900);
    });
  });

  /* ═════════════ sauvegarde ═════════════ */

  $('downloadBackupBtn').addEventListener('click', function () {
    if (S.mode === 'serveur') {
      // Le serveur produit le fichier : c'est lui qui détient le registre.
      root.location.href = '/api/backup';
      setMsg('backupMsg', 'ok', 'Sauvegarde téléchargée. Rangez-la ailleurs que sur ce poste.');
      return;
    }
    const copie = {
      exportedAt: new Date().toISOString(),
      contacts: S.contacts,
      history: S.history,
      settings: S.settings
    };
    download('registre-' + stampSuffix() + '.json', JSON.stringify(copie, null, 2), 'application/json');
    setMsg('backupMsg', 'ok', 'Sauvegarde du registre de ce poste téléchargée.');
  });

  /* Restauration depuis l'écran. Sans elle, les sauvegardes ne servent qu'à
     qui sait fouiller le disque du serveur — c'est-à-dire à personne, le jour
     où le registre est abîmé. */
  async function renderSauvegardes() {
    const boite = $('sauvegardesListe');
    try {
      const data = await store.listerSauvegardes();
      if (!data.sauvegardes.length) {
        boite.innerHTML = '<div class="empty">Aucune copie sur le serveur pour l’instant.</div>';
        return;
      }
      boite.innerHTML =
        '<div class="table-scroll"><table><thead><tr><th>Date</th><th>Destinataires</th>' +
        '<th>Courriers</th><th></th></tr></thead><tbody>' +
        data.sauvegardes
          .map(function (sv) {
            if (sv.illisible) {
              return (
                '<tr><td class="attente-cell">' + esc(util.formatJour(sv.jour)) +
                '</td><td colspan="3"><em>fichier illisible</em></td></tr>'
              );
            }
            return (
              '<tr><td class="attente-cell">' + esc(util.formatJour(sv.jour)) +
              '</td><td>' + sv.destinataires +
              '</td><td>' + sv.courriers +
              '</td><td class="actions"><button class="link-btn danger" data-restaurer="' +
              esc(sv.fichier) + '">Restaurer</button></td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';

      boite.querySelectorAll('button[data-restaurer]').forEach(function (b) {
        b.addEventListener('click', function () {
          restaurerSauvegarde(b.dataset.restaurer);
        });
      });
    } catch (err) {
      boite.innerHTML = '<div class="empty">Liste indisponible : ' + esc(err.message) + '</div>';
    }
  }

  async function restaurerSauvegarde(fichier) {
    const ok = await confirmDialog(
      'Restaurer cette copie',
      'Le registre et l’historique actuels seront remplacés par ceux de cette sauvegarde. ' +
        'Une copie de l’état présent est écrite avant l’opération, et les comptes ne sont pas touchés.',
      'Restaurer'
    );
    if (!ok) return;
    try {
      const r = await store.restaurerSauvegarde(fichier);
      setMsg(
        'backupMsg',
        'ok',
        'Registre restauré depuis <strong>' + esc(r.fichier) + '</strong> : ' +
          r.avant.destinataires + ' → ' + r.apres.destinataires + ' destinataire(s), ' +
          r.avant.courriers + ' → ' + r.apres.courriers + ' courrier(s). ' +
          'L’état précédent est conservé sous ' + esc(r.filet) + '.'
      );
      renderAll();
      renderSauvegardes();
    } catch (err) {
      setMsg('backupMsg', 'error', esc(err.message));
    }
  }

  $('listerSauvegardesBtn').addEventListener('click', function () {
    if (S.mode !== 'serveur') {
      setMsg('backupMsg', 'error', 'La restauration demande le registre partagé.');
      return;
    }
    renderSauvegardes();
  });

  $('conservationBtn').addEventListener('click', async function () {
    const mois = Number($('conservationMois').value);
    try {
      await store.saveSettings({ conservationMois: mois });
      setMsg(
        'conservationMsg',
        'ok',
        mois === 0
          ? 'Conservation illimitée : rien ne sera effacé automatiquement.'
          : 'Les courriers terminés depuis plus de ' + mois + ' mois seront effacés au prochain passage.'
      );
    } catch (err) {
      setMsg('conservationMsg', 'error', esc(err.message));
    }
  });

  $('serverBackupBtn').addEventListener('click', async function () {
    if (S.mode !== 'serveur') {
      setMsg('backupMsg', 'error', 'Sans serveur, seule la sauvegarde téléchargée est possible.');
      return;
    }
    try {
      const r = await store.serverBackup();
      setMsg('backupMsg', 'ok', 'Copie écrite sur le serveur : ' + esc(r.fichier) + ' (' + r.conserves + ' conservée(s)).');
    } catch (err) {
      setMsg('backupMsg', 'error', esc(err.message));
    }
  });

  /* ═════════════ comptes ═════════════ */

  /* Le code de reprise livré avec l'application est public. Tant qu'il n'a pas
     été remplacé, on le dit à l'endroit où on peut agir — pas seulement dans
     une console de démarrage que plus personne ne relit après l'installation.
     Le serveur ne le signale qu'au responsable : l'annoncer à un agent
     reviendrait à indiquer la porte. */
  function renderCodeMaitre() {
    const carte = $('codeMaitreCard');
    if (carte) carte.hidden = !S.codeMaitreParDefaut;
  }

  async function renderAccounts() {
    renderCodeMaitre();
    const carte = $('accountsCard');
    carte.hidden = !S.auth.user;
    if (!S.auth.user) return;

    try {
      const data = await store.listUsers();
      const responsable = data.responsableId === S.auth.user.id;
      $('usersList').innerHTML =
        '<h3 class="sous-titre">Comptes du bureau (' + data.users.length + ')</h3>' +
        '<div class="table-scroll"><table><thead><tr><th>Nom</th><th>Courriel</th><th>Boîte reliée</th><th></th></tr></thead><tbody>' +
        data.users
          .map(function (u) {
            const soi = u.id === S.auth.user.id;
            return (
              '<tr><td>' +
              esc(u.name) +
              (u.id === data.responsableId ? '<span class="relance-tag">responsable</span>' : '') +
              '</td><td>' +
              esc(u.email) +
              '</td><td class="box-cell">' +
              (u.mailbox ? esc(u.mailbox) : '—') +
              '</td><td class="actions">' +
              (responsable && !soi
                ? '<button class="link-btn danger" data-rmuser="' + esc(u.id) + '">Retirer l’accès</button>'
                : soi
                  ? '<span class="hint">vous</span>'
                  : '') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>' +
        (responsable
          ? ''
          : '<p class="hint" style="margin-top:10px;">Seul le compte responsable — le premier créé — peut retirer un accès.</p>');

      $('usersList')
        .querySelectorAll('[data-rmuser]')
        .forEach(function (btn) {
          btn.addEventListener('click', async function () {
            const cible = data.users.find(function (u) {
              return u.id === btn.dataset.rmuser;
            });
            const ok = await confirmDialog(
              'Retirer l’accès',
              'Retirer l’accès de ' + cible.name + ' (' + cible.email + ') ? Ses sessions seront fermées immédiatement. Le registre et l’historique ne changent pas.',
              'Retirer'
            );
            if (!ok) return;
            try {
              await store.removeUser(cible.id);
              toast('Accès retiré.');
              renderAccounts();
            } catch (err) {
              setMsg('accountsMsg', 'error', esc(err.message));
            }
          });
        });
    } catch (err) {
      $('usersList').innerHTML = '';
    }
  }

  /* Le retour s'affiche dans le bloc du mot de passe, pas au bas de la carte :
     un refus qu'on ne voit pas ressemble à une application qui ne répond plus. */
  /* ═════════════ antennes ═════════════ */

  /* Plusieurs points d'accueil sur un même serveur. Tant qu'aucune antenne
     n'est déclarée, la notion n'existe pas : aucun sélecteur, aucun champ.
     C'est la règle qui garde l'application simple pour un bureau unique. */

  const ANTENNE_KEY = 'courrier-antenne';

  /* « antennes », « antenneImposee » et « deLAntenne » sont dans ui/noyau.js :
     ce sont des lectures d'une ligne sur l'état du magasin, dont sept sections
     se servent — elles n'appartenaient pas aux réglages. */

  function renderAntennes() {
    const liste = antennes();
    const select = $('antenneActive');
    const imposee = antenneImposee();

    // Un accès limité n'a rien à choisir : on affiche son antenne, figée.
    if (imposee) {
      view.antenneActive = imposee;
    } else if (liste.length && view.antenneActive && !liste.some(function (a) { return a.id === view.antenneActive; })) {
      /* On n'oublie le choix que si la liste est chargée et n'en veut plus :
         au tout premier rendu, les réglages ne sont pas encore là, et effacer
         ici perdrait l'antenne retenue d'une visite à l'autre. */
      view.antenneActive = '';
    }

    select.hidden = liste.length === 0;
    if (liste.length === 0) return;

    select.innerHTML =
      (imposee ? '' : '<option value="">Toutes les antennes</option>') +
      liste
        .map(function (a) {
          return (
            '<option value="' + esc(a.id) + '"' +
            (a.id === view.antenneActive ? ' selected' : '') + '>' + esc(a.nom) + '</option>'
          );
        })
        .join('');
    select.disabled = !!imposee;
    select.title = imposee ? 'Votre accès est limité à cette antenne.' : 'Filtrer l’écran par antenne';

    // Les listes déroulantes de saisie suivent la même liste.
    const options = liste
      .map(function (a) {
        return '<option value="' + esc(a.id) + '">' + esc(a.nom) + '</option>';
      })
      .join('');
    $('newAntenneBloc').hidden = false;
    $('newAntenne').innerHTML = options;
    if (view.antenneActive) $('newAntenne').value = view.antenneActive;
    if ($('agentAntenne')) {
      $('agentAntenneBloc').hidden = false;
      $('agentAntenne').innerHTML = '<option value="">Toutes les antennes</option>' + options;
    }
  }

  $('antenneActive').addEventListener('change', function (e) {
    view.antenneActive = e.target.value;
    try {
      root.localStorage.setItem(ANTENNE_KEY, view.antenneActive);
    } catch (err) {
      /* stockage indisponible : le choix vaut pour cette session */
    }
    renderAll();
  });

  /** Filtre commun : tout ce qui s'affiche passe par là. */

  /* ═════════════ les postes du bureau ═════════════

     Quatre ordinateurs à l'accueil, un seul registre. Cette carte répond à la
     seule question que se pose le responsable : « qu'est-ce que je tape sur le
     poste d'à côté, et est-ce que mes postes sont bien reliés ? » */
  function ligneAdresse(titre, url, detail, principale) {
    return (
      '<div class="poste-adresse' + (principale ? ' principale' : '') + '">' +
      '<div class="poste-adresse-titre">' + esc(titre) + '</div>' +
      '<div class="poste-adresse-url"><code>' + esc(url) + '</code>' +
      '<button class="link-btn" data-copier="' + esc(url) + '">Copier</button></div>' +
      (detail ? '<div class="hint">' + esc(detail) + '</div>' : '') +
      '</div>'
    );
  }

  /* ═════════════ sections des réglages ═════════════

     Onze cartes empilées, c'est un mur : on ne sait plus où chercher, et le
     réglage qu'on utilise une fois par an occupe autant de place que celui
     qu'on touche chaque semaine. On les range par la question qu'on se pose en
     arrivant, et on n'en montre qu'un groupe à la fois.

     Aucune carte ne disparaît et aucune ne change de nom : elles changent
     seulement de voisinage. */
  const SECTIONS_REGLAGES = [
    { id: 'bureau', label: 'Le bureau' },
    { id: 'messages', label: 'Les messages' },
    { id: 'acces', label: 'Les accès' },
    { id: 'registre', label: 'Le registre' },
    { id: 'controle', label: 'Contrôle' }
  ];

  const SECTIONS_SUIVI = [
    { id: 'traiter', label: 'À traiter' },
    { id: 'journalier', label: 'Historique' },
    { id: 'chiffres', label: 'Statistiques' }
  ];

  /* Une seule mécanique de sous-sections pour tout le monde : une barre
     segmentée, des groupes de cartes, un seul groupe visible. Elle sert aux
     Réglages et au Suivi — en écrire deux versions garantirait qu'elles
     divergent au premier correctif. */
  function groupeDe(panneau, id) {
    return document.querySelector('#' + panneau + ' [data-groupe="' + id + '"]');
  }

  /* Un groupe dont toutes les cartes sont masquées par les droits ne doit pas
     s'afficher vide : mieux vaut retirer l'onglet que proposer une page morte. */
  function groupeHabite(panneau, id) {
    const g = groupeDe(panneau, id);
    if (!g) return false;
    return Array.prototype.some.call(g.querySelectorAll(':scope > .card'), function (c) {
      return !c.hidden;
    });
  }

  function renderSections(panneau, barreId, sections, choisie, choisir) {
    const barre = $(barreId);
    if (!barre) return;
    const ouvertes = sections.filter(function (s) {
      return groupeHabite(panneau, s.id);
    });
    if (!ouvertes.length) {
      barre.innerHTML = '';
      return;
    }
    /* Si la section retenue s'est refermée entre-temps — un droit retiré, un
       accès changé — on retombe sur la première ouverte plutôt que sur rien. */
    if (!ouvertes.some(function (s) { return s.id === choisie; })) {
      choisie = ouvertes[0].id;
      choisir(choisie);
    }
    barre.innerHTML = ouvertes
      .map(function (s) {
        return (
          '<button type="button" role="tab" data-section="' + esc(s.id) + '"' +
          (s.id === choisie ? ' class="active" aria-selected="true"' : ' aria-selected="false"') +
          '>' + esc(s.label) + '</button>'
        );
      })
      .join('');
    sections.forEach(function (s) {
      const g = groupeDe(panneau, s.id);
      if (g) g.hidden = s.id !== choisie;
    });
  }

  function renderSectionsReglages() {
    renderSections('panel-reglages', 'reglagesSections', SECTIONS_REGLAGES, view.sectionReglages, function (id) {
      view.sectionReglages = id;
    });
  }

  function renderSectionsSuivi() {
    renderSections('panel-suivi', 'suiviSections', SECTIONS_SUIVI, view.sectionSuivi, function (id) {
      view.sectionSuivi = id;
    });
  }

  $('reglagesSections').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-section]');
    if (!b) return;
    view.sectionReglages = b.dataset.section;
    renderSectionsReglages();
    // « Postes du bureau » interroge le serveur : elle ne se charge qu'affichée.
    if (view.sectionReglages === 'bureau') renderPostes(true);
  });

  $('suiviSections').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-section]');
    if (!b) return;
    view.sectionSuivi = b.dataset.section;
    renderSectionsSuivi();
  });

  async function renderPostes(force) {
    const carte = $('postesCard');
    /* Sans serveur, il n'y a pas de poste à relier : le registre tient dans ce
       navigateur, et parler de réseau n'aurait aucun sens. */
    const ouvert = S.mode === 'serveur' && S.auth.user && roles.peut(S.auth.user, 'reglages');
    carte.hidden = !ouvert;
    if (!ouvert) return;

    /* renderAll() est rappelé à chaque changement d'état — et le flux en
       provoque un à chaque écriture des autres postes. Interroger le serveur à
       chaque fois ferait un appel par écriture et par poste, pour une carte que
       personne ne regarde. On ne la charge que si elle est à l'écran. */
    /* Deux conditions maintenant : le panneau des réglages doit être à l'écran,
       *et* la section « Le bureau » ouverte — sinon on interrogerait le serveur
       pour une carte rangée derrière un autre onglet. */
    const visible =
      document.getElementById('panel-reglages').classList.contains('active') &&
      view.sectionReglages === 'bureau';
    if (!visible && !force) return;

    let vue;
    try {
      vue = await store.loadReseau();
    } catch (err) {
      $('postesAdresse').innerHTML = '<div class="empty">Adresse du serveur indisponible.</div>';
      return;
    }
    view.reseau = vue;
    const r = vue.reseau;

    if (vue.ecouteFermee) {
      /* Avant toute adresse : elles ne répondraient pas. C'est le réglage
         d'installation par défaut, prudent tant qu'on est sur un seul poste,
         et c'est exactement ce qui bloque tout dès qu'on en a quatre. */
      $('postesAdresse').innerHTML =
        '<div class="msg error"><strong>Ce serveur n’écoute que sur cet ordinateur.</strong><br>' +
        'Les autres postes du bureau ne peuvent pas s’y connecter, quelle que soit l’adresse ' +
        'qu’ils tapent. C’est le réglage posé à l’installation — prudent pour un poste seul, ' +
        'bloquant dès qu’il y en a plusieurs.<br><br>' +
        'Pour l’ouvrir : dans le fichier <code>.env</code>, à côté de l’application, remplacez ' +
        '<code>HOST=' + esc(vue.hote || '127.0.0.1') + '</code> par <code>HOST=0.0.0.0</code>, ' +
        'puis redémarrez l’application.</div>';
    } else if (r.aucuneAdresse) {
      $('postesAdresse').innerHTML =
        '<div class="msg error">Ce poste n’a aucune adresse sur le réseau : câble débranché, ' +
        'ou wifi coupé. Les autres postes ne peuvent rien joindre tant que c’est le cas.</div>';
    } else {
      $('postesAdresse').innerHTML =
        (r.nomPoste
          ? ligneAdresse('À taper sur les autres postes', r.recommandee,
              'Le nom du poste ne change pas, même si son adresse change.', true)
          : '') +
        r.adresses
          .map(function (a, i) {
            return ligneAdresse(
              r.nomPoste ? 'Ou, par l’adresse (' + a.type + ')' : 'À taper sur les autres postes',
              a.url,
              a.privee ? '' : 'Cette adresse n’est pas celle d’un réseau local habituel.',
              !r.nomPoste && i === 0
            );
          })
          .join('');
    }

    const alertes = [];
    if (vue.adresseChangee) {
      const avant = (vue.adresseChangee.precedentes || [])
        .map(function (a) {
          return a.adresse;
        })
        .join(', ');
      alertes.push(
        '<div class="msg error">L’adresse de ce poste a changé le ' +
          esc(util.formatJour(String(vue.adresseChangee.le).slice(0, 10))) +
          (avant ? ' (avant : ' + esc(avant) + ')' : '') +
          '. Les autres postes doivent être remis à jour — ou faites réserver une adresse ' +
          'fixe à ce poste sur votre box.</div>'
      );
    }
    if (r.protocole === 'http' && !r.aucuneAdresse) {
      alertes.push(
        '<div class="msg">En <strong>http</strong>, le mot de passe circule en clair sur le ' +
          'réseau, et les autres postes ne peuvent ni installer l’application ni travailler ' +
          'hors ligne. Voir <code>docs/plusieurs-postes.md</code> pour passer en https.</div>'
      );
    }
    $('postesAlertes').innerHTML = alertes.join('');

    const postes = vue.postes || [];
    $('postesListe').innerHTML = postes.length
      ? '<div class="table-scroll"><table><thead><tr><th>Poste</th><th>Accès</th>' +
        '<th>Antenne</th><th>Relié depuis</th></tr></thead><tbody>' +
        postes
          .map(function (p) {
            const antenne = p.antenneId
              ? (antennes().find(function (a) {
                  return a.id === p.antenneId;
                }) || {}).nom || p.antenneId
              : '—';
            return (
              '<tr><td><strong>' + esc(p.nom) + '</strong>' +
              (p.moi ? ' <span class="status-pill">ce poste</span>' : '') +
              '</td><td>' +
              (p.role === 'responsable' ? 'responsable' : 'agent ' + esc(p.identifiant)) +
              '</td><td>' + esc(antenne) + '</td><td class="attente-cell">' +
              esc(util.formatDateTime(p.depuis)) +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>'
      : '<div class="empty">Aucun poste relié — pas même celui-ci, ce qui est anormal.</div>';
  }

  $('postesCard').addEventListener('click', function (e) {
    const copier = e.target.closest('button[data-copier]');
    if (!copier) return;
    const texte = copier.dataset.copier;
    if (root.navigator.clipboard) {
      root.navigator.clipboard.writeText(texte).then(
        function () {
          toast('Adresse copiée : ' + texte, 'ok');
        },
        function () {
          toast('Copie impossible. Recopiez : ' + texte, 'error');
        }
      );
    } else {
      toast('Recopiez : ' + texte, '');
    }
  });

  $('rafraichirPostesBtn').addEventListener('click', function () {
    renderPostes(true);
  });

  /* La fiche à scotcher sur chacun des autres écrans : l'adresse, et les
     gestes à faire. Un papier collé au bord de l'écran vaut mieux qu'une
     explication donnée une fois. */
  $('imprimerPostesBtn').addEventListener('click', function () {
    const vue = view.reseau;
    if (!vue) return;
    const r = vue.reseau;
    const adresse = r.recommandee || '—';
    const secours = r.adresses.length && r.adresses[0].url !== adresse ? r.adresses[0].url : '';
    impression.imprimerFeuille(
      '<h1>' + esc(S.settings.officeName || 'Bureau du Courrier') + ' — accès depuis ce poste</h1>' +
        '<p>Le registre est tenu sur le poste du bureau. Cet ordinateur s’y connecte ; ' +
        'il n’a rien à installer.</p>' +
        '<table><tbody>' +
        '<tr><td>1. Ouvrir le navigateur et taper</td><td class="b">' + esc(adresse) + '</td></tr>' +
        (secours ? '<tr><td>2. Si cela ne répond pas, essayer</td><td class="b">' + esc(secours) + '</td></tr>' : '') +
        '<tr><td>' + (secours ? '3' : '2') + '. Se connecter avec</td><td class="b">l’identifiant et le code remis par le responsable</td></tr>' +
        '</tbody></table>' +
        '<p style="margin-top:28px;">Le poste du bureau doit être allumé : c’est lui qui garde le registre.</p>'
    );
  });

  async function renderCarteAntennes() {
    const carte = $('antennesCard');
    carte.hidden = !(S.auth.user && roles.estResponsable(S.auth.user) && S.mode === 'serveur');
    if (carte.hidden) return;

    const liste = antennes();
    $('countAntennes').textContent = liste.length;
    $('antennesListe').innerHTML = liste.length
      ? '<div class="table-scroll"><table><thead><tr><th>Antenne</th><th>Adresse</th>' +
        '<th>Destinataires</th><th>En attente</th><th></th></tr></thead><tbody>' +
        liste
          .map(function (a) {
            const dest = S.contacts.filter(function (c) {
              return util.dansAntenne(c, a.id, liste);
            }).length;
            const attente = S.history.filter(function (h) {
              return enAttente(h) && util.dansAntenne(h, a.id, liste);
            }).length;
            return (
              '<tr><td><strong>' + esc(a.nom) + '</strong></td><td>' + esc(a.adresse || '—') +
              '</td><td>' + dest + '</td><td>' + attente +
              '</td><td class="actions"><button class="link-btn danger" data-antenne-del="' +
              esc(a.id) + '">Retirer</button></td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>'
      : '<div class="empty">Un seul bureau. Ajoutez une antenne si vous en tenez plusieurs.</div>';

    $('antennesListe').querySelectorAll('button[data-antenne-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        retirerAntenne(b.dataset.antenneDel);
      });
    });
  }

  async function retirerAntenne(id) {
    const a = antennes().find(function (x) {
      return x.id === id;
    });
    const rattaches = S.contacts.filter(function (c) {
      return util.dansAntenne(c, id, antennes());
    }).length;
    const ok = await confirmDialog(
      'Retirer l’antenne',
      'L’antenne « ' + (a ? a.nom : id) + ' » disparaît de la liste. ' +
        (rattaches
          ? rattaches + ' destinataire(s) y sont rattachés : ils basculeront sur la première antenne restante. '
          : '') +
        'Aucun destinataire ni courrier n’est supprimé.',
      'Retirer'
    );
    if (!ok) return;
    try {
      await store.saveSettings({
        antennes: antennes().filter(function (x) {
          return x.id !== id;
        })
      });
      if (view.antenneActive === id) view.antenneActive = '';
      setMsg('antennesMsg', 'ok', 'Antenne retirée.');
      renderAll();
    } catch (err) {
      setMsg('antennesMsg', 'error', esc(err.message));
    }
  }

  $('nouvelleAntenneBtn').addEventListener('click', function () {
    $('nouvelleAntenneForm').hidden = false;
    $('antenneNom').value = '';
    $('antenneAdresse').value = '';
    $('antenneNom').focus();
  });

  $('annulerAntenneBtn').addEventListener('click', function () {
    $('nouvelleAntenneForm').hidden = true;
  });

  $('creerAntenneBtn').addEventListener('click', async function () {
    const nom = $('antenneNom').value.trim();
    if (!nom) {
      setMsg('antennesMsg', 'error', 'Donnez un nom à l’antenne.');
      $('antenneNom').focus();
      return;
    }
    const id = util.idAntenne(nom);
    if (antennes().some(function (a) { return a.id === id; })) {
      setMsg('antennesMsg', 'error', 'Une antenne porte déjà ce nom.');
      return;
    }
    try {
      await store.saveSettings({
        antennes: antennes().concat([{ id: id, nom: nom, adresse: $('antenneAdresse').value.trim() }])
      });
      $('nouvelleAntenneForm').hidden = true;
      setMsg('antennesMsg', 'ok', 'Antenne « ' + esc(nom) + ' » ajoutée.');
      renderAll();
    } catch (err) {
      setMsg('antennesMsg', 'error', esc(err.message));
    }
  });

  /* ═════════════ accès des agents ═════════════ */

  /* Le responsable crée ici les accès secondaires. Un accès = un nom, un
     identifiant tiré au sort, un code à six chiffres, et une liste de cases.
     Le code n'est montré qu'une fois : il n'est conservé que haché. */

  function casesDroits(prefixe, permissions) {
    const p = roles.nettoyerPermissions(permissions);
    return (
      '<div class="droits-grille">' +
      roles.DROITS.map(function (d) {
        return (
          '<label class="check-row droit-ligne"><input type="checkbox" data-droit="' +
          esc(d.id) + '" id="' + prefixe + '-' + esc(d.id) + '"' +
          (p[d.id] ? ' checked' : '') + '> <span><strong>' + esc(d.label) + '</strong>' +
          '<span class="droit-detail">' + esc(d.detail) + '</span></span></label>'
        );
      }).join('') +
      '</div>'
    );
  }

  function lireDroits(racine) {
    const out = {};
    racine.querySelectorAll('input[data-droit]').forEach(function (c) {
      out[c.dataset.droit] = c.checked;
    });
    return out;
  }

  async function renderAgents() {
    const carte = $('agentsCard');
    // La gestion des accès n'appartient qu'au responsable.
    carte.hidden = !(S.auth.user && roles.estResponsable(S.auth.user) && S.mode === 'serveur');
    if (carte.hidden) return;

    try {
      const data = await store.listerAgents();
      $('countAgents').textContent = data.agents.length;
      $('agentsListe').innerHTML = data.agents.length
        ? data.agents
            .map(function (a) {
              const p = roles.nettoyerPermissions(a.permissions);
              const ouverts = roles.DROITS.filter(function (d) {
                return p[d.id];
              });
              return (
                '<div class="agent-fiche' + (a.suspendu ? ' suspendu' : '') + '" data-agent="' + esc(a.id) + '">' +
                '<div class="agent-tete">' +
                '<span class="identifiant-pill">' + esc(a.identifiant) + '</span>' +
                '<strong>' + esc(a.name) + '</strong>' +
                (a.suspendu ? '<span class="porteur-tag">suspendu</span>' : '') +
                (p.codes ? '<span class="compte-pill">voit les codes</span>' : '') +
                '</div>' +
                '<p class="hint">' +
                (a.derniereConnexion
                  ? 'Dernière ouverture : ' + esc(util.formatDateTime(a.derniereConnexion))
                  : 'Jamais utilisé.') +
                ' — ' + ouverts.length + ' droit(s) ouvert(s).</p>' +
                '<details><summary>Modifier les autorisations</summary>' +
                casesDroits('a' + esc(a.id), p) +
                '<div class="row-actions">' +
                '<button class="btn small" data-agent-save="' + esc(a.id) + '">Enregistrer</button>' +
                '<button class="btn ghost small" data-agent-code="' + esc(a.id) + '">Nouveau code d’accès</button>' +
                '<button class="btn ghost small" data-agent-susp="' + esc(a.id) + '">' +
                (a.suspendu ? 'Réactiver' : 'Suspendre') + '</button>' +
                '<button class="btn ghost small danger" data-agent-del="' + esc(a.id) + '">Supprimer</button>' +
                '</div></details></div>'
              );
            })
            .join('')
        : '<div class="empty">Aucun accès agent. Le bouton ci-dessus en crée un.</div>';
      brancherAgents();
    } catch (err) {
      $('agentsListe').innerHTML = '<div class="empty">Liste indisponible : ' + esc(err.message) + '</div>';
    }
  }

  /* Le code ne se retrouve pas : on le montre en grand, une fois, avec de quoi
     le copier ou l'imprimer pour le remettre à la personne. */
  function montrerCode(nom, identifiant, code) {
    setMsg(
      'agentsMsg',
      'ok',
      '<strong>Accès créé pour ' + esc(nom) + '.</strong><br>' +
        'Notez ces deux valeurs et remettez-les à la personne : ' +
        '<span class="identifiant-pill">' + esc(identifiant) + '</span> ' +
        '<span class="code-pill">' + esc(code) + '</span><br>' +
        '<em>Le code n’est pas conservé en clair : il ne pourra pas être relu. ' +
        'Perdu, il se régénère.</em>'
    );
  }

  function brancherAgents() {
    const boite = $('agentsListe');
    boite.querySelectorAll('button[data-agent-save]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const fiche = b.closest('.agent-fiche');
        try {
          await store.majAgent(b.dataset.agentSave, { permissions: lireDroits(fiche) });
          setMsg('agentsMsg', 'ok', 'Autorisations enregistrées.');
          renderAgents();
        } catch (err) {
          setMsg('agentsMsg', 'error', esc(err.message));
        }
      });
    });
    boite.querySelectorAll('button[data-agent-code]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const ok = await confirmDialog(
          'Nouveau code d’accès',
          'L’ancien code cessera aussitôt de fonctionner et la session ouverte sera fermée.',
          'Régénérer'
        );
        if (!ok) return;
        try {
          const r = await store.regenererCodeAgent(b.dataset.agentCode);
          const fiche = b.closest('.agent-fiche');
          montrerCode(fiche.querySelector('strong').textContent, r.identifiant, r.code);
          renderAgents();
        } catch (err) {
          setMsg('agentsMsg', 'error', esc(err.message));
        }
      });
    });
    boite.querySelectorAll('button[data-agent-susp]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const fiche = b.closest('.agent-fiche');
        const suspendre = !fiche.classList.contains('suspendu');
        try {
          await store.majAgent(b.dataset.agentSusp, { suspendu: suspendre });
          setMsg('agentsMsg', 'ok', suspendre ? 'Accès suspendu, session fermée.' : 'Accès réactivé.');
          renderAgents();
        } catch (err) {
          setMsg('agentsMsg', 'error', esc(err.message));
        }
      });
    });
    boite.querySelectorAll('button[data-agent-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const ok = await confirmDialog(
          'Supprimer cet accès',
          'L’identifiant cessera définitivement de fonctionner. Le registre n’est pas touché.',
          'Supprimer'
        );
        if (!ok) return;
        try {
          await store.supprimerAgent(b.dataset.agentDel);
          setMsg('agentsMsg', 'ok', 'Accès supprimé.');
          renderAgents();
        } catch (err) {
          setMsg('agentsMsg', 'error', esc(err.message));
        }
      });
    });
  }

  $('nouvelAgentBtn').addEventListener('click', function () {
    $('agentDroitsNeuf').innerHTML = casesDroits('neuf', roles.DEFAUT_AGENT);
    $('nouvelAgentForm').hidden = false;
    $('agentNom').value = '';
    $('agentNom').focus();
  });

  $('annulerAgentBtn').addEventListener('click', function () {
    $('nouvelAgentForm').hidden = true;
  });

  $('creerAgentBtn').addEventListener('click', async function () {
    const nom = $('agentNom').value.trim();
    if (!nom) {
      setMsg('agentsMsg', 'error', 'Donnez un nom à cet accès — « Accueil du matin », « poste 2 ».');
      $('agentNom').focus();
      return;
    }
    try {
      const r = await store.creerAgent(nom, lireDroits($('agentDroitsNeuf')), {
        antenneId: $('agentAntenne') ? $('agentAntenne').value : ''
      });
      $('nouvelAgentForm').hidden = true;
      montrerCode(nom, r.agent.identifiant, r.code);
      renderAgents();
    } catch (err) {
      setMsg('agentsMsg', 'error', esc(err.message));
    }
  });

  $('changePasswordBtn').addEventListener('click', async function () {
    const actuel = $('pwdCurrent').value;
    const suivant = $('pwdNext').value;
    if (!actuel || !suivant) {
      setMsg('passwordMsg', 'error', 'Renseignez le mot de passe actuel et le nouveau.');
      return;
    }
    setMsg('passwordMsg', '', 'Changement…');
    try {
      await store.changePassword(actuel, suivant);
      $('pwdCurrent').value = '';
      $('pwdNext').value = '';
      setMsg('passwordMsg', 'ok', 'Mot de passe changé. Les autres sessions ont été fermées.');
    } catch (err) {
      // La session reste ouverte : seule la valeur saisie était fausse.
      setMsg('passwordMsg', 'error', esc(err.message));
      $('pwdCurrent').focus();
      $('pwdCurrent').select();
    }
  });

  /* ═════════════ application installable ═════════════ */

  const install = { prompt: null, installed: false };

  function isStandalone() {
    return (
      (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) ||
      root.navigator.standalone === true
    );
  }

  function renderInstallButton() {
    const btn = $('installBtn');
    btn.hidden = !install.prompt || install.installed || isStandalone();
  }

  root.addEventListener('beforeinstallprompt', function (e) {
    // On garde la main sur le moment de la proposition : elle n'a de sens
    // qu'après un clic délibéré sur « Installer l'application ».
    e.preventDefault();
    install.prompt = e;
    renderInstallButton();
    renderStatus();
  });

  root.addEventListener('appinstalled', function () {
    install.installed = true;
    install.prompt = null;
    renderInstallButton();
    renderStatus();
    toast('Application installée.', 'ok');
  });

  $('installBtn').addEventListener('click', async function () {
    if (!install.prompt) return;
    install.prompt.prompt();
    const choice = await install.prompt.userChoice;
    if (choice.outcome !== 'accepted') toast('Installation annulée.');
    install.prompt = null;
    renderInstallButton();
  });

  function installStatusText() {
    if (isStandalone() || install.installed) return 'Installée sur ce poste';
    if (install.prompt) return 'Installable — bouton en haut de la page';
    if (root.location.protocol === 'file:') {
      return 'Indisponible en ouverture directe du fichier — démarrez le serveur';
    }
    if (!('serviceWorker' in root.navigator)) return 'Navigateur sans prise en charge';
    return 'Non proposée par ce navigateur (voir README)';
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in root.navigator) || root.location.protocol === 'file:') return;

    /* Quand une nouvelle version prend le contrôle, la page affichée vient
       encore de l'ancienne : sans ce rechargement, il faudrait recharger deux
       fois pour voir la mise à jour. Le drapeau interdit toute boucle.

       Mais à la toute première visite, il n'y a pas d'ancienne version : le
       service worker s'installe et prend la main dans la foulée. Recharger là
       n'apporte rien et vide le formulaire en cours de saisie — une inscription
       tapée pendant ces deux secondes disparaissait. On ne recharge donc que
       s'il y avait déjà un contrôleur au chargement de la page. */
    const premiereInstallation = !root.navigator.serviceWorker.controller;
    let reloading = false;
    root.navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading || premiereInstallation) return;
      reloading = true;
      root.location.reload();
    });
    root.navigator.serviceWorker
      .register('sw.js')
      .then(function (registration) {
        registration.addEventListener('updatefound', function () {
          const arriving = registration.installing;
          if (!arriving) return;
          arriving.addEventListener('statechange', function () {
            // « installed » avec un contrôleur déjà en place = nouvelle version en attente.
            if (arriving.state === 'installed' && root.navigator.serviceWorker.controller) {
              toast('Nouvelle version disponible — rechargez la page.');
            }
          });
        });
      })
      .catch(function (err) {
        console.warn('Service worker non enregistré :', err.message);
      });
  }

  /* ═════════════ démarrage ═════════════ */

  function renderAll() {
    renderGate();
    renderRegistryChoice();
    renderMode();
    renderContacts();
    renderHistory();
    renderStatus();
    renderMailbox();
    renderPending();
    renderAppels();
    renderAppelEntrant();
    renderDossier();
    renderAccounts();
    renderStats();
    renderJournal();
    renderDomiciliation();
    renderAgents();
    renderAntennes();
    renderCarteAntennes();
    renderPostes();
    appliquerDroits();
    /* Après appliquerDroits : c'est lui qui masque les cartes, et les sections
       se calculent d'après ce qui reste visible. */
    renderSectionsReglages();
    renderSectionsSuivi();
  }

  /* L'interface masque ce qui n'est pas ouvert. Le serveur refuse de toute
     façon : cacher un bouton n'est pas une sécurité, c'est une politesse — on
     ne propose pas une action qui sera refusée. */
  function appliquerDroits() {
    const u = S.auth.user;
    // Sans compte du tout, le registre est ouvert : rien à masquer.
    if (!u) return;

    const droit = function (d) {
      return roles.peut(u, d);
    };
    const onglet = function (nom, ouvert) {
      const b = document.querySelector('nav button[data-panel="' + nom + '"]');
      if (b) b.hidden = !ouvert;
    };

    onglet('guichet', droit('guichet'));
    onglet('remise', droit('remise'));
    onglet('registre', droit('registre'));
    onglet('domiciliation', droit('domiciliation'));
    onglet('reglages', droit('reglages') || roles.estResponsable(u));

    // Un onglet masqué ne doit pas rester affiché sous les yeux.
    const actif = document.querySelector('nav button.active');
    if (actif && actif.hidden) {
      const premier = document.querySelector('nav button:not([hidden])');
      if (premier) showPanel(premier.dataset.panel);
    }

    /* Les codes de retrait masqués : le serveur les remplace déjà par des
       points. On le dit une fois, plutôt que de laisser croire à une panne. */
    const carte = $('retraitCard');
    if (carte) {
      let note = $('codesMasquesNote');
      if (!droit('codes')) {
        if (!note) {
          note = document.createElement('p');
          note.id = 'codesMasquesNote';
          note.className = 'hint';
          note.textContent =
            'Les codes de retrait ne sont pas affichés avec votre accès. Saisissez celui que la personne vous présente.';
          carte.appendChild(note);
        }
      } else if (note) {
        note.remove();
      }
    }

    // Exports et impression.
    ['exportContactsXlsxBtn', 'exportContactsBtn', 'exportHistoryBtn', 'exportHistoryXlsxBtn',
     'feuilleCasierBtn', 'feuilleCasierBtn2', 'etiquettesBtn', 'activesEtiquettesBtn'].forEach(function (id) {
      const b = $(id);
      if (b) b.hidden = !droit('exports');
    });
  }

  /* Une modification venue d'un autre poste change l'écran sans que personne
     n'ait rien touché ici. Sans un signe, c'est déroutant — on croit avoir
     cliqué quelque chose. On l'annonce brièvement, et on fait respirer une
     fois les compteurs qui ont bougé : de quoi comprendre d'où ça vient, sans
     interrompre ce qu'on est en train de faire. */
  let derniereMajVue = 0;

  function signalerMajDistante() {
    const quand = S.majDistanteA || 0;
    if (!quand || quand === derniereMajVue) return;
    derniereMajVue = quand;

    document.querySelectorAll('nav button[data-panel] .tab-count').forEach(function (n) {
      n.classList.remove('vient-de-changer');
      // Relire une propriété calculée relance l'animation sur un nœud déjà animé.
      void n.offsetWidth;
      n.classList.add('vient-de-changer');
    });

    const bandeau = $('majDistante');
    if (!bandeau) return;
    bandeau.hidden = false;
    bandeau.classList.remove('sortie');
    void bandeau.offsetWidth;
    clearTimeout(bandeau._minuteur);
    bandeau._minuteur = setTimeout(function () {
      bandeau.classList.add('sortie');
      setTimeout(function () {
        bandeau.hidden = true;
      }, 400);
    }, 3200);
  }

  store.onChange(function () {
    renderAll();
    signalerMajDistante();
  });

  document.addEventListener('keydown', function (e) {
    /* Ctrl+K (⌘K sur Mac) ouvre la recherche globale depuis n'importe où, y
       compris depuis un champ de saisie : c'est tout l'intérêt. */
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (palette.ouverte) fermerPalette();
      else ouvrirPalette();
      return;
    }
    if (e.key === 'Escape' && palette.ouverte) {
      e.preventDefault();
      fermerPalette();
      return;
    }
    // « / » ramène au guichet et met le curseur dans la recherche.
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      showPanel('guichet');
      nameInput.focus();
    }
  });

  async function start() {
    try {
      view.antenneActive = root.localStorage.getItem(ANTENNE_KEY) || '';
    } catch (e) {
      view.antenneActive = '';
    }
    $('dateStamp').textContent = new Date().toLocaleDateString('fr-CA', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const hash = (root.location.hash || '').replace('#', '');
    /* « dossier » et « historique » sont conservés : un signet ou un lien
       enregistré avant la fusion doit continuer d'aboutir quelque part, et le
       Suivi est bien l'endroit où ils menaient. */
    const ANCIENS = { dossier: 'suivi', historique: 'suivi' };
    const vers = ANCIENS[hash] || hash;
    if (['guichet', 'remise', 'registre', 'suivi', 'domiciliation', 'reglages'].includes(vers)) {
      if (ANCIENS[hash]) view.sectionSuivi = hash === 'historique' ? 'journalier' : 'traiter';
      showPanel(vers);
    }

    try {
      await store.init();
    } catch (err) {
      console.error(err);
      toast('Démarrage en mode dégradé : ' + err.message, 'error');
    }
    fillSettingsForm();
    syncCopiesFromSettings(true);
    renderAll();
    readMailboxReturn();
    renderInstallButton();
    registerServiceWorker();
    placerLeSoulignement();
    if (!S.auth.required) nameInput.focus();
  }

  /* Le soulignement de l'onglet se calcule à partir de la position réelle du
     bouton : il faut donc le replacer chaque fois que cette position change.
     Trois moments, et ils comptent tous les trois — au démarrage, quand les
     polices variables finissent d'arriver (les libellés changent alors de
     largeur), et au redimensionnement, où les six boutons se répartissent
     autrement. Sans le dernier, la barre reste sous l'ancien onglet dès qu'on
     tourne une tablette. */
  function placerLeSoulignement() {
    const actif = document.querySelector('nav button[data-panel].active');
    if (actif) ui.glisseOnglet(actif.dataset.panel);
  }
  root.addEventListener('resize', placerLeSoulignement);
  /* Les polices variables arrivent après le premier rendu : les libellés
     changent alors de largeur, et la barre se retrouve décalée. */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(placerLeSoulignement);
  }

  start();
})(window);
