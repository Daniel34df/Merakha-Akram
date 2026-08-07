/* Bureau du Courrier — interface. */
(function (root) {
  'use strict';

  const util = root.BC.util;
  const store = root.BC.store;
  const notify = root.BC.notify;
  const S = store.state;

  const $ = function (id) {
    return document.getElementById(id);
  };
  const esc = util.escapeHtml;

  /* Filtres d'affichage, purement locaux à l'interface. */
  const view = {
    contactFilter: '',
    historyFilter: '',
    historyDate: '',
    editingId: null,
    highlight: -1,
    suggestions: [],
    // Vrai dès que l'employé·e a modifié les copies au guichet : on cesse alors
    // de les réaligner sur les réglages tant qu'elles n'ont pas été remises à zéro.
    copiesTouched: false,
    // Premier démarrage : l'écran d'installation a été écarté volontairement.
    skipAccount: false,
    gateFormChosen: false,
    // Recherche au guichet : 'nom' ou 'boite'.
    searchMode: 'nom',
    historyState: 'tous',
    attenteFilter: '',
    pile: [],
    typeCourrier: 'lettre',
    // Inscription en attente du code de confirmation.
    pendingEmail: null,
    // Adresse confirmée, en cours d'association comme boîte d'envoi.
    associateEmail: null,
    // Réglages : onglet de gabarit affiché et brouillons non enregistrés.
    gabaritActif: 'general',
    gabaritGeneral: { subject: '', body: '' },
    gabarits: {}
  };

  /* ═════════════ retours visuels ═════════════ */

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity 0.3s ease';
      el.style.opacity = '0';
      setTimeout(function () {
        el.remove();
      }, 300);
    }, 3200);
  }

  function stamp(label, who) {
    const overlay = $('stampOverlay');
    $('stampLabel').textContent = label;
    $('stampWho').textContent = who;
    overlay.classList.add('show');
    setTimeout(function () {
      overlay.classList.remove('show');
    }, 1300);
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      const dlg = $('confirmDialog');
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmOk').textContent = okLabel || 'Confirmer';
      if (typeof dlg.showModal !== 'function') {
        resolve(root.confirm(text));
        return;
      }
      dlg.addEventListener(
        'close',
        function () {
          resolve(dlg.returnValue === 'ok');
        },
        { once: true }
      );
      dlg.showModal();
    });
  }

  function setMsg(id, kind, html) {
    $(id).innerHTML = html ? '<div class="msg ' + kind + '">' + html + '</div>' : '';
  }

  function download(filename, text, mime) {
    const blob = new Blob(['\uFEFF' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /** Téléchargement d'un fichier binaire (classeur Excel). */
  function downloadBytes(filename, bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function stampSuffix() {
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    const d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  /* ═════════════ navigation ═════════════ */

  function showPanel(name) {
    document.querySelectorAll('nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.panel === name);
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
    if (root.location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
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

  function renderCopiesState() {
    const cc = util.parseAddressList($('sendCc').value);
    const bcc = util.parseAddressList($('sendBcc').value);
    const total = cc.entries.length + bcc.entries.length;
    const parts = [];
    if (total) parts.push('· ' + total + (total > 1 ? ' adresses' : ' adresse'));
    if (view.copiesTouched) parts.push('· modifié');
    $('copiesState').textContent = parts.join(' ');
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
      ligneFiche('Courriel prévenu', record.email),
      ligneFiche(
        'Relances',
        record.reminderCount > 0
          ? record.reminderCount + ' relance(s) envoyée(s)'
          : 'aucune'
      )
    ];
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
        return util.matchesQuery(c, raw, view.searchMode);
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
      if (!util.isValidEmail(email)) {
        emailField.classList.add('invalid');
        setMsg('quickMsg', 'error', 'Veuillez entrer un courriel valide.');
        return;
      }
      const existing = store.findByEmail(email);
      if (existing) {
        setMsg('quickMsg', 'error', 'Ce courriel est déjà au registre sous « ' + esc(existing.name) + ' ».');
        return;
      }
      try {
        const contact = await store.addContact({ name: nom, email: email, box: boite });
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
    if (opts.pour) {
      message.body += '\n\n(Ce courrier est adressé à ' + opts.pour + ', dont vous assurez le relais.)';
    }
    const mailto = notify.mailtoUrl(contact, message);
    if (btn) btn.disabled = true;

    let auto = false;
    let failure = null;
    if (store.canSendAutomatically()) {
      try {
        await store.sendViaServer(contact, message);
        auto = true;
      } catch (err) {
        failure = err.message;
      }
    }

    if (!auto) {
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

  /* ═════════════ courriers en attente ═════════════ */

  function renderPending() {
    const box = $('pendingCard');
    const attente = S.history.filter(enAttente);
    $('countAttente').textContent = attente.length;
    $('tabCountAttente').textContent = attente.length;

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

    // Du plus ancien au plus récent : c'est celui qui attend le plus qui presse.
    const anciens = visibles.slice().sort(function (a, b) {
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
            (jours >= 7 ? ' class="vieux"' : '') +
            '><td class="attente-cell">' +
            (jours === 0 ? 'aujourd’hui' : jours + ' j') +
            '</td><td class="box-cell">' +
            ((contact && contact.box) || '—') +
            '</td><td>' +
            esc(h.name) +
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
        ['Courriel', c.email],
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

    const dlg = $('ficheDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
  }

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
    $('tabCountDossier').textContent = signales.length;

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

  function imprimerFeuilleCasier() {
    const attente = S.history.filter(enAttente);
    if (attente.length === 0) {
      toast('Aucun courrier en attente.', 'error');
      return;
    }
    // Triée par numéro de boîte : c'est l'ordre dans lequel on parcourt le local.
    const lignes = attente
      .map(function (h) {
        const contact = S.contacts.find(function (c) {
          return c.id === h.contactId;
        });
        return {
          boite: (contact && contact.box) || '',
          nom: h.name,
          jours: joursDepuis(h.date),
          type: util.typeCourrier(h.type).label,
          code: h.pickupCode || ''
        };
      })
      .sort(function (a, b) {
        return util.normalizeBox(a.boite).localeCompare(util.normalizeBox(b.boite), 'fr', { numeric: true });
      });

    $('feuilleCasier').innerHTML =
      '<h1>Courriers en attente</h1>' +
      '<p>' +
      (S.settings.officeName || 'Bureau du Courrier') +
      ' — ' +
      new Date().toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' }) +
      ' — ' +
      lignes.length +
      ' courrier(s)</p>' +
      '<table><thead><tr><th>Boîte</th><th>Nom</th><th>Type</th><th>Attente</th><th>Code</th><th>Retiré</th></tr></thead><tbody>' +
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
      '</tbody></table>';

    $('feuilleCasier').hidden = false;
    document.body.classList.add('impression-casier');
    root.print();
    // Le retour d'impression n'est pas fiable partout : on rétablit tout de suite.
    setTimeout(function () {
      document.body.classList.remove('impression-casier');
      $('feuilleCasier').hidden = true;
    }, 500);
  }

  $('feuilleCasierBtn').addEventListener('click', imprimerFeuilleCasier);
  $('feuilleCasierBtn2').addEventListener('click', imprimerFeuilleCasier);

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

  $('addForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const nameField = $('newName');
    const emailField = $('newEmail');
    const name = nameField.value.trim();
    const email = emailField.value.trim();
    const box = $('newBox').value.trim();

    nameField.classList.toggle('invalid', !name);
    emailField.classList.toggle('invalid', !util.isValidEmail(email));
    if (!name || !util.isValidEmail(email)) {
      setMsg('addMsg', 'error', 'Veuillez entrer un nom et un courriel valide.');
      return;
    }
    const existing = store.findByEmail(email);
    if (existing) {
      setMsg('addMsg', 'error', 'Ce courriel est déjà au registre sous « ' + esc(existing.name) + ' ».');
      return;
    }
    try {
      await store.addContact({ name: name, email: email, box: box });
      nameField.value = '';
      emailField.value = '';
      $('newBox').value = '';
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
    const list = q
      ? S.contacts.filter(function (c) {
          return util.matchesQuery(c, q, 'tout');
        })
      : S.contacts;
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
    $('countContacts').textContent = S.contacts.length;
    $('tabCountContacts').textContent = S.contacts.length;
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
      '<div class="table-scroll"><table><thead><tr><th>N° boîte</th><th>Nom</th><th>Courriel</th><th></th></tr></thead><tbody>' +
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
              '<td class="actions">' +
              '<button class="link-btn" data-save="' +
              esc(c.id) +
              '">Enregistrer</button>' +
              '<button class="link-btn" data-cancel="1">Annuler</button></td></tr>' +
              '<tr data-absence="' +
              esc(c.id) +
              '"><td colspan="4" class="absence-edit">' +
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
            esc(c.email) +
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
            '">Supprimer</button></td></tr>'
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
        const absence = lireAbsence(btn.dataset.save);
        if (!name || !util.isValidEmail(email)) {
          toast('Nom ou courriel invalide.', 'error');
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
            Object.assign({ name: name, email: email, box: boite }, absence)
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
        const ok = await confirmDialog(
          'Supprimer du registre',
          'Retirer « ' + c.name + ' » (' + c.email + ') du registre ? L’historique des notifications est conservé.',
          'Supprimer'
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

  function enAttente(h) {
    return !h.pickedUpAt && !h.closedAt && h.status !== 'échec';
  }

  /** Même classement que le serveur : clos, récupéré, échec, signalé, relancé, attente. */
  function etatCourrier(h) {
    if (h.closedAt) return 'clos';
    if (h.pickedUpAt) return 'recupere';
    if (h.status === 'échec') return 'echec';
    if (h.flaggedAt) return 'signale';
    if (h.reminderCount > 0) return 'relance';
    return 'attente';
  }

  function joursDepuis(iso) {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  function visibleHistory() {
    return S.history.filter(function (h) {
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
    $('countHistory').textContent = S.history.length;
    $('tabCountHistory').textContent = S.history.length;
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

    box.innerHTML =
      '<div class="table-scroll"><table><thead><tr><th>Nom</th><th>Type</th><th>Date</th><th>Attente</th><th>Suivi</th><th></th></tr></thead><tbody>' +
      list
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
        const propre = o.id !== 'general' && !!view.gabarits[o.id];
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
  function memoriserGabaritCourant() {
    const subject = $('setSubject').value;
    const body = $('setBody').value;
    if (view.gabaritActif === 'general') {
      view.gabaritGeneral = { subject: subject, body: body };
      return;
    }
    if (subject.trim() && body.trim()) {
      view.gabarits[view.gabaritActif] = { subject: subject, body: body };
    } else {
      // Un type dont on vide les champs revient au modèle général.
      delete view.gabarits[view.gabaritActif];
    }
  }

  function chargerGabaritActif() {
    const general = view.gabaritGeneral;
    const propre = view.gabaritActif !== 'general' ? view.gabarits[view.gabaritActif] : null;
    const courant = view.gabaritActif === 'general' ? general : propre || { subject: '', body: '' };

    $('setSubject').value = courant.subject;
    $('setBody').value = courant.body;
    $('setSubject').placeholder = view.gabaritActif === 'general' ? '' : general.subject;
    $('setBody').placeholder = view.gabaritActif === 'general' ? '' : general.body;
    $('gabaritActions').hidden = view.gabaritActif === 'general' || !propre;

    const type = view.gabaritActif === 'general' ? null : util.typeCourrier(view.gabaritActif);
    $('gabaritEtat').textContent =
      view.gabaritActif === 'general'
        ? 'Ce texte sert à tous les types qui n’ont pas de modèle propre.'
        : propre
          ? 'Modèle propre au type « ' + type.label + ' ».'
          : 'Aucun modèle propre : « ' + type.label + ' » emploie le modèle général. Écrivez ici pour en créer un.';

    ongletsGabarits();
    renderPreview();
  }

  function fillSettingsForm() {
    $('setOffice').value = S.settings.officeName || '';
    $('setFrom').value = S.settings.from || '';
    $('setCc').value = S.settings.cc || '';
    $('setBcc').value = S.settings.bcc || '';
    view.gabaritGeneral = { subject: S.settings.subject || '', body: S.settings.body || '' };
    view.gabarits = JSON.parse(JSON.stringify(S.settings.templates || {}));
    chargerGabaritActif();
  }

  $('gabaritEffacerBtn').addEventListener('click', function () {
    delete view.gabarits[view.gabaritActif];
    chargerGabaritActif();
    setMsg('settingsMsg', '', 'Ce type reprendra le modèle général au prochain enregistrement.');
  });

  function renderPreview() {
    const sample = S.contacts[0] || { name: 'Marie Tremblay', email: 'marie@exemple.com' };
    // Un onglet de type sans texte propre montre ce qui partirait vraiment :
    // le modèle général.
    const subject = $('setSubject').value.trim() || view.gabaritGeneral.subject;
    const body = $('setBody').value.trim() || view.gabaritGeneral.body;
    const type = view.gabaritActif === 'general' ? util.TYPES_COURRIER[0] : util.typeCourrier(view.gabaritActif);
    const message = notify.compose(sample, {
      officeName: $('setOffice').value,
      subject: subject,
      body: body,
      from: $('setFrom').value,
      cc: $('setCc').value,
      bcc: $('setBcc').value
    }, { type: type.id, code: '4821' });
    $('settingsPreview').textContent = notify.plainText(sample, message);
  }

  ['setOffice', 'setSubject', 'setBody', 'setFrom', 'setCc', 'setBcc'].forEach(function (id) {
    $(id).addEventListener('input', renderPreview);
  });

  $('saveSettingsBtn').addEventListener('click', async function () {
    memoriserGabaritCourant();
    const subject = view.gabaritGeneral.subject.trim();
    const body = view.gabaritGeneral.body.trim();
    if (!subject || !body) {
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
        templates: view.gabarits
      });
      fillSettingsForm();
      syncCopiesFromSettings(!view.copiesTouched);
      setMsg('settingsMsg', 'ok', 'Réglages enregistrés.');
    } catch (err) {
      setMsg('settingsMsg', 'error', 'Enregistrement impossible : ' + esc(err.message));
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
      const formulaires = ['loginForm', 'signupForm', 'verifyForm', 'associateForm', 'forgotForm', 'resetForm'];
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
    // Seuls Connexion et Créer un compte sont des onglets : les étapes
    // intermédiaires (code, association, oubli) masquent la barre.
    $('gateTabs').hidden = which !== 'login' && which !== 'signup';
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

  async function renderAccounts() {
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
    renderDossier();
    renderAccounts();
    renderStats();
    renderJournal();
  }

  store.onChange(renderAll);

  document.addEventListener('keydown', function (e) {
    // Échap ferme les suggestions ; « / » ramène au guichet et met le curseur dans la recherche.
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      showPanel('guichet');
      nameInput.focus();
    }
  });

  async function start() {
    $('dateStamp').textContent = new Date().toLocaleDateString('fr-CA', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const hash = (root.location.hash || '').replace('#', '');
    if (['guichet', 'remise', 'registre', 'dossier', 'historique', 'reglages'].includes(hash)) showPanel(hash);

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
    if (!S.auth.required) nameInput.focus();
  }

  start();
})(window);
