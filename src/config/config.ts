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
  Mode,
  ModelConfig,
  ModelRouting,
  Period,
  Policy,
  Result,
  Role,
  TareConfig,
} from "../types/index.js";
import { err, ok } from "../types/index.js";

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isPeriod = (x: unknown): x is Period => x === "weekly" || x === "monthly";
const isRole = (x: unknown): x is Role => x === "review" || x === "write";
const isMode = (x: unknown): x is Mode => x === "single_pass" || x === "agentic";

/**
 * Estrae e valida i `roles` di un modello (routing per ruolo). Assenti/null →
 * oggetto vuoto (modello "jolly"). Ogni voce deve essere `review` o `write`.
 */
function toRoles(name: string, def: Record<string, unknown>): Result<{ roles?: readonly Role[] }> {
  if (def.roles === undefined || def.roles === null) return ok({});
  if (!Array.isArray(def.roles)) return err(`modello "${name}": "roles" deve essere un array`);
  const roles: Role[] = [];
  for (const x of def.roles) {
    if (!isRole(x)) {
      return err(`modello "${name}": ruolo non valido "${String(x)}" (atteso review|write)`);
    }
    roles.push(x);
  }
  return ok({ roles });
}

/**
 * Estrae e valida i `modes` consentiti su un modello. Assenti/null → oggetto vuoto
 * (tutte le modalità). Ogni voce deve essere `single_pass` o `agentic`. Un array
 * vuoto è un errore: bloccherebbe il modello per qualsiasi modalità.
 */
function toModes(name: string, def: Record<string, unknown>): Result<{ modes?: readonly Mode[] }> {
  if (def.modes === undefined || def.modes === null) return ok({});
  if (!Array.isArray(def.modes)) return err(`modello "${name}": "modes" deve essere un array`);
  if (def.modes.length === 0) {
    return err(`modello "${name}": "modes" vuoto bloccherebbe il modello (ometti il campo)`);
  }
  const modes: Mode[] = [];
  for (const x of def.modes) {
    if (!isMode(x)) {
      return err(
        `modello "${name}": modalità non valida "${String(x)}" (atteso single_pass|agentic)`,
      );
    }
    modes.push(x);
  }
  return ok({ modes });
}

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
  const out: {
    baseUrl?: string;
    apiKeyEnv?: string;
    upstreamModel?: string;
    authStyle?: "x-api-key" | "bearer";
  } = {};
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
  if (def.authStyle !== undefined && def.authStyle !== null) {
    if (def.authStyle !== "x-api-key" && def.authStyle !== "bearer") {
      return err(`modello "${name}": "authStyle" deve essere "x-api-key" o "bearer"`);
    }
    out.authStyle = def.authStyle;
  }
  return ok(out);
}

/** Normalizza una definizione di modello in un `ModelConfig` (col nome iniettato). */
function toModel(name: string, def: unknown): Result<ModelConfig> {
  if (!isPlainObject(def)) return err(`modello "${name}": definizione non valida`);

  const routing = toRouting(name, def);
  if (!routing.ok) return routing;
  const rolesR = toRoles(name, def);
  if (!rolesR.ok) return rolesR;
  const modesR = toModes(name, def);
  if (!modesR.ok) return modesR;
  const r = { ...routing.value, ...rolesR.value, ...modesR.value };

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

  const base: {
    singlePassBelowTokens: number;
    opusMinHeadroomPct: number;
    preferCappedOverMetered: boolean;
    roleRouting?: "strict" | "off";
    autoPassCostBelow?: { meteredUsd?: number };
  } = {
    singlePassBelowTokens: x.singlePassBelowTokens,
    opusMinHeadroomPct: x.opusMinHeadroomPct,
    preferCappedOverMetered: x.preferCappedOverMetered,
  };

  // `roleRouting` opzionale: assente/null = "off" (i ruoli vengono ignorati).
  if (x.roleRouting !== undefined && x.roleRouting !== null) {
    if (x.roleRouting !== "strict" && x.roleRouting !== "off") {
      return err(`"policy.roleRouting" deve essere "strict" o "off"`);
    }
    base.roleRouting = x.roleRouting;
  }

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
  // Campi opzionali per modello:
  //   baseUrl       endpoint upstream (assente → default Anthropic)
  //   apiKeyEnv     NOME della env var con la chiave (MAI la chiave qui dentro).
  //                 ASSENTE = si inoltra l'auth in ingresso: è il caso degli
  //                 ABBONAMENTI Pro/Max usati via Claude Code (l'OAuth della tua
  //                 sessione passa così com'è). Mettilo solo per le API a chiave.
  //   upstreamModel id del modello da mandare al provider (assente → quello della richiesta)
  //   authStyle     "x-api-key" (default) o "bearer": come inviare la chiave. Gli endpoint
  //                 Anthropic-compatible di terze parti (DeepSeek/z.ai) vogliono "bearer".
  //   roles         ["review"] e/o ["write"]: con policy.roleRouting "strict" dedica
  //                 il modello a quel tipo di task. Assente = jolly (qualsiasi ruolo).
  //   modes         ["single_pass"] e/o ["agentic"]: modalità consentite. Assente =
  //                 tutte. Es. una quota piccola limitata a single_pass (mai loop).
  "models": {
    // Abbonamento Pro/Max (es. Opus) usato via Claude Code: NIENTE apiKeyEnv.
    // Qui dedicato alla SCRITTURA del codice.
    "opus": {
      "economy": "subscription_cap",
      "period": "weekly",
      "tokenCapacity": 1000000, // token che esauriscono il 100% del periodo
      "baseUrl": "https://api.anthropic.com",
      "roles": ["write"]
    },
    // Modello a chiave (es. "Lite") dedicato alle REVIEW; quota piccola → SOLO
    // single_pass, mai loop agentici che la esaurirebbero.
    "lite": {
      "economy": "tiered_quota",
      "period": "weekly",
      "tokenCapacity": 2000000,
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "LITE_API_KEY",
      "roles": ["review"],
      "modes": ["single_pass"]
    },
    // Jolly a consumo: nessun ruolo, copre i task ambigui.
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
    // "strict" forza review→modelli-review e write→modelli-write (jolly come ripiego).
    // "off" (o assente) ignora i ruoli.
    "roleRouting": "strict",
    "autoPassCostBelow": { "meteredUsd": 0.01 }
  }
}
`;
