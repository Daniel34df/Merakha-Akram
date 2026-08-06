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
    // Inscription en attente du code de confirmation.
    pendingEmail: null
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
          return util.matchesQuery(c, q);
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
        return util.matchesQuery(c, raw);
      })
    );

    if (matches.length === 0) {
      renderUnknown(raw);
      return;
    }

    box.innerHTML =
      '<div class="card"><h2>' +
      (matches.length === 1 ? '1 destinataire trouvé' : matches.length + ' destinataires trouvés') +
      '</h2>' +
      matches
        .map(function (c) {
          return (
            '<div class="result-row"><div class="who">' +
            esc(c.name) +
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
        if (c) sendNotification(c, btn);
      });
    });
  }

  function renderUnknown(raw) {
    $('searchResults').innerHTML =
      '<div class="card">' +
      '<div class="msg error">Aucun destinataire trouvé pour « ' +
      esc(raw) +
      ' » dans le registre.</div>' +
      '<label for="quickEmail">Ajouter « ' +
      esc(raw) +
      ' » au registre et notifier</label>' +
      '<input type="email" id="quickEmail" placeholder="courriel@exemple.com" autocomplete="off">' +
      '<div class="row-actions"><button class="btn" id="quickAddBtn">Ajouter et notifier</button>' +
      '<button class="btn ghost" id="quickRegistreBtn">Ouvrir le registre</button></div>' +
      '<div id="quickMsg"></div></div>';

    const emailField = $('quickEmail');
    emailField.focus();
    emailField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('quickAddBtn').click();
      }
    });
    $('quickRegistreBtn').addEventListener('click', function () {
      showPanel('registre');
      $('newName').value = raw;
      $('newEmail').focus();
    });
    $('quickAddBtn').addEventListener('click', async function () {
      const email = emailField.value.trim();
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
        const contact = await store.addContact({ name: raw, email: email });
        toast('« ' + contact.name + ' » ajouté au registre.', 'ok');
        await sendNotification(contact);
      } catch (err) {
        setMsg('quickMsg', 'error', 'Impossible d’ajouter le destinataire : ' + esc(err.message));
      }
    });
  }

  async function sendNotification(contact, btn) {
    const copies = currentCopies();
    if (!copies) {
      toast('Corrigez les adresses en copie avant d’envoyer.', 'error');
      return;
    }
    const message = notify.compose(contact, S.settings, copies);
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

    stamp(auto ? 'Envoyé' : 'Préparé', contact.name);
    nameInput.value = '';
    hideSuggestions();

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

  /* ═════════════ registre ═════════════ */

  $('addForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const nameField = $('newName');
    const emailField = $('newEmail');
    const name = nameField.value.trim();
    const email = emailField.value.trim();

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
      await store.addContact({ name: name, email: email });
      nameField.value = '';
      emailField.value = '';
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
          return util.matchesQuery(c, q);
        })
      : S.contacts;
    return util.sortByName(list);
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
      '<div class="table-scroll"><table><thead><tr><th>Nom</th><th>Courriel</th><th></th></tr></thead><tbody>' +
      list
        .map(function (c) {
          if (c.id === view.editingId) {
            return (
              '<tr data-row="' +
              esc(c.id) +
              '">' +
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
              '<button class="link-btn" data-cancel="1">Annuler</button></td></tr>'
            );
          }
          return (
            '<tr>' +
            '<td>' +
            esc(c.name) +
            '</td><td>' +
            esc(c.email) +
            '</td>' +
            '<td class="actions">' +
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
          await store.updateContact(btn.dataset.save, { name: name, email: email });
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
    box.querySelectorAll('button[data-notify]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const c = S.contacts.find(function (x) {
          return x.id === btn.dataset.notify;
        });
        if (!c) return;
        showPanel('guichet');
        nameInput.value = c.name;
        sendNotification(c);
      });
    });
  }

  /* ---------- import / export ---------- */

  $('exportContactsBtn').addEventListener('click', function () {
    if (S.contacts.length === 0) {
      toast('Le registre est vide.', 'error');
      return;
    }
    const csv = util.toCsv(util.sortByName(S.contacts), ['name', 'email']).replace('name,email', 'nom,courriel');
    download('destinataires-' + stampSuffix() + '.csv', csv);
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

  function visibleHistory() {
    return S.history.filter(function (h) {
      if (view.historyDate && !util.isSameDay(h.date, view.historyDate)) return false;
      if (view.historyFilter.trim() && !util.matchesQuery(h, view.historyFilter)) return false;
      return true;
    });
  }

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
      '<div class="table-scroll"><table><thead><tr><th>Nom</th><th>Courriel</th><th>Copies</th><th>Date</th><th>Voie</th><th></th></tr></thead><tbody>' +
      list
        .map(function (h) {
          const pill = STATUS_PILL[h.status] || STATUS_PILL['envoyé'];
          const copies = [];
          if (h.cc) copies.push('Cc : ' + h.cc);
          if (h.bcc) copies.push('Cci : ' + h.bcc);
          return (
            '<tr><td>' +
            esc(h.name) +
            '</td><td>' +
            esc(h.email) +
            '</td><td class="copies-cell"' +
            (copies.length ? ' title="' + esc(copies.join(' · ')) + '"' : '') +
            '>' +
            (copies.length ? esc(copies.join(' · ')) : '—') +
            '</td><td>' +
            esc(util.formatDateTime(h.date)) +
            '</td><td>' +
            esc(h.method === 'auto' ? 'Automatique' : 'Logiciel de courriel') +
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
  }

  $('exportHistoryBtn').addEventListener('click', function () {
    if (S.history.length === 0) {
      toast('L’historique est vide.', 'error');
      return;
    }
    const rows = visibleHistory().map(function (h) {
      return {
        nom: h.name,
        courriel: h.email,
        cc: h.cc || '',
        cci: h.bcc || '',
        date: util.formatDateTime(h.date),
        voie: h.method === 'auto' ? 'automatique' : 'logiciel de courriel',
        statut: h.status || 'envoyé'
      };
    });
    download(
      'historique-' + stampSuffix() + '.csv',
      util.toCsv(rows, ['nom', 'courriel', 'cc', 'cci', 'date', 'voie', 'statut'])
    );
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

  function fillSettingsForm() {
    $('setOffice').value = S.settings.officeName || '';
    $('setFrom').value = S.settings.from || '';
    $('setCc').value = S.settings.cc || '';
    $('setBcc').value = S.settings.bcc || '';
    $('setSubject').value = S.settings.subject || '';
    $('setBody').value = S.settings.body || '';
    renderPreview();
  }

  function renderPreview() {
    const sample = S.contacts[0] || { name: 'Marie Tremblay', email: 'marie@exemple.com' };
    const message = notify.compose(sample, {
      officeName: $('setOffice').value,
      subject: $('setSubject').value,
      body: $('setBody').value,
      from: $('setFrom').value,
      cc: $('setCc').value,
      bcc: $('setBcc').value
    });
    $('settingsPreview').textContent = notify.plainText(sample, message);
  }

  ['setOffice', 'setSubject', 'setBody', 'setFrom', 'setCc', 'setBcc'].forEach(function (id) {
    $(id).addEventListener('input', renderPreview);
  });

  $('saveSettingsBtn').addEventListener('click', async function () {
    const subject = $('setSubject').value.trim();
    const body = $('setBody').value.trim();
    if (!subject || !body) {
      setMsg('settingsMsg', 'error', 'Le sujet et le corps du message ne peuvent pas être vides.');
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
        bcc: util.formatAddressList(bcc.entries)
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
    const firstRun = S.mode === 'serveur' && !S.auth.accountsExist && !view.skipAccount;
    const needed = S.mode === 'serveur' && (S.auth.required || firstRun);
    gate.hidden = !needed;
    document.body.style.overflow = needed ? 'hidden' : '';
    $('gateSkip').hidden = !firstRun;
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
    if (!S.auth.accountsExist && !view.gateFormChosen && !view.pendingEmail) {
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
    // L'étape du code n'est pas un onglet : on masque les onglets pendant.
    $('gateTabs').hidden = which === 'verify';
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
        $('verifyEmail').textContent = result.email;
        $('verifyCode').value = '';
        showGateForm('verify');
        $('verifyHint').textContent =
          'Le code est valable 15 minutes. Pensez à regarder dans les indésirables.';
        $('verifyCode').focus();
        return;
      }
      afterLogin();
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
      await store.verifySignup(view.pendingEmail, code);
      setMsg('gateMsg', '', '');
      view.pendingEmail = null;
      afterLogin();
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
       fois pour voir la mise à jour. Le drapeau interdit toute boucle. */
    let reloading = false;
    root.navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
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
    renderMode();
    renderContacts();
    renderHistory();
    renderStatus();
    renderMailbox();
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
    if (['guichet', 'registre', 'historique', 'reglages'].includes(hash)) showPanel(hash);

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
