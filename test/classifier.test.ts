import { describe, it, expect } from "vitest";
import { classify } from "../src/classifier/index.js";
import type { Classification } from "../src/types/index.js";

/** Invarianti che OGNI classificazione deve rispettare (test robusti, non brittle). */
function expectValidShape(c: Classification): void {
  expect(c.tokenBand[0]).toBeLessThanOrEqual(c.tokenBand[1]);
  expect(c.tokenBand[0]).toBeGreaterThanOrEqual(0);
  expect(c.confidence).toBeGreaterThanOrEqual(0);
  expect(c.confidence).toBeLessThanOrEqual(1);
  expect(c.expectedSteps).toBeGreaterThanOrEqual(1);
  if (c.mode === "single_pass") expect(c.expectedSteps).toBe(1);
  if (c.mode === "agentic") expect(c.expectedSteps).toBeGreaterThan(1);
}

describe("classify — invarianti", () => {
  const samples = [
    "traduci questo paragrafo in inglese",
    "trova perché il test del checkout fallisce e correggilo",
    "",
    "x".repeat(500),
  ];
  for (const task of samples) {
    it(`rispetta lo shape per: "${task.slice(0, 30)}"`, () => {
      expectValidShape(classify({ task }));
    });
  }
});

describe("classify — ruolo (review vs write)", () => {
  it("review da keyword → role review", () => {
    expect(classify({ task: "rivedi questa funzione e cerca bug" }).role).toBe("review");
    expect(classify({ task: "do a code review of the auth module" }).role).toBe("review");
  });

  it("scrittura da keyword → role write", () => {
    expect(classify({ task: "implementa la cache e aggiungi i test" }).role).toBe("write");
    expect(classify({ task: "write a function that parses dates" }).role).toBe("write");
  });

  it("task senza segnali di ruolo → unknown", () => {
    expect(classify({ task: "ciao come stai" }).role).toBe("unknown");
  });

  it("tag esplicito [review] vince sull'euristica di scrittura", () => {
    // "implementa" spingerebbe a write, ma il tag forza review.
    expect(classify({ task: "[review] implementa la cache" }).role).toBe("review");
  });

  it("tag esplicito [write] vince sull'euristica di review", () => {
    expect(classify({ task: "[write] rivedi e poi scrivi" }).role).toBe("write");
  });

  it("entrambi i tag → si ricade sull'euristica", () => {
    // Con entrambi i tag, decide il conteggio dei keyword: qui prevale review.
    expect(classify({ task: "[review] [write] rivedi e controlla" }).role).toBe("review");
  });
});

describe("classify — single_pass (lavoro delimitato)", () => {
  it("una traduzione è single_pass", () => {
    const c = classify({ task: "traduci questo testo in inglese", contextTokens: 2000 });
    expect(c.mode).toBe("single_pass");
    expect(c.expectedSteps).toBe(1);
  });

  it("una code review breve è single_pass", () => {
    const c = classify({ task: "review this function for style", contextTokens: 3000 });
    expect(c.mode).toBe("single_pass");
  });

  it("la fascia single_pass è vicina al contesto + margine output", () => {
    const ctx = 5000;
    const c = classify({ task: "summarize this file", contextTokens: ctx });
    expect(c.tokenBand[0]).toBeGreaterThanOrEqual(ctx);
    expect(c.tokenBand[1]).toBeLessThanOrEqual(ctx + 5000);
  });
});

describe("classify — agentic (lavoro esplorativo)", () => {
  it("un debug aperto su file non nominati è agentico", () => {
    const c = classify({
      task: "find why the checkout test is failing and fix it across the codebase",
      contextTokens: 8200,
      toolsAvailable: ["edit", "bash", "grep"],
    });
    expect(c.mode).toBe("agentic");
    expect(c.expectedSteps).toBeGreaterThanOrEqual(3);
  });

  it("un termine multi-parola resta riconosciuto con doppio spazio (C5)", () => {
    // "più file" è un segnale agentico: deve scattare anche con whitespace irregolare.
    expect(classify({ task: "lavora su più file" }).mode).toBe("agentic");
    expect(classify({ task: "lavora su più  file" }).mode).toBe("agentic");
  });

  it("la fascia agentica modella lo snowball (cresce col contesto)", () => {
    const small = classify({
      task: "refactor the auth module across several files",
      contextTokens: 4000,
      toolsAvailable: ["edit"],
    });
    const big = classify({
      task: "refactor the auth module across several files",
      contextTokens: 16000,
      toolsAvailable: ["edit"],
    });
    expect(big.tokenBand[1]).toBeGreaterThan(small.tokenBand[1]);
  });

  it("più step → fascia più ampia del single_pass a parità di contesto", () => {
    const ctx = 8000;
    const single = classify({ task: "explain this code", contextTokens: ctx });
    const agentic = classify({
      task: "debug and refactor this across multiple files",
      contextTokens: ctx,
      toolsAvailable: ["edit", "bash"],
    });
    expect(agentic.tokenBand[1]).toBeGreaterThan(single.tokenBand[1]);
  });
});

describe("classify — confidenza", () => {
  it("un segnale netto ha confidenza maggiore di un caso ambiguo", () => {
    const clear = classify({
      task: "debug refactor migrate investigate across the codebase end-to-end",
      toolsAvailable: ["edit", "bash"],
      contextTokens: 30000,
    });
    const ambiguous = classify({ task: "aggiorna la pagina", contextTokens: 4000 });
    expect(clear.confidence).toBeGreaterThan(ambiguous.confidence);
  });

  it("non promette mai certezza assoluta (<= 0.85)", () => {
    const c = classify({
      task: "debug refactor migrate investigate across the codebase end-to-end step by step",
      toolsAvailable: ["edit", "bash"],
      contextTokens: 50000,
    });
    expect(c.confidence).toBeLessThanOrEqual(0.85);
  });
});

describe("classify — confini di parola (regressione F-03)", () => {
  it('"prefix" non deve attivare il termine agentico "fix"', () => {
    const c = classify({ task: "add a prefix to every line" });
    expect(c.mode).toBe("single_pass");
  });

  it('"preview" non deve attivare il termine "review"', () => {
    // Resta single_pass, ma NON perché ha matchato "review" per sottostringa.
    const c = classify({ task: "generate a preview of the page" });
    expect(c.mode).toBe("single_pass");
  });

  it("i termini accentati italiani matchano comunque (perché)", () => {
    const c = classify({ task: "perché questo test non funziona" });
    expect(c.mode).toBe("agentic");
  });

  it('i termini multi-parola matchano ("più file")', () => {
    const c = classify({ task: "aggiorna lo stesso valore in più file" });
    expect(c.mode).toBe("agentic");
  });
});

describe("classify — banda agentica con contesto assente (regressione F-04)", () => {
  it("contextTokens: 0 non deve produrre una banda [0, 0]", () => {
    const c = classify({
      task: "debug and refactor this across multiple files",
      contextTokens: 0,
      toolsAvailable: ["edit", "bash"],
    });
    expect(c.mode).toBe("agentic");
    expect(c.tokenBand[1]).toBeGreaterThan(0);
  });
});

describe("classify — determinismo", () => {
  it("stesso input → stesso output", () => {
    const input = { task: "fix the failing test", contextTokens: 6000, toolsAvailable: ["edit"] };
    expect(classify(input)).toEqual(classify(input));
  });
});
