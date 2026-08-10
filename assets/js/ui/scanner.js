/* Bureau du Courrier — l'écran du scanner.

   Ce que voit l'agent : un champ, et la caméra quand elle est disponible.

   Le champ **est** la douchette. Un lecteur de comptoir tape le code puis
   envoie « Entrée », exactement comme un clavier : il n'y a rien à installer,
   rien à autoriser, et ça marche sur tous les navigateurs, en http comme en
   https. C'est pour ça qu'il est au centre de l'écran et non relégué en bas —
   c'est la voie qui marche toujours, pas le repli.

   La caméra vient en plus, quand le navigateur la donne. Sinon l'écran dit
   pourquoi et ce qu'il faut faire, plutôt que de laisser un bouton mort.

   Le calcul — ce qu'un code désigne, ce qu'une image contient — vit dans
   `assets/js/scanner.js`, vérifiable hors navigateur. Ici il n'y a que la
   caméra, le canevas et les clics. */
(function (root) {
  'use strict';

  const BC = root.BC;
  const ui = BC.ui;
  const store = BC.store;
  const scanner = BC.scanner;
  const S = store.state;
  const $ = ui.$;
  const esc = ui.esc;
  const ecrans = ui.ecrans;
  const toast = ui.toast;

  /* Le flux vidéo en cours, et la boucle de lecture. Gardés ici pour être
     coupés à coup sûr : une caméra qu'on oublie d'éteindre laisse une diode
     allumée au guichet, ce qui est au mieux inquiétant pour la personne en
     face. */
  const vif = { flux: null, boucle: null, detecteur: null };

  function capacites() {
    return scanner.capacites(root);
  }

  /* ── ouvrir, fermer ── */

  function ouvrir() {
    const dlg = $('scanDialog');
    if (!dlg) return;
    const c = capacites();

    $('scanEtat').innerHTML = c.camera
      ? ''
      : '<div class="msg" style="margin-bottom:10px;">' + esc(c.raison) + '</div>';
    $('scanCameraBloc').hidden = !c.camera;
    $('scanResultat').innerHTML = '';
    $('scanChamp').value = '';

    if (typeof dlg.showModal === 'function') dlg.showModal();
    // Le curseur dans le champ : une douchette tape aussitôt, sans clic.
    setTimeout(function () { $('scanChamp').focus(); }, 50);

    dlg.addEventListener('close', arreterCamera, { once: true });
  }

  function arreterCamera() {
    if (vif.boucle) { clearInterval(vif.boucle); vif.boucle = null; }
    if (vif.flux) {
      vif.flux.getTracks().forEach(function (t) { t.stop(); });
      vif.flux = null;
    }
    const b = $('scanCameraBtn');
    if (b) b.textContent = 'Allumer la caméra';
  }

  async function basculerCamera() {
    if (vif.flux) { arreterCamera(); return; }
    const video = $('scanVideo');
    const bouton = $('scanCameraBtn');
    try {
      vif.flux = await root.navigator.mediaDevices.getUserMedia({
        // La caméra arrière sur un téléphone : c'est celle qu'on pointe.
        video: { facingMode: 'environment', width: { ideal: 1280 } }
      });
    } catch (e) {
      ui.setMsg('scanEtat', 'error',
        'La caméra n’a pas pu être ouverte : ' + esc(e.message) +
        '. Le champ ci-dessus fonctionne avec une douchette.');
      return;
    }
    video.srcObject = vif.flux;
    await video.play().catch(function () {});
    bouton.textContent = 'Éteindre la caméra';

    /* Le détecteur natif s'il existe — il ajoute les QR et les codes des
       transporteurs. Sinon le décodeur maison lit le Code 39, donc les
       étiquettes que l'application a imprimées. */
    if (typeof root.BarcodeDetector === 'function' && !vif.detecteur) {
      try { vif.detecteur = new root.BarcodeDetector(); } catch (e) { vif.detecteur = null; }
    }

    /* Cinq images par seconde. Plus serait du calcul pour rien : une main qui
       présente une étiquette met une bonne seconde à se stabiliser. */
    vif.boucle = setInterval(lireUneImage, 200);
  }

  async function lireUneImage() {
    const video = $('scanVideo');
    if (!video || !video.videoWidth) return;

    if (vif.detecteur) {
      try {
        const trouves = await vif.detecteur.detect(video);
        if (trouves && trouves.length) return resoudre(trouves[0].rawValue);
      } catch (e) { /* on retombe sur le décodeur maison */ }
    }

    const c = $('scanCanevas');
    /* On ne lit qu'une bande horizontale au centre : c'est là qu'on présente
       l'étiquette, et c'est cinq fois moins de pixels à parcourir. */
    const largeur = Math.min(960, video.videoWidth);
    const hauteur = Math.max(40, Math.round(video.videoHeight / 5));
    c.width = largeur;
    c.height = hauteur;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(
      video,
      0, Math.round((video.videoHeight - hauteur) / 2), video.videoWidth, hauteur,
      0, 0, largeur, hauteur
    );
    const img = ctx.getImageData(0, 0, largeur, hauteur);
    const lu = scanner.lireImage(img.data, largeur, hauteur);
    if (lu) resoudre(lu);
  }

  /* ── ce qu'on fait d'un code lu ── */

  function resoudre(code) {
    const r = scanner.interpreter(code, {
      contacts: S.contacts,
      history: S.history,
      boites: S.boites,
      numerotation: S.settings && S.settings.numerotation
    });

    if (r.type === 'vide') return;

    const zone = $('scanResultat');
    zone.innerHTML =
      '<div class="msg ' + (r.type === 'inconnu' ? 'error' : 'ok') + '">' +
      esc(scanner.libelle(r)) + '</div>' +
      (r.type === 'plusieurs'
        ? '<ul>' + r.contacts.slice(0, 10).map(function (c) {
          return '<li><button type="button" class="link-btn" data-scan-fiche="' +
            esc(c.id) + '">' + esc(c.name) + '</button></li>';
        }).join('') + '</ul>'
        : '');

    if (r.type === 'inconnu' || r.type === 'plusieurs') return;

    // Un résultat sûr : on éteint la caméra et on ouvre ce qui a été trouvé.
    arreterCamera();
    $('scanDialog').close();

    if (r.type === 'boite') {
      ecrans.app.showPanel('registre');
      ui.view.sectionRegistre = 'casiers';
      ecrans.app.renderAll();
      ecrans.casiers.ouvrir(r.boite.id);
      return;
    }
    if (r.type === 'contact') {
      ecrans.registre.ouvrirFiche(r.contact.id);
      return;
    }
    if (r.type === 'retrait' || r.type === 'courrier') {
      /* Un code de retrait mène au comptoir de remise, avec le code déjà
         saisi : c'est le geste suivant, et le retaper serait absurde. */
      ecrans.app.showPanel('remise');
      const champ = $('pickupCode');
      if (champ && r.courrier.pickupCode) {
        champ.value = r.courrier.pickupCode;
        const btn = $('pickupCodeBtn');
        if (btn) btn.click();
      } else {
        toast(scanner.libelle(r), 'ok');
      }
    }
  }

  /* ── mise en place ── */

  function init() {
    const dlg = $('scanDialog');
    if (!dlg) return;

    $('scanForm').addEventListener('submit', function (e) {
      e.preventDefault();
      resoudre($('scanChamp').value);
      $('scanChamp').select();
    });

    $('scanCameraBtn').addEventListener('click', basculerCamera);

    $('scanResultat').addEventListener('click', function (e) {
      const b = e.target.closest('[data-scan-fiche]');
      if (!b) return;
      arreterCamera();
      dlg.close();
      ecrans.registre.ouvrirFiche(b.dataset.scanFiche);
    });

    /* Une photo déposée : le même décodeur, sans caméra du tout. C'est le
       chemin de qui scanne avec son téléphone puis envoie l'image au poste. */
    $('scanFichier').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const img = new root.Image();
      img.onload = function () {
        const c = $('scanCanevas');
        c.width = Math.min(1600, img.naturalWidth);
        c.height = Math.round((c.width / img.naturalWidth) * img.naturalHeight);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const lu = scanner.lireImage(d.data, c.width, c.height, { lignes: 31 });
        root.URL.revokeObjectURL(img.src);
        if (lu) resoudre(lu);
        else ui.setMsg('scanResultat', 'error',
          'Aucun code à barres lisible sur cette image. Cadrez le code de plus près, bien à plat.');
      };
      img.src = root.URL.createObjectURL(f);
    });

    document.querySelectorAll('[data-ouvrir-scan]').forEach(function (b) {
      b.addEventListener('click', ouvrir);
    });

    /* Le raccourci demandé au §4 des raccourcis clavier. Pas Ctrl+K, déjà pris
       par la recherche : le scanner est un geste voisin mais distinct. */
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        ouvrir();
      }
    });
  }

  function render() {
    /* Le bouton n'apparaît que là où le scanner sert : au guichet et à la
       remise. Il ne dépend d'aucune permission particulière — scanner ne fait
       qu'ouvrir un écran que l'agent a déjà le droit de voir. */
    const c = capacites();
    document.querySelectorAll('[data-ouvrir-scan]').forEach(function (b) {
      b.title = c.camera
        ? 'Douchette ou caméra — Ctrl+B'
        : 'Douchette USB — Ctrl+B (la caméra demande https)';
    });
  }

  ui.inscrire('scanner', { init: init, render: render, ouvrir: ouvrir, resoudre: resoudre });
})(globalThis);
