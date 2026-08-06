/* Bureau du Courrier — composition et acheminement des notifications. */
(function (root) {
  'use strict';

  const util = root.BC.util;

  /** Construit le sujet et le corps à partir du gabarit des réglages. */
  function compose(contact, settings) {
    const vars = {
      nom: contact.name,
      courriel: contact.email,
      date: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
      bureau: settings.officeName || 'Bureau du Courrier'
    };
    return {
      subject: util.renderTemplate(settings.subject, vars),
      body: util.renderTemplate(settings.body, vars)
    };
  }

  function mailtoUrl(contact, message) {
    return (
      'mailto:' +
      encodeURIComponent(contact.email) +
      '?subject=' +
      encodeURIComponent(message.subject) +
      '&body=' +
      encodeURIComponent(message.body)
    );
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

  function plainText(contact, message) {
    return 'À : ' + contact.email + '\nSujet : ' + message.subject + '\n\n' + message.body;
  }

  root.BC.notify = {
    compose: compose,
    mailtoUrl: mailtoUrl,
    openMailClient: openMailClient,
    copyText: copyText,
    plainText: plainText
  };
})(window);
