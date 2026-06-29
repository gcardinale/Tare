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

/** Base URL upstream del modello scelto, o il fallback se il modello non la specifica. */
export function resolveUpstreamBase(model: ModelConfig, fallbackBaseUrl: string): string {
  return model.baseUrl ?? fallbackBaseUrl;
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
 * Pura. Rimuove gli header hop-by-hop e gestisce l'auth: se `apiKey` è fornita, la
 * imposta come `x-api-key` e rimuove l'`authorization` in ingresso; altrimenti
 * lascia passare gli header di auth originali. NON forza `content-type`: lo fa il
 * percorso routed dove il body è riserializzato in JSON (il passthrough preserva
 * il content-type originale, così una GET senza body non ne acquista uno, R3).
 */
export function buildForwardHeaders(
  incoming: Record<string, string | string[] | undefined>,
  apiKey: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (DROP_HEADERS.has(key) || v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (apiKey !== null) {
    out["x-api-key"] = apiKey;
    delete out["authorization"];
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
