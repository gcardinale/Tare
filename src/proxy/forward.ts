/**
 * Proxy — logica PURA di inoltro (PROXY-02). Nessun I/O.
 *
 * Date la decisione di `plan()` e la richiesta in ingresso, questi helper
 * calcolano TUTTO ciò che serve al bordo (`server.io.ts`) per inoltrare al
 * modello scelto e per registrare il consumo reale:
 *  - dove inoltrare (`resolveUpstreamBase`);
 *  - quale chiave usare (`resolveApiKey`: nome env → valore, mai in chiaro nel config);
 *  - quali header e quale body mandare upstream (`buildForwardHeaders`, `withUpstreamModel`);
 *  - quanti token ha consumato la risposta e quanto è costata (`extractUsageTokens`, `toUsage`).
 *
 * Pure e deterministiche: l'ambiente (`env`) e gli header arrivano come argomenti,
 * così sono interamente testabili senza toccare `process.env` né la rete.
 */

import type { ModelConfig, Plan, Result, Usage } from "../types/index.js";
import { err, ok } from "../types/index.js";

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** `true` se la richiesta chiede streaming SSE (non gestito nell'MVP: passthrough). */
export function isStreamingRequest(body: unknown): boolean {
  return isPlainObject(body) && body.stream === true;
}

/**
 * Override esplicito del modello dal prompt: `[model:nome]`. Pura. Ritorna il nome
 * del modello (di config) o null. Permette di forzare un modello per la SINGOLA
 * richiesta senza riavviare nulla; ha priorità sul routing automatico e sul pin.
 */
export function parseForcedModel(task: string): string | null {
  const m = /\[\s*model\s*:\s*([A-Za-z0-9._-]+)\s*\]/i.exec(task);
  return m ? m[1]! : null;
}

/** Base URL upstream del modello scelto, o il fallback se il modello non la specifica. */
export function resolveUpstreamBase(model: ModelConfig, fallbackBaseUrl: string): string {
  return model.baseUrl ?? fallbackBaseUrl;
}

/**
 * Compone l'URL upstream APPENDENDO il path della richiesta a quello del baseUrl.
 * Pura. Necessario perché un baseUrl con prefisso di path (es. `.../api/anthropic`)
 * con `new URL("/v1/messages", base)` perderebbe il prefisso (un path assoluto lo
 * sostituisce). Qui invece si concatena: `.../api/anthropic` + `/v1/messages`.
 * Preserva la query della richiesta.
 */
export function joinUpstreamUrl(baseUrl: string, reqUrl: string): string {
  const base = new URL(baseUrl);
  const incoming = new URL(reqUrl, "http://placeholder.invalid");
  const basePath = base.pathname.replace(/\/+$/, ""); // via le slash finali del prefisso
  base.pathname = basePath + incoming.pathname;
  base.search = incoming.search;
  return base.toString();
}

/**
 * Risolve la chiave API del modello dalla env var nominata in `apiKeyEnv`.
 *  - `apiKeyEnv` assente → `ok(null)`: si inoltra l'header di auth in ingresso.
 *  - `apiKeyEnv` presente ma env var mancante/vuota → `err` (config promette una
 *    chiave che non esiste: meglio fermarsi che inoltrare senza credenziali).
 */
export function resolveApiKey(
  model: ModelConfig,
  env: Record<string, string | undefined>,
): Result<string | null> {
  if (model.apiKeyEnv === undefined) return ok(null);
  const value = env[model.apiKeyEnv];
  if (value === undefined || value.trim() === "") {
    return err(
      `env var "${model.apiKeyEnv}" non impostata (richiesta dal modello "${model.name}")`,
    );
  }
  return ok(value);
}

/** Header che non vanno reinoltrati: hop-by-hop o ricalcolati da fetch. */
const DROP_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "accept-encoding",
]);

/**
 * Costruisce gli header per la chiamata upstream a partire da quelli in ingresso.
 * Pura. Rimuove gli header hop-by-hop e gestisce l'auth: se `apiKey` è fornita la
 * imposta secondo `authStyle` (`x-api-key` di default, stile Anthropic; oppure
 * `Authorization: Bearer` per gli endpoint di terze parti) rimuovendo l'altro header
 * di auth in ingresso; se `apiKey` è null lascia passare gli header di auth originali.
 * NON forza `content-type`: lo fa il percorso routed dove il body è riserializzato
 * in JSON (il passthrough preserva il content-type originale, R3).
 */
export function buildForwardHeaders(
  incoming: Record<string, string | string[] | undefined>,
  apiKey: string | null,
  authStyle: "x-api-key" | "bearer" = "x-api-key",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (DROP_HEADERS.has(key) || v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (apiKey !== null) {
    if (authStyle === "bearer") {
      out["authorization"] = `Bearer ${apiKey}`;
      delete out["x-api-key"];
    } else {
      out["x-api-key"] = apiKey;
      delete out["authorization"];
    }
  }
  return out;
}

/**
 * Body da inoltrare: il body originale con il campo `model` sostituito da
 * `upstreamModel`, se il modello scelto ne specifica uno. Pura (shallow clone).
 */
export function withUpstreamModel(body: unknown, model: ModelConfig): Record<string, unknown> {
  const base = isPlainObject(body) ? { ...body } : {};
  if (model.upstreamModel !== undefined) base.model = model.upstreamModel;
  return base;
}

/**
 * Rimuove i blocchi `thinking`/`redacted_thinking` dalla cronologia dei messaggi.
 * Pura. Necessario col multi-provider: un blocco di reasoning prodotto da un
 * provider ha una firma valida solo per quel provider; reinoltrarlo a un altro
 * (es. cronologia GLM → richiesta a Claude) fa fallire la validazione della firma.
 * Sono contesto opzionale dei turni passati: ometterli è sicuro e sblocca lo switch.
 */
export function stripThinkingBlocks(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return body;
  const messages = body.messages.map((msg) => {
    if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter(
      (b) => !(isPlainObject(b) && (b.type === "thinking" || b.type === "redacted_thinking")),
    );
    return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
  });
  return { ...body, messages };
}

/**
 * Estrae i token consumati dall'`usage` della risposta del provider. `null` se
 * la risposta non riporta usage (es. errore upstream): in tal caso il bordo non
 * aggiorna il ledger. Campi assenti contano 0 (Anthropic riporta i due campi).
 */
export function extractUsageTokens(
  responseJson: unknown,
): { readonly inputTokens: number; readonly outputTokens: number } | null {
  if (!isPlainObject(responseJson) || !isPlainObject(responseJson.usage)) return null;
  const u = responseJson.usage;
  const inputTokens = isFiniteNumber(u.input_tokens) ? u.input_tokens : 0;
  const outputTokens = isFiniteNumber(u.output_tokens) ? u.output_tokens : 0;
  return { inputTokens, outputTokens };
}

/**
 * Estrae i token consumati da uno stream SSE Anthropic (testo accumulato). Pura.
 * `input_tokens` viene dall'evento `message_start` (`message.usage`); gli
 * `output_tokens` sono cumulativi negli eventi `message_delta` → vince l'ultimo.
 * Le righe `data:` non-JSON (ping, `[DONE]`) sono ignorate. `null` se nessun
 * usage compare (es. stream di errore non strutturato): niente da registrare.
 */
export function extractSseUsage(
  sse: string,
): { readonly inputTokens: number; readonly outputTokens: number } | null {
  let input: number | null = null;
  let output: number | null = null;
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isPlainObject(json)) continue;
    if (
      json.type === "message_start" &&
      isPlainObject(json.message) &&
      isPlainObject(json.message.usage)
    ) {
      const u = json.message.usage;
      if (isFiniteNumber(u.input_tokens)) input = u.input_tokens;
      if (isFiniteNumber(u.output_tokens)) output = u.output_tokens;
    } else if (json.type === "message_delta" && isPlainObject(json.usage)) {
      const u = json.usage;
      if (isFiniteNumber(u.output_tokens)) output = u.output_tokens;
    }
  }
  if (input === null && output === null) return null;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

/**
 * Costruisce lo `Usage` per `recordActual`. Per i modelli metered calcola il
 * `costCurrency` dai prezzi del modello (la risposta dà i token, non il costo);
 * per capped/tiered bastano i token, che il ledger somma a `used`.
 */
export function toUsage(
  model: ModelConfig,
  tokens: { readonly inputTokens: number; readonly outputTokens: number },
): Usage {
  if (model.economy === "metered") {
    const costCurrency =
      (tokens.inputTokens / 1_000_000) * model.pricePerMillionInput +
      (tokens.outputTokens / 1_000_000) * model.pricePerMillionOutput;
    return { ...tokens, costCurrency };
  }
  return tokens;
}

/**
 * Trasparenza del model id: rimette nel JSON di risposta il `model` che il CLIENT
 * aveva chiesto, al posto di quello del provider upstream. Senza questo, Claude
 * Code vede un model id diverso da quello richiesto e considera il modello "non
 * accessibile". Pura. `clientModel` assente/vuoto o risposta senza `model` → invariata.
 */
export function rewriteResponseModel(json: unknown, clientModel: string | undefined): unknown {
  if (typeof clientModel !== "string" || clientModel === "" || !isPlainObject(json)) return json;
  if (typeof json.model !== "string") return json;
  return { ...json, model: clientModel };
}

/**
 * Come sopra ma per UNA riga SSE `data:`: riscrive `message.model` (evento
 * `message_start`) e l'eventuale `model` di primo livello col model del client.
 * Le righe non-data o non-JSON restano intatte. Pura. Preserva il newline finale.
 */
export function rewriteSseModelLine(line: string, clientModel: string | undefined): string {
  if (typeof clientModel !== "string" || clientModel === "") return line;
  if (!line.startsWith("data:")) return line;
  const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  const payload = line.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return line;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return line;
  }
  if (!isPlainObject(json)) return line;
  let changed = false;
  const out: Record<string, unknown> = { ...json };
  if (isPlainObject(json.message) && typeof json.message.model === "string") {
    out.message = { ...json.message, model: clientModel };
    changed = true;
  }
  if (typeof json.model === "string") {
    out.model = clientModel;
    changed = true;
  }
  if (!changed) return line;
  return `data: ${JSON.stringify(out)}${newline}`;
}

/** Riga di preflight da mostrare/loggare prima di inoltrare. Pura. */
export function formatPreflight(plan: Plan): string {
  const { decision } = plan;
  const tag = decision.autoPass ? " [auto-pass]" : "";
  const alts =
    decision.alternatives.length > 0
      ? ` · alternative: ${decision.alternatives.map((a) => `${a.model}/${a.mode}`).join(", ")}`
      : "";
  return `[tare]${tag} ${decision.suggestion}${alts}`;
}
