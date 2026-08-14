/* Bureau du Courrier — les boîtes du local.

   Pourquoi ce module existe. Jusqu'ici, une boîte aux lettres n'existait pas :
   il n'y avait qu'une chaîne posée sur une fiche, `contact.box`, libre et
   facultative. « B-12 », « b12 », « Casier 7 » et « 142 » y cohabitaient.

   Ce que ça coûtait au guichet :

     · **personne ne savait quelles boîtes étaient libres.** Attribuer un
       casier demandait de connaître le local par cœur, ou de parcourir trois
       cents fiches ;

     · **rien n'empêchait deux personnes d'avoir la même.** Deux agents à deux
       postes inscrivent « B-24 » le même matin, et deux courriers partent au
       même casier — celui qui ouvre trouve le courrier d'un autre ;

     · **une boîte n'avait pas de mémoire.** Quelqu'un est relogé, le casier
       passe à un autre, et l'ancien titulaire disparaît sans trace. Un
       courrier qui arrive trois semaines plus tard n'a plus rien à quoi se
       rattacher ;

     · **aucun état intermédiaire.** Une serrure cassée, une boîte réservée à
       quelqu'un attendu lundi : rien pour le dire, sinon s'en souvenir.

   Le principe. Une boîte est un objet qui dure : un numéro, un statut, une
   zone, une capacité, et **une suite de périodes** — un changement de
   titulaire n'écrase rien, il clôt une période et en ouvre une autre.

   Le miroir. `contact.box` reste sur la fiche et continue de s'afficher
   partout, mais c'est la boîte qui fait autorité : la chaîne n'est plus écrite
   qu'en attribuant ou en libérant. L'invariant tenu est celui-ci, dans ce sens
   et pas dans l'autre : **le titulaire courant d'une boîte porte le numéro de
   cette boîte sur sa fiche.** L'inverse peut être faux le temps qu'un conflit
   de reprise soit tranché — `incoherences()` les liste plutôt que de les taire.

   Ce module ne touche ni au réseau ni au DOM : il calcule sur des tableaux.
   C'est ce qui le rend vérifiable hors navigateur. */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./util.js') : root.BC.util
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BC = root.BC || {};
    root.BC.boites = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  /* Les statuts. Chacun correspond à une situation qu'un bureau rencontre pour
     de vrai, et qu'il fallait jusqu'ici retenir de tête. `mot` est ce qui
     s'écrit à côté de la couleur sur le plan du local : une pastille de
     couleur seule ne se lit pas quand on distingue mal le rouge du vert, et un
     casier hors service pris pour un casier libre fait perdre un courrier. */
  const STATUTS = [
    { id: 'libre', label: 'Libre', mot: 'libre' },
    { id: 'occupee', label: 'Occupée', mot: 'occupée' },
    { id: 'reservee', label: 'Réservée', mot: 'réservée' },
    { id: 'suspendue', label: 'Suspendue', mot: 'suspendue' },
    { id: 'horsservice', label: 'Hors service', mot: 'hors service' }
  ];

  function statut(id) {
    return STATUTS.find(function (s) {
      return s.id === id;
    }) || STATUTS[0];
  }

  /* Le schéma de numérotation. Ce sont des valeurs de départ, pas une règle :
     un bureau numérote « B-001 », un autre « 142 » tout court, un troisième
     « A-01 » par étage. Tout est réglable ; ce qui compte est que le serveur
     seul attribue, pour que deux postes ne tombent pas sur le même numéro.

     `reutiliser` : quand une boîte est retirée du plan, son numéro
     redevient-il disponible ? Oui par défaut — les casiers d'un local sont
     physiquement numérotés et ne se renumérotent pas. Un bureau qui préfère
     qu'un numéro ne resserve jamais met la valeur à faux. */
  const NUMEROTATION_DEFAUT = {
    prefixe: 'B-',
    chiffres: 3,
    debut: 1,
    fin: 200,
    reutiliser: true
  };

  /* Capacité par défaut d'un casier, en courriers en attente. Sert à prévenir
     avant que ça déborde — un casier plein, c'est du courrier qui reste sur le
     comptoir, et du courrier sur le comptoir finit par se perdre. */
  const CAPACITE_DEFAUT = 10;

  function schemaDe(schema) {
    const s = Object.assign({}, NUMEROTATION_DEFAUT, schema || {});
    s.prefixe = String(s.prefixe === undefined ? NUMEROTATION_DEFAUT.prefixe : s.prefixe);
    s.chiffres = Math.max(1, Math.min(8, Number(s.chiffres) || NUMEROTATION_DEFAUT.chiffres));
    s.debut = Math.max(0, Number(s.debut) || 0);
    s.fin = Math.max(s.debut, Number(s.fin) || 0);
    s.reutiliser = s.reutiliser !== false;
    return s;
  }

  /** 24 → « B-024 ». */
  function formaterNumero(n, schema) {
    const s = schemaDe(schema);
    return s.prefixe + String(Math.max(0, Math.floor(Number(n) || 0))).padStart(s.chiffres, '0');
  }

  /* L'inverse : « B-024 », « b24 » et « B 24 » rendent tous 24. Une chaîne qui
     ne suit pas le schéma — « Casier 7 » quand le préfixe est « B- » — rend
     `null` : elle désigne une vraie boîte du local, mais hors numérotation, et
     la ranger de force fabriquerait des collisions. */
  function lireNumero(texte, schema) {
    const s = schemaDe(schema);
    const brut = util.normalizeBox(texte);
    if (!brut) return null;
    const prefixe = util.normalizeBox(s.prefixe);
    if (prefixe && brut.indexOf(prefixe) !== 0) return null;
    const reste = brut.slice(prefixe.length);
    if (!reste || !/^\d+$/.test(reste)) return null;
    return parseInt(reste, 10);
  }

  /* La clé d'un casier : ce par quoi deux écritures se rejoignent.

     `util.normalizeBox` fait déjà l'essentiel — la casse, les espaces, les
     tirets — mais s'arrête aux zéros de tête : « B-012 » et « b12 » en
     ressortaient distincts, alors que c'est la même porte. Le registre
     contenait donc des casiers en double sans que rien ne le montre, et la
     recherche par boîte ne retrouvait qu'une écriture sur deux.

     Deux branches, préfixées pour ne pas se confondre : un numéro qui suit le
     schéma se compare comme un nombre, et le reste comme du texte dont on
     retire les zéros de tête de chaque groupe de chiffres — « Casier 07 » et
     « casier 7 » sont le même casier eux aussi. */
  function cleNumero(texte, schema) {
    const n = lireNumero(texte, schema);
    if (n !== null) return 'n:' + n;
    const brut = util.normalizeBox(texte);
    return brut ? 't:' + brut.replace(/(^|\D)0+(\d)/g, '$1$2') : '';
  }

  /** Deux écritures du même numéro sont le même numéro. */
  function memeNumero(a, b, schema) {
    const x = cleNumero(a, schema);
    return !!x && x === cleNumero(b, schema);
  }

  function trouverParNumero(boites, texte, schema) {
    return (boites || []).find(function (b) {
      return memeNumero(b.numero, texte, schema);
    }) || null;
  }

  /* L'ordre du local : « B-2 » avant « B-10 », ce qu'un tri alphabétique fait
     à l'envers. C'est l'ordre dans lequel on parcourt les casiers, et celui de
     la feuille de casier depuis toujours. */
  function trier(boites) {
    return (boites || []).slice().sort(function (a, b) {
      return util
        .normalizeBox(a && a.numero)
        .localeCompare(util.normalizeBox(b && b.numero), 'fr', { numeric: true });
    });
  }

  /* ---------- les titulaires, et leur suite ---------- */

  function periodes(boite) {
    return (boite && Array.isArray(boite.periodes) ? boite.periodes : []);
  }

  /** La période ouverte : celle qui n'a pas de fin. */
  function titulaireCourant(boite) {
    return periodes(boite).find(function (p) {
      return p && !p.jusqua;
    }) || null;
  }

  function estLibre(boite) {
    return !!boite && boite.statut === 'libre' && !titulaireCourant(boite);
  }

  /* Attribuer. On clôt la période en cours et on en ouvre une — jamais un
     remplacement en place. C'est ce qui permet, trois semaines plus tard, de
     savoir à qui était ce casier quand le courrier est arrivé.

     Le nom est recopié dans la période. Il fait doublon avec la fiche, et
     c'est voulu : la fiche peut être effacée à la demande de la personne, et
     l'historique du casier ne doit pas devenir illisible pour autant. Il
     s'efface avec le reste quand l'effacement complet passe. */
  function attribuer(boite, titulaire, at) {
    const quand = at || new Date().toISOString();
    const suite = periodes(boite).map(function (p) {
      return p && !p.jusqua ? Object.assign({}, p, { jusqua: quand }) : p;
    });
    suite.push({
      contactId: (titulaire && titulaire.id) || null,
      nom: (titulaire && titulaire.name) || '',
      depuis: quand,
      jusqua: '',
      motif: ''
    });
    return Object.assign({}, boite, { statut: 'occupee', periodes: suite });
  }

  function liberer(boite, motif, at) {
    const quand = at || new Date().toISOString();
    const suite = periodes(boite).map(function (p) {
      return p && !p.jusqua
        ? Object.assign({}, p, { jusqua: quand, motif: String(motif || '') })
        : p;
    });
    return Object.assign({}, boite, { statut: 'libre', periodes: suite });
  }

  /* ---------- le prochain numéro ---------- */

  /* Attribué par le serveur, à l'intérieur d'une seule écriture sérialisée :
     le calculer avant d'écrire laisserait deux postes obtenir le même.

     Rend `null` quand la plage est épuisée. Ce n'est pas une erreur — c'est un
     local plein, et l'écran doit le dire plutôt que d'inventer un numéro qui
     ne correspond à aucun casier. */
  function prochainNumero(boites, schema) {
    const s = schemaDe(schema);
    const pris = new Set();
    (boites || []).forEach(function (b) {
      const n = lireNumero(b && b.numero, s);
      if (n !== null) pris.add(n);
    });
    if (!s.reutiliser) {
      let max = s.debut - 1;
      pris.forEach(function (n) {
        if (n > max) max = n;
      });
      const suivant = max + 1;
      return suivant <= s.fin ? suivant : null;
    }
    for (let n = s.debut; n <= s.fin; n++) {
      if (!pris.has(n)) return n;
    }
    return null;
  }

  /* La première boîte réellement libre du local — ce qu'on propose au guichet
     quand quelqu'un s'inscrit. Différent du prochain numéro : celui-ci
     fabrique un casier qui n'existe pas encore, celle-là en désigne un qui
     attend, vide, dans le couloir. */
  function premiereLibre(boites) {
    return trier(boites).find(estLibre) || null;
  }

  /* Le numéro à attribuer d'office, quand le bureau demande l'attribution
     automatique — typiquement à l'ouverture d'un premier dossier de
     domiciliation, où la personne n'a encore aucun casier.

     L'ordre compte, et il n'est pas évident :

       1. **une boîte qui existe et qui est libre**, la plus petite. Un local
          où B-012 s'est libérée le mois dernier doit la réattribuer avant
          d'ouvrir B-061 : les portes existent physiquement, et laisser un trou
          au milieu du couloir pour aller poser une étiquette au bout est
          absurde ;
       2. **à défaut, le prochain numéro du schéma**, qui créera un casier.

     Rend `null` quand le schéma est épuisé — un local plein est un fait, pas
     une erreur, et l'appelant doit pouvoir le dire à l'agent plutôt que
     d'inventer un numéro hors plan.

     **À n'appeler que depuis l'intérieur d'un `db.write`.** Deux postes qui
     ouvrent un dossier au même instant liraient sinon le même « premier libre »
     et attribueraient la même porte à deux personnes — exactement ce que
     l'attribution par le serveur existe pour empêcher. */
  function numeroAAttribuer(boites, schema) {
    const libre = premiereLibre(boites);
    if (libre && libre.numero) return libre.numero;
    const n = prochainNumero(boites, schema);
    return n === null ? null : formaterNumero(n, schema);
  }

  /* ---------- la capacité ---------- */

  /* Deux seuils, parce qu'un seul arrive trop tard : à 80 % on prévient, à
     100 % on a déjà du courrier qui traîne ailleurs. */
  function etat(boite, enAttente) {
    const capacite = Math.max(1, Number(boite && boite.capacite) || CAPACITE_DEFAUT);
    const n = Math.max(0, Number(enAttente) || 0);
    const taux = Math.round((n / capacite) * 100);
    return {
      statut: (boite && boite.statut) || 'libre',
      label: statut(boite && boite.statut).label,
      mot: statut(boite && boite.statut).mot,
      courriers: n,
      capacite: capacite,
      taux: taux,
      seuil: taux >= 100 ? 'pleine' : taux >= 80 ? 'presque' : 'ok'
    };
  }

  /** Combien de courriers en attente par boîte, par le titulaire courant. */
  function comptesEnAttente(boites, history) {
    const parContact = {};
    (history || []).forEach(function (h) {
      if (!util.enAttente(h) || !h.contactId) return;
      parContact[h.contactId] = (parContact[h.contactId] || 0) + 1;
    });
    const out = {};
    (boites || []).forEach(function (b) {
      const t = titulaireCourant(b);
      out[b.id] = (t && parContact[t.contactId]) || 0;
    });
    return out;
  }

  /* ---------- le plan du local ---------- */

  /** Groupé par zone, chaque groupe dans l'ordre des casiers. */
  function plan(boites) {
    const zones = [];
    trier(boites).forEach(function (b) {
      const nom = String((b && b.zone) || '');
      let z = zones.find(function (x) {
        return x.zone === nom;
      });
      if (!z) {
        z = { zone: nom, boites: [] };
        zones.push(z);
      }
      z.boites.push(b);
    });
    // La zone sans nom en dernier : c'est le fourre-tout, pas la salle principale.
    return zones.sort(function (a, b) {
      if (!a.zone) return 1;
      if (!b.zone) return -1;
      return a.zone.localeCompare(b.zone, 'fr');
    });
  }

  /* ---------- fabriquer une boîte ---------- */

  function creer(input) {
    const o = input || {};
    return {
      id: o.id || util.uuid(),
      numero: String(o.numero || '').trim().slice(0, 40),
      zone: String(o.zone || '').trim().slice(0, 60),
      antenneId: String(o.antenneId || '').trim().slice(0, 40),
      statut: statut(o.statut).id,
      motif: String(o.motif || '').trim().slice(0, 200),
      capacite: Math.max(1, Math.min(999, Number(o.capacite) || CAPACITE_DEFAUT)),
      createdAt: o.createdAt || new Date().toISOString(),
      periodes: Array.isArray(o.periodes) ? o.periodes : []
    };
  }

  /* ---------- la réconciliation ----------

     Les formulaires du bureau écrivent toujours le numéro en texte libre — la
     ligne d'édition du registre, le formulaire de domiciliation, l'ajout au
     guichet. Ils continuent : un bureau qui n'ouvre jamais l'écran des casiers
     doit travailler exactement comme avant.

     C'est ici que la chaîne saisie rejoint le plan du local. Si elle désigne
     une boîte connue, la boîte change de titulaire ; si elle n'en désigne
     aucune, la boîte est créée à la volée. Le plan se remplit donc tout seul,
     au fil des inscriptions, sans que personne ait à le saisir d'abord.

     Ce qui revient — `numero` — est l'orthographe **de la boîte**, pas celle
     qui vient d'être tapée. Quelqu'un écrit « b12 », la fiche reçoit « B-012 » :
     le registre cesse de mélanger quatre écritures du même casier, et la
     recherche par boîte retrouve enfin tout le monde. */
  function reconcilier(boites, contact, texteSaisi, schema, at) {
    const liste = (boites || []).slice();
    const quand = at || new Date().toISOString();
    const id = contact && contact.id;
    const texte = String(texteSaisi || '').trim();

    const remplacer = function (b) {
      const i = liste.findIndex(function (x) {
        return x.id === b.id;
      });
      if (i === -1) liste.push(b);
      else liste[i] = b;
    };

    // Ce que cette personne occupe en ce moment, s'il y a lieu.
    const actuelle = liste.find(function (b) {
      const t = titulaireCourant(b);
      return !!t && !!id && t.contactId === id;
    }) || null;

    if (!texte) {
      // Le champ a été vidé : la personne n'a plus de boîte, le casier se rend.
      if (actuelle) remplacer(liberer(actuelle, 'numéro retiré de la fiche', quand));
      return { boites: liste, numero: '' };
    }

    const cible = trouverParNumero(liste, texte, schema);
    if (cible && actuelle && cible.id === actuelle.id) {
      // Même casier, écrit autrement : rien à faire qu'à rendre l'orthographe.
      return { boites: liste, numero: cible.numero };
    }

    if (actuelle) remplacer(liberer(actuelle, 'changement de boîte', quand));

    if (cible) {
      remplacer(attribuer(cible, contact, quand));
      return { boites: liste, numero: cible.numero };
    }

    /* Numéro inconnu : la boîte existe dans le local, elle manquait au plan.
       On garde **la saisie telle quelle**.

       La première version la reformatait selon le schéma — « B-12 » devenait
       « B-012 ». C'était une erreur, et pas seulement de goût : quelqu'un qui
       tape un numéro décrit une porte du couloir, sur laquelle est peint
       « B-12 ». Réécrire sa saisie faisait dire à l'écran autre chose que ce
       que l'agent a sous les yeux — et le jour où il cherche « B-12 » dans le
       local, il ne le trouve pas au même endroit que dans l'application.

       Le schéma reste l'autorité là où personne n'a rien tapé : quand c'est le
       serveur qui attribue le prochain numéro, ou qu'on crée une série. */
    const neuve = creer({
      numero: texte,
      antenneId: (contact && contact.antenneId) || '',
      createdAt: quand
    });
    remplacer(attribuer(neuve, contact, quand));
    return { boites: liste, numero: neuve.numero };
  }

  /* ---------- la migration ----------

     Le passage du texte libre au plan du local, joué une fois sur un registre
     existant. Chaque numéro distinct devient une boîte occupée par son
     titulaire ; les fiches ne sont pas touchées.

     Deux fiches sur le même numéro ne sont pas une erreur de saisie qu'on
     tranche à leur place : c'est soit un casier repris sans que l'ancienne
     fiche ait été mise à jour, soit deux personnes qui partagent réellement
     une boîte — un couple, une famille. On désigne comme titulaire la fiche la
     plus récente, et **on rend la liste des conflits** pour que l'équipe
     regarde. Choisir en silence ferait disparaître quelqu'un du plan. */
  function migrer(contacts, schema) {
    const groupes = [];
    (contacts || []).forEach(function (c) {
      const texte = String((c && c.box) || '').trim();
      if (!texte) return;
      const cle = cleNumero(texte, schema);
      let g = groupes.find(function (x) {
        return x.cle === cle;
      });
      if (!g) {
        g = { cle: cle, numero: texte, fiches: [] };
        groupes.push(g);
      }
      g.fiches.push(c);
    });

    const conflits = [];
    const boites = groupes.map(function (g) {
      const tries = g.fiches.slice().sort(function (a, b) {
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
      const titulaire = tries[tries.length - 1];
      if (tries.length > 1) {
        conflits.push({
          numero: g.numero,
          titulaire: titulaire.name,
          autres: tries.slice(0, -1).map(function (c) {
            return { id: c.id, nom: c.name };
          })
        });
      }
      /* Le numéro tel qu'il était écrit sur la fiche : la migration relève un
         local existant, elle ne le renumérote pas. */
      const neuve = creer({
        numero: g.numero,
        antenneId: titulaire.antenneId || '',
        createdAt: titulaire.createdAt || ''
      });
      return attribuer(neuve, titulaire, titulaire.createdAt || '');
    });

    return { boites: trier(boites), conflits: conflits };
  }

  /* ---------- ce qui ne colle plus ----------

     L'invariant tenu est à sens unique : le titulaire d'une boîte porte le
     numéro de cette boîte sur sa fiche. L'autre sens peut être faux — une
     fiche qui nomme un casier dont quelqu'un d'autre est titulaire — le temps
     qu'un conflit de reprise soit tranché.

     Cette fonction dit lesquelles. La taire reviendrait à laisser deux vérités
     coexister sans que personne le sache ; c'est aussi ce qui permet au test
     d'affirmer que le miroir est tenu. */
  function incoherences(boites, contacts, schema) {
    const out = [];
    const parId = {};
    (contacts || []).forEach(function (c) {
      if (c && c.id) parId[c.id] = c;
    });

    (boites || []).forEach(function (b) {
      const t = titulaireCourant(b);
      if (!t || !t.contactId) return;
      const c = parId[t.contactId];
      if (!c) return; // fiche effacée : l'historique du casier la garde, c'est voulu
      if (!memeNumero(c.box, b.numero, schema)) {
        out.push({
          type: 'fiche-desaccordee',
          boite: b.numero,
          nom: c.name,
          surLaFiche: c.box || '',
          message: 'La fiche de ' + c.name + ' porte « ' + (c.box || '—') + ' » alors qu’elle occupe ' + b.numero + '.'
        });
      }
    });

    (contacts || []).forEach(function (c) {
      const texte = String((c && c.box) || '').trim();
      if (!texte) return;
      const b = trouverParNumero(boites, texte, schema);
      if (!b) {
        out.push({
          type: 'boite-absente-du-plan',
          boite: texte,
          nom: c.name,
          surLaFiche: texte,
          message: 'La fiche de ' + c.name + ' porte « ' + texte + ' », qui n’est pas au plan du local.'
        });
        return;
      }
      const t = titulaireCourant(b);
      if (!t || t.contactId !== c.id) {
        out.push({
          type: 'titulaire-different',
          boite: b.numero,
          nom: c.name,
          surLaFiche: texte,
          message:
            'La fiche de ' + c.name + ' porte ' + b.numero +
            ', dont le titulaire est ' + ((t && t.nom) || 'personne') + '.'
        });
      }
    });

    return out;
  }

  return {
    STATUTS: STATUTS,
    NUMEROTATION_DEFAUT: NUMEROTATION_DEFAUT,
    CAPACITE_DEFAUT: CAPACITE_DEFAUT,
    statut: statut,
    schemaDe: schemaDe,
    formaterNumero: formaterNumero,
    lireNumero: lireNumero,
    cleNumero: cleNumero,
    memeNumero: memeNumero,
    trouverParNumero: trouverParNumero,
    trier: trier,
    creer: creer,
    titulaireCourant: titulaireCourant,
    estLibre: estLibre,
    attribuer: attribuer,
    liberer: liberer,
    prochainNumero: prochainNumero,
    premiereLibre: premiereLibre,
    numeroAAttribuer: numeroAAttribuer,
    etat: etat,
    comptesEnAttente: comptesEnAttente,
    plan: plan,
    reconcilier: reconcilier,
    migrer: migrer,
    incoherences: incoherences
  };
});
