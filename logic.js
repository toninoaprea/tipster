// Logica pura: nessuna dipendenza da Firebase o dal DOM (testabile con Node).

export const ATTESA = new Set(['NS', 'TBD']);
export const IN_CORSO = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
export const FINITI = new Set(['FT', 'AET', 'PEN']);
export const ANOMALI = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);

export const MERCATI = {
  '1X2':   { nome: '1X2' },
  'DC':    { nome: 'Doppia chance' },
  'UO':    { nome: 'Under/Over gol' },
  'GGNG':  { nome: 'Goal/No Goal' },
  'CORNER':{ nome: 'Under/Over corner' },
  'MARC':  { nome: 'Marcatore' },
};

export function norm(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Cognome = ultima parola significativa del nome ("L. Martínez" -> "martinez")
export function cognome(s) {
  const p = norm(s).split(' ').filter(w => w.length > 1);
  return p[p.length - 1] || norm(s);
}

/** Riduce una partita di API-Football (/fixtures?ids=...) ai dati che servono. */
export function snapshot(f) {
  const st = f.fixture.status.short;
  let h = f.goals?.home ?? 0, a = f.goals?.away ?? 0;
  // Le scommesse si riferiscono ai 90' (+ recupero): nei supplementari usa il risultato dei regolamentari
  if (['ET', 'BT', 'P', 'AET', 'PEN'].includes(st) && f.score?.fulltime?.home != null) {
    h = f.score.fulltime.home; a = f.score.fulltime.away;
  }
  const stats = f.statistics || [];
  const corners = stats.reduce((s, t) => {
    const c = (t.statistics || []).find(x => x.type === 'Corner Kicks');
    return s + (Number(c?.value) || 0);
  }, 0);
  const gol = (f.events || []).filter(e =>
    e.type === 'Goal' && e.detail !== 'Missed Penalty' && e.comments !== 'Penalty Shootout');
  const golEventi = gol.map(e => ({
    min: e.time.elapsed + (e.time.extra ? '+' + e.time.extra : ''),
    name: e.player?.name || '', teamId: e.team?.id ?? null, detail: e.detail,
  }));
  const marcatori = gol
    .filter(e => e.detail !== 'Own Goal' && e.time.elapsed <= 90)
    .map(e => ({ id: e.player?.id ?? null, name: e.player?.name || '' }));
  return {
    status: st,
    elapsed: f.fixture.status.elapsed ?? null,
    h, a,
    golTotali: { h: f.goals?.home ?? 0, a: f.goals?.away ?? 0 },
    corners, hasStats: stats.length > 0,
    marcatori, golEventi,
    finito: FINITI.has(st),
    updatedAt: Date.now(),
  };
}

function esitoRisultato(h, a) { return h > a ? '1' : h < a ? '2' : 'X'; }

/** Under/Over: l'Over si vince (e l'Under si perde) appena si supera la linea. */
function valutaUO(totale, linea, sel, finito) {
  const over = totale > linea;
  if (over) return sel === 'O' ? 'vinto' : 'perso';
  if (finito) return sel === 'U' ? 'vinto' : 'perso';
  return sel === 'U' ? 'ok' : 'ko';
}

/**
 * Esiti possibili:
 *  attesa (non iniziata) · ok (in corso, sta vincendo) · ko (in corso, sta perdendo)
 *  vinto · perso · nullo (rimborsato) · verifica (rinviata/sospesa o dato mancante)
 */
export function valuta(ev) {
  if (ev.esitoManuale) return ev.esitoManuale;
  const L = ev.live;
  if (!L || ATTESA.has(L.status)) return 'attesa';
  if (ANOMALI.has(L.status)) return 'verifica';
  const { h, a, finito } = L;
  const r = esitoRisultato(h, a);
  const fin = (ok) => finito ? (ok ? 'vinto' : 'perso') : (ok ? 'ok' : 'ko');
  switch (ev.mercato) {
    case '1X2': return fin(r === ev.sel);
    case 'DC': return fin(ev.sel.includes(r));
    case 'UO': return valutaUO(h + a, Number(ev.linea), ev.sel, finito);
    case 'GGNG': {
      const gg = h > 0 && a > 0;
      if (gg) return ev.sel === 'GG' ? 'vinto' : 'perso';
      return fin(ev.sel === 'NG');
    }
    case 'CORNER': {
      if (!L.hasStats) return finito ? 'verifica' : 'ko';
      return valutaUO(L.corners, Number(ev.linea), ev.sel, finito);
    }
    case 'MARC': {
      const c = cognome(ev.giocatore);
      const segnato = (L.marcatori || []).some(m =>
        (ev.giocatoreId && m.id === ev.giocatoreId) || (!ev.giocatoreId && cognome(m.name) === c));
      if (segnato) return 'vinto';
      return finito ? 'perso' : 'ko';
    }
  }
  return 'verifica';
}

export function etichettaSelezione(ev) {
  switch (ev.mercato) {
    case '1X2': return `Esito ${ev.sel}`;
    case 'DC': return `Doppia chance ${ev.sel}`;
    case 'UO': return `${ev.sel === 'O' ? 'Over' : 'Under'} ${ev.linea} gol`;
    case 'GGNG': return ev.sel === 'GG' ? 'Goal' : 'No Goal';
    case 'CORNER': return `${ev.sel === 'O' ? 'Over' : 'Under'} ${ev.linea} corner`;
    case 'MARC': return `Marcatore: ${ev.giocatore}`;
  }
  return '';
}

/** Stato complessivo della schedina, quota effettiva (esclusi i nulli) e vincita. */
export function statoSchedina(s) {
  const esiti = s.eventi.map(valuta);
  const puntata = Number(s.puntata) || 0;
  const validi = s.eventi.filter((_, i) => esiti[i] !== 'nullo');
  const prodotto = validi.reduce((p, e) => p * (Number(e.quota) || 1), 1);
  const haNulli = validi.length < s.eventi.length;
  // La quota totale inserita a mano (es. con bonus) vale solo se non ci sono eventi annullati
  const quota = (!haNulli && Number(s.quotaTotale)) ? Number(s.quotaTotale) : prodotto;
  const vincitaPotenziale = +(puntata * quota).toFixed(2);

  let stato;
  if (esiti.includes('perso')) stato = 'persa';
  else if (esiti.every(e => e === 'vinto' || e === 'nullo')) stato = 'vinta';
  else if (esiti.some(e => e === 'ok' || e === 'ko')) stato = 'in corso';
  else stato = 'aperta';

  const vincita = stato === 'vinta' ? vincitaPotenziale : 0;
  return { stato, esiti, quota: +quota.toFixed(2), vincitaPotenziale, vincita, chiusa: stato === 'vinta' || stato === 'persa' };
}

/** Statistiche per la pagina Storico (solo schedine chiuse). */
export function statistiche(schedine) {
  const chiuse = schedine.map(s => ({ s, r: statoSchedina(s) })).filter(x => x.r.chiusa);
  const giocato = chiuse.reduce((t, x) => t + (Number(x.s.puntata) || 0), 0);
  const vinto = chiuse.reduce((t, x) => t + x.r.vincita, 0);
  const vinte = chiuse.filter(x => x.r.stato === 'vinta').length;
  const perMercato = {};
  const perMese = {};
  for (const { s, r } of chiuse) {
    s.eventi.forEach((ev, i) => {
      const e = r.esiti[i];
      if (e !== 'vinto' && e !== 'perso') return;
      const m = perMercato[ev.mercato] ||= { giocati: 0, vinti: 0 };
      m.giocati++; if (e === 'vinto') m.vinti++;
    });
    const d = new Date(s.createdAtMs || Date.now());
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const mm = perMese[k] ||= { giocato: 0, vinto: 0, n: 0 };
    mm.giocato += Number(s.puntata) || 0; mm.vinto += r.vincita; mm.n++;
  }
  return {
    n: chiuse.length, vinte, giocato, vinto,
    saldo: vinto - giocato,
    percVinte: chiuse.length ? vinte / chiuse.length * 100 : 0,
    roi: giocato ? (vinto - giocato) / giocato * 100 : 0,
    perMercato, perMese,
  };
}
