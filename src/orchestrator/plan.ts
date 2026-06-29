/**
 * Orchestrator — la pipeline PURA del nucleo (ORC-01).
 *
 * Mette in fila i quattro componenti puri in un'unica chiamata: dal task grezzo
 * alla decisione di instradamento. È il cuore che il preflight di M4 riuserà;
 * resta puro (niente I/O), così è interamente testabile e deterministico.
 *
 *   classify → syncLedger → route
 *
 * `syncLedger` allinea il budget ai modelli di config PRIMA di instradare, così
 * un modello appena aggiunto è subito considerato (a budget pieno) invece di
 * essere escluso perché assente dal ledger (audit B1/B4).
 */

import type { ClassifyInput, Ledger, Plan, Result, TareConfig } from "../types/index.js";
import { ok } from "../types/index.js";
import { classify } from "../classifier/index.js";
import { syncLedger } from "../ledger/index.js";
import { route } from "../router/index.js";

/**
 * Pianifica l'esecuzione di un task: lo classifica e lo instrada secondo config
 * e budget. Pura. `Result.err` se il router non trova un modello idoneo.
 *
 * Nota: il ledger sincronizzato NON viene persistito qui (sync in memoria solo
 * per l'instradamento); la persistenza è del chiamante/bordo.
 */
export function plan(input: ClassifyInput, config: TareConfig, ledger: Ledger): Result<Plan> {
  const classification = classify(input);
  const synced = syncLedger(ledger, config.models);
  const decision = route(classification, config.models, synced, config.policy);
  if (!decision.ok) return decision;
  return ok({ classification, decision: decision.value });
}
