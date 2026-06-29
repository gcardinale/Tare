import { describe, it, expect } from "vitest";
import { parseConfig, DEFAULT_CONFIG_JSONC } from "../src/config/index.js";

const MODELS = `
  "models": {
    "opus": { "economy": "subscription_cap", "period": "weekly", "tokenCapacity": 1000000 },
    "lite": { "economy": "tiered_quota", "period": "monthly", "tokenCapacity": 2000000 },
    "pay": { "economy": "metered", "currency": "USD", "priceInPerMillion": 0.27, "priceOutPerMillion": 0.41 }
  }`;
const POLICY = `
  "policy": {
    "singlePassBelowTokens": 15000,
    "opusMinHeadroomPct": 20,
    "preferCappedOverMetered": true,
    "autoPassCostBelow": { "meteredUsd": 0.01 }
  }`;
const full = `{ ${MODELS}, ${POLICY} }`;

describe("parseConfig — config valida", () => {
  it("mappa modelli e policy sui tipi interni", () => {
    const r = parseConfig(full);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.models.map((m) => m.name)).toEqual(["opus", "lite", "pay"]);
      const opus = r.value.models[0];
      expect(opus).toMatchObject({ economy: "subscription_cap", periodTokenCapacity: 1000000 });
      const pay = r.value.models[2];
      expect(pay).toMatchObject({
        economy: "metered",
        pricePerMillionInput: 0.27,
        pricePerMillionOutput: 0.41,
      });
      expect(r.value.policy).toMatchObject({
        opusMinHeadroomPct: 20,
        autoPassCostBelow: { meteredUsd: 0.01 },
      });
    }
  });

  it("accetta commenti e trailing comma (JSONC)", () => {
    const jsonc = `{
      // commento
      "models": { "pay": { "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": 2, }, },
      "policy": { "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": false, },
    }`;
    expect(parseConfig(jsonc).ok).toBe(true);
  });

  it("autoPassCostBelow opzionale: assente → policy senza la soglia", () => {
    const cfg = `{ ${MODELS}, "policy": { "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": true } }`;
    const r = parseConfig(cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policy.autoPassCostBelow).toBeUndefined();
  });

  it("autoPassCostBelow vuoto è ammesso (meteredUsd opzionale)", () => {
    const cfg = `{ ${MODELS}, "policy": { "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": true, "autoPassCostBelow": {} } }`;
    const r = parseConfig(cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policy.autoPassCostBelow).toEqual({});
  });

  it("il template di default supera sempre il parsing", () => {
    expect(parseConfig(DEFAULT_CONFIG_JSONC).ok).toBe(true);
  });

  it("nomi modello duplicati: vince l'ultimo, una sola entry (C3, documentato)", () => {
    const cfg = `{ "models": {
      "opus": { "economy": "subscription_cap", "period": "weekly", "tokenCapacity": 1000000 },
      "opus": { "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": 2 }
    }, ${POLICY} }`;
    const r = parseConfig(cfg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.models).toHaveLength(1);
      expect(r.value.models[0]).toMatchObject({ name: "opus", economy: "metered" });
    }
  });

  it("autoPassCostBelow: null trattato come assente (B7)", () => {
    const cfg = `{ ${MODELS}, "policy": { "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": true, "autoPassCostBelow": null } }`;
    const r = parseConfig(cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policy.autoPassCostBelow).toBeUndefined();
  });
});

describe("parseConfig — routing del proxy (M4)", () => {
  const withModel = (def: string): string => `{ "models": { "x": ${def} }, ${POLICY} }`;

  it("mappa baseUrl, apiKeyEnv e upstreamModel sul modello", () => {
    const r = parseConfig(
      withModel(
        `{ "economy": "subscription_cap", "period": "weekly", "tokenCapacity": 1, "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "MY_KEY", "upstreamModel": "claude-opus-4" }`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.models[0]).toMatchObject({
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "MY_KEY",
        upstreamModel: "claude-opus-4",
      });
    }
  });

  it("campi di routing assenti → modello senza quei campi", () => {
    const r = parseConfig(
      withModel(
        `{ "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": 2 }`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const m = r.value.models[0]!;
      expect(m).not.toHaveProperty("baseUrl");
      expect(m).not.toHaveProperty("apiKeyEnv");
      expect(m).not.toHaveProperty("upstreamModel");
    }
  });

  it("baseUrl null trattato come assente", () => {
    const r = parseConfig(
      withModel(
        `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "baseUrl": null }`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.models[0]).not.toHaveProperty("baseUrl");
  });

  it("baseUrl non-URL → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": 2, "baseUrl": "non-un-url" }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("baseUrl con protocollo non http(s) → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": 2, "baseUrl": "ftp://x/y" }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("apiKeyEnv vuoto → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "apiKeyEnv": "  " }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("upstreamModel non stringa → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "upstreamModel": 5 }`,
        ),
      ).ok,
    ).toBe(false);
  });
});

describe("parseConfig — ruoli e roleRouting (M6)", () => {
  const withModel = (def: string): string => `{ "models": { "x": ${def} }, ${POLICY} }`;
  const withPolicy = (def: string): string => `{ ${MODELS}, "policy": ${def} }`;

  it("mappa roles sul modello", () => {
    const r = parseConfig(
      withModel(
        `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "roles": ["review"] }`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.models[0]).toMatchObject({ roles: ["review"] });
  });

  it("roles assente → modello senza roles (jolly)", () => {
    const r = parseConfig(
      withModel(
        `{ "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": 2 }`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.models[0]).not.toHaveProperty("roles");
  });

  it("roles non array → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "roles": "review" }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("ruolo non valido → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "roles": ["deploy"] }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("roleRouting strict/off ammessi; assente → undefined", () => {
    const strict = parseConfig(
      withPolicy(
        `{ "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": true, "roleRouting": "strict" }`,
      ),
    );
    expect(strict.ok).toBe(true);
    if (strict.ok) expect(strict.value.policy.roleRouting).toBe("strict");

    const off = parseConfig(full);
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.value.policy.roleRouting).toBeUndefined();
  });

  it("roleRouting con valore non ammesso → err", () => {
    expect(
      parseConfig(
        withPolicy(
          `{ "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": true, "roleRouting": "loose" }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("mappa modes sul modello", () => {
    const r = parseConfig(
      withModel(
        `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "modes": ["single_pass"] }`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.models[0]).toMatchObject({ modes: ["single_pass"] });
  });

  it("modes assente → modello senza modes (tutte ammesse)", () => {
    const r = parseConfig(
      withModel(
        `{ "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": 2 }`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.models[0]).not.toHaveProperty("modes");
  });

  it("modes non array → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "modes": "single_pass" }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("modes vuoto → err (bloccherebbe il modello)", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "modes": [] }`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("modalità non valida → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 1, "modes": ["turbo"] }`,
        ),
      ).ok,
    ).toBe(false);
  });
});

describe("parseConfig — errori struttura", () => {
  it("JSONC malformato → err", () => {
    expect(parseConfig("{ models: ").ok).toBe(false);
  });

  it('manca "models" → err', () => {
    expect(parseConfig(`{ ${POLICY} }`).ok).toBe(false);
  });

  it('"models" non oggetto → err', () => {
    expect(parseConfig(`{ "models": [], ${POLICY} }`).ok).toBe(false);
  });

  it("models vuoto → err", () => {
    expect(parseConfig(`{ "models": {}, ${POLICY} }`).ok).toBe(false);
  });
});

describe("parseConfig — errori modello", () => {
  const withModel = (def: string): string => `{ "models": { "x": ${def} }, ${POLICY} }`;

  it("definizione non oggetto → err", () => {
    expect(parseConfig(withModel("42")).ok).toBe(false);
  });
  it("economy sconosciuta → err", () => {
    expect(parseConfig(withModel(`{ "economy": "bitcoin" }`)).ok).toBe(false);
  });
  it("metered senza currency → err", () => {
    expect(
      parseConfig(
        withModel(`{ "economy": "metered", "priceInPerMillion": 1, "priceOutPerMillion": 2 }`),
      ).ok,
    ).toBe(false);
  });
  it("metered con prezzo non numerico → err", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "metered", "currency": "USD", "priceInPerMillion": "x", "priceOutPerMillion": 2 }`,
        ),
      ).ok,
    ).toBe(false);
  });
  it("capped con period errato → err", () => {
    expect(
      parseConfig(
        withModel(`{ "economy": "subscription_cap", "period": "daily", "tokenCapacity": 1 }`),
      ).ok,
    ).toBe(false);
  });
  it("capped con tokenCapacity <= 0 → err", () => {
    expect(
      parseConfig(
        withModel(`{ "economy": "tiered_quota", "period": "weekly", "tokenCapacity": 0 }`),
      ).ok,
    ).toBe(false);
  });
  it("metered con prezzo <= 0 → err (B3)", () => {
    expect(
      parseConfig(
        withModel(
          `{ "economy": "metered", "currency": "USD", "priceInPerMillion": 0, "priceOutPerMillion": 2 }`,
        ),
      ).ok,
    ).toBe(false);
    expect(
      parseConfig(
        withModel(
          `{ "economy": "metered", "currency": "USD", "priceInPerMillion": 1, "priceOutPerMillion": -1 }`,
        ),
      ).ok,
    ).toBe(false);
  });
});

describe("parseConfig — errori policy", () => {
  const withPolicy = (def: string): string => `{ ${MODELS}, "policy": ${def} }`;

  it("policy assente/non oggetto → err", () => {
    expect(parseConfig(`{ ${MODELS} }`).ok).toBe(false);
    expect(parseConfig(withPolicy("5")).ok).toBe(false);
  });
  it("singlePassBelowTokens non numerico → err", () => {
    expect(
      parseConfig(
        withPolicy(
          `{ "singlePassBelowTokens": "x", "opusMinHeadroomPct": 1, "preferCappedOverMetered": true }`,
        ),
      ).ok,
    ).toBe(false);
  });
  it("opusMinHeadroomPct non numerico → err", () => {
    expect(
      parseConfig(
        withPolicy(
          `{ "singlePassBelowTokens": 1, "opusMinHeadroomPct": "x", "preferCappedOverMetered": true }`,
        ),
      ).ok,
    ).toBe(false);
  });
  it("preferCappedOverMetered non booleano → err", () => {
    expect(
      parseConfig(
        withPolicy(
          `{ "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": "yes" }`,
        ),
      ).ok,
    ).toBe(false);
  });
  it("autoPassCostBelow non oggetto → err", () => {
    expect(
      parseConfig(
        withPolicy(
          `{ "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": true, "autoPassCostBelow": 3 }`,
        ),
      ).ok,
    ).toBe(false);
  });
  it("autoPassCostBelow.meteredUsd non numerico → err", () => {
    expect(
      parseConfig(
        withPolicy(
          `{ "singlePassBelowTokens": 1, "opusMinHeadroomPct": 1, "preferCappedOverMetered": true, "autoPassCostBelow": { "meteredUsd": "x" } }`,
        ),
      ).ok,
    ).toBe(false);
  });
  it("singlePassBelowTokens negativo → err (B2)", () => {
    expect(
      parseConfig(
        withPolicy(
          `{ "singlePassBelowTokens": -1, "opusMinHeadroomPct": 20, "preferCappedOverMetered": true }`,
        ),
      ).ok,
    ).toBe(false);
  });
  it("opusMinHeadroomPct fuori 0..100 → err (B2)", () => {
    const make = (pct: number): string =>
      withPolicy(
        `{ "singlePassBelowTokens": 1, "opusMinHeadroomPct": ${pct}, "preferCappedOverMetered": true }`,
      );
    expect(parseConfig(make(-1)).ok).toBe(false);
    expect(parseConfig(make(150)).ok).toBe(false);
    expect(parseConfig(make(0)).ok).toBe(true); // estremi ammessi
    expect(parseConfig(make(100)).ok).toBe(true);
  });
});
