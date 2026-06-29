/**
 * Config — parsing e validazione PURI (CFG-01..04).
 *
 * Trasforma il testo di `~/.tare/config.jsonc` (JSONC: JSON con commenti e
 * trailing comma) nei tipi interni già validati (`TareConfig` = modelli + policy).
 * Tutto qui è puro: il file lo legge il bordo (`config.io.ts`).
 *
 * Decisioni (vedi `ai/decisions.md`):
 *  - DEC-CONFIG-1: schema in camelCase, mappato quasi 1:1 sui tipi interni, così la
 *    validazione è diretta e non c'è un dizionario di alias da mantenere. (Lo
 *    snippet snake_case nel README è illustrativo: va riconciliato a fine M3.)
 *  - DEC-CONFIG-2: validazione forte al bordo, stessa filosofia del ledger
 *    (`isBudgetState`): una config malformata è un errore esplicito, mai un default
 *    silenzioso. Meglio fermarsi che instradare su numeri inventati.
 */

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

import type {
  ModelConfig,
  ModelRouting,
  Period,
  Policy,
  Result,
  TareConfig,
} from "../types/index.js";
import { err, ok } from "../types/index.js";

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isPeriod = (x: unknown): x is Period => x === "weekly" || x === "monthly";

const isHttpUrl = (x: string): boolean => {
  try {
    const u = new URL(x);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Estrae e valida i campi di routing del proxy (M4). Tutti opzionali: assenti →
 * oggetto vuoto. Validazione forte come il resto del config: una `baseUrl`
 * malformata è un errore esplicito, non un default silenzioso.
 */
function toRouting(name: string, def: Record<string, unknown>): Result<ModelRouting> {
  const out: { baseUrl?: string; apiKeyEnv?: string; upstreamModel?: string } = {};
  if (def.baseUrl !== undefined && def.baseUrl !== null) {
    if (typeof def.baseUrl !== "string" || !isHttpUrl(def.baseUrl)) {
      return err(`modello "${name}": "baseUrl" deve essere un URL http(s) valido`);
    }
    out.baseUrl = def.baseUrl;
  }
  if (def.apiKeyEnv !== undefined && def.apiKeyEnv !== null) {
    if (typeof def.apiKeyEnv !== "string" || def.apiKeyEnv.trim() === "") {
      return err(`modello "${name}": "apiKeyEnv" deve essere il nome (non vuoto) di una env var`);
    }
    out.apiKeyEnv = def.apiKeyEnv;
  }
  if (def.upstreamModel !== undefined && def.upstreamModel !== null) {
    if (typeof def.upstreamModel !== "string" || def.upstreamModel.trim() === "") {
      return err(`modello "${name}": "upstreamModel" deve essere una stringa non vuota`);
    }
    out.upstreamModel = def.upstreamModel;
  }
  return ok(out);
}

/** Normalizza una definizione di modello in un `ModelConfig` (col nome iniettato). */
function toModel(name: string, def: unknown): Result<ModelConfig> {
  if (!isPlainObject(def)) return err(`modello "${name}": definizione non valida`);

  const routing = toRouting(name, def);
  if (!routing.ok) return routing;
  const r = routing.value;

  if (def.economy === "metered") {
    if (typeof def.currency !== "string") return err(`modello "${name}": "currency" mancante`);
    if (
      !isFiniteNumber(def.priceInPerMillion) ||
      def.priceInPerMillion <= 0 ||
      !isFiniteNumber(def.priceOutPerMillion) ||
      def.priceOutPerMillion <= 0
    ) {
      return err(`modello "${name}": "priceInPerMillion"/"priceOutPerMillion" devono essere > 0`);
    }
    return ok({
      name,
      economy: "metered",
      currency: def.currency,
      pricePerMillionInput: def.priceInPerMillion,
      pricePerMillionOutput: def.priceOutPerMillion,
      ...r,
    });
  }

  if (def.economy === "subscription_cap" || def.economy === "tiered_quota") {
    if (!isPeriod(def.period)) return err(`modello "${name}": "period" deve essere weekly|monthly`);
    if (!isFiniteNumber(def.tokenCapacity) || def.tokenCapacity <= 0) {
      return err(`modello "${name}": "tokenCapacity" deve essere un numero > 0`);
    }
    return ok({
      name,
      economy: def.economy,
      period: def.period,
      periodTokenCapacity: def.tokenCapacity,
      ...r,
    });
  }

  return err(
    `modello "${name}": "economy" sconosciuta (atteso subscription_cap|tiered_quota|metered)`,
  );
}

/** Normalizza la sezione `policy`. */
function toPolicy(x: unknown): Result<Policy> {
  if (!isPlainObject(x)) return err(`"policy": oggetto mancante`);
  if (!isFiniteNumber(x.singlePassBelowTokens) || x.singlePassBelowTokens < 0) {
    return err(`"policy.singlePassBelowTokens" deve essere un numero >= 0`);
  }
  if (
    !isFiniteNumber(x.opusMinHeadroomPct) ||
    x.opusMinHeadroomPct < 0 ||
    x.opusMinHeadroomPct > 100
  ) {
    return err(`"policy.opusMinHeadroomPct" deve essere in 0..100`);
  }
  if (typeof x.preferCappedOverMetered !== "boolean") {
    return err(`"policy.preferCappedOverMetered" deve essere booleano`);
  }

  const base = {
    singlePassBelowTokens: x.singlePassBelowTokens,
    opusMinHeadroomPct: x.opusMinHeadroomPct,
    preferCappedOverMetered: x.preferCappedOverMetered,
  };

  // `null` (comune in JSON per "nessun valore") è trattato come assente (audit B7).
  if (x.autoPassCostBelow === undefined || x.autoPassCostBelow === null) return ok(base);
  if (!isPlainObject(x.autoPassCostBelow)) return err(`"policy.autoPassCostBelow" non valido`);
  const m = x.autoPassCostBelow.meteredUsd;
  if (m !== undefined && !isFiniteNumber(m))
    return err(`"policy.autoPassCostBelow.meteredUsd" non valido`);
  return ok({ ...base, autoPassCostBelow: m === undefined ? {} : { meteredUsd: m } });
}

/**
 * Parsa e valida il testo di una config. Puro. `Result.err` con messaggio
 * leggibile a ogni passo: JSONC malformato, modelli mancanti, campi non validi.
 */
export function parseConfig(text: string): Result<TareConfig> {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const e = errors[0]!;
    return err(`config JSONC non valido: ${printParseErrorCode(e.error)} a offset ${e.offset}`);
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.models)) {
    return err(`config: "models" deve essere un oggetto`);
  }
  // I nomi dei modelli devono essere UNIVOCI. Con chiavi duplicate, JSON/JSONC
  // tiene solo l'ultima (RFC 8259): la prima è persa silenziosamente. Comportamento
  // documentato e fissato da un test; la detection stretta è rimandata (audit C3).
  const entries = Object.entries(parsed.models);
  if (entries.length === 0) return err(`config: serve almeno un modello in "models"`);

  const models: ModelConfig[] = [];
  for (const [name, def] of entries) {
    const m = toModel(name, def);
    if (!m.ok) return m;
    models.push(m.value);
  }

  const policy = toPolicy(parsed.policy);
  if (!policy.ok) return policy;

  return ok({ models, policy: policy.value });
}

/**
 * Template scritto da `tare init`. Deve SEMPRE superare `parseConfig` (c'è un
 * test che lo verifica): è il primo contatto dell'utente con Tare.
 */
export const DEFAULT_CONFIG_JSONC = `{
  // Configurazione di Tare — ~/.tare/config.jsonc
  // I modelli che Tare può scegliere, ciascuno nella sua "economia".
  // Campi di routing del proxy (M4), tutti opzionali:
  //   baseUrl       endpoint upstream del modello (assente → default Anthropic)
  //   apiKeyEnv     NOME della env var con la chiave (MAI la chiave qui dentro;
  //                 assente → si inoltra l'header di auth in ingresso)
  //   upstreamModel id del modello da mandare al provider (assente → quello della richiesta)
  "models": {
    // Piano ad abbonamento con tetto periodico (es. Opus).
    "opus": {
      "economy": "subscription_cap",
      "period": "weekly",
      "tokenCapacity": 1000000, // token che esauriscono il 100% del periodo
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    // Quota a livelli (es. modello "Lite").
    "lite": {
      "economy": "tiered_quota",
      "period": "weekly",
      "tokenCapacity": 2000000,
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "LITE_API_KEY"
    },
    // Pagamento a consumo.
    "pay": {
      "economy": "metered",
      "currency": "USD",
      "priceInPerMillion": 0.27,
      "priceOutPerMillion": 0.41,
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "PAY_API_KEY"
    }
  },
  // Le regole che controlli tu.
  "policy": {
    "singlePassBelowTokens": 15000,
    "opusMinHeadroomPct": 20,
    "preferCappedOverMetered": true,
    "autoPassCostBelow": { "meteredUsd": 0.01 }
  }
}
`;
