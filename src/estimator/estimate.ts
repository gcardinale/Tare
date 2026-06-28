/**
 * Estimator — logica PURA (EST-02..05).
 *
 * Trasforma "quanto pesa" (Classification) in "quanto costa" (CostRange) per UN
 * modello, mappando i token sull'economia di quel modello: % di un cap, % di una
 * quota, o denaro a consumo.
 *
 * Due principi guida (vedi `ai/decisions.md`):
 *  - DEC-ESTIMATE-1: SEMPRE una fascia [low, high] + confidenza, mai un numero secco.
 *  - DEC-ESTIMATE-2: lo split input/output e la capacità-token del periodo sono
 *    assunzioni esplicite e calibrabili, non costanti magiche nascoste.
 */

import type { Classification, CostRange, Mode, ModelConfig } from "../types/index.js";

/**
 * Frazione di token che è OUTPUT (generazione). Nell'agentico il contesto
 * ri-inviato (input) domina, quindi l'output pesa meno; nella passata singola
 * la risposta è una quota maggiore. Assunzioni iniziali, calibrabili in v0.2.
 */
const OUTPUT_RATIO: Record<Mode, number> = {
  single_pass: 0.35,
  agentic: 0.15,
};

/** L'agentico ha un'incertezza intrinseca maggiore (numero di step ignoto). */
const MODE_CONFIDENCE_FACTOR: Record<Mode, number> = {
  single_pass: 1,
  agentic: 0.9,
};

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Stima il costo di un task su UN modello. Funzione pura e deterministica.
 * Ritorna SEMPRE una fascia + confidenza.
 */
export function estimate(c: Classification, model: ModelConfig): CostRange {
  const ratio = OUTPUT_RATIO[c.mode];
  const [bandLow, bandHigh] = c.tokenBand;
  const confidence = clamp(c.confidence * MODE_CONFIDENCE_FACTOR[c.mode], 0.2, 0.85);

  if (model.economy === "metered") {
    const cost = (total: number): number => {
      const input = total * (1 - ratio);
      const output = total * ratio;
      return (input / 1e6) * model.pricePerMillionInput + (output / 1e6) * model.pricePerMillionOutput;
    };
    return {
      low: round(cost(bandLow), 4),
      high: round(cost(bandHigh), 4),
      unit: "currency",
      confidence,
    };
  }

  // subscription_cap | tiered_quota → percentuale del periodo.
  const unit = model.economy === "subscription_cap" ? "pct_cap" : "pct_quota";
  const capacity = model.periodTokenCapacity;
  if (capacity <= 0) {
    // Capacità non configurata: nessuna stima onesta possibile.
    return { low: 0, high: 0, unit, confidence: 0 };
  }
  const pct = (total: number): number => (total / capacity) * 100;
  return {
    low: round(pct(bandLow), 2),
    high: round(pct(bandHigh), 2),
    unit,
    confidence,
  };
}

/**
 * Stima il costo dello stesso task su più modelli candidati.
 * Ritorna una mappa nome-modello → CostRange (EST-05).
 */
export function estimateAll(
  c: Classification,
  models: readonly ModelConfig[],
): Record<string, CostRange> {
  const out: Record<string, CostRange> = {};
  for (const model of models) {
    out[model.name] = estimate(c, model);
  }
  return out;
}
