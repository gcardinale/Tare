/**
 * Router — logica PURA (RTR-01..06). Il pezzo che "fa la chiamata".
 *
 * Date una classificazione, i modelli candidati, lo stato del budget (Ledger) e
 * le regole dell'utente (Policy), decide MODALITÀ effettiva + MODELLO e produce
 * un `RouteDecision` pronto per il preflight. È l'orchestratore puro del nucleo:
 * niente I/O, niente rete. Si appoggia all'estimator per le stime per-modello.
 *
 * Le due decisioni (vedi README §"Le due decisioni"):
 *  - DEC-ROUTER-1 (modalità): `singlePassBelowTokens` è la leva del router. Se la
 *    banda di token è sotto soglia, si forza `single_pass` anche se il classifier
 *    aveva detto agentico: i task piccoli non meritano il loop. Le stime vengono
 *    ricalcolate sulla modalità EFFETTIVA, così non restano disallineate.
 *  - DEC-ROUTER-2 (budget): le economie non si confrontano per token grezzi ma per
 *    headroom residuo. Un capped è idoneo solo se resta sopra `opusMinHeadroomPct`
 *    DOPO il task; un tiered solo se non sfora; il metered non ha tetto. A parità,
 *    `preferCappedOverMetered` evita di spendere denaro se un piano a tetto ha spazio.
 */

import type {
  Classification,
  CostRange,
  Ledger,
  Mode,
  ModelConfig,
  Policy,
  Result,
  RouteCandidate,
  RouteDecision,
} from "../types/index.js";
import { err, ok } from "../types/index.js";
import { estimate } from "../estimator/index.js";
import { headroom } from "../ledger/index.js";

/** Economia di un modello, leggibile direttamente dalla sua config. */
type Economy = ModelConfig["economy"];

/** Headroom residuo (0..1) di un modello secondo il ledger. */
function headroomOf(ledger: Ledger, model: ModelConfig): number {
  const state = ledger.models[model.name];
  // Modello non ancora tracciato = nessun consumo registrato = budget pieno (1).
  // Tornare 0 lo escluderebbe per sempre (audit B1): l'unico ingresso nel ledger è
  // recordActual, che però esige il modello già presente. `syncLedger` pre-popola
  // il ledger dai modelli di config all'avvio; questo è la rete di sicurezza.
  if (state === undefined) return 1;
  return headroom(state);
}

/**
 * Un modello "ci sta"? Per capped/tiered si confronta l'headroom (in %) con la
 * stima di spesa (anch'essa in % del periodo); il metered passa sempre.
 */
function fits(economy: Economy, headroomPct: number, est: CostRange, policy: Policy): boolean {
  if (economy === "metered") return true;
  const projected = headroomPct - est.high;
  if (economy === "subscription_cap") return projected >= policy.opusMinHeadroomPct;
  return projected >= 0; // tiered_quota: basta non sforare la quota.
}

/** Un candidato con i dati che servono a idoneità e ranking. */
interface Ranked {
  readonly candidate: RouteCandidate;
  readonly economy: Economy;
  /** Headroom residuo in percentuale (0..100). */
  readonly hr: number;
}

/**
 * Ordina due candidati: ritorna <0 se `a` va prima di `b` (a è migliore).
 * Non confronta MAI scale diverse (% vs $): solo entro la stessa economia.
 *  1. tier: il non-metered batte il metered se `preferCappedOverMetered`;
 *  2. tra non-metered: più headroom residuo dopo il task = meglio;
 *  3. tra metered: $ più basso = meglio;
 *  4. economie miste senza preferenza: ordine d'ingresso (sort stabile).
 */
function compare(a: Ranked, b: Ranked, policy: Policy): number {
  const tier = (x: Ranked): number =>
    x.economy === "metered" && policy.preferCappedOverMetered ? 0 : 1;
  const dt = tier(b) - tier(a);
  if (dt !== 0) return dt;

  const aMetered = a.economy === "metered";
  const bMetered = b.economy === "metered";
  if (!aMetered && !bMetered) {
    return b.hr - b.candidate.estimate.high - (a.hr - a.candidate.estimate.high);
  }
  if (aMetered && bMetered) {
    return a.candidate.estimate.high - b.candidate.estimate.high;
  }
  return 0;
}

// Etichetta dell'unità: un % di un tetto abbonamento e un % di una quota a livelli
// pesano in modo diverso per l'utente, quindi vanno distinti nel preflight (audit B5).
const PCT_SUFFIX: Record<"pct_cap" | "pct_quota", string> = {
  pct_cap: "% cap",
  pct_quota: "% quota",
};

function describe(c: RouteCandidate, autoPass: boolean): string {
  const e = c.estimate;
  const range =
    e.unit === "currency" ? `$${e.low}–$${e.high}` : `${e.low}–${e.high}${PCT_SUFFIX[e.unit]}`;
  const tail = autoPass ? " · economico: auto-pass" : "";
  return `${c.mode} su ${c.model}: ~${range} (conf. ${e.confidence})${tail}`;
}

/**
 * Instrada un task. Funzione pura: stessa input → stessa decisione.
 * `Result.err` se non c'è nessun modello, o nessuno che rientri in budget/policy.
 */
export function route(
  classification: Classification,
  models: readonly ModelConfig[],
  ledger: Ledger,
  policy: Policy,
): Result<RouteDecision> {
  if (models.length === 0) return err("nessun modello candidato");

  // DEC-ROUTER-1: modalità effettiva dalla banda di token, poi stime coerenti.
  const mode: Mode =
    classification.tokenBand[1] < policy.singlePassBelowTokens
      ? "single_pass"
      : classification.mode;
  const effective: Classification = { ...classification, mode };

  // Costruisci le candidature idonee.
  const eligible: Ranked[] = models
    .map((model) => ({
      candidate: { model: model.name, mode, estimate: estimate(effective, model) },
      economy: model.economy,
      hr: headroomOf(ledger, model) * 100,
    }))
    .filter((x) => fits(x.economy, x.hr, x.candidate.estimate, policy));

  if (eligible.length === 0) {
    return err("nessun modello rientra nel budget e nella policy");
  }

  // Migliore in testa; sort stabile (Node 20) preserva l'ordine d'ingresso nei pari.
  eligible.sort((a, b) => compare(a, b, policy));

  const best = eligible[0]!;
  const alternatives = eligible.slice(1).map((x) => x.candidate);

  // auto-pass: solo per il metered scelto, sotto la soglia in $ (l'unica nella Policy).
  const meteredThreshold = policy.autoPassCostBelow?.meteredUsd;
  const autoPass =
    best.economy === "metered" &&
    meteredThreshold !== undefined &&
    best.candidate.estimate.high < meteredThreshold;

  return ok({
    ...best.candidate,
    suggestion: describe(best.candidate, autoPass),
    alternatives,
    autoPass,
  });
}
