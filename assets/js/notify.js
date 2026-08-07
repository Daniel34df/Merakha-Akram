/* Bureau du Courrier — composition et acheminement des notifications. */
(function (root) {
  'use strict';

  const util = root.BC.util;

  /**
   * Construit le message à partir du gabarit des réglages.
   * `overrides` permet de changer De / Cc / Cci pour un envoi précis, sans
   * toucher aux réglages : on passe les champs à remplacer, les autres suivent
   * les valeurs par défaut.
   */
  function compose(contact, settings, overrides) {
    const o = overrides || {};
    const type = util.typeCourrier(o.type);
    /* La langue vient du destinataire, sauf si l'appelant en impose une —
       l'aperçu des Réglages montre la langue en cours d'édition. */
    const langueId = util.langue(o.langue !== undefined ? o.langue : contact && contact.langue).id;
    const vars = {
      nom: contact.name,
      courriel: contact.email,
      date: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
      bureau: settings.officeName || 'Bureau du Courrier',
      // Le type voyage avec le message : c'est ce qui permet d'écrire
      // « {article} vous attend » sans rédiger quatre variantes à la main.
      type: type.label,
      // « Un colis » ouvre une phrase ; « un colis » se glisse au milieu.
      article: type.article,
      article_min: type.article.toLowerCase(),
      code: o.code || ''
    };
    /* Le gabarit propre au type l'emporte, sauf si l'appelant impose un texte
       (l'aperçu des réglages montre exactement ce qui est en train d'être
       écrit, pas ce qui serait choisi). */
    const gabarit =
      o.subject !== undefined || o.body !== undefined
        ? { subject: o.subject !== undefined ? o.subject : settings.subject, body: o.body !== undefined ? o.body : settings.body }
        : util.gabaritPour(settings, type.id, langueId);
    const pick = function (key) {
      return util.formatAddressList(
        util.parseAddressList(o[key] !== undefined ? o[key] : settings[key] || '').entries
      );
    };
    return {
      subject: util.renderTemplate(gabarit.subject, vars),
      body: util.renderTemplate(gabarit.body, vars),
      from: pick('from'),
      cc: pick('cc'),
      bcc: pick('bcc')
    };
  }

  /* mailto accepte cc et bcc (RFC 6068) mais pas l'expéditeur : celui-ci est
     imposé par le logiciel de courriel de l'employé·e. « De » ne s'applique
     donc qu'à l'envoi automatique par le serveur. */
  function mailtoUrl(contact, message) {
    const params = [
      'subject=' + encodeURIComponent(message.subject),
      'body=' + encodeURIComponent(message.body)
    ];
    if (message.cc) params.push('cc=' + encodeURIComponent(message.cc));
    if (message.bcc) params.push('bcc=' + encodeURIComponent(message.bcc));
    return 'mailto:' + encodeURIComponent(contact.email) + '?' + params.join('&');
  }

  /* Un clic sur une ancre est honoré dans bien plus de contextes (iframe cloisonnée,
     bloqueur de fenêtres strict) que window.open(), qui peut échouer en silence. */
  function openMailClient(url) {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.style.position = 'fixed';
      a.style.left = '-9999px';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e2) {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    }
  }

  /** Le message tel qu'il sera envoyé, en-têtes compris — pour l'aperçu et la copie. */
  function plainText(contact, message, options) {
    const opts = options || {};
    const lines = [];
    if (message.from) lines.push('De : ' + message.from);
    lines.push('À : ' + contact.email);
    if (message.cc) lines.push('Cc : ' + message.cc);
    // L'invisibilité du Cci vaut pour les destinataires, pas pour l'employé·e
    // au guichet : on l'affiche, sauf demande contraire.
    if (message.bcc && !opts.hideBcc) lines.push('Cci : ' + message.bcc);
    lines.push('Sujet : ' + message.subject);
    return lines.join('\n') + '\n\n' + message.body;
  }

  root.BC.notify = {
    compose: compose,
    mailtoUrl: mailtoUrl,
    openMailClient: openMailClient,
    copyText: copyText,
    plainText: plainText
  };
})(window);
