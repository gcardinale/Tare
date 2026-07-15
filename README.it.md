# Tare

**Il tuo abbonamento Claude e le tue API a consumo, in gara nello stesso budget — e vedi il prezzo prima di premere invio.**

<sub>🇬🇧 [Read in English](README.md)</sub>

Tare è un preflight budget-aware per agenti di coding AI. Si mette tra il tuo agente (Claude Code, o qualsiasi cosa accetti una base URL personalizzata) e i tuoi modelli, e prima che un task costoso parta ti mostra una scheda — nel terminale del tuo agente — con il prezzo stimato su ciascuna delle tue economie. Rispondi `ok`, scegli un modello più economico, o annulli. Poi parte.

Il punto che la maggior parte dei router ignora: il tuo **abbonamento Pro/Max** e le tue **API a consumo** (DeepSeek, GLM/z.ai, …) sono tipi di denaro diversi, non confrontabili per numero di token. Tare li mette in **un unico ledger normalizzato**, così un task può essere pagato dal budget che in quel momento ti costa meno — e te lo chiede prima.

```
⚖️ tare — preflight
  agentic · ~8 step · 180k–260k token · confidenza 70%

  → glm-lite     3%–5% della quota settimanale · agentic   ← scelto
  → deepseek     0.03 USD–0.05 USD · agentic
  → opus         11%–14% del cap settimanale · agentic

  rispondi:  ok  ·  ok:<modello>  ·  no
```

<sub>La scheda qui sopra è l'output reale di Tare. Appare nel terminale del tuo agente — rispondi `ok` per eseguire, `ok:deepseek` per cambiare economia, `no` per annullare a costo zero.</sub>

---

## Cosa funziona oggi

- **Proxy interceptor su loopback** che parla il formato Anthropic Messages — streaming (SSE) e non-streaming — a cui l'agente si collega via `ANTHROPIC_BASE_URL`. Nel tuo flusso non cambia altro.
- **Routing multi-provider** su tre economie insieme: il tuo **abbonamento Pro/Max** (l'OAuth di Claude Code è inoltrato così com'è — niente chiave) e le **API Anthropic-compatibili** di terze parti (DeepSeek, GLM/z.ai) dietro chiavi Bearer. Provato dal vivo end-to-end su Claude, GLM e DeepSeek.
- **Un unico ledger normalizzato** su cap di abbonamento, quota a scaglioni e spesa a consumo, aggiornato dopo ogni run dall'usage riportato dal provider.
- **Classifier locale e gratuito** — regole deterministiche e trasparenti che dimensionano il task (modalità, ruolo, fascia di token) sulla tua macchina. Nessuna chiamata di rete, nessun codice che esce, nessun costo per decidere.
- **Il cancello di preflight in-band** — quando un task non è abbastanza economico da passare in automatico, Tare risponde con la scheda invece di inoltrare, e aspetta il tuo `ok` / `ok:<modello>` / `no`. Un'approvazione per task; poi il loop agentico gira senza richiedere altro.
- **Un modello per scrivere, uno per le review** — con `roleRouting: "strict"`, review e scrittura attingono a budget separati. Limita un piano "Lite" a `single_pass` così un loop agentico non lo prosciuga.
- **Forzare un modello al volo** — `[model:nome]` nel prompt per una richiesta, oppure `tare use <nome>` / `tare auto` per il pin persistente, senza riavvii.
- **CLI**: `tare init · up · status · use · auto`.

**Limite noto:** alcuni provider (GLM/z.ai) non riportano sempre gli `input_tokens` come fa Anthropic, quindi per quei modelli l'accounting dell'input è parziale. Le stime restano fasce oneste; migliora quando migliora il reporting del provider.

## Installazione

```bash
npm install -g @gcardinale/tare

tare init                                 # scrive ~/.tare/config.jsonc + ledger
export ANTHROPIC_BASE_URL=http://127.0.0.1:3210
tare up                                   # avvia proxy + ledger + classifier
```

Punta il tuo agente a `http://127.0.0.1:3210` e lavora come sempre. I task costosi mostrano la scheda; quelli economici possono passare in silenzio.

## In cosa si distingue da un router

|                                              | Router esistenti     | **Tare**                  |
| -------------------------------------------- | -------------------- | ------------------------- |
| Sceglie il modello per tipo di richiesta      | ✅                   | ✅                        |
| Fa fallback se un provider dà errore          | ✅                   | ✅                        |
| **Predice il costo prima di eseguire**        | ❌                   | ✅                        |
| **Decide passata singola vs. agentico**       | ❌                   | ✅                        |
| **Traccia il budget su economie miste**       | statistiche parziali | ✅ un ledger normalizzato |
| **Ti chiede prima di spendere**               | ❌                   | ✅ cancello in-band       |
| Classifier locale gratuito                    | ❌                   | ✅                        |

Tare **non** è un gateway, non è un gestore di credenziali e non è un modo per usare un agente senza un account. È un preflight. Se un router sposta già le tue richieste, Tare sta un livello sopra e decide _se e come_ spendere prima che il router veda la richiesta. I due lavorano insieme.

## Perché adesso

Un agente che lavora in modo "agentico" procede passo dopo passo — legge un file, esegue un comando, ripianifica, modifica, ricontrolla — e **a ogni step rimanda tutto ciò che ha visto finora**, quindi il costo in token cresce a valanga. Un task rapido e ben definito non ha bisogno di tutto questo: una sola passata pulita fa il lavoro a una frazione del costo. Mandare un task semplice in un loop agentico completo è uno dei modi più facili di sprecare soldi, e di solito te ne accorgi dopo.

Intanto il tuo budget non è un'unica cassa — sono tre insieme:

- **Cap di abbonamento** — un piano fisso con un tetto rigido settimanale/mensile (es. un piano di classe Opus).
- **Quota a scaglioni** — un'allocazione "Lite" che rallenta o si ferma a una soglia.
- **Crediti a consumo** — paghi per token: nessun tetto, ma ogni chiamata costa soldi veri.

Un 12% di quota settimanale, uno 0,4% intaccato su un cap e tre centesimi a consumo non si confrontano per token grezzi — ti costano cose diverse. Decidere quale paga un task, mantenendo margine in ciascuno, è la contabilità che nessuno vuole fare a mano. Tare la fa, e ti mostra la risposta prima che tu ti impegni.

## Come funziona

Cinque componenti piccoli, ognuno con un solo compito:

1. **Interceptor** — un proxy su loopback a cui parla l'agente al posto del provider. Vede il task prima che parta, inoltra al modello scelto e rilegge l'usage reale.
2. **Classifier** — un giudice locale, gratuito, a regole: quanto pesa, passata singola o agentico, quanti step e token all'incirca, e il ruolo (review vs. scrittura). Gira in-process; niente esce dalla tua macchina.
3. **Estimator** — trasforma "quanto pesa" in "quanto costa" su ogni modello, sempre una **fascia con una confidenza**, mappata sull'economia di quel modello (percentuale di un cap/quota, o denaro).
4. **Ledger** — la parte che nessun altro ha: traccia quanto budget resta in ogni economia, aggiornato con quanto è costato davvero ogni run.
5. **Router + cancello** — date le fasce, il budget e le tue regole, sceglie modello + modalità e, se il task non è abbastanza economico da passare in automatico, ti mostra la scheda e aspetta.

### Onestà sulle stime

Il costo agentico è davvero difficile da predire — non puoi sapere in anticipo quanti step farà un loop — quindi Tare non finge. Ogni stima è una **fascia con una confidenza dichiarata**, mai un numero secco falsamente preciso. "Tra 28k e 52k token, confidenza 0,6" e giusta sulla fascia è più utile di "41.000 token" e sbagliata in silenzio.

## Configurazione

`tare init` scrive `~/.tare/config.jsonc`. L'essenziale:

```jsonc
// ~/.tare/config.jsonc
{
  "models": {
    // Abbonamento Pro/Max (es. Opus) via Claude Code: NIENTE apiKeyEnv — l'OAuth
    // della tua sessione è inoltrato così com'è. Qui dedicato alla SCRITTURA.
    "opus": {
      "economy": "subscription_cap",
      "period": "weekly",
      "tokenCapacity": 1000000,      // token che esauriscono il 100% del periodo
      "baseUrl": "https://api.anthropic.com",
      "roles": ["write"],
    },
    // Modello a chiave per le REVIEW; quota piccola → solo single_pass, così un
    // loop agentico non la prosciuga.
    "glm-lite": {
      "economy": "tiered_quota",
      "period": "weekly",
      "tokenCapacity": 2000000,
      "baseUrl": "https://api.z.ai/api/anthropic",
      "apiKeyEnv": "GLM_LITE_API_KEY",
      "authStyle": "bearer",          // gli endpoint di terze parti usano Bearer
      "upstreamModel": "glm-4.6",     // il codice modello del provider
      "roles": ["review"],
      "modes": ["single_pass"],
    },
    // Jolly a consumo: nessun ruolo, copre i task ambigui.
    "deepseek": {
      "economy": "metered",
      "currency": "USD",
      "priceInPerMillion": 0.27,
      "priceOutPerMillion": 0.41,
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "authStyle": "bearer",
      "upstreamModel": "deepseek-chat",
    },
  },
  "policy": {
    "singlePassBelowTokens": 15000,
    "opusMinHeadroomPct": 20,            // tieni il cap Opus sopra il 20% per la settimana
    "preferCappedOverMetered": true,
    "roleRouting": "strict",            // review→modelli-review, write→modelli-write
    "preflight": "auto",                // il cancello: "auto" | "always" | "off"
    "autoPassCostBelow": { "meteredUsd": 0.01 },
  },
}
```

**Il cancello di preflight — `policy.preflight`:**

- `"auto"` (default) — mostra la scheda solo per i task non abbastanza economici da passare in automatico.
- `"always"` — mostra la scheda per ogni task, anche economico.
- `"off"` — non chiede mai; instrada e inoltra (il preflight resta un log di una riga).

**Abbonamenti vs. chiavi.** Un modello **senza `apiKeyEnv`** fa inoltrare a Tare l'header di auth in ingresso così com'è — incluso l'OAuth che Claude Code usa per un piano **Pro/Max**. Quindi l'abbonamento è solo un modello `subscription_cap` senza chiave, in gara alla pari con le API a consumo nello stesso ledger. Tare non conserva né gestisce credenziali; le inoltra soltanto.

**Provider Anthropic-compatibili di terze parti.** Punta la `baseUrl` di un modello a DeepSeek (`https://api.deepseek.com/anthropic`) o GLM/z.ai (`https://api.z.ai/api/anthropic`), imposta `apiKeyEnv` + `authStyle: "bearer"` e `upstreamModel` col codice del provider. Tare riscrive il modello in uscita e **lo riporta al tuo in entrata**, così Claude Code è contento.

**Ruoli e modalità.** Marca i modelli con `roles` e imposta `roleRouting: "strict"` per forzare review e scrittura su budget separati. `modes: ["single_pass"]` limita un modello a quota piccola così un loop agentico non lo prosciuga.

**Forzare un modello.** `[model:nome]` nel prompt sovrascrive il routing per una richiesta; `tare use <nome>` fissa ogni richiesta fino a `tare auto`. Il proxy in esecuzione lo applica dalla prossima richiesta — nessun riavvio.

## Comandi

```bash
tare init             # scrive ~/.tare/config.jsonc (e inizializza il ledger)
tare up               # avvia il proxy su 127.0.0.1:3210 (--port per cambiarla)
tare status           # headroom residuo per modello (ed eventuale modello forzato)
tare use <modello>    # forza tutte le richieste su <modello> (senza riavvio)
tare auto             # torna al routing automatico
```

## Roadmap

Solo ciò che manca:

- **Un classifier che impara** — sostituire il giudice a regole con un piccolo modello GGUF locale (via Ollama / llama.cpp) e calibrare le fasce di token dalla tua cronologia di sessione, così le fasce si stringono coi dati predetto-vs-reale.
- **Modalità hook / MCP** accanto al proxy, per agenti che preferiscono una chiamata a un tool prima del task.
- **Budget per-progetto** e report settimanali di spesa; preset di modelli condivisibili.

La disciplina è consegnare un preflight che fa una cosa in modo completo, e guadagnarsi ogni feature successiva dall'uso reale.

## FAQ

**Non è il router che uso già?** No. I router decidono _quale modello_ e reagiscono _dopo_ che hai speso. Tare decide _se e come_ spendere, _prima_, e te lo chiede. Usa entrambi — router sotto, Tare sopra.

**Come stima il costo agentico senza sapere il numero di step?** Non esattamente, e non finge. Dà una fascia calibrata con una confidenza, e quella fascia si stringe man mano che impara dalle tue run.

**Perché il classifier gira in locale?** Uno strumento che ha come scopo farti risparmiare non può costare — o far uscire il tuo codice — ogni volta che prende una decisione.

## Contribuire

Uno strumento focalizzato, non un framework. Le PR che lo tengono piccolo, affilato e onesto sono benvenute. Le segnalazioni di uno scarto tra la stima e il costo reale (con i log) sono particolarmente preziose — sono i dati che rendono buono il classifier.

## Licenza

MIT — vedi [LICENSE](LICENSE).
