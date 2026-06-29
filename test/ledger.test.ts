import { describe, it, expect } from "vitest";
import {
  applyUsage,
  emptyLedger,
  headroom,
  headrooms,
  initialBudgetState,
  recordUsage,
  syncLedger,
} from "../src/ledger/index.js";
import type { Ledger, ModelConfig, Usage } from "../src/types/index.js";

const capped = (cap: number, used: number) =>
  ({ economy: "subscription_cap", period: "weekly", cap, used }) as const;
const tiered = (cap: number, used: number) =>
  ({ economy: "tiered_quota", period: "weekly", cap, used }) as const;
const metered = (spent: number) => ({ economy: "metered", currency: "USD", spent }) as const;

const tokens = (input: number, output: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
});

describe("headroom — residuo normalizzato 0..1", () => {
  it("capped a metà cap → 0.5", () => {
    expect(headroom(capped(1_000_000, 500_000))).toBe(0.5);
  });

  it("tiered pieno (used=0) → 1", () => {
    expect(headroom(tiered(2_000_000, 0))).toBe(1);
  });

  it("budget esaurito (used=cap) → 0", () => {
    expect(headroom(capped(100, 100))).toBe(0);
  });

  it("sforamento (used>cap) → 0, mai negativo (DEC-LEDGER-2)", () => {
    expect(headroom(capped(100, 137))).toBe(0);
  });

  it("cap <= 0 → guard difensivo 0", () => {
    expect(headroom(capped(0, 0))).toBe(0);
    expect(headroom(tiered(-5, 0))).toBe(0);
  });

  it("metered non ha tetto → headroom sempre 1 (DEC-LEDGER-1)", () => {
    expect(headroom(metered(0))).toBe(1);
    expect(headroom(metered(999))).toBe(1);
  });
});

describe("headrooms — mappa per ledger", () => {
  it("ritorna il residuo di ogni modello", () => {
    const ledger: Ledger = {
      models: { opus: capped(100, 25), lite: tiered(100, 90), pay: metered(2) },
    };
    expect(headrooms(ledger)).toEqual({ opus: 0.75, lite: 0.1, pay: 1 });
  });

  it("ledger vuoto → mappa vuota", () => {
    expect(headrooms(emptyLedger())).toEqual({});
  });
});

describe("applyUsage — consumo reale (immutabile)", () => {
  it("capped/tiered: somma i token a used", () => {
    expect(applyUsage(capped(1_000_000, 100), tokens(300, 200))).toMatchObject({ used: 600 });
  });

  it("metered: somma costCurrency a spent", () => {
    const out = applyUsage(metered(2), { inputTokens: 9, outputTokens: 9, costCurrency: 0.5 });
    expect(out).toMatchObject({ economy: "metered", spent: 2.5 });
  });

  it("metered senza costCurrency: spent invariato (DEC-LEDGER-3)", () => {
    expect(applyUsage(metered(2), tokens(1000, 1000))).toMatchObject({ spent: 2 });
  });

  it("non muta lo stato originale", () => {
    const original = capped(1_000_000, 100);
    applyUsage(original, tokens(50, 50));
    expect(original.used).toBe(100);
  });
});

describe("recordUsage — aggiornamento puro del ledger", () => {
  const ledger: Ledger = {
    models: { opus: capped(1_000_000, 0), pay: metered(0) },
  };

  it("aggiorna il modello e lascia gli altri intatti", () => {
    const r = recordUsage(ledger, "opus", tokens(1000, 500));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.models.opus).toMatchObject({ used: 1500 });
      expect(r.value.models.pay).toBe(ledger.models.pay);
    }
  });

  it("non muta il ledger di partenza", () => {
    recordUsage(ledger, "opus", tokens(1000, 500));
    expect(ledger.models.opus).toMatchObject({ used: 0 });
  });

  it("modello sconosciuto → err esplicito", () => {
    const r = recordUsage(ledger, "fantasma", tokens(1, 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fantasma");
  });
});

const cappedModel: ModelConfig = {
  name: "opus",
  economy: "subscription_cap",
  period: "weekly",
  periodTokenCapacity: 1_000_000,
};
const meteredModel: ModelConfig = {
  name: "pay",
  economy: "metered",
  currency: "USD",
  pricePerMillionInput: 0.27,
  pricePerMillionOutput: 0.41,
};

describe("initialBudgetState — stato a consumo zero (B4)", () => {
  it("capped/tiered: cap = periodTokenCapacity, used 0 (stessa scala della stima)", () => {
    expect(initialBudgetState(cappedModel)).toEqual({
      economy: "subscription_cap",
      period: "weekly",
      cap: 1_000_000,
      used: 0,
    });
    // headroom pieno appena inizializzato.
    expect(headroom(initialBudgetState(cappedModel))).toBe(1);
  });

  it("metered: spent 0", () => {
    expect(initialBudgetState(meteredModel)).toEqual({
      economy: "metered",
      currency: "USD",
      spent: 0,
    });
  });
});

describe("syncLedger — allinea ledger ai modelli di config (B1/B4)", () => {
  it("aggiunge i modelli mancanti a consumo zero", () => {
    const out = syncLedger(emptyLedger(), [cappedModel, meteredModel]);
    expect(Object.keys(out.models).sort()).toEqual(["opus", "pay"]);
    expect(out.models.opus).toMatchObject({ cap: 1_000_000, used: 0 });
  });

  it("preserva gli stati esistenti (non azzera il consumo già tracciato)", () => {
    const start: Ledger = { models: { opus: capped(1_000_000, 700_000) } };
    const out = syncLedger(start, [cappedModel, meteredModel]);
    expect(out.models.opus).toMatchObject({ used: 700_000 }); // intatto
    expect(out.models.pay).toMatchObject({ spent: 0 }); // nuovo
  });
});
