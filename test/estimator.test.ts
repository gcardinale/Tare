import { describe, it, expect } from "vitest";
import { estimate, estimateAll } from "../src/estimator/index.js";
import type { Classification, ModelConfig } from "../src/types/index.js";

// Classificazioni costruite a mano: l'estimator è testato in isolamento dal classifier.
const singlePass = (band: [number, number], confidence = 0.6): Classification => ({
  mode: "single_pass",
  expectedSteps: 1,
  tokenBand: band,
  confidence,
  role: "unknown",
});

const agentic = (band: [number, number], confidence = 0.6): Classification => ({
  mode: "agentic",
  expectedSteps: 7,
  tokenBand: band,
  confidence,
  role: "unknown",
});

const capped: ModelConfig = {
  name: "opus",
  economy: "subscription_cap",
  period: "weekly",
  periodTokenCapacity: 1_000_000,
};
const tiered: ModelConfig = {
  name: "glm-lite",
  economy: "tiered_quota",
  period: "weekly",
  periodTokenCapacity: 2_000_000,
};
const metered: ModelConfig = {
  name: "deepseek",
  economy: "metered",
  currency: "USD",
  pricePerMillionInput: 0.27,
  pricePerMillionOutput: 0.41,
};

describe("estimate — invarianti", () => {
  it("low <= high e confidenza in 0..1 per ogni economia", () => {
    for (const model of [capped, tiered, metered]) {
      const r = estimate(agentic([20000, 50000]), model);
      expect(r.low).toBeLessThanOrEqual(r.high);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("non promette mai certezza assoluta (<= 0.85)", () => {
    const r = estimate(singlePass([1000, 2000], 0.99), metered);
    expect(r.confidence).toBeLessThanOrEqual(0.85);
  });
});

describe("estimate — unità per economia", () => {
  it("subscription_cap → pct_cap", () => {
    expect(estimate(singlePass([1000, 2000]), capped).unit).toBe("pct_cap");
  });
  it("tiered_quota → pct_quota", () => {
    expect(estimate(singlePass([1000, 2000]), tiered).unit).toBe("pct_quota");
  });
  it("metered → currency", () => {
    expect(estimate(singlePass([1000, 2000]), metered).unit).toBe("currency");
  });
});

describe("estimate — percentuale capped/tiered (numeri noti)", () => {
  it("band [100k,200k] su cap 1M → [10%, 20%]", () => {
    const r = estimate(agentic([100_000, 200_000]), capped);
    expect(r.low).toBe(10);
    expect(r.high).toBe(20);
  });

  it("stessa band su quota 2M → metà percentuale", () => {
    const r = estimate(agentic([100_000, 200_000]), tiered);
    expect(r.low).toBe(5);
    expect(r.high).toBe(10);
  });

  it("capacità non configurata (<=0) → fascia 0 e confidenza 0", () => {
    const broken: ModelConfig = { ...capped, periodTokenCapacity: 0 };
    const r = estimate(agentic([100_000, 200_000]), broken);
    expect(r).toMatchObject({ low: 0, high: 0, confidence: 0, unit: "pct_cap" });
  });
});

describe("estimate — costo metered (numeri noti)", () => {
  it("1M token single_pass (35% output) con prezzi 0.27/0.41 → $0.319", () => {
    // input 650k * 0.27/1e6 + output 350k * 0.41/1e6 = 0.1755 + 0.1435 = 0.319
    const r = estimate(singlePass([1_000_000, 1_000_000]), metered);
    expect(r.low).toBeCloseTo(0.319, 4);
    expect(r.high).toBeCloseTo(0.319, 4);
  });

  it("il costo cresce con la dimensione della band", () => {
    const r = estimate(agentic([1_000_000, 2_000_000]), metered);
    expect(r.high).toBeGreaterThan(r.low);
  });

  it("prezzi più alti → costo più alto", () => {
    const cheap = estimate(agentic([1_000_000, 1_000_000]), metered);
    const pricey = estimate(agentic([1_000_000, 1_000_000]), {
      ...metered,
      pricePerMillionInput: 3,
      pricePerMillionOutput: 15,
    });
    expect(pricey.low).toBeGreaterThan(cheap.low);
  });
});

describe("estimate — confidenza per modalità", () => {
  it("l'agentico è meno confidente del single_pass a parità di input classifier", () => {
    const conf = 0.7;
    const sp = estimate(singlePass([10_000, 20_000], conf), metered);
    const ag = estimate(agentic([10_000, 20_000], conf), metered);
    expect(ag.confidence).toBeLessThan(sp.confidence);
  });
});

describe("estimateAll — multi-modello", () => {
  it("ritorna una stima per ogni modello candidato", () => {
    const all = estimateAll(agentic([40_000, 60_000]), [capped, tiered, metered]);
    expect(Object.keys(all).sort()).toEqual(["deepseek", "glm-lite", "opus"]);
    expect(all.opus?.unit).toBe("pct_cap");
    expect(all["glm-lite"]?.unit).toBe("pct_quota");
    expect(all.deepseek?.unit).toBe("currency");
  });

  it("lista vuota → mappa vuota", () => {
    expect(estimateAll(agentic([1000, 2000]), [])).toEqual({});
  });
});
