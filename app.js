import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, setDoc, getDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { MERCATI, ANOMALI, IN_CORSO, MERCATI_SOLO_GOL, snapshotDaElenco, snapshot, valuta, statoSchedina, etichettaSelezione, statistiche } from "./logic.js";
import { leggiScreenshot, abbina, SOGLIA_SICURA, SOGLIA_MINIMA } from "./sisal.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const API = 'https://v3.football.api-sports.io';
const TZ = 'Europe/Rome';
// Campionati mostrati con il filtro "Principali"
const PRINCIPALI = new Set([135, 136, 137, 39, 140, 78, 61, 2, 3, 848, 88, 94]);

const S = {
  user: null,
  schedine: [],
  settings: { apiKey: '', intervallo: 3 },
  view: 'live',
  draft: { eventi: [], puntata: '', quotaTotale: '' },
  nuova: { data: oggi(), partite: null, cerca: '', tutte: false, caricando: false },
  storicoFiltro: 'tutto',
  ultimoAgg: null,
  aggiornando: false,
  timer: null,
  unsub: null,
};

/* ---------- utilità ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = (n) => (Number(n) || 0).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const num = (n, d = 2) => (Number(n) || 0).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
function oggi() { return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); }
const ora = (iso) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const giorno = (iso) => new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', timeZone: TZ });
// "2026-10-04" + "13:00" (ora italiana) -> ISO con il fuso giusto (legale o solare)
function isoRoma(data, hhmm) {
  const d = data || oggi(), h = /^\d{1,2}:\d{2}$/.test(hhmm || '') ? hhmm.padStart(5, '0') : '12:00';
  for (const off of ['+02:00', '+01:00']) {
    const iso = `${d}T${h}:00${off}`;
    if (ora(iso) === h) return iso;
  }
  return `${d}T${h}:00+01:00`;
}

function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 3500);
}
function cacheGet(k, maxAge) {
  try { const v = JSON.parse(localStorage.getItem(k)); if (v && Date.now() - v.t < maxAge) return v.d; } catch {}
  return null;
}
function cacheSet(k, d) {
  try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); }
  catch { try { Object.keys(localStorage).filter(x => x.startsWith('fx-')).forEach(x => localStorage.removeItem(x)); } catch {} }
}

/* ---------- API-Football ---------- */
// Contatore richieste: il dato vero arriva da /status di API-Football (che non consuma quota).
// Il conteggio locale serve solo finché /status non risponde. La quota si azzera a mezzanotte UTC.
const chiaveContatore = () => 'req-' + new Date().toISOString().slice(0, 10);
function contaRichiesta(rimaste) {
  let n = 0; try { n = Number(localStorage.getItem(chiaveContatore())) || 0; localStorage.setItem(chiaveContatore(), n + 1); } catch {}
  if (S.quota) S.quota.usate++;                       // stima immediata, poi corretta da /status
  else if (rimaste != null) S.quota = { usate: 100 - Number(rimaste), limite: 100, stimata: true };
  mostraQuota();
  clearTimeout(contaRichiesta._t);
  contaRichiesta._t = setTimeout(aggiornaContatore, 1500);
}
async function aggiornaContatore() {
  if (!S.settings.apiKey) return;
  try {
    const st = await api('/status', false);
    const usate = st.requests?.current, limite = st.requests?.limit_day;
    if (typeof usate === 'number' && typeof limite === 'number') S.quota = { usate, limite, piano: st.subscription?.plan };
  } catch {}
  mostraQuota();
  if (S.user && S.view === 'live') renderLive();
}
function rimaste() { return S.quota ? Math.max(0, S.quota.limite - S.quota.usate) : null; }
// Richieste necessarie per il prossimo aggiornamento live (1 ogni 20 partite iniziate)
function costoAggiornamento() { return Math.ceil(partiteDaAggiornare().length / 20); }
function oraAzzeramento() {
  const d = new Date(); d.setUTCHours(24, 0, 0, 0);
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}
function mostraQuota() {
  const el = $('#quota-api');
  if (!S.quota) {
    let n = 0; try { n = Number(localStorage.getItem(chiaveContatore())) || 0; } catch {}
    el.innerHTML = S.settings.apiKey ? `<span class="q-num">${n}</span><span class="q-lbl">richieste oggi</span>` : '';
    el.className = 'quota-api';
    return;
  }
  const { usate, limite } = S.quota;
  const perc = Math.min(100, usate / limite * 100);
  el.className = 'quota-api' + (perc >= 90 ? ' alto' : perc >= 70 ? ' medio' : '');
  el.title = `Richieste API usate oggi: ${usate} su ${limite}. Si azzera alle ${oraAzzeramento()}.`;
  el.innerHTML = `<span class="q-num">${usate}<small>/${limite}</small></span>
    <span class="q-bar"><i style="width:${perc}%"></i></span>`;
}

async function api(path, conta = true) {
  if (!S.settings.apiKey) throw new Error('Inserisci la chiave API-Football nelle Impostazioni');
  const r = await fetch(API + path, { headers: { 'x-apisports-key': S.settings.apiKey } });
  if (conta) contaRichiesta(r.headers.get('x-ratelimit-requests-remaining'));
  if (!r.ok) throw new Error('Errore API ' + r.status);
  const j = await r.json();
  const errs = j.errors ? (Array.isArray(j.errors) ? j.errors : Object.values(j.errors)) : [];
  if (errs.length) throw new Error(errs.join(' · '));
  return j.response;
}

async function partiteDelGiorno(data, forza = false) {
  const k = 'fx-' + data;
  // Giorni passati: i risultati non cambiano più. Oggi: elenco valido 15 minuti, così i risultati finali sono freschi.
  const durata = data < oggi() ? 24 * 3600e3 : data === oggi() ? 15 * 60e3 : 6 * 3600e3;
  if (!forza) { const c = cacheGet(k, durata); if (c && c[0]?.gh !== undefined) return c; }
  const res = await api(`/fixtures?date=${data}&timezone=${TZ}`);
  const lista = res.map(f => ({
    id: f.fixture.id, kickoff: f.fixture.date, status: f.fixture.status.short, elapsed: f.fixture.status.elapsed,
    gh: f.goals?.home ?? null, ga: f.goals?.away ?? null, fth: f.score?.fulltime?.home ?? null, fta: f.score?.fulltime?.away ?? null,
    leagueId: f.league.id, league: f.league.name, country: f.league.country,
    homeId: f.teams.home.id, home: f.teams.home.name, awayId: f.teams.away.id, away: f.teams.away.name,
  })).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  cacheSet(k, lista);
  return lista;
}

async function rosa(teamId) {
  const k = 'sq-' + teamId;
  const c = cacheGet(k, 7 * 86400e3); if (c) return c;
  const res = await api(`/players/squads?team=${teamId}`);
  const p = (res[0]?.players || []).map(x => ({ id: x.id, name: x.name, pos: x.position }));
  cacheSet(k, p);
  return p;
}

/* ---------- aggiornamento live ---------- */
function partiteDaAggiornare() {
  const adesso = Date.now();
  const ids = new Set();
  for (const s of S.schedine) {
    if (statoSchedina(s).chiusa) continue;           // schedina già decisa: niente richieste
    for (const ev of s.eventi) {
      if (!ev.fixtureId || ev.esitoManuale || ev.live?.finito) continue;
      if (ev.live && ANOMALI.has(ev.live.status)) continue;
      if (new Date(ev.kickoff).getTime() > adesso + 60e3) continue; // non ancora iniziata
      ids.add(ev.fixtureId);
    }
  }
  return [...ids];
}

async function aggiornaLive(manuale = false) {
  if (S.aggiornando || !S.user) return;
  const ids = partiteDaAggiornare();
  if (!ids.length) { if (manuale) toast('Nessuna partita iniziata da aggiornare'); return; }
  const costo = Math.ceil(ids.length / 20), restano = rimaste();
  if (restano != null && restano < costo) {
    // quota finita: niente aggiornamenti automatici, avviso una volta sola
    if (manuale || !S.avvisoQuota) toast(`Richieste API finite per oggi: si riparte alle ${oraAzzeramento()}`, true);
    S.avvisoQuota = true;
    return;
  }
  S.avvisoQuota = false;
  S.aggiornando = true; render();
  try {
    const snap = new Map();
    for (let i = 0; i < ids.length; i += 20) {
      const res = await api(`/fixtures?ids=${ids.slice(i, i + 20).join('-')}&timezone=${TZ}`);
      res.forEach(f => snap.set(f.fixture.id, snapshot(f)));
    }
    const scritture = [];
    for (const s of S.schedine) {
      let cambiata = false;
      const eventi = s.eventi.map(ev => {
        const L = snap.get(ev.fixtureId);
        if (!L || ev.esitoManuale) return ev;
        cambiata = true;
        return { ...ev, live: L };
      });
      if (cambiata) {
        const r = statoSchedina({ ...s, eventi });
        scritture.push(updateDoc(doc(db, 'users', S.user.uid, 'schedine', s.id), { eventi, stato: r.stato }));
      }
    }
    await Promise.all(scritture);
    S.ultimoAgg = Date.now();
    if (manuale) toast('Risultati aggiornati');
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.aggiornando = false; render();
  }
}

// Minuti tra un aggiornamento e l'altro; 0 = solo manuale
function minuti() {
  const v = Number(S.settings.intervallo);
  return Number.isFinite(v) && v >= 0 ? v : 3;
}
function avviaTimer() {
  clearInterval(S.timer);
  if (!minuti()) return;
  S.timer = setInterval(() => {
    if (document.visibilityState === 'visible') aggiornaLive();
  }, minuti() * 60e3);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.user || !minuti()) return;
  const scaduto = !S.ultimoAgg || Date.now() - S.ultimoAgg > minuti() * 60e3;
  if (scaduto) aggiornaLive();
});

/* ---------- auth + dati ---------- */
$('#btn-login').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => toast(e.message, true));

onAuthStateChanged(auth, async (user) => {
  S.user = user;
  if (S.unsub) { S.unsub(); S.unsub = null; }
  $('#login').classList.toggle('hidden', !!user);
  $('#nav').classList.toggle('hidden', !user);
  if (!user) { document.querySelectorAll('.view').forEach(v => v.classList.add('hidden')); clearInterval(S.timer); return; }
  try {
    const st = await getDoc(doc(db, 'users', user.uid, 'meta', 'settings'));
    if (st.exists()) S.settings = { ...S.settings, ...st.data() };
  } catch (e) { toast('Impossibile leggere le impostazioni: ' + e.message, true); }
  const q = query(collection(db, 'users', user.uid, 'schedine'), orderBy('createdAtMs', 'desc'));
  let primo = true;
  S.unsub = onSnapshot(q, (snap) => {
    S.schedine = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
    if (primo) { primo = false; if (minuti()) aggiornaLive(); }
  }, (e) => toast(e.message, true));
  if (!S.settings.apiKey) S.view = 'impostazioni';
  avviaTimer(); mostraQuota(); aggiornaContatore(); render();
});

/* ---------- navigazione ---------- */
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => { S.view = b.dataset.view; render(); window.scrollTo(0, 0); });

function render() {
  if (!S.user) return;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + S.view));
  ({ live: renderLive, nuova: renderNuova, storico: renderStorico, impostazioni: renderImpostazioni })[S.view]();
}

/* ---------- vista LIVE ---------- */
const TESTO_ESITO = { attesa: '—', ok: 'Ok', ko: 'No', vinto: 'Vinto', perso: 'Perso', nullo: 'Nullo', verifica: 'Verifica', manuale: 'A mano' };

function orologio(ev) {
  const L = ev.live;
  if (!L || L.status === 'NS' || L.status === 'TBD') {
    const oggiK = new Date(ev.kickoff).toLocaleDateString('sv-SE', { timeZone: TZ }) === oggi();
    return `<div class="clock">${oggiK ? ora(ev.kickoff) : giorno(ev.kickoff) + '<br>' + ora(ev.kickoff)}</div>`;
  }
  if (L.status === 'HT') return `<div class="clock live">INT</div>`;
  if (IN_CORSO.has(L.status)) return `<div class="clock live">${L.elapsed ?? ''}'</div>`;
  const map = { FT: 'FINE', AET: 'DTS', PEN: 'RIG', PST: 'RINV', CANC: 'ANN', ABD: 'SOSP', AWD: 'TAV', WO: 'WO' };
  return `<div class="clock">${map[L.status] || L.status}</div>`;
}

function rigaEvento(s, ev, i, esito) {
  const L = ev.live;
  const score = L ? `${L.h}–${L.a}` : '';
  let extra = '';
  if (L && ev.mercato === 'CORNER') extra = `Corner: ${L.hasStats ? L.corners : 'n.d.'}`;
  if (L && ev.mercato === 'MARC' && L.marcatori?.length) extra = 'Gol: ' + L.marcatori.map(m => esc(m.name)).join(', ');
  if (L && (L.status === 'AET' || L.status === 'PEN' || L.status === 'ET')) extra += (extra ? ' · ' : '') + `Dopo i supplementari ${L.golTotali.h}–${L.golTotali.a}`;
  if (!ev.fixtureId) extra = 'Partita non seguita in automatico: tocca per segnare l\'esito';
  const testo = ev.mercato === 'MARC' && esito === 'ko' ? 'Non ancora' : TESTO_ESITO[esito];
  return `<div class="ev ${esito}" data-act="evento" data-s="${s.id}" data-i="${i}">
    ${orologio(ev)}
    <div class="teams">
      <div class="t"><span>${esc(ev.home)} – ${esc(ev.away)}</span><span class="score">${score}</span></div>
      <div class="sel"><b>${esc(etichettaSelezione(ev))}</b>${ev.quota ? ' @ ' + num(ev.quota) : ''}</div>
      ${extra ? `<div class="extra">${extra}</div>` : ''}
    </div>
    <div class="esito">${testo}${ev.esitoManuale ? `<span class="man">${ev.fixtureId ? 'corretto a mano' : 'segnato a mano'}</span>` : ''}</div>
  </div>`;
}

function cardSchedina(s) {
  const r = statoSchedina(s);
  const cls = r.stato.replace(' ', '-');
  const data = new Date(s.createdAtMs).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const R = r.riepilogo;
  const chip = (n, cls, t) => n ? `<span class="chip ${cls}">${n} ${t}</span>` : '';
  return `<div class="card">
    <div class="card-head">
      <div><span class="badge ${cls}">${r.stato}</span> <span class="meta">${data} · ${s.eventi.length} eventi</span></div>
      <button class="x" data-act="menu-schedina" data-s="${s.id}" aria-label="Opzioni">⋯</button>
    </div>
    <div class="riepilogo">
      ${chip(R.vinti, 'vinto', R.vinti === 1 ? 'vinto' : 'vinti')}${chip(R.persi, 'perso', R.persi === 1 ? 'perso' : 'persi')}${chip(R.inCorso, 'live', 'in corso')}${chip(R.attesa, '', 'da iniziare')}${chip(R.gialli, 'giallo', 'da verificare')}${chip(R.nulli, '', R.nulli === 1 ? 'nullo' : 'nulli')}
    </div>
    ${s.eventi.map((ev, i) => rigaEvento(s, ev, i, r.esiti[i])).join('')}
    <div class="card-foot">
      <span>Puntata <b>${euro(s.puntata)}</b></span>
      <span>Quota <b>${num(r.quota)}</b></span>
      <span>${r.stato === 'vinta' ? 'Vinto' : r.stato === 'persa' ? 'Perso' : 'Potenziale'} <b class="${r.stato === 'vinta' ? 'pos' : r.stato === 'persa' ? 'neg' : ''}">${r.stato === 'persa' ? euro(s.puntata) : euro(r.vincitaPotenziale)}</b></span>
    </div>
  </div>`;
}

function renderLive() {
  const costoLive = costoAggiornamento();
  const aperte = S.schedine.filter(s => !statoSchedina(s).chiusa);
  const limite = Date.now() - 2 * 86400e3;
  const recenti = S.schedine.filter(s => statoSchedina(s).chiusa && (s.createdAtMs || 0) > limite).slice(0, 10);
  const agg = S.ultimoAgg ? 'Aggiornato alle ' + new Date(S.ultimoAgg).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'Non ancora aggiornato';
  $('#view-live').innerHTML = `
    <div class="toolbar">
      <div><h2>In gioco</h2><div class="muted small">${agg} · ${minuti() ? `ogni ${minuti()} min` : 'aggiornamento manuale'}</div>
        ${costoLive ? `<div class="muted small">Ogni aggiornamento costa ${costoLive} ${costoLive === 1 ? 'richiesta' : 'richieste'}${rimaste() != null ? ` · ne restano ${rimaste()} (≈ ${Math.floor(rimaste() / costoLive)} aggiornamenti)` : ''}</div>` : ''}</div>
      <button class="btn" data-act="aggiorna" ${S.aggiornando ? 'disabled' : ''}>${S.aggiornando ? 'Aggiorno…' : '↻ Aggiorna'}</button>
    </div>
    ${aperte.length ? aperte.map(cardSchedina).join('') : `<div class="empty">Nessuna schedina aperta.<br><br><button class="btn primary" data-act="vai-nuova">Crea una schedina</button></div>`}
    ${recenti.length ? `<h3>Chiuse di recente</h3>${recenti.map(cardSchedina).join('')}` : ''}
  `;
}

/* ---------- vista NUOVA ---------- */
function renderNuova() {
  const N = S.nuova, D = S.draft;
  let lista = '';
  if (N.caricando) lista = '<p class="muted">Carico le partite…</p>';
  else if (N.partite) {
    const q = N.cerca.trim().toLowerCase();
    const filtrate = N.partite.filter(p =>
      (N.tutte || PRINCIPALI.has(p.leagueId) || q) &&
      (!q || (p.home + ' ' + p.away + ' ' + p.league + ' ' + p.country).toLowerCase().includes(q)));
    const gruppi = {};
    filtrate.forEach(p => (gruppi[`${p.country} · ${p.league}`] ||= []).push(p));
    lista = Object.keys(gruppi).length ? Object.entries(gruppi).map(([g, ps]) => `
      <div class="league-title">${esc(g)}</div>
      ${ps.map(p => `<div class="match" data-act="scegli" data-id="${p.id}">
        <span class="time">${ora(p.kickoff)}</span>
        <span class="names">${esc(p.home)} – ${esc(p.away)}</span>
        <span class="muted">＋</span></div>`).join('')}`).join('')
      : `<p class="muted">Nessuna partita trovata${N.tutte ? '' : ' nei campionati principali: prova "Tutti i campionati" o cerca la squadra'}.</p>`;
  }

  const prodotto = D.eventi.reduce((p, e) => p * (Number(e.quota) || 1), 1);
  const quota = Number(D.quotaTotale) || prodotto;
  const vincita = (Number(D.puntata) || 0) * quota;

  $('#view-nuova').innerHTML = `
    ${D.eventi.length ? `<div class="draft">
      <h2 style="margin-top:0">La tua schedina</h2>
      ${D.eventi.map((e, i) => `<div class="draft-ev">
        <div><div>${esc(e.home)} – ${esc(e.away)}${e.fixtureId ? '' : ' <span class="chip giallo">a mano</span>'}</div><div class="muted small">${esc(etichettaSelezione(e))}${e.quota ? ' @ ' + num(e.quota) : ''} · ${giorno(e.kickoff)} ${ora(e.kickoff)}</div></div>
        <button class="x" data-act="rimuovi" data-i="${i}" aria-label="Rimuovi">✕</button></div>`).join('')}
      <div class="totali">
        <div><label>Puntata €</label><input id="d-puntata" type="number" inputmode="decimal" min="0" step="0.5" value="${esc(D.puntata)}"></div>
        <div><label>Quota totale</label><input id="d-quota" type="number" inputmode="decimal" step="0.01" placeholder="${num(prodotto)}" value="${esc(D.quotaTotale)}"></div>
        <div><label>Vincita</label><div style="padding:10px 0;font:700 22px/1 var(--font-num)" id="d-vincita">${euro(vincita)}</div></div>
      </div>
      <p class="muted small">La quota totale si calcola dalle quote dei singoli eventi; scrivila a mano solo se il bookmaker applica un bonus.</p>
      <button class="btn primary block" data-act="salva">Salva schedina</button>
    </div>` : ''}

    <label class="upload">
      <input type="file" id="n-foto" accept="image/*" hidden>
      <span class="upload-ico">📷</span>
      <span><b>Carica lo screenshot Sisal</b><br><span class="muted small">Leggo le giocate e le inserisco io. Puoi anche incollarlo con Ctrl+V.</span></span>
    </label>

    <h2>Aggiungi partite a mano</h2>
    <div class="row">
      <input class="grow" id="n-data" type="date" value="${N.data}">
      <button class="btn" data-act="carica">${N.partite ? 'Ricarica' : 'Carica partite'}</button>
    </div>
    ${N.partite ? `
      <div class="row" style="margin-top:8px">
        <input class="grow" id="n-cerca" placeholder="Cerca squadra o campionato" value="${esc(N.cerca)}">
      </div>
      <div class="filtri" style="margin-top:8px">
        <button data-act="filtro-camp" data-v="0" class="${N.tutte ? '' : 'on'}">Principali</button>
        <button data-act="filtro-camp" data-v="1" class="${N.tutte ? 'on' : ''}">Tutti i campionati</button>
      </div>` : '<p class="muted small">Le partite del giorno costano una sola richiesta API e restano in memoria per 6 ore.</p>'}
    <div id="lista-partite">${lista}</div>
  `;
  const p = $('#d-puntata'), qt = $('#d-quota');
  const ricalcola = () => {
    D.puntata = p.value; D.quotaTotale = qt.value;
    $('#d-vincita').textContent = euro((Number(D.puntata) || 0) * (Number(D.quotaTotale) || prodotto));
  };
  if (p) { p.oninput = ricalcola; qt.oninput = ricalcola; }
  const c = $('#n-cerca');
  if (c) c.oninput = () => { N.cerca = c.value; const pos = c.selectionStart; renderNuova(); const c2 = $('#n-cerca'); c2.focus(); c2.setSelectionRange(pos, pos); };
  $('#n-data').onchange = (e) => { N.data = e.target.value; N.partite = null; caricaPartite(); };
  $('#n-foto').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importaScreenshot(f); };
}

/* ---------- import da screenshot Sisal ---------- */
document.addEventListener('paste', (e) => {
  if (!S.user || S.view !== 'nuova') return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); importaScreenshot(f); }
});

async function importaScreenshot(file) {
  $('#modal-box').onclick = null;
  $('#modal-box').innerHTML = `<h2 style="margin-top:0">Leggo lo screenshot</h2><p id="imp-stato" class="muted">Avvio…</p>
    <p class="muted small">La lettura avviene sul tuo dispositivo e richiede qualche secondo (la prima volta scarica il lettore di testo, circa 10 MB).</p>`;
  $('#modal').classList.remove('hidden');
  const stato = (t) => { const el = $('#imp-stato'); if (el) el.textContent = t; };
  try {
    const letto = await leggiScreenshot(file, stato);
    if (!letto.eventi.length) throw new Error('Non ho trovato giocate nello screenshot. Usa lo screenshot "Il Mio Tip" di Sisal intero.');
    const anno = letto.anno || new Date().getFullYear();
    const giorni = [...new Set(letto.eventi.filter(e => e.giorno && e.mese)
      .map(e => `${anno}-${String(e.mese).padStart(2, '0')}-${String(e.giorno).padStart(2, '0')}`))];
    const partitePerGiorno = {};
    for (const g of giorni) {
      stato(`Cerco le partite del ${g.split('-').reverse().slice(0, 2).join('/')}…`);
      partitePerGiorno[g] = await partiteDelGiorno(g);
    }
    const righe = letto.eventi.map(e => {
      const g = e.giorno ? `${anno}-${String(e.mese).padStart(2, '0')}-${String(e.giorno).padStart(2, '0')}` : giorni[0];
      const cand = abbina(e, partitePerGiorno[g] || []);
      const top = cand[0];
      const margine = top && cand[1] ? top.punti - cand[1].punti : 1;
      const sicura = top && top.punti >= SOGLIA_SICURA && margine >= 0.06;
      return {
        letto: e, cand,
        scelta: top && top.punti >= SOGLIA_MINIMA ? top.partita.id : 'mano',
        data: g,
        livello: !top || top.punti < SOGLIA_MINIMA ? 'no' : sicura ? 'ok' : 'dubbio',
        mercato: e.mercato || 'UO', sel: e.sel || (e.mercato === '1X2' ? '1' : e.mercato === 'DC' ? '1X' : e.mercato === 'GGNG' ? 'GG' : 'O'),
        linea: e.linea ?? 2.5, quota: e.quota ?? '', giocatore: e.giocatore || '',
        mercatoDubbio: !e.mercato,
      };
    });
    revisioneImport(letto, righe);
  } catch (e) {
    $('#modal-box').innerHTML = `<h2 style="margin-top:0">Non sono riuscito a leggerlo</h2><p class="neg">${esc(e.message)}</p>
      <button class="btn block" id="imp-chiudi">Chiudi</button>`;
    $('#imp-chiudi').onclick = chiudiModal;
  }
}

function revisioneImport(letto, righe) {
  const opzioni = { '1X2': ['1', 'X', '2'], 'DC': ['1X', '12', 'X2'], 'UO': ['O', 'U'], 'GGNG': ['GG', 'NG'], 'CORNER': ['O', 'U'] };
  const nomeSel = (v) => ({ U: 'Under', O: 'Over', GG: 'Goal', NG: 'No Goal' }[v] || v);
  const icona = { ok: '<span class="pos">✓</span>', dubbio: '<span style="color:var(--warn)">?</span>', no: '<span class="neg">✕</span>' };

  const disegna = () => {
    const daImportare = righe.filter(r => r.scelta !== '').length;
    const aMano = righe.filter(r => r.scelta === 'mano').length;
    const dubbi = righe.filter(r => r.scelta !== '' && r.scelta !== 'mano' && (r.livello !== 'ok' || r.mercatoDubbio)).length;
    $('#modal-box').innerHTML = `
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Controlla la schedina</h2><button class="x" data-r="chiudi">✕</button></div>
      <p class="muted small">Letti ${righe.length} eventi${letto.puntata ? ` · puntata ${euro(letto.puntata)}` : ''}${letto.quotaTotale ? ` · quota ${num(letto.quotaTotale)}` : ''}.
        ${dubbi ? `<b style="color:var(--warn)">${dubbi} da controllare</b> (segnati con ?). ` : ''}
        ${aMano ? `<b style="color:var(--warn)">${aMano} non trovate</b>: restano nella schedina in giallo e l'esito lo segni tu. ` : ''}
        ${righe.length - daImportare ? `${righe.length - daImportare} eliminate. ` : ''}
        ${!dubbi && !aMano && daImportare === righe.length ? 'Tutto abbinato.' : ''}</p>
      ${righe.map((r, i) => `
        <div class="imp ${r.scelta === '' ? 'saltato' : r.scelta === 'mano' ? 'amano' : ''}">
          <div class="imp-top">${r.scelta === 'mano' ? icona.dubbio.replace('?', '✋') : icona[r.scelta === '' ? 'no' : r.livello]}
            <div class="grow"><b>${esc(r.letto.casa)} – ${esc(r.letto.ospite)}</b><div class="muted small">Sisal · ${esc(r.letto.ora || '?')}</div></div>
          </div>
          <select data-r="scelta" data-i="${i}">
            ${r.cand.filter(c => c.punti > 0.25).map(c => `<option value="${c.partita.id}" ${c.partita.id === r.scelta ? 'selected' : ''}>${ora(c.partita.kickoff)} ${esc(c.partita.home)} – ${esc(c.partita.away)} (${esc(c.partita.league)})</option>`).join('')}
            <option value="mano" ${r.scelta === 'mano' ? 'selected' : ''}>✋ Non trovata: la tengo e la segno io a mano</option>
            <option value="" ${r.scelta === '' ? 'selected' : ''}>✕ Elimina (letta male, non è nella schedina)</option>
          </select>
          <div class="imp-merc">
            <select data-r="mercato" data-i="${i}" class="${r.mercatoDubbio ? 'warn' : ''}">${Object.entries(MERCATI).map(([k, m]) => `<option value="${k}" ${k === r.mercato ? 'selected' : ''}>${m.nome}</option>`).join('')}</select>
            ${r.mercato === 'MARC'
              ? `<input data-r="giocatore" data-i="${i}" value="${esc(r.giocatore)}" placeholder="Giocatore">`
              : `<select data-r="sel" data-i="${i}">${opzioni[r.mercato].map(v => `<option value="${v}" ${v === r.sel ? 'selected' : ''}>${nomeSel(v)}</option>`).join('')}</select>`}
            ${r.mercato === 'UO' || r.mercato === 'CORNER' ? `<input data-r="linea" data-i="${i}" type="number" step="1" value="${r.linea}" title="Linea">` : ''}
            <input data-r="quota" data-i="${i}" type="number" step="0.01" value="${r.quota}" placeholder="Quota" title="Quota">
          </div>
        </div>`).join('')}
      <button class="btn primary block" data-r="importa" style="margin-top:14px" ${daImportare ? '' : 'disabled'}>Metti ${daImportare} eventi nella schedina</button>
      <p class="muted small">Le partite tenute "a mano" non consumano richieste API: quando finiscono le tocchi e scegli Vinto, Perso o Nullo.</p>`;
  };

  $('#modal-box').onclick = (e) => {
    const a = e.target.dataset?.r;
    if (a === 'chiudi') chiudiModal();
    if (a === 'importa') {
      const eventi = [];
      for (const r of righe) {
        if (r.scelta === '') continue;
        const p = r.scelta === 'mano'
          ? { id: null, kickoff: isoRoma(r.data, r.letto.ora), league: '', home: r.letto.casa || '?', away: r.letto.ospite || '?', homeId: null, awayId: null }
          : r.cand.find(c => c.partita.id === r.scelta).partita;
        const ev = {
          fixtureId: p.id, kickoff: p.kickoff, league: p.league, home: p.home, away: p.away, homeId: p.homeId, awayId: p.awayId,
          mercato: r.mercato, sel: r.mercato === 'MARC' ? null : r.sel, quota: r.quota ? Number(r.quota) : null,
          live: MERCATI_SOLO_GOL.has(r.mercato) ? snapshotDaElenco(p) : null, esitoManuale: null,
        };
        if (r.mercato === 'UO' || r.mercato === 'CORNER') ev.linea = Number(r.linea);
        if (r.mercato === 'MARC') { ev.giocatore = r.giocatore.trim(); ev.giocatoreId = null; }
        eventi.push(ev);
      }
      const D = S.draft;
      const vuota = !D.eventi.length;
      D.eventi.push(...eventi);
      if (vuota && letto.puntata) D.puntata = String(letto.puntata);
      // la quota è sempre quella della schedina Sisal (bonus compreso)
      if (vuota && letto.quotaTotale) D.quotaTotale = String(letto.quotaTotale);
      chiudiModal(); S.view = 'nuova'; render(); window.scrollTo(0, 0);
      toast(`${eventi.length} eventi aggiunti: controlla la puntata e salva`);
    }
  };
  $('#modal-box').onchange = (e) => {
    const a = e.target.dataset?.r, i = Number(e.target.dataset?.i);
    if (!a || Number.isNaN(i)) return;
    const r = righe[i];
    if (a === 'scelta') { const v = e.target.value; r.scelta = v === '' || v === 'mano' ? v : Number(v); r.livello = 'ok'; }
    if (a === 'mercato') { r.mercato = e.target.value; r.mercatoDubbio = false; r.sel = opzioni[r.mercato]?.[0] ?? null; }
    if (a === 'sel') r.sel = e.target.value;
    if (a === 'linea') r.linea = e.target.value;
    if (a === 'quota') r.quota = e.target.value;
    if (a === 'giocatore') r.giocatore = e.target.value;
    if (a === 'scelta' || a === 'mercato') disegna();
  };
  disegna();
}

async function caricaPartite(forza = false) {
  S.nuova.caricando = true; renderNuova();
  try { S.nuova.partite = await partiteDelGiorno(S.nuova.data, forza); }
  catch (e) { toast(e.message, true); S.nuova.partite = null; }
  S.nuova.caricando = false; renderNuova();
}

/* Modal per scegliere la giocata su una partita */
function apriGiocata(p) {
  const st = { mercato: '1X2', sel: '1', linea: 2.5, lineaCorner: 9.5, quota: '', giocatore: '', giocatoreId: null, rose: null };
  const lineeGol = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
  const lineeCorner = [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5];
  const opzioni = { '1X2': ['1', 'X', '2'], 'DC': ['1X', '12', 'X2'], 'UO': ['U', 'O'], 'GGNG': ['GG', 'NG'], 'CORNER': ['U', 'O'] };
  const nomeSel = (v) => ({ U: 'Under', O: 'Over', GG: 'Goal', NG: 'No Goal' }[v] || v);

  const disegna = () => {
    let campi = '';
    if (opzioni[st.mercato]) campi += `<label>Esito</label><div class="seg">${opzioni[st.mercato].map(v => `<button data-sel="${v}" class="${st.sel === v ? 'on' : ''}">${nomeSel(v)}</button>`).join('')}</div>`;
    if (st.mercato === 'UO') campi += `<label>Linea gol</label><select id="g-linea">${lineeGol.map(l => `<option ${l === st.linea ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    if (st.mercato === 'CORNER') campi += `<label>Linea corner (totale partita)</label><select id="g-linea">${lineeCorner.map(l => `<option ${l === st.lineaCorner ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    if (st.mercato === 'MARC') {
      campi += `<label>Giocatore</label>`;
      if (st.rose) {
        const opt = (lista) => lista.map(g => `<option value="${g.id}" ${g.id === st.giocatoreId ? 'selected' : ''}>${esc(g.name)}${g.pos ? ' (' + esc(g.pos.slice(0, 3)) + ')' : ''}</option>`).join('');
        campi += `<select id="g-gioc"><option value="">Scegli…</option>
          <optgroup label="${esc(p.home)}">${opt(st.rose.home)}</optgroup>
          <optgroup label="${esc(p.away)}">${opt(st.rose.away)}</optgroup></select>`;
      } else {
        campi += `<div class="row"><input class="grow" id="g-nome" placeholder="Es. Lautaro Martinez" value="${esc(st.giocatore)}">
          <button class="btn sm" id="g-rose">Carica rose (2 richieste)</button></div>
          <p class="muted small">Scegliere dalla rosa è più sicuro: il controllo usa l'ID del giocatore invece del nome. L'autogol non vale come marcatore.</p>`;
      }
    }
    $('#modal-box').innerHTML = `
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(p.home)} – ${esc(p.away)}</h2><button class="x" id="g-chiudi">✕</button></div>
      <div class="muted small">${esc(p.league)} · ${giorno(p.kickoff)} ${ora(p.kickoff)}</div>
      <label>Tipo di giocata</label>
      <select id="g-mercato">${Object.entries(MERCATI).map(([k, m]) => `<option value="${k}" ${k === st.mercato ? 'selected' : ''}>${m.nome}</option>`).join('')}</select>
      ${campi}
      <label>Quota (facoltativa)</label><input id="g-quota" type="number" inputmode="decimal" step="0.01" min="1" value="${esc(st.quota)}">
      <button class="btn primary block" id="g-ok" style="margin-top:16px">Aggiungi alla schedina</button>`;

    $('#g-chiudi').onclick = chiudiModal;
    $('#g-mercato').onchange = (e) => { st.mercato = e.target.value; st.sel = opzioni[st.mercato]?.[0] ?? null; disegna(); };
    document.querySelectorAll('#modal-box .seg button').forEach(b => b.onclick = () => { st.sel = b.dataset.sel; disegna(); });
    const l = $('#g-linea'); if (l) l.onchange = () => { st.mercato === 'UO' ? st.linea = Number(l.value) : st.lineaCorner = Number(l.value); };
    $('#g-quota').oninput = (e) => st.quota = e.target.value;
    const n = $('#g-nome'); if (n) n.oninput = () => { st.giocatore = n.value; st.giocatoreId = null; };
    const gs = $('#g-gioc'); if (gs) gs.onchange = () => {
      const tutti = [...st.rose.home, ...st.rose.away];
      const g = tutti.find(x => String(x.id) === gs.value);
      st.giocatoreId = g?.id ?? null; st.giocatore = g?.name ?? '';
    };
    const br = $('#g-rose'); if (br) br.onclick = async () => {
      br.disabled = true; br.textContent = 'Carico…';
      try { st.rose = { home: await rosa(p.homeId), away: await rosa(p.awayId) }; }
      catch (e) { toast(e.message, true); }
      disegna();
    };
    $('#g-ok').onclick = () => {
      if (st.mercato === 'MARC' && !st.giocatore.trim()) return toast('Scegli o scrivi il giocatore', true);
      const ev = {
        fixtureId: p.id, kickoff: p.kickoff, league: p.league, home: p.home, away: p.away, homeId: p.homeId, awayId: p.awayId,
        mercato: st.mercato, sel: st.sel, quota: st.quota ? Number(st.quota) : null,
        live: MERCATI_SOLO_GOL.has(st.mercato) ? snapshotDaElenco(p) : null, esitoManuale: null,
      };
      if (st.mercato === 'UO') ev.linea = st.linea;
      if (st.mercato === 'CORNER') ev.linea = st.lineaCorner;
      if (st.mercato === 'MARC') { ev.giocatore = st.giocatore.trim(); ev.giocatoreId = st.giocatoreId; ev.sel = null; }
      S.draft.eventi.push(ev);
      chiudiModal(); toast('Aggiunto alla schedina'); renderNuova(); window.scrollTo(0, 0);
    };
  };
  $('#modal-box').onclick = null;
  disegna();
  $('#modal').classList.remove('hidden');
}

function chiudiModal() {
  const box = $('#modal-box');
  $('#modal').classList.add('hidden'); box.innerHTML = ''; box.onclick = null; box.onchange = null;
}
$('#modal').onclick = (e) => { if (e.target.id === 'modal') chiudiModal(); };

async function salvaSchedina() {
  const D = S.draft;
  if (!D.eventi.length) return;
  if (!(Number(D.puntata) > 0)) return toast('Inserisci la puntata', true);
  try {
    await addDoc(collection(db, 'users', S.user.uid, 'schedine'), {
      createdAtMs: Date.now(),
      puntata: Number(D.puntata),
      quotaTotale: Number(D.quotaTotale) || null,
      eventi: D.eventi,
      stato: statoSchedina({ puntata: D.puntata, quotaTotale: D.quotaTotale, eventi: D.eventi }).stato,
    });
    S.draft = { eventi: [], puntata: '', quotaTotale: '' };
    S.view = 'live'; render(); toast('Schedina salvata');
    aggiornaLive();
  } catch (e) { toast(e.message, true); }
}

/* Menu su un evento: correzione manuale dell'esito */
function menuEvento(sid, i) {
  const s = S.schedine.find(x => x.id === sid); if (!s) return;
  const ev = s.eventi[i];
  const L = ev.live;
  const gol = L?.golEventi?.length ? L.golEventi.map(g => `${g.min}' ${esc(g.name)}${g.detail === 'Own Goal' ? ' (aut.)' : g.detail === 'Penalty' ? ' (rig.)' : ''}`).join('<br>') : '';
  $('#modal-box').innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(ev.home)} – ${esc(ev.away)}</h2><button class="x" data-m="chiudi">✕</button></div>
    <div class="muted small">${esc(etichettaSelezione(ev))}${L ? ` · ${L.h}–${L.a}` : ''}${L?.hasStats ? ` · corner ${L.corners}` : ''}</div>
    ${gol ? `<h3>Gol</h3><div class="small">${gol}</div>` : ''}
    <h3>Esito</h3>
    <p class="muted small">${ev.fixtureId ? "Calcolato in automatico. Correggilo a mano se il bookmaker l'ha refertato diversamente (es. marcatore non entrato = rimborso)." : 'Questa partita non è seguita in automatico: controlla il risultato e segna tu l\'esito.'}</p>
    <div class="seg">
      <button data-m="vinto">Vinto</button><button data-m="perso">Perso</button><button data-m="nullo">Nullo</button>
    </div>
    ${ev.fixtureId
      ? `<button class="btn block" data-m="auto" style="margin-top:8px" ${ev.esitoManuale ? '' : 'disabled'}>Torna al calcolo automatico</button>`
      : `<button class="btn block" data-m="auto" style="margin-top:8px" ${ev.esitoManuale ? '' : 'disabled'}>Rimetti "da verificare"</button>`}`;
  $('#modal-box').onclick = async (e) => {
    const m = e.target.dataset.m; if (!m) return;
    if (m === 'chiudi') return chiudiModal();
    const eventi = s.eventi.map((x, j) => j === i ? { ...x, esitoManuale: m === 'auto' ? null : m } : x);
    try {
      await updateDoc(doc(db, 'users', S.user.uid, 'schedine', sid), { eventi, stato: statoSchedina({ ...s, eventi }).stato });
      chiudiModal();
      if (m === 'auto') aggiornaLive();
    } catch (err) { toast(err.message, true); }
  };
  $('#modal').classList.remove('hidden');
}

function menuSchedina(sid) {
  $('#modal-box').onclick = null;
  $('#modal-box').innerHTML = `
    <h2 style="margin-top:0">Schedina</h2>
    <button class="btn block" id="m-copia">Duplica in una nuova schedina</button>
    <button class="btn block danger" id="m-elimina" style="margin-top:8px">Elimina</button>
    <button class="btn block" id="m-chiudi" style="margin-top:8px">Annulla</button>`;
  $('#m-chiudi').onclick = chiudiModal;
  $('#m-copia').onclick = () => {
    const s = S.schedine.find(x => x.id === sid);
    S.draft = { eventi: s.eventi.map(e => ({ ...e, live: null, esitoManuale: null })), puntata: String(s.puntata), quotaTotale: s.quotaTotale ? String(s.quotaTotale) : '' };
    chiudiModal(); S.view = 'nuova'; render();
  };
  $('#m-elimina').onclick = async () => {
    if (!confirm('Eliminare questa schedina? Non si può annullare.')) return;
    try { await deleteDoc(doc(db, 'users', S.user.uid, 'schedine', sid)); chiudiModal(); toast('Schedina eliminata'); }
    catch (e) { toast(e.message, true); }
  };
  $('#modal').classList.remove('hidden');
}

/* ---------- vista STORICO ---------- */
function renderStorico() {
  const ora0 = new Date();
  const filtri = {
    tutto: () => true,
    '30gg': (s) => s.createdAtMs > Date.now() - 30 * 86400e3,
    mese: (s) => { const d = new Date(s.createdAtMs); return d.getMonth() === ora0.getMonth() && d.getFullYear() === ora0.getFullYear(); },
  };
  const scelte = S.schedine.filter(filtri[S.storicoFiltro]);
  const st = statistiche(scelte);
  const segno = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  const mesi = Object.entries(st.perMese).sort((a, b) => b[0].localeCompare(a[0]));
  const nomeMese = (k) => new Date(k + '-01T12:00').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  const chiuse = scelte.filter(s => statoSchedina(s).chiusa);

  $('#view-storico').innerHTML = `
    <h2>Storico e bilancio</h2>
    <div class="filtri">
      ${[['tutto', 'Sempre'], ['30gg', 'Ultimi 30 giorni'], ['mese', 'Questo mese']].map(([k, t]) => `<button data-act="filtro-storico" data-v="${k}" class="${S.storicoFiltro === k ? 'on' : ''}">${t}</button>`).join('')}
    </div>
    ${st.n ? `
    <div class="kpis">
      <div class="kpi"><div class="k">Saldo</div><div class="v ${segno(st.saldo)}">${st.saldo > 0 ? '+' : ''}${euro(st.saldo)}</div></div>
      <div class="kpi"><div class="k">Giocato</div><div class="v">${euro(st.giocato)}</div></div>
      <div class="kpi"><div class="k">Vinto</div><div class="v">${euro(st.vinto)}</div></div>
      <div class="kpi"><div class="k">Schedine</div><div class="v">${st.n}</div></div>
      <div class="kpi"><div class="k">Vincenti</div><div class="v">${st.vinte} <span class="muted small">(${num(st.percVinte, 0)}%)</span></div></div>
      <div class="kpi"><div class="k">Resa (ROI)</div><div class="v ${segno(st.roi)}">${num(st.roi, 1)}%</div></div>
    </div>

    <h3>Rendimento per tipo di giocata</h3>
    <p class="muted small">Quanti eventi di ogni tipo hai indovinato, schedina per schedina.</p>
    <table><thead><tr><th>Giocata</th><th class="n">Eventi</th><th class="n">Presi</th><th class="n">%</th></tr></thead><tbody>
      ${Object.entries(st.perMercato).sort((a, b) => b[1].giocati - a[1].giocati).map(([k, m]) => {
        const p = m.vinti / m.giocati * 100;
        return `<tr><td>${MERCATI[k]?.nome || k}<div class="bar"><i style="width:${p}%"></i></div></td><td class="n">${m.giocati}</td><td class="n">${m.vinti}</td><td class="n">${num(p, 0)}%</td></tr>`;
      }).join('')}
    </tbody></table>

    <h3>Mese per mese</h3>
    <table><thead><tr><th>Mese</th><th class="n">Schedine</th><th class="n">Giocato</th><th class="n">Saldo</th></tr></thead><tbody>
      ${mesi.map(([k, m]) => `<tr><td style="text-transform:capitalize">${nomeMese(k)}</td><td class="n">${m.n}</td><td class="n">${euro(m.giocato)}</td><td class="n ${segno(m.vinto - m.giocato)}">${euro(m.vinto - m.giocato)}</td></tr>`).join('')}
    </tbody></table>

    <h3>Schedine chiuse</h3>
    ${chiuse.map(cardSchedina).join('')}
    ` : '<div class="empty">Ancora nessuna schedina chiusa in questo periodo.</div>'}
  `;
}

/* ---------- vista IMPOSTAZIONI ---------- */
function renderImpostazioni() {
  $('#view-impostazioni').innerHTML = `
    <h2>Impostazioni</h2>
    ${S.settings.apiKey ? '' : '<p>Per seguire i risultati serve una chiave gratuita di <b>API-Football</b>: registrati su dashboard.api-football.com, poi copia la chiave da Account → My Access.</p>'}
    <label>Chiave API-Football</label>
    <input id="i-key" type="password" autocomplete="off" value="${esc(S.settings.apiKey)}" placeholder="Incolla la chiave">
    <p class="muted small">Viene salvata nel tuo account Firebase, non nel codice del sito su GitHub.</p>
    <label>Aggiornamento automatico durante le partite</label>
    <select id="i-int">${[2, 3, 5, 10, 15, 30, 0].map(m => `<option value="${m}" ${minuti() === m ? 'selected' : ''}>${m ? `Ogni ${m} minuti` : 'Solo manuale (premo io Aggiorna)'}</option>`).join('')}</select>
    <p class="muted small">Con il piano gratuito (100 richieste al giorno) ogni aggiornamento costa 1 richiesta per ogni gruppo di 20 partite in corso, e parte solo se il sito è aperto e c'è almeno una partita iniziata. Per una fascia di partite di circa 2 ore: ogni 3 minuti ≈ 38 aggiornamenti, ogni 15 minuti ≈ 8. In modalità manuale ogni pressione di "Aggiorna" costa 1 richiesta ogni 20 partite in corso.</p>
    <div class="row" style="margin-top:12px">
      <button class="btn primary grow" id="i-salva">Salva</button>
      <button class="btn grow" id="i-prova">Prova la chiave</button>
    </div>
    <div id="i-esito" class="small" style="margin-top:12px"></div>
    <h3>Account</h3>
    <p class="muted small">${esc(S.user.email || '')}</p>
    <button class="btn danger" id="i-esci">Esci</button>
  `;
  $('#i-salva').onclick = async () => {
    S.settings.apiKey = $('#i-key').value.trim();
    S.settings.intervallo = Number($('#i-int').value);
    try {
      await setDoc(doc(db, 'users', S.user.uid, 'meta', 'settings'), S.settings, { merge: true });
      avviaTimer(); toast('Impostazioni salvate');
    } catch (e) { toast(e.message, true); }
  };
  $('#i-prova').onclick = async () => {
    const out = $('#i-esito');
    S.settings.apiKey = $('#i-key').value.trim();
    out.textContent = 'Verifico…';
    try {
      const st = await api('/status', false); // /status non consuma la quota
      const piano = st.subscription?.plan || '?';
      const usate = st.requests?.current ?? '?', limite = st.requests?.limit_day ?? '?';
      if (typeof usate === 'number' && typeof limite === 'number') S.quota = { usate, limite, piano };
      mostraQuota();
      let msg = `✓ Chiave valida · piano ${esc(piano)} · richieste oggi ${usate}/${limite}.`;
      try {
        const p = await partiteDelGiorno(oggi());
        msg += `<br>✓ Partite di oggi accessibili: ${p.length}.`;
      } catch (e) {
        msg += `<br><span class="neg">✗ Le partite di oggi non sono accessibili con questo piano: ${esc(e.message)}</span>`;
      }
      out.innerHTML = msg;
    } catch (e) { out.innerHTML = `<span class="neg">✗ ${esc(e.message)}</span>`; }
  };
  $('#i-esci').onclick = () => signOut(auth);
}

/* ---------- click delegati ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act;
  if (a === 'aggiorna') aggiornaLive(true);
  else if (a === 'vai-nuova') { S.view = 'nuova'; render(); }
  else if (a === 'carica') caricaPartite(!!S.nuova.partite);
  else if (a === 'filtro-camp') { S.nuova.tutte = t.dataset.v === '1'; renderNuova(); }
  else if (a === 'scegli') { const p = S.nuova.partite.find(x => String(x.id) === t.dataset.id); if (p) apriGiocata(p); }
  else if (a === 'rimuovi') { S.draft.eventi.splice(Number(t.dataset.i), 1); renderNuova(); }
  else if (a === 'salva') salvaSchedina();
  else if (a === 'evento') menuEvento(t.dataset.s, Number(t.dataset.i));
  else if (a === 'menu-schedina') { e.stopPropagation(); menuSchedina(t.dataset.s); }
  else if (a === 'filtro-storico') { S.storicoFiltro = t.dataset.v; renderStorico(); }
});
