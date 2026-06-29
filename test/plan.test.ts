import { describe, it, expect } from "vitest";
import { plan } from "../src/orchestrator/index.js";
import { emptyLedger } from "../src/ledger/index.js";
import type { Ledger, TareConfig } from "../src/types/index.js";

const config = (overPolicy: Partial<TareConfig["policy"]> = {}): TareConfig => ({
  models: [
    { name: "opus", economy: "subscription_cap", period: "weekly", periodTokenCapacity: 1_000_000 },
    { name: "lite", economy: "tiered_quota", period: "weekly", periodTokenCapacity: 2_000_000 },
    {
      name: "pay",
      economy: "metered",
      currency: "USD",
      pricePerMillionInput: 0.27,
      pricePerMillionOutput: 0.41,
    },
  ],
  policy: {
    singlePassBelowTokens: 15000,
    opusMinHeadroomPct: 20,
    preferCappedOverMetered: true,
    ...overPolicy,
  },
});

describe("plan — pipeline classify → route", () => {
  it("classifica e instrada un task, restituendo entrambi", () => {
    const r = plan({ task: "traduci questo paragrafo in inglese" }, config(), emptyLedger());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.classification.mode).toBe("single_pass");
      expect(["opus", "lite", "pay"]).toContain(r.value.decision.model);
      expect(r.value.decision.suggestion).toContain(r.value.decision.model);
    }
  });

  it("un task esplorativo grande resta agentico nella decisione", () => {
    const r = plan(
      {
        task: "esegui il debug e il refactoring del modulo across più file del codebase",
        contextTokens: 60_000,
        toolsAvailable: ["edit", "bash"],
      },
      config(),
      emptyLedger(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision.mode).toBe("agentic");
  });

  it("ledger vuoto: i modelli di config sono comunque instradabili (B1 a livello pipeline)", () => {
    // Nessun modello tracciato: senza syncLedger il capped sarebbe escluso.
    const r = plan({ task: "spiega questa funzione" }, config(), emptyLedger());
    expect(r.ok).toBe(true);
  });

  it("preserva il consumo già tracciato nel ledger", () => {
    // opus quasi esaurito → non idoneo; resta lite/pay.
    const ledger: Ledger = {
      models: {
        opus: { economy: "subscription_cap", period: "weekly", cap: 1_000_000, used: 990_000 },
      },
    };
    const r = plan({ task: "riassumi il file" }, config(), ledger);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision.model).not.toBe("opus");
  });

  it("propaga l'errore del router quando nessun modello è idoneo", () => {
    // Solo capped, soglia headroom irraggiungibile → err.
    const onlyOpus: TareConfig = {
      models: [
        {
          name: "opus",
          economy: "subscription_cap",
          period: "weekly",
          periodTokenCapacity: 1_000_000,
        },
      ],
      policy: { singlePassBelowTokens: 1, opusMinHeadroomPct: 100, preferCappedOverMetered: true },
    };
    const r = plan(
      { task: "refactor del sistema across vari file", contextTokens: 50_000 },
      onlyOpus,
      emptyLedger(),
    );
    expect(r.ok).toBe(false);
  });
});
