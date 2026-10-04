// Lettura di uno screenshot "Il Mio Tip" di Sisal: preparazione immagine, OCR e interpretazione.
// Le funzioni pure (preparaPixel, righe, interpretaSisal, abbina) sono testabili anche con Node.

/** Bianco/nero ad alto contrasto. Le fasce scure (intestazione) vengono invertite. */
export function preparaPixel(rgba, w, h, soglia = 175) {
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    const m = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    out[i] = m < soglia ? 0 : 255;
  }
  for (let y = 0; y < h; y++) {
    let neri = 0;
    for (let x = 0; x < w; x++) if (!out[y * w + x]) neri++;
    if (neri > w * 0.5) for (let x = 0; x < w; x++) out[y * w + x] = 255 - out[y * w + x];
  }
  return out;
}

/** Raggruppa le parole OCR (con bbox) in righe ordinate dall'alto in basso. */
export function righe(parole) {
  const ws = parole.filter(p => p.t && p.t.trim()).map(p => ({ ...p, cy: (p.y0 + p.y1) / 2, hh: p.y1 - p.y0 }))
    .sort((a, b) => a.cy - b.cy);
  const out = [];
  for (const p of ws) {
    const r = out[out.length - 1];
    if (r && Math.abs(p.cy - r.cy) < Math.max(r.hh, p.hh) * 0.6) {
      r.parole.push(p);
      r.cy = (r.cy * (r.parole.length - 1) + p.cy) / r.parole.length;
      r.hh = Math.max(r.hh, p.hh);
    } else out.push({ cy: p.cy, hh: p.hh, parole: [p] });
  }
  return out.map(r => {
    r.parole.sort((a, b) => a.x0 - b.x0);
    return { y: r.cy, parole: r.parole, testo: r.parole.map(p => p.t).join(' ') };
  });
}

const RE_DATA = /(\d{2})\s*\/\s*(\d{2})\s*[-–—~]?\s*(\d{1,2})\s*[:.]\s*(\d{2})/;
const RE_QUOTA = /^\(?(\d{1,4})[.,](\d{2})\)?$/;

// Corregge gli errori OCR tipici nelle righe del mercato
function pulisciMercato(t) {
  return t.toUpperCase()
    .replace(/[0Q]VER/g, 'OVER').replace(/UNDER|UNOER|UNDFR/g, 'UNDER')
    .replace(/U\s*[\/|lI1]?\s*[OC0Q]\b/g, 'U/O').replace(/:\s*/g, ': ');
}

function quotaDa(parole) {
  for (let i = parole.length - 1; i >= 0; i--) {
    const t = parole[i].t.replace(/[^\d.,()]/g, '');
    const m = t.match(RE_QUOTA);
    if (m) return Number(m[1] + '.' + m[2]);
    // "148" letto senza punto -> 1.48
    if (/^\d{3,4}$/.test(t) && i >= parole.length - 3) return Number(t) / 100;
  }
  return null;
}

/** Riconosce il mercato da una riga. Restituisce null se la riga non è un mercato. */
export function mercatoDa(testo) {
  const t = pulisciMercato(testo);
  let m;
  if (/CORNER|ANGOL/.test(t) && (m = t.match(/(\d{1,2}[.,]5)\D*?(OVER|UNDER)|(OVER|UNDER)\D*?(\d{1,2}[.,]5)/)))
    return { mercato: 'CORNER', linea: Number((m[1] || m[4]).replace(',', '.')), sel: (m[2] || m[3]) === 'OVER' ? 'O' : 'U' };
  if ((m = t.match(/U\/O\s*(\d{1,2}[.,]5)\s*:?\s*(OVER|UNDER)/)) || (m = t.match(/(\d[.,]5)\s*:\s*(OVER|UNDER)/)))
    return { mercato: 'UO', linea: Number(m[1].replace(',', '.')), sel: m[2] === 'OVER' ? 'O' : 'U' };
  if ((m = t.match(/DOPPIA\s*CHANCE[^:]*:\s*(1X|12|X2)\b/)) || (m = t.match(/\bDC\b[^:]*:\s*(1X|12|X2)\b/)))
    return { mercato: 'DC', sel: m[1] };
  if ((m = t.match(/(GOAL\s*\/?\s*NO\s*GOAL|GG\s*\/\s*NG)[^:]*:\s*(NO\s*GOAL|NOGOAL|GOAL|GG|NG)\b/)))
    return { mercato: 'GGNG', sel: /NO|NG/.test(m[2]) ? 'NG' : 'GG' };
  if ((m = t.match(/(MARCATORE|SEGNA)[^:]*:\s*(.+?)(\s+\d+[.,]\d{2}.*)?$/)))
    return { mercato: 'MARC', giocatore: testo.split(':').slice(1).join(':').replace(/\s+\(?\d+[.,]?\d*\)?\s*\S?\s*$/, '').trim() };
  if ((m = t.match(/(1X2|ESITO\s*FINALE)[^:]*:\s*(1|X|2)\b/)))
    return { mercato: '1X2', sel: m[2] };
  if (/\b(OVER|UNDER)\b/.test(t)) return { mercato: null };   // mercato visto ma non leggibile del tutto
  return null;
}

function separaSquadre(t) {
  const pulito = t.replace(/[|_©®]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = pulito.match(/^(.+?)\s+[-–—=~]+\s+(.+)$/) || pulito.match(/^(.+?)[–—=](.+)$/);
  if (m) return [m[1].trim(), m[2].trim()];
  return [pulito, ''];
}

/** Interpreta le righe dello screenshot e restituisce puntata, quota totale ed eventi. */
export function interpretaSisal(rs) {
  const tutto = rs.map(r => r.testo).join('\n');
  const res = { puntata: null, vincita: null, quotaTotale: null, anno: null, eventi: [] };
  const g = tutto.match(/giocato\s+il\s+\d{2}\/\d{2}\/(\d{4})/i);
  if (g) res.anno = Number(g[1]);
  const q = tutto.match(/Quota\s*:?\s*(\d+[.,]\d{2})/i);
  if (q) res.quotaTotale = Number(q[1].replace(',', '.'));
  const iP = rs.findIndex(r => /Puntata/i.test(r.testo));
  if (iP >= 0) {
    for (const r of rs.slice(iP, iP + 3)) {
      const soldi = [...r.testo.matchAll(/(\d+(?:\.\d{3})*,\d{2}|\d+\.\d{2})\s*€?/g)].map(x => Number(x[1].replace(/\.(?=\d{3})/g, '').replace(',', '.')));
      if (soldi.length >= 2) { res.puntata = soldi[0]; res.vincita = soldi[1]; break; }
    }
  }
  if (!res.quotaTotale && res.puntata && res.vincita) res.quotaTotale = +(res.vincita / res.puntata).toFixed(2);

  // Ogni evento è ancorato alla sua riga del mercato ("U/O 2.5: OVER  1.45");
  // le righe sopra (fino al mercato precedente) contengono squadre, data e ora.
  const inizio = iP >= 0 ? iP + 1 : 0;
  const isMercato = rs.map((r, i) => i >= inizio && !/tipster|scommesse/i.test(r.testo) && mercatoDa(r.testo) !== null);
  const g0 = tutto.match(/giocato\s+il\s+(\d{2})\/(\d{2})/i);
  let giorno = g0 ? +g0[1] : null, mese = g0 ? +g0[2] : null, ora = null;
  let prec = inizio - 1;
  rs.forEach((r, i) => {
    if (!isMercato[i]) return;
    const blocco = rs.slice(prec + 1, i).filter(b => !/€|Puntata|Vincita|giocato il|Mio Tip/i.test(b.testo));
    const yDa = prec >= 0 ? rs[prec].y : -Infinity;
    prec = i;
    const squadre = [];
    let trovataOra = false;
    for (const b of blocco) {
      const d = b.testo.match(RE_DATA);
      if (d) {
        giorno = +d[1]; mese = +d[2]; ora = `${d[3].padStart(2, '0')}:${d[4]}`; trovataOra = true;
        // le squadre sono le parole a sinistra della data
        const xData = b.parole.find(p => /\d{2}\s*\/\s*\d{2}/.test(p.t))?.x0 ?? Infinity;
        squadre.push(b.parole.filter(p => p.x1 <= xData + 2).map(p => p.t).join(' ').replace(RE_DATA, ''));
        continue;
      }
      // data illeggibile ma ora in fondo alla riga ("—1300")
      const o = b.testo.match(/[-–—~\s](\d{1,2})[:.]?(\d{2})\s*$/);
      if (o && +o[1] < 24 && +o[2] < 60 && !trovataOra) {
        ora = `${o[1].padStart(2, '0')}:${o[2]}`; trovataOra = true;
        squadre.push(b.testo.slice(0, o.index).replace(/[-–—~]+\s*[a-z]{0,6}\s*[-–—~]*\s*$/i, ''));
        continue;
      }
      if (/[A-Za-z]{3,}/.test(b.testo)) squadre.push(b.testo);
    }
    const [casa, ospite] = separaSquadre(squadre.join(' '));
    res.eventi.push({
      giorno, mese, ora, oraIncerta: !trovataOra, casa, ospite, yDa, yA: r.y,
      ...mercatoDa(r.testo), quota: quotaDa(r.parole), testoMercato: r.testo,
    });
  });
  res.eventi.forEach(e => { if (e.mercato === undefined) e.mercato = null; });
  return res;
}

/** Completa gli eventi senza squadre usando le righe di una seconda lettura OCR. */
export function completaConSecondaLettura(res, rs2, scala = 1) {
  for (const e of res.eventi) {
    if (e.casa && e.ospite && !e.oraIncerta) continue;
    const cand = rs2.filter(r => r.y * scala > e.yDa + 5 && r.y * scala < e.yA - 5 && /[A-Za-z]{3,}/.test(r.testo));
    if (!cand.length) continue;
    const testo = cand.map(r => r.testo).join(' ');
    const d = testo.match(RE_DATA);
    if (e.casa && e.ospite && !d) continue;   // la seconda lettura non è migliore
    if (d && e.oraIncerta) { e.giorno = +d[1]; e.mese = +d[2]; e.ora = `${d[3].padStart(2, '0')}:${d[4]}`; e.oraIncerta = false; }
    [e.casa, e.ospite] = separaSquadre(testo.replace(RE_DATA, ''));
  }
  return res;
}

/* ---------- abbinamento con le partite di API-Football ---------- */

// Parole che non aiutano a riconoscere una squadra
const VUOTE = new Set(['fc', 'fk', 'if', 'bk', 'sv', 'usv', 'ud', 'cf', 'ac', 'as', 'sc', 'afc', 'cd', 'sd', 'ss', 'asd', 'us', 'club', 'calcio', 'the', 'de', 'la', 'fsv', 'vfl', 'vfb', 'tsv', 'sk', 'skn', 'il', 'ik', 'ff', 'aif', 'fotball', 'spor', 'kulubu', 'sk', 'ks', 'mks', 'zks', 'sp', 'utd', 'united', 'city', 'cfc', 'nk', 'hnk', 'gnk', 'ofk', 'fcm', 'rc', 'sl', 'jk', 'fbc']);
const DONNE = /\b(femm|femminile|women|woman|wfc|lfc|ladies|w|fem|f)\b/;

// Traduzioni italiane usate da Sisal -> nome internazionale
const ALIAS = { amburgo: 'hamburger', monaco: 'munchen', colonia: 'koln', lisbona: 'lisbon', siviglia: 'sevilla', stella: 'crvena', bodoe: 'bodo' };

function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function token(s) {
  return norm(s).split(' ').filter(t => t.length > 1 && !VUOTE.has(t) && !DONNE.test(t) && !/^\d{4}$/.test(t)).map(t => ALIAS[t] || t);
}
function bigrammi(s) { const r = []; for (let i = 0; i < s.length - 1; i++) r.push(s.slice(i, i + 2)); return r; }
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrammi(a), B = bigrammi(b); if (!A.length || !B.length) return 0;
  const m = new Map(); A.forEach(x => m.set(x, (m.get(x) || 0) + 1));
  let n = 0; B.forEach(x => { const c = m.get(x); if (c) { n++; m.set(x, c - 1); } });
  return 2 * n / (A.length + B.length);
}

/** Somiglianza 0..1 tra il nome letto da Sisal e il nome di API-Football. */
export function somiglianza(a, b) {
  const ta = token(a), tb = token(b);
  if (!ta.length || !tb.length) return dice(norm(a), norm(b)) * 0.8;
  // per ogni parola di Sisal, la parola più simile di API-Football (gestisce errori OCR e prefissi)
  const best = (x, ys) => Math.max(...ys.map(y => (y.startsWith(x) || x.startsWith(y)) && Math.min(x.length, y.length) >= 4 ? 0.95 : dice(x, y)));
  const s1 = ta.reduce((s, x) => s + best(x, tb), 0) / ta.length;
  const s2 = tb.reduce((s, y) => s + best(y, ta), 0) / tb.length;
  const intero = dice(ta.join(''), tb.join(''));
  return Math.max(Math.max(s1, s2) * 0.6 + Math.min(s1, s2) * 0.4, intero);
}

/**
 * Cerca la partita di API-Football che corrisponde a un evento letto da Sisal.
 * partite: lista di { id, kickoff (ISO), home, away, ... } dello stesso giorno.
 * Restituisce i candidati ordinati per punteggio (il primo è la scelta proposta).
 */
export function abbina(ev, partite, tz = 'Europe/Rome') {
  const donne = DONNE.test(norm(ev.casa + ' ' + ev.ospite));
  const [hh, mm] = ev.ora.split(':').map(Number);
  const minEv = hh * 60 + mm;
  return partite.map(p => {
    const t = new Date(p.kickoff).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: tz }).split(':').map(Number);
    const diff = Math.abs(t[0] * 60 + t[1] - minEv);
    const sh = somiglianza(ev.casa, p.home), sa = somiglianza(ev.ospite, p.away);
    let punti = (sh + sa) / 2;
    if (Math.min(sh, sa) < 0.35) punti -= 0.15;              // una delle due squadre non torna
    if (diff <= 2) punti += 0.15; else if (diff <= 15) punti += 0.05; else if (diff > 90) punti -= 0.3;
    const pDonne = / W$|women|femenino|feminin|damen|ladies/i.test(p.home + ' ' + p.away);
    // Sisal scrive "Femm" quasi sempre, ma non per tutti i campionati femminili
    if (donne && !pDonne) punti -= 0.25; else if (!donne && pDonne) punti -= 0.08;
    return { partita: p, punti: +punti.toFixed(3), diff };
  }).sort((a, b) => b.punti - a.punti).slice(0, 6);
}

export const SOGLIA_SICURA = 0.75;   // sopra: abbinamento proposto come certo
export const SOGLIA_MINIMA = 0.5;    // sotto: "partita non trovata"

/* ---------- parte browser: OCR con Tesseract.js ---------- */
let tesseractPronto = null;
function caricaTesseract() {
  if (globalThis.Tesseract) return Promise.resolve();
  if (!tesseractPronto) tesseractPronto = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = ok; s.onerror = () => ko(new Error('Impossibile caricare il lettore di testo (Tesseract)'));
    document.head.appendChild(s);
  });
  return tesseractPronto;
}

/** Disegna l'immagine a una certa larghezza e la porta in bianco e nero. */
function canvasBN(bmp, larghezza) {
  const scala = larghezza / bmp.width;
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scala); cv.height = Math.round(bmp.height * scala);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const bn = preparaPixel(img.data, cv.width, cv.height);
  for (let i = 0; i < bn.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = bn[i]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return cv;
}

async function leggiParole(worker, cv, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300' });
  const { data } = await worker.recognize(cv, {}, { blocks: true });
  const parole = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) parole.push({ t: w.text, ...w.bbox });
  return righe(parole);
}

/** File immagine -> { puntata, quotaTotale, eventi } */
export async function leggiScreenshot(file, avanzamento = () => {}) {
  avanzamento('Preparo il lettore di testo…');
  await caricaTesseract();
  const bmp = await createImageBitmap(file);
  // Prima lettura ad alta risoluzione (testo sparso), seconda più piccola solo se serve
  const L1 = 1824, L2 = 1216;
  let passo = 1;
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') avanzamento(`Leggo la schedina${passo > 1 ? ' (controllo)' : ''}… ${Math.round(m.progress * 100)}%`); },
  });
  try {
    const res = interpretaSisal(await leggiParole(worker, canvasBN(bmp, L1), '11'));
    if (res.eventi.some(e => !e.casa || !e.ospite || e.oraIncerta)) {
      passo = 2;
      completaConSecondaLettura(res, await leggiParole(worker, canvasBN(bmp, L2), '4'), L1 / L2);
    }
    return res;
  } finally {
    await worker.terminate();
  }
}
