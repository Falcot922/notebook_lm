/* ==================================================================
   Notes au propre — application locale
   Le seul rôle du modèle : remettre en forme, sans dénaturer.
   ================================================================== */

const {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo
} = React;
const MODELE = "claude-haiku-4-5-20251001"; // alias équivalent : claude-haiku-4-5
const URL_API = "https://api.anthropic.com/v1/messages";
const CLE_STOCKAGE = "nap.v2";

// Tarifs Haiku 4.5, en dollars par token
const PRIX = {
  entree: 1 / 1e6,
  sortie: 5 / 1e6
};
// Au-delà de ce nombre de cellules, un lot demande confirmation
const SEUIL_LOT = 80;
// Plafond de dépense mensuel par défaut, en dollars
const PLAFOND_DEFAUT = 10;
// Coût moyen observé d'une cellule, pour les estimations avant traitement
const COUT_CELLULE = 0.005;

/* ------------------------------------------------------------------
   Consigne
------------------------------------------------------------------ */

const REGLES = `Tu remets au propre des notes prises en cours, souvent abrégées, mal ponctuées et écrites vite.

Ce que tu fais dans tous les cas :
- corriger l'orthographe, la grammaire, la ponctuation et les accords ;
- développer les abréviations à la première occurrence (art. → article, JP → jurisprudence, tjs → toujours, cad → c'est-à-dire) ;
- appliquer la typographie française : espace insécable avant ; : ? !, guillemets « », italiques en *astérisques* pour les locutions latines ;
- conserver les titres des notes comme titres Markdown (## Titre).

Ce que tu ne fais jamais :
- ajouter une idée, un exemple, une explication ou une référence absente des notes ;
- résumer, condenser ou supprimer une information, même secondaire ou répétée ;
- réorganiser l'ordre des idées ;
- remplacer un terme technique par un synonyme ;
- corriger une référence (article, date, nom, juridiction) : tu la recopies exactement telle qu'elle est écrite, même si elle te semble fausse ou incomplète ;
- commenter ton travail ou annoncer ce que tu vas faire.

Si un passage est incompréhensible, recopie-le mot pour mot entre crochets : [tel quel : ...].

Tu réponds uniquement par le texte remis au propre, sans introduction ni conclusion, sans bloc de code.`;
const NIVEAUX = [{
  id: "minimal",
  nom: "Minimal",
  expl: "Orthographe, ponctuation et typographie. La forme des notes est conservée telle quelle.",
  consigne: "Niveau d'intervention : minimal. Tu te limites à la correction et à la typographie. Tu ne transformes pas les notes en phrases : ce qui est écrit en style télégraphique le reste, ce qui est en liste reste en liste. Tu ne changes ni l'ordre ni la structure."
}, {
  id: "standard",
  nom: "Standard",
  expl: "Phrases reconstituées, listes conservées, découpage en paragraphes.",
  consigne: "Niveau d'intervention : standard. Tu reconstitues des phrases complètes à partir des notes télégraphiques et tu découpes en paragraphes là où le sujet change. Tu conserves les listes lorsqu'elles structurent réellement l'information (énumérations de conditions, de critères)."
}, {
  id: "redige",
  nom: "Rédigé",
  expl: "Texte suivi : les listes deviennent des phrases articulées. Aucune idée ajoutée.",
  consigne: "Niveau d'intervention : rédigé. Tu produis un texte suivi en paragraphes. Les listes de notes deviennent des phrases articulées par les connecteurs logiques que la note sous-entend (donc, or, en effet, dès lors). Tu n'ajoutes aucune idée : les connecteurs ne servent qu'à relier ce qui est déjà écrit."
}];
function systemePour(niveau) {
  const n = NIVEAUX.find(x => x.id === niveau) || NIVEAUX[1];
  return REGLES + "\n\n" + n.consigne;
}

/* ------------------------------------------------------------------
   Utilitaires
------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10);
const pause = ms => new Promise(r => setTimeout(r, ms));
function echappe(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Markdown restreint → HTML (le modèle ne produit que titres, listes, gras, italiques) */
function versHTML(md, options) {
  const opt = options || {};
  const lignes = echappe(md || "").replace(/\r/g, "").split("\n");
  const out = [];
  let liste = null;
  let typeListe = "ul";
  let para = [];
  let cite = [];
  const enligne = t => t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/\[([^\]]*)\]/g, '<span class="trou">[$1]</span>');
  const videPara = () => {
    if (para.length) out.push("<p>" + enligne(para.join(" ")) + "</p>");
    para = [];
  };
  const videListe = () => {
    if (liste) out.push("<" + typeListe + ">" + liste.map(i => "<li>" + enligne(i) + "</li>").join("") + "</" + typeListe + ">");
    liste = null;
  };
  const videCite = () => {
    if (cite.length) out.push("<blockquote>" + enligne(cite.join(" ")) + "</blockquote>");
    cite = [];
  };
  const videTout = () => {
    videPara();
    videListe();
    videCite();
  };
  lignes.forEach(brute => {
    const l = brute.trim();
    if (!l) return videTout();
    const t = l.match(/^(#{1,4})\s+(.*)$/);
    if (t) {
      videTout();
      const n = Math.min(t[1].length + (opt.decale || 0), 4);
      out.push("<h" + n + ">" + enligne(t[2]) + "</h" + n + ">");
      return;
    }
    const c = l.match(/^&gt;\s?(.*)$/);
    if (c) {
      videPara();
      videListe();
      cite.push(c[1]);
      return;
    }
    const p = l.match(/^[-–—*•]\s+(.*)$/);
    if (p) {
      videPara();
      videCite();
      if (!liste || typeListe !== "ul") {
        videListe();
        typeListe = "ul";
        liste = [];
      }
      liste.push(p[1]);
      return;
    }
    const n = l.match(/^\d+[.)]\s+(.*)$/);
    if (n) {
      videPara();
      videCite();
      if (!liste || typeListe !== "ol") {
        videListe();
        typeListe = "ol";
        liste = [];
      }
      liste.push(n[1]);
      return;
    }
    videListe();
    videCite();
    para.push(l);
  });
  videTout();
  return out.join("\n");
}

/* Comparaison mot à mot */
const cle = m => m.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function diffHTML(avant, apres) {
  const A = String(avant).split(/\s+/).filter(Boolean);
  const B = String(apres).split(/\s+/).filter(Boolean);
  if (A.length * B.length > 900000) return null;
  const a = A.map(cle);
  const b = B.map(cle);
  const n = a.length;
  const m = b.length;
  const L = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = a[i] === b[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  let html = "";
  let ajouts = 0;
  let retraits = 0;
  let i = 0;
  let j = 0;
  const bloc = (type, mots) => {
    const t = echappe(mots.join(" ")) + " ";
    if (type === "+") {
      ajouts += mots.length;
      html += "<ins>" + t + "</ins>";
    } else if (type === "-") {
      retraits += mots.length;
      html += "<del>" + t + "</del>";
    } else html += t;
  };
  let courant = null;
  let tampon = [];
  const pousse = (type, mot) => {
    if (type !== courant) {
      if (courant !== null) bloc(courant, tampon);
      courant = type;
      tampon = [];
    }
    tampon.push(mot);
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pousse("=", B[j]);
      i++;
      j++;
    } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) {
      pousse("-", A[i++]);
    } else {
      pousse("+", B[j++]);
    }
  }
  while (i < n) pousse("-", A[i++]);
  while (j < m) pousse("+", B[j++]);
  if (courant !== null) bloc(courant, tampon);
  return {
    html: "<p>" + html + "</p>",
    ajouts,
    retraits
  };
}

/* Découpage d'un texte importé en cellules d'environ 1200 caractères */
function decouper(texte, cible) {
  const max = cible || 1200;
  const net = String(texte).replace(/\r/g, "").trim();
  if (!net) return [];
  const blocs = net.includes("\n\n") ? net.split(/\n\s*\n/) : net.split("\n");
  const sortie = [];
  let courant = "";
  const joint = net.includes("\n\n") ? "\n\n" : "\n";
  blocs.forEach(b => {
    const t = b.trim();
    if (!t) return;
    if (courant && (courant.length + t.length + 2 > max || /^#{1,4}\s/.test(t))) {
      sortie.push(courant);
      courant = t;
    } else courant = courant ? courant + joint + t : t;
  });
  if (courant) sortie.push(courant);
  return sortie;
}
const compteMots = t => t ? t.split(/\s+/).filter(Boolean).length : 0;
function dateLisible(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}
function heureLisible(ts) {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

/* ------------------------------------------------------------------
   Appel à l'API
------------------------------------------------------------------ */

async function mettreAuPropre({
  apiKey,
  texte,
  niveau,
  signal
}) {
  let derniere = null;
  for (let essai = 0; essai < 4; essai++) {
    let rep;
    try {
      rep = await fetch(URL_API, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: MODELE,
          max_tokens: 4000,
          system: systemePour(niveau),
          messages: [{
            role: "user",
            content: texte
          }]
        })
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Pas de connexion à l'API. Vérifiez le réseau ; si l'application a été ouverte directement depuis le dossier et que le problème persiste, ouvrez-la avec le raccourci « Ouvrir » fourni.");
    }
    if (rep.status === 429 || rep.status >= 500) {
      derniere = rep.status === 429 ? "Limite de débit atteinte." : "Service momentanément surchargé.";
      await pause(1200 * Math.pow(2, essai));
      continue;
    }
    const data = await rep.json().catch(() => null);
    if (!rep.ok) {
      const m = data && data.error ? data.error.message : "erreur " + rep.status;
      if (rep.status === 401) throw new Error("Clé API refusée. Vérifiez la clé dans le fichier cle-api.js.");
      if (rep.status === 400 && /credit|balance/i.test(m)) throw new Error("Crédit API épuisé. Rechargez le compte sur console.anthropic.com.");
      throw new Error(m);
    }
    const texteSortie = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").replace(/^```[a-z]*\n?|```$/g, "").trim();
    if (!texteSortie) throw new Error("Réponse vide du modèle.");
    return {
      texte: texteSortie,
      usage: data.usage || {}
    };
  }
  throw new Error((derniere || "Échec") + " Réessayez dans un instant.");
}

/* ------------------------------------------------------------------
   Stockage local
------------------------------------------------------------------ */

const nouvelleCellule = brut => ({
  id: uid(),
  brut: brut || "",
  propre: "",
  etat: "vide",
  erreur: "",
  diff: false,
  duree: 0
});
const nouveauDoc = titre => ({
  id: uid(),
  titre: titre || "Document sans titre",
  cree: Date.now(),
  maj: Date.now(),
  niveau: "standard",
  cellules: [nouvelleCellule("")]
});
const moisCourant = () => new Date().toISOString().slice(0, 7);
const consoVide = () => ({
  mois: moisCourant(),
  entree: 0,
  sortie: 0,
  appels: 0
});
const coutDe = c => c.entree * PRIX.entree + c.sortie * PRIX.sortie;
function charger() {
  try {
    const brut = localStorage.getItem(CLE_STOCKAGE);
    if (!brut) return null;
    const d = JSON.parse(brut);
    if (!d.docs || !d.docs.length) return null;
    return d;
  } catch (e) {
    return null;
  }
}
function sauver(etat) {
  try {
    localStorage.setItem(CLE_STOCKAGE, JSON.stringify(etat));
  } catch (e) {
    /* quota */
  }
}

/* ------------------------------------------------------------------
   Icônes
------------------------------------------------------------------ */

const Ico = {
  play: /*#__PURE__*/React.createElement("svg", {
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M7 4.5v15l13-7.5z"
  })),
  stop: /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "5",
    y: "5",
    width: "14",
    height: "14",
    rx: "1.5"
  })),
  docs: /*#__PURE__*/React.createElement("svg", {
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M4 5h7l2 2h7v12H4z"
  }))
};

/* ==================================================================
   Application
   ================================================================== */

function App({
  apiKey,
  onOublierCle
}) {
  const initial = useMemo(() => {
    const s = charger();
    if (s) return s;
    const d = nouveauDoc("Mes notes");
    return {
      docs: [d],
      actif: d.id
    };
  }, []);
  const [docs, setDocs] = useState(initial.docs);
  const [actif, setActif] = useState(initial.actif || initial.docs[0].id);
  const [conso, setConso] = useState(() => initial.conso && initial.conso.mois === moisCourant() ? initial.conso : consoVide());
  const [plafond, setPlafond] = useState(typeof initial.plafond === "number" ? initial.plafond : PLAFOND_DEFAUT);
  const [vue, setVue] = useState("atelier");
  const [tiroir, setTiroir] = useState(false);
  const [lot, setLot] = useState(null); // {faits, total}
  const [toast, setToast] = useState("");
  const [survol, setSurvol] = useState(false);
  const [selection, setSelection] = useState(null);
  const stop = useRef(false);
  const refsTexte = useRef({});
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const consoRef = useRef(conso);
  consoRef.current = conso;
  const plafondRef = useRef(plafond);
  plafondRef.current = plafond;
  const coutMois = coutDe(conso);
  const partPlafond = plafond > 0 ? Math.min(100, 100 * coutMois / plafond) : 0;
  const doc = docs.find(d => d.id === actif) || docs[0];

  /* sauvegarde différée */
  useEffect(() => {
    const t = setTimeout(() => sauver({
      docs,
      actif,
      conso,
      plafond
    }), 350);
    return () => clearTimeout(t);
  }, [docs, actif, conso, plafond]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  const majDoc = useCallback(patch => setDocs(ds => ds.map(d => d.id === actif ? Object.assign({}, d, patch, {
    maj: Date.now()
  }) : d)), [actif]);
  const majCellule = useCallback((idc, patch) => setDocs(ds => ds.map(d => d.id !== actif ? d : Object.assign({}, d, {
    maj: Date.now(),
    cellules: d.cellules.map(c => c.id === idc ? Object.assign({}, c, patch) : c)
  }))), [actif]);

  /* ------------------------------------------------------- traitement */

  const traiter = useCallback(async idc => {
    const d = docsRef.current.find(x => x.id === actif);
    const c = d && d.cellules.find(x => x.id === idc);
    if (!c || !c.brut.trim() || c.etat === "encours") return;
    if (coutDe(consoRef.current) >= plafondRef.current) {
      majCellule(idc, {
        etat: "erreur",
        erreur: "Plafond mensuel atteint (" + plafondRef.current.toFixed(2) + " $). Relevez-le en cliquant sur la jauge en haut à droite, ou reprenez le mois prochain."
      });
      return "plafond";
    }
    majCellule(idc, {
      etat: "encours",
      erreur: ""
    });
    const t0 = Date.now();
    try {
      const res = await mettreAuPropre({
        apiKey,
        texte: c.brut,
        niveau: d.niveau
      });
      majCellule(idc, {
        propre: res.texte,
        etat: "ok",
        erreur: "",
        duree: (Date.now() - t0) / 1000
      });
      const u = res.usage || {};
      setConso(prev => {
        const base = prev.mois === moisCourant() ? prev : consoVide();
        return {
          mois: base.mois,
          entree: base.entree + (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
          sortie: base.sortie + (u.output_tokens || 0),
          appels: base.appels + 1
        };
      });
    } catch (e) {
      majCellule(idc, {
        etat: "erreur",
        erreur: e.message
      });
    }
  }, [actif, apiKey, majCellule]);
  async function traiterTout(forcer) {
    const d = docsRef.current.find(x => x.id === actif);
    const file = d.cellules.filter(c => c.brut.trim() && (forcer || c.etat !== "ok")).map(c => c.id);
    if (!file.length) return;
    if (file.length > SEUIL_LOT) {
      const cout = (file.length * COUT_CELLULE).toFixed(2);
      const minutes = Math.max(1, Math.round(file.length * 4 / 2 / 60));
      const ok = window.confirm(file.length + " cellules vont être traitées.\n\n" + "Coût estimé : environ " + cout + " $\nDurée estimée : environ " + minutes + " minutes\n\nContinuer ?");
      if (!ok) return;
    }
    stop.current = false;
    setLot({
      faits: 0,
      total: file.length
    });
    let index = 0;
    let faits = 0;
    let bloque = false;
    const ouvrier = async () => {
      while (!stop.current) {
        const i = index++;
        if (i >= file.length) return;
        const r = await traiter(file[i]);
        if (r === "plafond") {
          bloque = true;
          stop.current = true;
          return;
        }
        faits++;
        setLot({
          faits,
          total: file.length
        });
      }
    };
    await Promise.all([ouvrier(), ouvrier()]);
    setLot(null);
    if (bloque) setToast("Traitement interrompu : plafond mensuel atteint.");else if (!stop.current) setToast("Document mis au propre.");
  }

  /* ------------------------------------------------------- cellules */

  function ajouter(apres) {
    const c = nouvelleCellule("");
    setDocs(ds => ds.map(d => {
      if (d.id !== actif) return d;
      const i = apres ? d.cellules.findIndex(x => x.id === apres) : d.cellules.length - 1;
      const cs = d.cellules.slice();
      cs.splice(i + 1, 0, c);
      return Object.assign({}, d, {
        cellules: cs,
        maj: Date.now()
      });
    }));
    setSelection(c.id);
    setTimeout(() => refsTexte.current[c.id] && refsTexte.current[c.id].focus(), 40);
  }
  function supprimer(idc) {
    setDocs(ds => ds.map(d => {
      if (d.id !== actif) return d;
      const cs = d.cellules.filter(c => c.id !== idc);
      return Object.assign({}, d, {
        cellules: cs.length ? cs : [nouvelleCellule("")],
        maj: Date.now()
      });
    }));
  }
  function decouperCellule(idc) {
    setDocs(ds => ds.map(d => {
      if (d.id !== actif) return d;
      const i = d.cellules.findIndex(c => c.id === idc);
      const morceaux = decouper(d.cellules[i].brut);
      if (morceaux.length < 2) return d;
      const cs = d.cellules.slice();
      cs.splice(i, 1, ...morceaux.map(m => nouvelleCellule(m)));
      return Object.assign({}, d, {
        cellules: cs,
        maj: Date.now()
      });
    }));
    setToast("Cellule découpée.");
  }
  function fusionner(idc) {
    setDocs(ds => ds.map(d => {
      if (d.id !== actif) return d;
      const i = d.cellules.findIndex(c => c.id === idc);
      if (i < 1) return d;
      const cs = d.cellules.slice();
      const fusion = nouvelleCellule(cs[i - 1].brut.trim() + "\n\n" + cs[i].brut.trim());
      cs.splice(i - 1, 2, fusion);
      return Object.assign({}, d, {
        cellules: cs,
        maj: Date.now()
      });
    }));
  }

  /* ------------------------------------------------------- import */

  async function importer(fichier) {
    try {
      let texte = "";
      if (/\.docx$/i.test(fichier.name)) {
        const buf = await fichier.arrayBuffer();
        const res = await window.mammoth.extractRawText({
          arrayBuffer: buf
        });
        texte = res.value;
      } else {
        texte = await fichier.text();
      }
      const morceaux = decouper(texte);
      if (!morceaux.length) return setToast("Fichier vide.");
      const titre = fichier.name.replace(/\.[^.]+$/, "");
      setDocs(ds => ds.map(d => d.id !== actif ? d : Object.assign({}, d, {
        titre: d.cellules.length === 1 && !d.cellules[0].brut ? titre : d.titre,
        cellules: (d.cellules.length === 1 && !d.cellules[0].brut ? [] : d.cellules).concat(morceaux.map(m => nouvelleCellule(m))),
        maj: Date.now()
      })));
      setToast(morceaux.length + " cellules importées.");
    } catch (e) {
      setToast("Lecture impossible : " + e.message);
    }
  }

  /* ------------------------------------------------------- documents */

  function nouveau() {
    const d = nouveauDoc("Document du " + new Date().toLocaleDateString("fr-FR"));
    setDocs(ds => [d].concat(ds));
    setActif(d.id);
    setVue("atelier");
    setTiroir(false);
  }
  function supprimerDoc(id) {
    setDocs(ds => {
      const reste = ds.filter(d => d.id !== id);
      if (!reste.length) {
        const d = nouveauDoc("Mes notes");
        setActif(d.id);
        return [d];
      }
      if (id === actif) setActif(reste[0].id);
      return reste;
    });
  }

  /* ------------------------------------------------------- assemblage */

  // Une version propre reste dans le document tant que sa cellule existe.
  // Modifier les notes de gauche ne la fait pas disparaître : seule la
  // suppression de la cellule la retire.
  const assemble = doc.cellules.filter(c => c.propre).map(c => c.propre.trim()).join("\n\n");
  const restantes = doc.cellules.filter(c => c.brut.trim() && c.etat !== "ok").length;
  const desynchro = doc.cellules.filter(c => c.etat === "modifiee" && c.propre).length;
  const motsPropres = compteMots(assemble);
  function copier(texte) {
    if (!texte) return;
    try {
      navigator.clipboard.writeText(texte);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = texte;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setToast("Copié.");
  }
  function fichier(nom, contenu, type) {
    const url = URL.createObjectURL(new Blob([contenu], {
      type: type
    }));
    const a = document.createElement("a");
    a.href = url;
    a.download = nom;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exporterWord() {
    const corps = versHTML(assemble);
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' + 'xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' + '<head><meta charset="utf-8"><title>' + echappe(doc.titre) + "</title><style>@page{margin:2.2cm}" + "body{font-family:Garamond,'Times New Roman',serif;font-size:12pt;line-height:1.5;text-align:justify}" + "h1.t{font-size:20pt;text-align:left;margin:0 0 4pt}" + ".d{color:#666;font-size:10pt;margin:0 0 22pt}" + "h2,h3,h4{text-align:left}" + "</style></head><body>" + '<h1 class="t">' + echappe(doc.titre) + "</h1><p class=\"d\">" + dateLisible(doc.maj) + "</p>" + corps + "</body></html>";
    fichier(doc.titre + ".doc", html, "application/msword");
  }

  /* ------------------------------------------------------- clavier */

  function touche(e, idc, i) {
    if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      traiter(idc);
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const suiv = doc.cellules[i + 1];
        if (suiv) {
          setSelection(suiv.id);
          refsTexte.current[suiv.id] && refsTexte.current[suiv.id].focus();
        } else ajouter(idc);
      }
    }
  }

  /* ------------------------------------------------------- rendu */

  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    onDragOver: e => {
      e.preventDefault();
      setSurvol(true);
    },
    onDragLeave: () => setSurvol(false),
    onDrop: e => {
      e.preventDefault();
      setSurvol(false);
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importer(f);
    }
  }, /*#__PURE__*/React.createElement("header", {
    className: "barre"
  }, /*#__PURE__*/React.createElement("div", {
    className: "barre-l1"
  }, /*#__PURE__*/React.createElement("button", {
    className: "bt nu",
    onClick: () => setTiroir(true),
    title: "Mes documents"
  }, Ico.docs), /*#__PURE__*/React.createElement("input", {
    className: "titre-doc",
    value: doc.titre,
    onChange: e => majDoc({
      titre: e.target.value
    }),
    spellCheck: false
  }), /*#__PURE__*/React.createElement("span", {
    className: "maj"
  }, "modifié à ", heureLisible(doc.maj)), /*#__PURE__*/React.createElement("div", {
    className: "onglets",
    role: "tablist"
  }, /*#__PURE__*/React.createElement("button", {
    className: "onglet",
    role: "tab",
    "aria-selected": vue === "atelier",
    onClick: () => setVue("atelier")
  }, "Atelier"), /*#__PURE__*/React.createElement("button", {
    className: "onglet",
    role: "tab",
    "aria-selected": vue === "document",
    onClick: () => setVue("document")
  }, "Document")), /*#__PURE__*/React.createElement("div", {
    className: "actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "jauge" + (partPlafond > 80 ? " chaud" : ""),
    onClick: () => {
      const v = window.prompt("Plafond de dépense mensuel, en dollars.\n\nCe compteur est local : il protège des accidents, pas des contournements. Le vrai verrou se règle dans la console Anthropic, section Billing.", String(plafond));
      const n = parseFloat(String(v).replace(",", "."));
      if (!isNaN(n) && n > 0) setPlafond(n);
    },
    title: conso.appels + " appels ce mois-ci · " + conso.entree.toLocaleString("fr-FR") + " tokens d'entrée, " + conso.sortie.toLocaleString("fr-FR") + " de sortie"
  }, /*#__PURE__*/React.createElement("span", {
    className: "jauge-txt"
  }, coutMois.toFixed(2), " $ ", /*#__PURE__*/React.createElement("em", null, "/ ", plafond, " $")), /*#__PURE__*/React.createElement("span", {
    className: "jauge-barre"
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: partPlafond + "%"
    }
  }))), lot ? /*#__PURE__*/React.createElement("button", {
    className: "bt",
    onClick: () => stop.current = true
  }, Ico.stop, " Interrompre (", lot.faits, "/", lot.total, ")") : /*#__PURE__*/React.createElement("button", {
    className: "bt prim",
    onClick: () => traiterTout(false),
    disabled: !restantes,
    title: restantes ? "" : "Toutes les cellules sont traitées"
  }, Ico.play, " Mettre au propre", restantes ? " (" + restantes + ")" : ""))), /*#__PURE__*/React.createElement("div", {
    className: "progres"
  }, lot && /*#__PURE__*/React.createElement("i", {
    style: {
      width: 100 * lot.faits / lot.total + "%"
    }
  }))), vue === "atelier" ? /*#__PURE__*/React.createElement("main", {
    className: "atelier"
  }, survol && /*#__PURE__*/React.createElement("div", {
    className: "depot"
  }, "Déposez un fichier .txt, .md ou .docx"), /*#__PURE__*/React.createElement("div", {
    className: "consigne-barre"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lab"
  }, "Intervention"), /*#__PURE__*/React.createElement("div", {
    className: "niveaux"
  }, NIVEAUX.map(n => /*#__PURE__*/React.createElement("button", {
    key: n.id,
    "aria-pressed": doc.niveau === n.id,
    onClick: () => majDoc({
      niveau: n.id
    })
  }, n.nom))), /*#__PURE__*/React.createElement("span", {
    className: "expl"
  }, (NIVEAUX.find(n => n.id === doc.niveau) || NIVEAUX[1]).expl), /*#__PURE__*/React.createElement("label", {
    className: "bt",
    style: {
      cursor: "pointer"
    }
  }, "Importer un fichier", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: ".txt,.md,.docx,text/plain",
    style: {
      display: "none"
    },
    onChange: e => {
      const f = e.target.files && e.target.files[0];
      if (f) importer(f);
      e.target.value = "";
    }
  }))), doc.cellules.map((c, i) => /*#__PURE__*/React.createElement(Cellule, {
    key: c.id,
    c: c,
    i: i,
    active: selection === c.id,
    premiere: i === 0,
    refsTexte: refsTexte,
    onSelect: () => setSelection(c.id),
    onChange: v => majCellule(c.id, {
      brut: v,
      etat: c.etat === "ok" ? "modifiee" : c.etat
    }),
    onRun: () => traiter(c.id),
    onKey: e => touche(e, c.id, i),
    onAdd: () => ajouter(c.id),
    onDel: () => supprimer(c.id),
    onSplit: () => decouperCellule(c.id),
    onMerge: () => fusionner(c.id),
    onDiff: () => majCellule(c.id, {
      diff: !c.diff
    }),
    onCopy: () => copier(c.propre)
  })), /*#__PURE__*/React.createElement("div", {
    className: "ajout"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => ajouter(null)
  }, "+ Ajouter une cellule")), /*#__PURE__*/React.createElement("div", {
    className: "aide-bas",
    style: {
      paddingTop: 28
    }
  }, /*#__PURE__*/React.createElement("p", null, "Une cellule = un passage de notes. ", /*#__PURE__*/React.createElement("kbd", null, "Maj"), "+", /*#__PURE__*/React.createElement("kbd", null, "Entrée"), " traite la cellule et passe à la suivante, ", /*#__PURE__*/React.createElement("kbd", null, "Ctrl"), "+", /*#__PURE__*/React.createElement("kbd", null, "Entrée"), " traite sans bouger. Un cours entier se colle dans une seule cellule, puis « Découper »."), /*#__PURE__*/React.createElement("p", null, "« Comparer » superpose l'avant et l'après mot à mot : en vert ce qui a été ajouté, en rouge ce qui a été retiré. Les ajouts doivent être des mots de liaison et des abréviations développées — jamais une idée."))) : /*#__PURE__*/React.createElement("main", {
    className: "vue-doc"
  }, /*#__PURE__*/React.createElement("div", {
    className: "doc-outils"
  }, /*#__PURE__*/React.createElement("button", {
    className: "bt",
    onClick: () => window.print()
  }, "Imprimer / PDF"), /*#__PURE__*/React.createElement("button", {
    className: "bt",
    onClick: exporterWord,
    disabled: !assemble
  }, "Word (.doc)"), /*#__PURE__*/React.createElement("button", {
    className: "bt",
    onClick: () => fichier(doc.titre + ".md", "# " + doc.titre + "\n\n" + assemble, "text/markdown"),
    disabled: !assemble
  }, "Markdown"), /*#__PURE__*/React.createElement("button", {
    className: "bt",
    onClick: () => copier(assemble),
    disabled: !assemble
  }, "Copier"), /*#__PURE__*/React.createElement("span", {
    className: "compte"
  }, motsPropres.toLocaleString("fr-FR"), " mots", restantes ? " · " + restantes + " cellule(s) pas encore traitée(s)" : "", desynchro ? " · " + desynchro + " retouchée(s) depuis leur mise au propre" : "")), assemble ? /*#__PURE__*/React.createElement("article", {
    className: "feuille"
  }, /*#__PURE__*/React.createElement("div", {
    className: "entete"
  }, /*#__PURE__*/React.createElement("h1", null, doc.titre), /*#__PURE__*/React.createElement("div", {
    className: "date"
  }, dateLisible(doc.maj))), /*#__PURE__*/React.createElement("div", {
    className: "corps",
    dangerouslySetInnerHTML: {
      __html: versHTML(assemble)
    }
  })) : /*#__PURE__*/React.createElement("div", {
    className: "vide-doc"
  }, /*#__PURE__*/React.createElement("b", null, "Le document est vide"), "Retournez dans l'atelier, collez vos notes et lancez la mise au propre. Le résultat s'assemble ici, prêt à imprimer.")), tiroir && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "voile",
    onClick: () => setTiroir(false)
  }), /*#__PURE__*/React.createElement("aside", {
    className: "tiroir"
  }, /*#__PURE__*/React.createElement("h2", null, "Mes documents"), /*#__PURE__*/React.createElement("div", {
    className: "liste"
  }, docs.map(d => /*#__PURE__*/React.createElement("button", {
    key: d.id,
    className: "item",
    "aria-current": d.id === actif,
    onClick: () => {
      setActif(d.id);
      setTiroir(false);
    }
  }, /*#__PURE__*/React.createElement("b", null, d.titre), /*#__PURE__*/React.createElement("span", null, d.cellules.length, " cellule", d.cellules.length > 1 ? "s" : "", " · modifié le", " ", new Date(d.maj).toLocaleDateString("fr-FR"))))), /*#__PURE__*/React.createElement("div", {
    className: "pied"
  }, /*#__PURE__*/React.createElement("button", {
    className: "bt prim",
    onClick: nouveau
  }, "Nouveau document"), /*#__PURE__*/React.createElement("button", {
    className: "bt",
    onClick: () => {
      if (confirm("Supprimer « " + doc.titre + " » ?")) supprimerDoc(actif);
    }
  }, "Supprimer celui-ci")), /*#__PURE__*/React.createElement("div", {
    className: "pied",
    style: {
      borderTop: "none",
      paddingTop: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "mini",
    onClick: onOublierCle
  }, "Changer la clé API")))), toast && /*#__PURE__*/React.createElement("div", {
    className: "toast"
  }, toast));
}

/* ------------------------------------------------------------------
   Cellule
------------------------------------------------------------------ */

function Cellule(props) {
  const {
    c,
    i,
    active,
    premiere,
    refsTexte
  } = props;
  const zone = useRef(null);
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.max(el.scrollHeight, 62) + "px";
  }, [c.brut]);
  const comparaison = c.diff && c.propre ? diffHTML(c.brut, c.propre) : null;
  let droite;
  if (c.etat === "encours") droite = /*#__PURE__*/React.createElement("div", {
    className: "encours"
  }, /*#__PURE__*/React.createElement("span", {
    className: "roue"
  }), " mise au propre…");else if (c.etat === "erreur") droite = /*#__PURE__*/React.createElement("div", {
    className: "msg-err"
  }, c.erreur);else if (c.propre && comparaison) droite = /*#__PURE__*/React.createElement("div", {
    className: "propre",
    dangerouslySetInnerHTML: {
      __html: comparaison.html
    }
  });else if (c.propre && c.diff) droite = /*#__PURE__*/React.createElement("div", {
    className: "vide"
  }, "Passage trop long pour la comparaison mot à mot.");else if (c.propre) droite = /*#__PURE__*/React.createElement("div", {
    className: "propre",
    dangerouslySetInnerHTML: {
      __html: versHTML(c.propre)
    }
  });else droite = /*#__PURE__*/React.createElement("div", {
    className: "vide"
  }, "La version propre s'affichera ici.");
  return /*#__PURE__*/React.createElement("section", {
    className: "cellule" + (active ? " active" : "") + (c.etat === "erreur" ? " erreur" : ""),
    onClick: props.onSelect
  }, /*#__PURE__*/React.createElement("div", {
    className: "gout"
  }, /*#__PURE__*/React.createElement("span", {
    className: "idx"
  }, i + 1), /*#__PURE__*/React.createElement("button", {
    className: "play",
    onClick: props.onRun,
    disabled: !c.brut.trim() || c.etat === "encours",
    title: "Mettre au propre (Maj + Entrée)",
    "aria-label": "Mettre au propre la cellule " + (i + 1)
  }, Ico.play), /*#__PURE__*/React.createElement("span", {
    className: "pastille" + (c.etat === "ok" ? " ok" : c.etat === "erreur" ? " ko" : c.etat === "encours" ? " wait" : "")
  })), /*#__PURE__*/React.createElement("div", {
    className: "face g"
  }, /*#__PURE__*/React.createElement("textarea", {
    ref: el => {
      zone.current = el;
      refsTexte.current[c.id] = el;
    },
    className: "brut",
    value: c.brut,
    placeholder: "Collez ici les notes telles qu'elles ont été prises…",
    onChange: e => props.onChange(e.target.value),
    onKeyDown: props.onKey,
    onFocus: props.onSelect,
    spellCheck: false,
    rows: 3
  })), /*#__PURE__*/React.createElement("div", {
    className: "sep"
  }), /*#__PURE__*/React.createElement("div", {
    className: "face d"
  }, droite), active && /*#__PURE__*/React.createElement("div", {
    className: "outils"
  }, /*#__PURE__*/React.createElement("button", {
    className: "mini",
    onClick: props.onAdd
  }, "+ dessous"), /*#__PURE__*/React.createElement("button", {
    className: "mini",
    onClick: props.onSplit
  }, "Découper"), !premiere && /*#__PURE__*/React.createElement("button", {
    className: "mini",
    onClick: props.onMerge
  }, "Fusionner ↑"), c.propre && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    className: "mini",
    onClick: props.onDiff
  }, c.diff ? "Voir le propre" : "Comparer"), /*#__PURE__*/React.createElement("button", {
    className: "mini",
    onClick: props.onCopy
  }, "Copier")), /*#__PURE__*/React.createElement("button", {
    className: "mini danger",
    onClick: props.onDel
  }, "Supprimer"), /*#__PURE__*/React.createElement("span", {
    className: "compte"
  }, comparaison ? comparaison.ajouts + " ajoutés · " + comparaison.retraits + " retirés" : c.etat === "modifiee" ? "notes modifiées depuis le traitement" : c.duree ? c.duree.toFixed(1) + " s" : compteMots(c.brut) + " mots")));
}

/* ------------------------------------------------------------------
   Porte d'entrée : clé API
------------------------------------------------------------------ */

function Porte({
  onCle
}) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  function valider() {
    const k = val.trim();
    if (!/^sk-ant-/.test(k)) return setErr("Une clé Anthropic commence par sk-ant-.");
    localStorage.setItem("nap.cle", k);
    onCle(k);
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "porte"
  }, /*#__PURE__*/React.createElement("div", {
    className: "porte-carte"
  }, /*#__PURE__*/React.createElement("h1", null, "Notes au propre"), /*#__PURE__*/React.createElement("p", {
    className: "sous"
  }, "Une clé API est nécessaire pour faire fonctionner l'application."), /*#__PURE__*/React.createElement("label", {
    htmlFor: "k"
  }, "Clé API Anthropic"), /*#__PURE__*/React.createElement("input", {
    id: "k",
    value: val,
    onChange: e => {
      setVal(e.target.value);
      setErr("");
    },
    onKeyDown: e => e.key === "Enter" && valider(),
    placeholder: "sk-ant-...",
    autoFocus: true
  }), err && /*#__PURE__*/React.createElement("div", {
    className: "err"
  }, err), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "bt prim",
    onClick: valider
  }, "Ouvrir l'application")), /*#__PURE__*/React.createElement("p", {
    className: "aide"
  }, "La clé se crée sur console.anthropic.com. Elle reste sur cet ordinateur, dans le navigateur. Pour ne plus la saisir du tout, ouvrez le fichier ", /*#__PURE__*/React.createElement("b", null, "cle-api.js"), " du dossier et collez-la entre les guillemets.")));
}

/* ------------------------------------------------------------------
   Racine
------------------------------------------------------------------ */

function Racine() {
  const [cleApi, setCleApi] = useState(() => (window.CLE_API && /^sk-ant-/.test(window.CLE_API) ? window.CLE_API : localStorage.getItem("nap.cle")) || "");
  if (!cleApi) return /*#__PURE__*/React.createElement(Porte, {
    onCle: setCleApi
  });
  return /*#__PURE__*/React.createElement(App, {
    apiKey: cleApi,
    onOublierCle: () => {
      localStorage.removeItem("nap.cle");
      setCleApi("");
    }
  });
}
ReactDOM.createRoot(document.getElementById("racine")).render(/*#__PURE__*/React.createElement(Racine, null));
