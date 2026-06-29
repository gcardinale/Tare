/**
 * Ledger — logica PURA (LDG-01..05).
 *
 * Il ledger è la cosa che nessun altro router ha: tiene quanto budget resta in
 * OGNI economia. Le tre economie non sono comparabili per token grezzi, lo sono
 * per *headroom* — il residuo normalizzato 0..1. Questo modulo è puro: prende uno
 * stato di budget e ne ricava il residuo, o vi applica un consumo reale. L'I/O su
 * `~/.tare/ledger.json` sta ai bordi (`store.io.ts`).
 *
 * Decisioni (vedi `ai/decisions.md`):
 *  - DEC-LEDGER-1: `headroom` è un rapporto adimensionale (cap e used nella stessa
 *    unità → l'unità si elide). Il metered non ha tetto, quindi headroom = 1 per
 *    costruzione; il vincolo "non spendere metered se un capped ha spazio" è una
 *    *policy* del router, non un residuo.
 *  - DEC-LEDGER-2: si può sforare il budget. `used > cap` è onesto: headroom va a 0
 *    (clamp), non negativo. Niente clamp su `used` stesso: il dato resta vero.
 *  - DEC-LEDGER-3: per capped/tiered il consumo si conta in token (stessa unità di
 *    `periodTokenCapacity`); per il metered serve `costCurrency` (il denaro non si
 *    deduce dai token senza prezzo: è dominio di estimator/config).
 */

import type { BudgetState, Ledger, ModelConfig, Result, Usage } from "../types/index.js";
import { err, ok } from "../types/index.js";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Un ledger vuoto: nessun modello ancora tracciato. */
export function emptyLedger(): Ledger {
  return { models: {} };
}

/**
 * Residuo di budget di un modello, normalizzato in 0..1. Funzione pura.
 *  - capped/tiered: (cap - used) / cap, con clamp; cap <= 0 è guard difensivo → 0.
 *  - metered: nessun tetto → 1 (spazio pieno per costruzione).
 */
export function headroom(state: BudgetState): number {
  if (state.economy === "metered") return 1;
  if (state.cap <= 0) return 0;
  return clamp01((state.cap - state.used) / state.cap);
}

/** Headroom di ogni modello del ledger: nome → residuo 0..1. */
export function headrooms(ledger: Ledger): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, state] of Object.entries(ledger.models)) {
    out[name] = headroom(state);
  }
  return out;
}

/**
 * Applica un consumo reale a uno stato di budget, ritornando un NUOVO stato
 * (immutabile). Pura. Per capped/tiered somma i token a `used`; per il metered
 * somma `costCurrency` a `spent` (se assente, lo stato resta invariato: senza
 * prezzo il denaro non è deducibile).
 */
export function applyUsage(state: BudgetState, usage: Usage): BudgetState {
  if (state.economy === "metered") {
    return { ...state, spent: state.spent + (usage.costCurrency ?? 0) };
  }
  return { ...state, used: state.used + usage.inputTokens + usage.outputTokens };
}

/**
 * Aggiorna il ledger col consumo reale di un modello (LDG-05), ritornando un
 * nuovo ledger. Pura. Errore esplicito (Result) se il modello non è tracciato:
 * il ledger non inventa economie, le legge dalla config.
 */
export function recordUsage(ledger: Ledger, model: string, usage: Usage): Result<Ledger> {
  const current = ledger.models[model];
  if (current === undefined) {
    return err(`modello sconosciuto nel ledger: "${model}"`);
  }
  return ok({
    models: { ...ledger.models, [model]: applyUsage(current, usage) },
  });
}

/**
 * Stato di budget iniziale di un modello: nessun consumo ancora. Per capped/tiered
 * il tetto è `periodTokenCapacity` (così headroom e stima usano la STESSA scala in
 * token); per il metered si parte da `spent: 0`.
 */
export function initialBudgetState(model: ModelConfig): BudgetState {
  if (model.economy === "metered") {
    return { economy: "metered", currency: model.currency, spent: 0 };
  }
  return {
    economy: model.economy,
    period: model.period,
    cap: model.periodTokenCapacity,
    used: 0,
  };
}

/**
 * Allinea il ledger ai modelli di config (LDG-08): aggiunge quelli ancora assenti
 * inizializzandoli a consumo zero, preserva gli stati esistenti. Pura. È il ponte
 * config→ledger che evita lo stallo "modello nuovo mai instradabile" (audit B1/B4).
 */
export function syncLedger(ledger: Ledger, models: readonly ModelConfig[]): Ledger {
  const out: Record<string, BudgetState> = { ...ledger.models };
  for (const m of models) {
    if (out[m.name] === undefined) out[m.name] = initialBudgetState(m);
  }
  return { models: out };
}
