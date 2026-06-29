import { describe, it, expect } from "vitest";
import { route } from "../src/router/index.js";
import type { Classification, Ledger, ModelConfig, Mode, Policy } from "../src/types/index.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const opus: ModelConfig = {
  name: "opus",
  economy: "subscription_cap",
  period: "weekly",
  periodTokenCapacity: 1_000_000,
};
const lite: ModelConfig = {
  name: "lite",
  economy: "tiered_quota",
  period: "weekly",
  periodTokenCapacity: 2_000_000,
};
const pay: ModelConfig = {
  name: "pay",
  economy: "metered",
  currency: "USD",
  pricePerMillionInput: 0.27,
  pricePerMillionOutput: 0.41,
};

const cls = (
  mode: Mode,
  band: [number, number],
  confidence = 0.6,
  role: Classification["role"] = "unknown",
): Classification => ({
  mode,
  expectedSteps: mode === "agentic" ? 7 : 1,
  tokenBand: band,
  confidence,
  role,
});

// headroom: cap=100 così `used` è già una percentuale leggibile.
const ledger = (opusUsed: number, liteUsed: number): Ledger => ({
  models: {
    opus: { economy: "subscription_cap", period: "weekly", cap: 100, used: opusUsed },
    lite: { economy: "tiered_quota", period: "weekly", cap: 100, used: liteUsed },
    pay: { economy: "metered", currency: "USD", spent: 0 },
  },
});

const policy = (over: Partial<Policy> = {}): Policy => ({
  singlePassBelowTokens: 15000,
  opusMinHeadroomPct: 20,
  preferCappedOverMetered: true,
  ...over,
});

// ─── Modalità effettiva (DEC-ROUTER-1) ──────────────────────────────────────

describe("route — modalità effettiva", () => {
  it("forza single_pass se la banda di token è sotto soglia, anche da agentico", () => {
    const r = route(cls("agentic", [1000, 9000]), [opus], ledger(0, 0), policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mode).toBe("single_pass");
  });

  it("mantiene agentico se la banda supera la soglia", () => {
    const r = route(cls("agentic", [1000, 50_000]), [opus], ledger(0, 0), policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mode).toBe("agentic");
  });
});

// ─── Routing per ruolo (DEC-ROUTER-3) ───────────────────────────────────────

describe("route — routing per ruolo (strict)", () => {
  const writeModel: ModelConfig = { ...opus, name: "wri", roles: ["write"] };
  const reviewModel: ModelConfig = { ...lite, name: "rev", roles: ["review"] };
  const jolly: ModelConfig = { ...pay, name: "joll" }; // metered, nessun ruolo
  const empty: Ledger = { models: {} }; // modelli non tracciati = budget pieno
  const strict = policy({ roleRouting: "strict" });
  const small = (role: Classification["role"]): Classification =>
    cls("single_pass", [1000, 2000], 0.6, role);

  const all = [writeModel, reviewModel, jolly];

  it("task review → modello-review (non il write)", () => {
    const r = route(small("review"), all, empty, strict);
    expect(r.ok && r.value.model).toBe("rev");
  });

  it("task write → modello-write", () => {
    const r = route(small("write"), all, empty, strict);
    expect(r.ok && r.value.model).toBe("wri");
  });

  it("ruolo unknown → jolly (modello senza ruolo)", () => {
    const r = route(small("unknown"), all, empty, strict);
    expect(r.ok && r.value.model).toBe("joll");
  });

  it("nessun modello per il ruolo → ripiega sul jolly", () => {
    const r = route(small("review"), [writeModel, jolly], empty, strict);
    expect(r.ok && r.value.model).toBe("joll");
  });

  it("roleRouting off (default) ignora i ruoli: write su [review, jolly] → review (non-metered preferito)", () => {
    const off = route(small("write"), [reviewModel, jolly], empty, policy());
    expect(off.ok && off.value.model).toBe("rev");
    // mentre strict, senza modello-write, ripiega sul jolly:
    const st = route(small("write"), [reviewModel, jolly], empty, strict);
    expect(st.ok && st.value.model).toBe("joll");
  });

  it("nessun modello-ruolo né jolly → ripiega su TUTTI i modelli", () => {
    // Solo un modello write: un task review non ha né review né jolly → si usa tutto.
    const r = route(small("review"), [writeModel], empty, strict);
    expect(r.ok && r.value.model).toBe("wri");
  });

  it("roles: [] è trattato come jolly (nessun ruolo)", () => {
    const emptyRoles: ModelConfig = { ...pay, name: "neu", roles: [] };
    const r = route(small("unknown"), [writeModel, emptyRoles], empty, strict);
    expect(r.ok && r.value.model).toBe("neu");
  });
});

// ─── Modalità consentite per modello (modes) ────────────────────────────────

describe("route — modalità consentite per modello (modes)", () => {
  const glm: ModelConfig = { ...lite, name: "glm", modes: ["single_pass"] }; // quota piccola: mai agentico
  const empty: Ledger = { models: {} };
  const agentic = cls("agentic", [20_000, 50_000]); // sopra soglia → modalità effettiva agentica
  const single = cls("single_pass", [1000, 2000]);

  it("task agentico: il modello single_pass-only è escluso → nessun candidato", () => {
    expect(route(agentic, [glm], empty, policy()).ok).toBe(false);
  });

  it("task single_pass: il modello single_pass-only è idoneo", () => {
    const r = route(single, [glm], empty, policy());
    expect(r.ok && r.value.model).toBe("glm");
  });

  it("task agentico: instrada su un modello senza vincolo, mai su quello single_pass-only", () => {
    const r = route(agentic, [glm, opus], empty, policy());
    expect(r.ok && r.value.model).toBe("opus");
  });
});

// ─── Idoneità per economia (DEC-ROUTER-2) ───────────────────────────────────

describe("route — idoneità budget/policy", () => {
  const task = cls("single_pass", [100_000, 200_000]); // opus: stima 10–20%

  it("capped idoneo se resta sopra opusMinHeadroomPct dopo il task", () => {
    const r = route(task, [opus], ledger(0, 0), policy()); // headroom 100 - 20 = 80 ≥ 20
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("opus");
  });

  it("capped escluso se scenderebbe sotto la soglia di headroom", () => {
    const r = route(task, [opus], ledger(85, 0), policy()); // headroom 15 - 20 < 20
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/budget e nella policy/);
  });

  it("tiered idoneo finché non sfora la quota", () => {
    const r = route(task, [lite], ledger(0, 95), policy()); // headroom 5; stima 5–10 → sfora
    expect(r.ok).toBe(false);
  });

  it("modello assente dal ledger: trattato come budget pieno → idoneo (B1)", () => {
    const empty: Ledger = { models: {} };
    expect(route(task, [pay], empty, policy()).ok).toBe(true);
    // capped non tracciato = nessun consumo = pieno → idoneo (prima era escluso).
    const r = route(task, [opus], empty, policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("opus");
  });

  it("lista modelli vuota → err", () => {
    const r = route(task, [], ledger(0, 0), policy());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nessun modello candidato/);
  });
});

// ─── Ranking ─────────────────────────────────────────────────────────────────

describe("route — ranking tra economie", () => {
  const task = cls("single_pass", [100_000, 200_000]);

  it("preferCappedOverMetered: il capped batte il metered anche se più caro in headroom", () => {
    const r = route(task, [pay, opus], ledger(0, 0), policy({ preferCappedOverMetered: true }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.model).toBe("opus");
      expect(r.value.alternatives.map((a) => a.model)).toContain("pay");
    }
  });

  it("se il capped è esaurito, instrada sul metered", () => {
    const r = route(task, [opus, pay], ledger(85, 0), policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("pay");
  });

  it("tra due non-metered vince chi lascia più headroom residuo", () => {
    // opus: 80 residuo; lite: 90 residuo → lite preferito.
    const r = route(task, [opus, lite], ledger(0, 0), policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("lite");
  });

  it("tra due metered vince il $ più basso", () => {
    const payCheap: ModelConfig = {
      ...pay,
      name: "paycheap",
      pricePerMillionInput: 0.1,
      pricePerMillionOutput: 0.1,
    };
    const r = route(task, [pay, payCheap], { models: {} }, policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("paycheap");
  });

  it("economie miste senza preferenza: ordine d'ingresso stabile", () => {
    const r = route(task, [opus, pay], ledger(0, 0), policy({ preferCappedOverMetered: false }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("opus");
  });
});

// ─── auto-pass ───────────────────────────────────────────────────────────────

describe("route — auto-pass", () => {
  const task = cls("single_pass", [100_000, 200_000]); // metered ~ $0.0638 high

  it("metered economico sotto soglia → autoPass true", () => {
    const r = route(
      task,
      [pay],
      { models: {} },
      policy({ autoPassCostBelow: { meteredUsd: 0.1 } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.autoPass).toBe(true);
      expect(r.value.suggestion).toMatch(/auto-pass/);
    }
  });

  it("metered sopra soglia → autoPass false", () => {
    const r = route(
      task,
      [pay],
      { models: {} },
      policy({ autoPassCostBelow: { meteredUsd: 0.05 } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.autoPass).toBe(false);
  });

  it("senza soglia configurata → autoPass false", () => {
    const r = route(task, [pay], { models: {} }, policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.autoPass).toBe(false);
  });

  it("scelta non-metered → autoPass sempre false", () => {
    const r = route(task, [opus], ledger(0, 0), policy({ autoPassCostBelow: { meteredUsd: 999 } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.autoPass).toBe(false);
  });
});

// ─── Forma del risultato ─────────────────────────────────────────────────────

describe("route — RouteDecision", () => {
  it("riporta modello, modalità, stima, suggestion e alternative", () => {
    const r = route(
      cls("single_pass", [100_000, 200_000]),
      [opus, lite, pay],
      ledger(0, 0),
      policy(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ model: expect.any(String), mode: "single_pass" });
      expect(r.value.estimate.unit).toBe("pct_quota"); // vince lite (tiered)
      expect(r.value.suggestion).toContain(r.value.model);
      expect(r.value.suggestion).toMatch(/% quota/); // etichetta unità (B5)
      expect(r.value.alternatives.length).toBe(2);
    }
  });

  it("suggestion distingue % cap da % quota (B5)", () => {
    const r = route(cls("single_pass", [100_000, 200_000]), [opus], ledger(0, 0), policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.suggestion).toMatch(/% cap/);
  });

  it("suggestion in $ per un metered", () => {
    const r = route(cls("single_pass", [100_000, 200_000]), [pay], { models: {} }, policy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.suggestion).toMatch(/\$/);
  });
});
