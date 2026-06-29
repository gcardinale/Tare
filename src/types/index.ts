/**
 * Tipi di dominio condivisi di Tare.
 *
 * Sono il vocabolario comune dei cinque componenti (interceptor, classifier,
 * estimator, ledger, router). La logica decisionale che li produce è pura e
 * testabile; l'I/O sta ai bordi. Vedi `ai/architecture.md` e `ai/patterns.md`.
 */

// ─── Result ────────────────────────────────────────────────────────────────

/** Esito esplicito di un'operazione: niente throw per i flussi attesi. */
export type Result<T, E = string> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ─── Classifier ──────────────────────────────────────────────────────────────

/** Modalità di esecuzione: l'asse che i router esistenti ignorano. */
export type Mode = "single_pass" | "agentic";

/** Input per la classificazione di un task. */
export interface ClassifyInput {
  /** Il prompt / task in linguaggio naturale. */
  readonly task: string;
  /** Token di contesto già presenti (file aperti, storia…). */
  readonly contextTokens?: number;
  /** Tool a disposizione dell'agente (es. "edit", "bash", "grep"). */
  readonly toolsAvailable?: readonly string[];
}

/** Risposta del classifier: quanto pesa il task. */
export interface Classification {
  readonly mode: Mode;
  /** Stima del numero di step agentici (1 per single_pass). */
  readonly expectedSteps: number;
  /** Fascia di token attesa [low, high], low <= high. */
  readonly tokenBand: readonly [number, number];
  /** Confidenza dichiarata, 0..1. */
  readonly confidence: number;
}

// ─── Economie & Ledger ─────────────────────────────────────────────────────

/** Le tre economie non comparabili per token grezzi. */
export type Economy = "subscription_cap" | "tiered_quota" | "metered";

/** Stato di budget di un modello in una delle tre economie. */
export type BudgetState =
  | {
      readonly economy: "subscription_cap";
      readonly period: "weekly" | "monthly";
      readonly cap: number;
      readonly used: number;
    }
  | {
      readonly economy: "tiered_quota";
      readonly period: "weekly" | "monthly";
      readonly cap: number;
      readonly used: number;
    }
  | {
      readonly economy: "metered";
      readonly currency: string;
      readonly spent: number;
    };

/** Consumo reale riportato da un run, per calibrare e aggiornare il ledger. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Costo monetario reale, se l'economia è metered. */
  readonly costCurrency?: number;
}

/**
 * Stato di budget di tutti i modelli noti: è il contenuto di `~/.tare/ledger.json`.
 * Mappa nome-modello → stato nella sua economia. Vedi README §4 (Ledger).
 */
export interface Ledger {
  readonly models: Readonly<Record<string, BudgetState>>;
}

// ─── Modelli ─────────────────────────────────────────────────────────────────

export type Period = "weekly" | "monthly";

/**
 * Configurazione di un modello, una per economia. È ciò che serve all'estimator
 * per trasformare i token in costo nell'unità giusta.
 *
 * Per le economie a tetto/quota, `periodTokenCapacity` è il numero di token che
 * esaurisce il 100% del periodo: è il ponte tra "token" e "% di budget". Vedi
 * `ai/decisions.md → DEC-ESTIMATE-2`.
 */
export type ModelConfig =
  | {
      readonly name: string;
      readonly economy: "subscription_cap";
      readonly period: Period;
      readonly periodTokenCapacity: number;
    }
  | {
      readonly name: string;
      readonly economy: "tiered_quota";
      readonly period: Period;
      readonly periodTokenCapacity: number;
    }
  | {
      readonly name: string;
      readonly economy: "metered";
      readonly currency: string;
      /** Prezzo per 1.000.000 di token di input. */
      readonly pricePerMillionInput: number;
      /** Prezzo per 1.000.000 di token di output. */
      readonly pricePerMillionOutput: number;
    };

// ─── Estimator ───────────────────────────────────────────────────────────────

/** Unità in cui è espressa una stima di costo. */
export type CostUnit = "pct_cap" | "pct_quota" | "currency";

/** Una stima è SEMPRE una fascia + confidenza, mai un numero secco. */
export interface CostRange {
  readonly low: number;
  readonly high: number;
  readonly unit: CostUnit;
  readonly confidence: number;
}

// ─── Router ────────────────────────────────────────────────────────────────

/** Regole editabili che l'utente controlla. */
export interface Policy {
  readonly singlePassBelowTokens: number;
  readonly opusMinHeadroomPct: number;
  readonly preferCappedOverMetered: boolean;
  readonly autoPassCostBelow?: { readonly meteredUsd?: number };
}

/** Una candidatura: modello + modalità + stima. */
export interface RouteCandidate {
  readonly model: string;
  readonly mode: Mode;
  readonly estimate: CostRange;
}

/** Decisione finale del router, pronta per la schermata preflight. */
export interface RouteDecision extends RouteCandidate {
  /** Testo sintetico per il preflight. */
  readonly suggestion: string;
  /** Alternative scartate ma valide, in ordine di preferenza. */
  readonly alternatives: readonly RouteCandidate[];
}
