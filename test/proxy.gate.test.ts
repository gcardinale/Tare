import { describe, it, expect } from "vitest";
import {
  buildGateMessage,
  buildGateSse,
  formatPreflightCard,
  GATE_MARKER,
  isGateableTurn,
  parseApproval,
  readGateReply,
  stripGateTurns,
} from "../src/proxy/index.js";
import type { ModelConfig, Plan } from "../src/types/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const models: readonly ModelConfig[] = [
  { name: "glm-lite", economy: "tiered_quota", period: "weekly", periodTokenCapacity: 2_000_000 },
  {
    name: "deepseek",
    economy: "metered",
    currency: "USD",
    pricePerMillionInput: 0.27,
    pricePerMillionOutput: 0.41,
  },
  { name: "opus", economy: "subscription_cap", period: "weekly", periodTokenCapacity: 1_000_000 },
];

const plan: Plan = {
  classification: {
    mode: "agentic",
    expectedSteps: 8,
    tokenBand: [180_000, 260_000],
    confidence: 0.7,
    role: "write",
  },
  decision: {
    model: "glm-lite",
    mode: "agentic",
    estimate: { low: 3, high: 5, unit: "pct_quota", confidence: 0.7 },
    suggestion: "glm-lite / agentic",
    autoPass: false,
    alternatives: [
      {
        model: "deepseek",
        mode: "agentic",
        estimate: { low: 0.03, high: 0.05, unit: "currency", confidence: 0.7 },
      },
      {
        model: "opus",
        mode: "agentic",
        estimate: { low: 11, high: 14, unit: "pct_cap", confidence: 0.6 },
      },
    ],
  },
};

/** Costruisce un body-richiesta minimo con la sequenza di messaggi data. */
function body(messages: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { model: "claude-x", messages, ...extra };
}

/** Turno assistente che porta la scheda di preflight. */
const card = { role: "assistant", content: `${GATE_MARKER}\n  glm-lite ...` };

// ── parseApproval ────────────────────────────────────────────────────────────

describe("parseApproval", () => {
  it("riconosce le forme di approvazione senza modello", () => {
    for (const t of ["ok", "OK", " ok ", "sì", "si", "yes", "y", "va bene"]) {
      expect(parseApproval(t)).toEqual({ kind: "approved", model: null });
    }
  });

  it("estrae il modello da ok:<nome> e ok <nome>", () => {
    expect(parseApproval("ok:deepseek")).toEqual({ kind: "approved", model: "deepseek" });
    expect(parseApproval("ok deepseek")).toEqual({ kind: "approved", model: "deepseek" });
    expect(parseApproval("OK: glm-lite")).toEqual({ kind: "approved", model: "glm-lite" });
  });

  it("riconosce il rifiuto", () => {
    for (const t of ["no", "NO", "n", "annulla", "stop", "cancel"]) {
      expect(parseApproval(t)).toEqual({ kind: "rejected" });
    }
  });

  it("un ok dentro una frase non è una risposta al cancello", () => {
    expect(parseApproval("ok now refactor the auth module")).toEqual({ kind: "none" });
    expect(parseApproval("nothing to do here")).toEqual({ kind: "none" });
  });
});

// ── readGateReply ────────────────────────────────────────────────────────────

describe("readGateReply", () => {
  it("conta l'approvazione solo se preceduta dalla NOSTRA scheda", () => {
    const b = body([{ role: "user", content: "task" }, card, { role: "user", content: "ok" }]);
    expect(readGateReply(b)).toEqual({ kind: "approved", model: null });
  });

  it("ok:<modello> dopo la scheda porta il modello scelto", () => {
    const b = body([{ role: "user", content: "task" }, card, { role: "user", content: "ok:deepseek" }]);
    expect(readGateReply(b)).toEqual({ kind: "approved", model: "deepseek" });
  });

  it("no dopo la scheda è un rifiuto", () => {
    const b = body([{ role: "user", content: "task" }, card, { role: "user", content: "no" }]);
    expect(readGateReply(b)).toEqual({ kind: "rejected" });
  });

  it("un ok NON preceduto da una scheda è testo normale, non approvazione", () => {
    const b = body([{ role: "user", content: "ok" }]);
    expect(readGateReply(b)).toEqual({ kind: "none" });
  });

  it("ignora i tool_result in coda e guarda l'ultimo turno utente con testo", () => {
    const b = body([
      { role: "user", content: "task" },
      card,
      { role: "user", content: "ok" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
    ]);
    // L'ultimo turno utente CON testo resta "ok", preceduto dalla scheda.
    expect(readGateReply(b)).toEqual({ kind: "approved", model: null });
  });

  it("body malformati → none", () => {
    expect(readGateReply(null)).toEqual({ kind: "none" });
    expect(readGateReply({ messages: "x" })).toEqual({ kind: "none" });
    expect(readGateReply(body([]))).toEqual({ kind: "none" });
  });
});

// ── stripGateTurns ───────────────────────────────────────────────────────────

describe("stripGateTurns", () => {
  it("toglie scheda e risposta, lasciando la conversazione originale", () => {
    const b = body([{ role: "user", content: "il task vero" }, card, { role: "user", content: "ok" }]);
    const out = stripGateTurns(b) as { messages: unknown[] };
    expect(out.messages).toEqual([{ role: "user", content: "il task vero" }]);
  });

  it("toglie la scheda anche quando la risposta sceglie un modello", () => {
    const b = body([{ role: "user", content: "task" }, card, { role: "user", content: "ok:deepseek" }]);
    const out = stripGateTurns(b) as { messages: unknown[] };
    expect(out.messages).toEqual([{ role: "user", content: "task" }]);
  });

  it("non tocca un turno utente che segue la scheda ma è un vero task", () => {
    const b = body([{ role: "user", content: "t1" }, card, { role: "user", content: "adesso fai altro" }]);
    const out = stripGateTurns(b) as { messages: unknown[] };
    expect(out.messages).toEqual([
      { role: "user", content: "t1" },
      { role: "user", content: "adesso fai altro" },
    ]);
  });

  it("restituisce il body invariato (stesso riferimento logico) se non c'è nessuna scheda", () => {
    const b = body([{ role: "user", content: "task" }]);
    expect(stripGateTurns(b)).toBe(b);
  });

  it("body non-standard passano invariati", () => {
    expect(stripGateTurns(null)).toBe(null);
    expect(stripGateTurns({ messages: 3 })).toEqual({ messages: 3 });
  });
});

// ── isGateableTurn ───────────────────────────────────────────────────────────

describe("isGateableTurn", () => {
  it("true per un turno utente con testo e con tool disponibili", () => {
    const b = body([{ role: "user", content: "refactor auth" }], { tools: [{ name: "bash" }] });
    expect(isGateableTurn(b)).toBe(true);
  });

  it("true per una richiesta grande anche senza tool", () => {
    const b = body([{ role: "user", content: "refactor auth" }], { max_tokens: 4096 });
    expect(isGateableTurn(b)).toBe(true);
  });

  it("false per una chiamata di servizio piccola senza tool (es. titolo conversazione)", () => {
    const b = body([{ role: "user", content: "dai un titolo" }], { max_tokens: 64 });
    expect(isGateableTurn(b)).toBe(false);
  });

  it("false quando l'ultimo turno è un tool_result (continuazione del loop)", () => {
    const b = body(
      [
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] },
      ],
      { tools: [{ name: "bash" }] },
    );
    expect(isGateableTurn(b)).toBe(false);
  });

  it("body malformati → false", () => {
    expect(isGateableTurn(null)).toBe(false);
    expect(isGateableTurn(body([]))).toBe(false);
  });
});

// ── formatPreflightCard ──────────────────────────────────────────────────────

describe("formatPreflightCard", () => {
  const text = formatPreflightCard(plan, models);

  it("intesta con il marcatore e la classificazione", () => {
    expect(text).toContain(GATE_MARKER);
    expect(text).toContain("agentic");
    expect(text).toContain("180k–260k token");
    expect(text).toContain("confidenza 70%");
  });

  it("mostra il modello scelto con la sua unità di economia e il periodo", () => {
    expect(text).toContain("glm-lite");
    expect(text).toContain("della quota settimanale");
    expect(text).toContain("← scelto");
  });

  it("mostra le alternative con il loro prezzo (denaro e % di cap)", () => {
    expect(text).toContain("deepseek");
    expect(text).toContain("0.03 USD"); // ≥ 0.01 → 2 decimali
    expect(text).toContain("opus");
    expect(text).toContain("del cap settimanale");
  });

  it("chiude con le istruzioni di risposta", () => {
    expect(text).toContain("ok");
    expect(text).toContain("ok:<modello>");
    expect(text).toContain("no");
  });

  it("copre i rami di formattazione: periodo mensile, denaro <0.01, single-pass, token piccoli", () => {
    const monthlyModels: readonly ModelConfig[] = [
      { name: "sub", economy: "subscription_cap", period: "monthly", periodTokenCapacity: 5_000_000 },
      {
        name: "cheap",
        economy: "metered",
        currency: "EUR",
        pricePerMillionInput: 0.1,
        pricePerMillionOutput: 0.2,
      },
    ];
    const p: Plan = {
      classification: {
        mode: "single_pass",
        expectedSteps: 1,
        tokenBand: [400, 900],
        confidence: 0.9,
        role: "unknown",
      },
      decision: {
        model: "sub",
        mode: "single_pass",
        estimate: { low: 12, high: 18, unit: "pct_cap", confidence: 0.9 },
        suggestion: "sub / single_pass",
        autoPass: false,
        alternatives: [
          {
            model: "cheap",
            mode: "single_pass",
            estimate: { low: 0.0004, high: 0.0009, unit: "currency", confidence: 0.9 },
          },
          // Alternativa che punta a un modello NON in `models`: resa degradata.
          {
            model: "ghost",
            mode: "single_pass",
            estimate: { low: 1, high: 2, unit: "pct_quota", confidence: 0.5 },
          },
        ],
      },
    };
    const out = formatPreflightCard(p, monthlyModels);
    expect(out).toContain("single-pass"); // niente "· step" per single_pass
    expect(out).not.toContain("step");
    expect(out).toContain("400–900 token"); // token < 1000 restano interi
    expect(out).toContain("del cap mensile"); // periodo mensile
    expect(out).toContain("0.0004 EUR"); // denaro < 0.01 → 4 decimali, valuta del modello
    expect(out).toContain("ghost"); // modello ignoto reso comunque, senza periodo
  });
});

// ── buildGateMessage / buildGateSse ──────────────────────────────────────────

describe("buildGateMessage", () => {
  it("è un messaggio Anthropic con la scheda e usage a zero", () => {
    const m = buildGateMessage("scheda", "claude-x") as {
      type: string;
      role: string;
      model: string;
      content: { type: string; text: string }[];
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };
    expect(m.type).toBe("message");
    expect(m.role).toBe("assistant");
    expect(m.model).toBe("claude-x");
    expect(m.content[0]).toEqual({ type: "text", text: "scheda" });
    expect(m.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(m.stop_reason).toBe("end_turn");
  });

  it("senza clientModel usa un id neutro", () => {
    const m = buildGateMessage("x", undefined) as { model: string };
    expect(m.model).toBe("tare");
  });
});

describe("buildGateSse", () => {
  const sse = buildGateSse("la scheda", "claude-x");

  it("emette la sequenza completa di eventi Anthropic", () => {
    for (const e of [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]) {
      expect(sse).toContain(`event: ${e}`);
    }
  });

  it("il testo della scheda viaggia nel text_delta", () => {
    // Ricompone il testo dai content_block_delta.
    const deltas = sse
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as { type: string; delta?: { text?: string } })
      .filter((d) => d.type === "content_block_delta")
      .map((d) => d.delta?.text ?? "")
      .join("");
    expect(deltas).toBe("la scheda");
  });

  it("riporta il model del client nel message_start", () => {
    const start = sse
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as { type: string; message?: { model?: string } })
      .find((d) => d.type === "message_start");
    expect(start?.message?.model).toBe("claude-x");
  });
});
