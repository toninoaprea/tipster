# Schedine live

Sito personale per seguire le schedine di calcio in tempo reale: inserisci le giocate, il sito controlla i risultati mentre le partite sono in corso e tiene lo storico con il bilancio.

**Giocate supportate:** 1X2, doppia chance, Under/Over gol, Goal/No Goal, Under/Over corner, marcatore.
Ogni esito si può correggere a mano toccando l'evento (vinto / perso / nullo).

## File

| File | Cosa contiene |
|---|---|
| `index.html` | Struttura della pagina |
| `style.css` | Grafica (tema scuro, pensato per il telefono) |
| `app.js` | Login, salvataggio su Firebase, chiamate ad API-Football, le quattro schermate |
| `logic.js` | Le regole di valutazione delle giocate (si può testare a parte) |
| `sisal.js` | Lettura dello screenshot Sisal e abbinamento con le partite |
| `firebase-config.js` | **Da compilare** con i dati del tuo progetto Firebase |
| `firestore.rules` | Regole di sicurezza da incollare in Firestore |

## Configurazione (una volta sola)

### 1. Firebase
1. Su console.firebase.google.com crea un progetto (o usane uno esistente).
2. **Authentication** → Metodo di accesso → attiva **Google**.
3. **Authentication** → Impostazioni → Domini autorizzati → aggiungi `toninoaprea.github.io`.
4. **Firestore Database** → Crea database (modalità produzione).
5. **Firestore** → scheda Regole → incolla il contenuto di `firestore.rules` → Pubblica.
6. Impostazioni progetto → Le tue app → aggiungi un'**App web** → copia l'oggetto `firebaseConfig` dentro `firebase-config.js`.

### 2. API-Football (risultati live)
1. Registrati gratis su dashboard.api-football.com.
2. Account → My Access → copia la chiave.
3. Apri il sito, vai in **Impostazioni**, incolla la chiave, premi **Prova la chiave** e poi **Salva**.
   La chiave resta nel tuo account Firebase, non finisce nel codice pubblico su GitHub.

**Importante sul piano gratuito:** 100 richieste al giorno, e API-Football limita le stagioni accessibili gratis. Il pulsante *Prova la chiave* ti dice subito se le partite di oggi sono disponibili con la tua chiave. Se non lo sono, serve il piano Pro (circa 19 $/mese, 7.500 richieste al giorno).

### 3. GitHub Pages
1. Crea un repository (es. `toninoaprea/schedine`) e carica tutti i file nella radice.
2. Settings → Pages → Branch `main`, cartella `/ (root)` → Save.
3. Il sito sarà su `https://toninoaprea.github.io/schedine/`.

## Import dallo screenshot Sisal
Nella schermata **Nuova** tocca *Carica lo screenshot Sisal* (o incollalo con Ctrl+V da PC).
1. Il testo viene letto **sul tuo dispositivo** con Tesseract.js (gratis, nessuna chiave; la prima volta scarica circa 10 MB).
2. Per ogni evento il sito legge squadre, orario, giocata e quota, più puntata e quota totale.
3. Cerca la partita tra quelle del giorno su API-Football (1 richiesta per giorno) confrontando nomi e orario: gestisce nomi italiani (Amburgo → Hamburger SV), squadre femminili ("Femm") ed errori di lettura.
4. Ti mostra un riepilogo: ✓ abbinata, ? da controllare, ✕ non trovata (saltata). Puoi cambiare partita, giocata, linea e quota prima di confermare.

Funziona con lo screenshot "Il Mio Tip" condiviso da Sisal. Mercati riconosciuti in automatico: Under/Over gol, 1X2, doppia chance, Goal/No Goal, Under/Over corner, marcatore; se un mercato non viene riconosciuto lo scegli tu nel riepilogo.
La quota totale di Sisal (che include l'eventuale bonus multipla) viene usata solo se importi tutti gli eventi.

## Come risparmia le richieste API
- Le partite di un giorno si caricano con **1 richiesta** e restano in memoria 6 ore.
- Le rose per il marcatore costano 2 richieste e restano in memoria 7 giorni.
- Durante le partite, ogni aggiornamento costa **1 richiesta ogni 20 partite in corso** e parte solo se il sito è aperto e almeno una partita è iniziata.
- Partite finite, eventi corretti a mano e schedine già perse non vengono più richiesti.
- Con aggiornamento ogni 3 minuti, una partita seguita dall'inizio alla fine costa circa 35 richieste. Puoi cambiare l'intervallo in Impostazioni.

## Regole di calcolo
- Tutti gli esiti si riferiscono ai **90 minuti più recupero**: supplementari e rigori non contano.
- **Over** si dà vinto (e **Under** perso) appena la linea viene superata; **Goal** appena segnano entrambe.
- **Marcatore**: valgono i gol nei 90', anche su rigore; l'autogol non conta. Se il giocatore non entra in campo il bookmaker di solito rimborsa: segna l'evento come *nullo*.
- **Corner**: totale della partita dalle statistiche di API-Football.
- Gli eventi nulli vengono tolti dal calcolo della quota.
- Partite rinviate o sospese vanno in stato *Verifica*: decidi tu l'esito.
