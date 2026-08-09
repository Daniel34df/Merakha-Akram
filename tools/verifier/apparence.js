/* Vérification : ce que la refonte visuelle a promis, et que rien ne prouve
 * autrement.
 *
 * Une feuille de style ne se teste pas en la lisant. Trois choses seulement
 * comptent ici, et chacune correspond à un défaut qui reviendrait sans ce
 * script :
 *
 *   1. Le thème. Il se choisit, il se retient d'une visite à l'autre, et sans
 *      choix il suit le système. Une bascule qui s'oublie au rechargement est
 *      pire que pas de bascule du tout.
 *
 *   2. Le soulignement d'onglet. Il se calcule à partir de la position réelle
 *      du bouton : il doit donc suivre après un clic, après un `#ancre`, et
 *      après un redimensionnement. C'est le troisième cas qui casse en
 *      silence — on tourne une tablette et la barre reste sous l'ancien onglet.
 *
 *   3. Le papier. Les polices et les encres de l'attestation, des étiquettes et
 *      du code à barres ne suivent pas l'écran. C'est le seul contrôle qui
 *      regarde ce que le navigateur a réellement calculé, plutôt que ce que la
 *      feuille prétend.
 */
'use strict';

const C = require('./commun.js');

const v = C.verificateur();
const ok = v.ok;

/* Gelées le jour de la refonte. Si l'une bouge, c'est qu'une retouche d'écran
   a débordé sur un document qu'une personne présente à un guichet. */
const PAPIER = {
  ancre: '#16233F',
  encreSecondaire: '#5B6B82',
  fond: '#F4F0E6',
  machine: 'Special Elite',
  serif: 'Source Serif 4'
};

(async () => {
  const b = await C.lancerNavigateur();
  const page = await C.nouvellePage(b, {
    avantChargement: function () {
      window.__imprime = 0;
      window.print = function () { window.__imprime++; };
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await C.ouvrirLeBureau(page);

  /* ---- 1. le thème ---- */
  console.log('\n1. Le thème se choisit, et il se retient');

  const auDepart = await page.evaluate(() => ({
    attribut: document.documentElement.getAttribute('data-theme'),
    resolu: BC.ui.themeResolu(),
    choisi: BC.ui.themeChoisi()
  }));
  ok(auDepart.choisi === 'auto', 'sans réglage, on suit le système : ' + auDepart.choisi);
  ok(!auDepart.attribut, 'et rien n’est écrit sur la racine (' + auDepart.attribut + ')');

  await page.click('#themeBtn');
  await page.waitForTimeout(300);
  const apresUn = await page.evaluate(() => ({
    attribut: document.documentElement.getAttribute('data-theme'),
    choisi: BC.ui.themeChoisi(),
    fond: getComputedStyle(document.body).backgroundColor
  }));
  ok(apresUn.choisi !== 'auto', 'un clic pose un choix explicite : ' + apresUn.choisi);
  ok(apresUn.attribut === apresUn.choisi, 'la racine porte ce choix : ' + apresUn.attribut);

  /* Le tour complet ramène à « auto » : personne ne doit rester coincé dans un
     thème qu'il a essayé par curiosité. */
  await page.click('#themeBtn');
  await page.waitForTimeout(200);
  await page.click('#themeBtn');
  await page.waitForTimeout(200);
  const boucle = await page.evaluate(() => BC.ui.themeChoisi());
  ok(boucle === 'auto', 'trois clics reviennent au point de départ : ' + boucle);

  /* Le sombre, choisi, doit tenir au rechargement — c'est tout l'intérêt. */
  await page.evaluate(() => BC.ui.appliquerTheme('sombre'));
  await page.waitForTimeout(200);
  const avantRechargement = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1600);
  const apresRechargement = await page.evaluate(() => ({
    attribut: document.documentElement.getAttribute('data-theme'),
    fond: getComputedStyle(document.body).backgroundColor
  }));
  ok(apresRechargement.attribut === 'sombre', 'le choix survit au rechargement');
  ok(
    apresRechargement.fond === avantRechargement,
    'et le fond est le même qu’avant : ' + apresRechargement.fond
  );

  /* La couleur de la barre du navigateur suit : sur un téléphone, c'est elle
     qui trahit une bascule oubliée. */
  const barre = await page.evaluate(() => {
    const m = document.querySelector('meta[name="theme-color"]');
    return m ? m.getAttribute('content') : '';
  });
  ok(/^#/.test(barre), 'la barre du navigateur a suivi : ' + barre);

  await page.evaluate(() => BC.ui.appliquerTheme('auto'));
  await page.waitForTimeout(200);

  /* ---- 2. le soulignement d'onglet ---- */
  console.log('\n2. Le soulignement suit l’onglet ouvert');

  const mesurer = () => page.evaluate(() => {
    const barre = document.getElementById('navGlisse');
    const actif = document.querySelector('nav button[data-panel].active');
    if (!barre || !actif) return null;
    const b = barre.getBoundingClientRect();
    const a = actif.getBoundingClientRect();
    return {
      onglet: actif.dataset.panel,
      centreBarre: Math.round(b.left + b.width / 2),
      centreOnglet: Math.round(a.left + a.width / 2),
      /* Le second axe compte autant : sur un écran étroit les six onglets
         passent sur plusieurs lignes, et une barre ancrée en bas se retrouve
         sous la mauvaise. */
      basBarre: Math.round(b.bottom),
      basOnglet: Math.round(a.bottom),
      largeur: Math.round(b.width),
      visible: barre.classList.contains('pret')
    };
  });

  for (const nom of ['remise', 'registre', 'domiciliation', 'guichet']) {
    await page.click('nav button[data-panel="' + nom + '"]');
    await page.waitForTimeout(500);
    const m = await mesurer();
    ok(
      m && m.visible && m.onglet === nom &&
        Math.abs(m.centreBarre - m.centreOnglet) <= 2 &&
        Math.abs(m.basBarre - m.basOnglet) <= 4,
      nom + ' — la barre est sous l’onglet (écarts ' +
        (m ? Math.abs(m.centreBarre - m.centreOnglet) + ' px en x, ' +
             Math.abs(m.basBarre - m.basOnglet) + ' px en y' : '?') + ')'
    );
  }

  /* Le cas qui casse en silence : on change la largeur de la fenêtre, les six
     boutons se répartissent autrement, et rien ne redéclenche le calcul. */
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(600);
  const apresRedim = await mesurer();
  ok(
    apresRedim && Math.abs(apresRedim.centreBarre - apresRedim.centreOnglet) <= 2,
    'après redimensionnement, la barre a suivi (écart ' +
      (apresRedim ? Math.abs(apresRedim.centreBarre - apresRedim.centreOnglet) : '?') + ' px)'
  );

  /* Le téléphone, et le cas qui a réellement cassé : à 360 px les six onglets
     tiennent sur trois lignes. Une barre ancrée en bas de la barre entière se
     retrouvait sous « Domiciliation » pendant que « Registre » était ouvert. */
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(700);
  await page.click('nav button[data-panel="registre"]');
  await page.waitForTimeout(600);
  const petit = await mesurer();
  ok(
    petit && Math.abs(petit.centreBarre - petit.centreOnglet) <= 2 &&
      Math.abs(petit.basBarre - petit.basOnglet) <= 4,
    'à 360 px, sur trois lignes d’onglets, la barre est sous la bonne (écarts ' +
      (petit ? Math.abs(petit.centreBarre - petit.centreOnglet) + ' px en x, ' +
               Math.abs(petit.basBarre - petit.basOnglet) + ' px en y' : '?') + ')'
  );
  const deborde = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(deborde <= 0, 'et la page ne déborde pas en largeur (' + deborde + ' px)');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(500);

  /* ---- 3. le papier ne suit pas l'écran ---- */
  console.log('\n3. Le papier garde ses polices et ses encres');

  await C.inscrire(page, {
    nom: 'Amina Diallo',
    telephone: '06 12 34 56 78',
    boite: 'B-12',
    domicilieDepuis: new Date().toISOString().slice(0, 10)
  });

  /* On imprime en thème sombre : c'est là que la fuite se verrait. */
  await page.evaluate(() => BC.ui.appliquerTheme('sombre'));
  await page.waitForTimeout(300);
  await page.locator('#contactsTable tbody tr', { hasText: 'Amina' }).first()
    .locator('button[data-fiche]').click();
  await page.waitForTimeout(600);
  await page.click('#ficheAttestationBtn');
  await page.waitForTimeout(900);

  const papier = await page.evaluate(() => {
    const f = document.getElementById('feuilleCasier');
    f.hidden = false;
    const lire = (sel, prop) => {
      const el = f.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : '';
    };
    const out = {
      titre: lire('.attestation h1', 'fontFamily'),
      organisme: lire('.attest-organisme', 'fontFamily'),
      corps: lire('.attestation', 'fontFamily'),
      encre: lire('.attestation', 'color'),
      adresseFond: lire('.attest-adresse', 'backgroundColor'),
      barre: lire('.cb-barre', 'backgroundColor'),
      fondCode: lire('.codebarres', 'backgroundColor'),
      legende: (f.querySelector('.cb-legende') || {}).textContent || ''
    };
    f.hidden = true;
    return out;
  });

  const rgb = (hex) => {
    const n = hex.replace('#', '');
    return 'rgb(' + [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)).join(', ') + ')';
  };

  ok(papier.titre.indexOf(PAPIER.machine) >= 0, 'le titre reste à la machine à écrire : ' + papier.titre);
  ok(papier.organisme.indexOf(PAPIER.machine) >= 0, 'l’en-tête de l’organisme aussi');
  ok(papier.corps.indexOf(PAPIER.serif) >= 0, 'le corps reste en serif : ' + papier.corps);
  ok(papier.encre === rgb(PAPIER.ancre), 'l’encre est celle d’avant : ' + papier.encre);
  ok(papier.adresseFond === rgb(PAPIER.fond), 'le fond de l’adresse aussi : ' + papier.adresseFond);
  ok(papier.barre === 'rgb(0, 0, 0)', 'les barres du code sont noires : ' + papier.barre);
  ok(papier.fondCode === 'rgb(255, 255, 255)', 'sur fond blanc : ' + papier.fondCode);
  ok(papier.legende === 'B-12', 'et le numéro se lit en clair dessous : ' + papier.legende);

  await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    if (d) d.close();
    BC.ui.appliquerTheme('auto');
  });

  await C.capture(page, 'apparence');
  await C.conclure(b, page, v);
})().catch((e) => {
  console.error('PLANTAGE', e);
  process.exit(1);
});
