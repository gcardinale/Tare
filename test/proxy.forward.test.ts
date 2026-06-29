import { describe, it, expect } from "vitest";
import {
  buildForwardHeaders,
  extractSseUsage,
  extractUsageTokens,
  formatPreflight,
  isStreamingRequest,
  joinUpstreamUrl,
  parseForcedModel,
  resolveApiKey,
  resolveUpstreamBase,
  rewriteResponseModel,
  rewriteSseModelLine,
  toUsage,
  withUpstreamModel,
} from "../src/proxy/index.js";
import type { ModelConfig, Plan } from "../src/types/index.js";

const capped: ModelConfig = {
  name: "opus",
  economy: "subscription_cap",
  period: "weekly",
  periodTokenCapacity: 1_000_000,
};
const metered: ModelConfig = {
  name: "pay",
  economy: "metered",
  currency: "USD",
  pricePerMillionInput: 3,
  pricePerMillionOutput: 15,
};

describe("isStreamingRequest", () => {
  it("true solo se stream === true", () => {
    expect(isStreamingRequest({ stream: true })).toBe(true);
    expect(isStreamingRequest({ stream: false })).toBe(false);
    expect(isStreamingRequest({})).toBe(false);
    expect(isStreamingRequest(null)).toBe(false);
    expect(isStreamingRequest("x")).toBe(false);
  });
});

describe("resolveUpstreamBase", () => {
  it("usa baseUrl del modello se presente", () => {
    expect(resolveUpstreamBase({ ...capped, baseUrl: "https://x.dev" }, "https://fb")).toBe(
      "https://x.dev",
    );
  });
  it("fallback se baseUrl assente", () => {
    expect(resolveUpstreamBase(capped, "https://fb")).toBe("https://fb");
  });
});

describe("parseForcedModel", () => {
  it("estrae il nome da [model:nome]", () => {
    expect(parseForcedModel("[model:glm] fai questo")).toBe("glm");
    expect(parseForcedModel("usa [model:deepseek] qui")).toBe("deepseek");
  });
  it("tollera spazi e maiuscole nel tag", () => {
    expect(parseForcedModel("[ MODEL : claude ] ciao")).toBe("claude");
  });
  it("accetta nomi con punti/trattini/underscore", () => {
    expect(parseForcedModel("[model:glm-4.6_lite]")).toBe("glm-4.6_lite");
  });
  it("nessun tag → null", () => {
    expect(parseForcedModel("fai qualcosa senza tag")).toBeNull();
    expect(parseForcedModel("[model:]")).toBeNull();
  });
});

describe("joinUpstreamUrl", () => {
  it("APPENDE il path al prefisso del baseUrl (non lo sostituisce)", () => {
    expect(joinUpstreamUrl("https://api.z.ai/api/anthropic", "/v1/messages")).toBe(
      "https://api.z.ai/api/anthropic/v1/messages",
    );
    expect(joinUpstreamUrl("https://api.deepseek.com/anthropic", "/v1/messages")).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
  });
  it("baseUrl senza prefisso → path diretto", () => {
    expect(joinUpstreamUrl("https://api.anthropic.com", "/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });
  it("preserva la query e gestisce la slash finale del baseUrl", () => {
    expect(joinUpstreamUrl("https://x.com/p/", "/v1/messages?beta=1")).toBe(
      "https://x.com/p/v1/messages?beta=1",
    );
  });
});

describe("resolveApiKey", () => {
  it("apiKeyEnv assente → ok(null) (inoltra auth in ingresso)", () => {
    const r = resolveApiKey(capped, {});
    expect(r).toEqual({ ok: true, value: null });
  });
  it("apiKeyEnv presente e valorizzata → ok(valore)", () => {
    const r = resolveApiKey({ ...capped, apiKeyEnv: "K" }, { K: "segreto" });
    expect(r).toEqual({ ok: true, value: "segreto" });
  });
  it("apiKeyEnv presente ma env mancante → err", () => {
    expect(resolveApiKey({ ...capped, apiKeyEnv: "K" }, {}).ok).toBe(false);
  });
  it("apiKeyEnv presente ma env vuota → err", () => {
    expect(resolveApiKey({ ...capped, apiKeyEnv: "K" }, { K: "  " }).ok).toBe(false);
  });
});

describe("buildForwardHeaders", () => {
  it("rimuove hop-by-hop e normalizza in lowercase, preservando l'auth in ingresso", () => {
    const h = buildForwardHeaders(
      {
        Host: "tare",
        "Content-Length": "10",
        Connection: "keep-alive",
        "anthropic-version": "2023-06-01",
        "X-Api-Key": "in",
      },
      null,
    );
    expect(h).not.toHaveProperty("host");
    expect(h).not.toHaveProperty("content-length");
    expect(h).not.toHaveProperty("connection");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["x-api-key"]).toBe("in"); // auth in ingresso preservata
  });

  it("non forza content-type: assente se non in ingresso, preservato se presente (R3)", () => {
    expect(buildForwardHeaders({}, null)).not.toHaveProperty("content-type");
    expect(buildForwardHeaders({ "content-type": "text/plain" }, null)["content-type"]).toBe(
      "text/plain",
    );
  });

  it("con apiKey (default x-api-key): imposta x-api-key e rimuove authorization", () => {
    const h = buildForwardHeaders({ authorization: "Bearer old", "x-api-key": "old" }, "nuova");
    expect(h["x-api-key"]).toBe("nuova");
    expect(h).not.toHaveProperty("authorization");
  });

  it("authStyle bearer: imposta Authorization Bearer e rimuove x-api-key", () => {
    const h = buildForwardHeaders({ "x-api-key": "old" }, "tok", "bearer");
    expect(h["authorization"]).toBe("Bearer tok");
    expect(h).not.toHaveProperty("x-api-key");
  });

  it("unisce i valori array degli header", () => {
    const h = buildForwardHeaders({ "anthropic-beta": ["a", "b"] }, null);
    expect(h["anthropic-beta"]).toBe("a, b");
  });

  it("salta header undefined", () => {
    const h = buildForwardHeaders({ "x-skip": undefined }, null);
    expect(h).not.toHaveProperty("x-skip");
  });
});

describe("withUpstreamModel", () => {
  it("sostituisce model se upstreamModel è impostato", () => {
    const out = withUpstreamModel(
      { model: "alias", max_tokens: 10 },
      { ...capped, upstreamModel: "claude-real" },
    );
    expect(out).toEqual({ model: "claude-real", max_tokens: 10 });
  });
  it("lascia il model originale se upstreamModel assente", () => {
    const out = withUpstreamModel({ model: "alias" }, capped);
    expect(out.model).toBe("alias");
  });
  it("body non oggetto → oggetto vuoto (eventualmente col model)", () => {
    expect(withUpstreamModel(null, capped)).toEqual({});
    expect(withUpstreamModel(null, { ...capped, upstreamModel: "m" })).toEqual({ model: "m" });
  });
});

describe("extractUsageTokens", () => {
  it("legge input_tokens/output_tokens", () => {
    expect(extractUsageTokens({ usage: { input_tokens: 100, output_tokens: 50 } })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
  it("campi assenti → 0", () => {
    expect(extractUsageTokens({ usage: {} })).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
  it("usage assente o risposta non oggetto → null", () => {
    expect(extractUsageTokens({})).toBeNull();
    expect(extractUsageTokens(null)).toBeNull();
    expect(extractUsageTokens({ usage: "x" })).toBeNull();
  });
});

describe("extractSseUsage", () => {
  const sse = [
    `event: message_start`,
    `data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":100,"output_tokens":1}}}`,
    ``,
    `event: ping`,
    `data: {"type":"ping"}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","delta":{"text":"ciao"}}`,
    ``,
    `event: message_delta`,
    `data: {"type":"message_delta","usage":{"output_tokens":42}}`,
    ``,
    `event: message_stop`,
    `data: {"type":"message_stop"}`,
    ``,
  ].join("\n");

  it("input da message_start, output (cumulativo) dall'ultimo message_delta", () => {
    expect(extractSseUsage(sse)).toEqual({ inputTokens: 100, outputTokens: 42 });
  });

  it("più message_delta: vince l'ultimo output_tokens", () => {
    const s = [
      `data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}`,
      `data: {"type":"message_delta","usage":{"output_tokens":5}}`,
      `data: {"type":"message_delta","usage":{"output_tokens":20}}`,
    ].join("\n");
    expect(extractSseUsage(s)).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("ignora righe data non-JSON (ping, [DONE]) e righe non-data", () => {
    const s = [
      `: heartbeat`,
      `data: [DONE]`,
      `data: non-json`,
      `data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}`,
    ].join("\n");
    expect(extractSseUsage(s)).toEqual({ inputTokens: 7, outputTokens: 0 });
  });

  it("nessun usage → null", () => {
    expect(extractSseUsage(`data: {"type":"ping"}\n\n`)).toBeNull();
    expect(extractSseUsage("")).toBeNull();
  });

  it("data JSON ma non oggetto (array/numero) è ignorato", () => {
    const s = [
      `data: [1,2,3]`,
      `data: 42`,
      `data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}`,
    ].join("\n");
    expect(extractSseUsage(s)).toEqual({ inputTokens: 5, outputTokens: 0 });
  });

  it("solo message_delta (nessun message_start) → input 0", () => {
    expect(extractSseUsage(`data: {"type":"message_delta","usage":{"output_tokens":9}}`)).toEqual({
      inputTokens: 0,
      outputTokens: 9,
    });
  });

  it("gestisce i CRLF", () => {
    const s = `data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\r\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\r\n`;
    expect(extractSseUsage(s)).toEqual({ inputTokens: 3, outputTokens: 9 });
  });
});

describe("toUsage", () => {
  it("metered: calcola costCurrency dai prezzi del modello", () => {
    const u = toUsage(metered, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // 1M * 3$/M + 1M * 15$/M = 18
    expect(u).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000, costCurrency: 18 });
  });
  it("capped/tiered: solo token, niente costCurrency", () => {
    const u = toUsage(capped, { inputTokens: 10, outputTokens: 20 });
    expect(u).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});

describe("rewriteResponseModel", () => {
  it("rimette il model del client nella risposta", () => {
    expect(rewriteResponseModel({ model: "glm-5.2", usage: {} }, "claude-opus")).toEqual({
      model: "claude-opus",
      usage: {},
    });
  });
  it("clientModel assente/vuoto o risposta senza model → invariata", () => {
    expect(rewriteResponseModel({ model: "x" }, undefined)).toEqual({ model: "x" });
    expect(rewriteResponseModel({ model: "x" }, "")).toEqual({ model: "x" });
    expect(rewriteResponseModel({ usage: {} }, "claude")).toEqual({ usage: {} });
    expect(rewriteResponseModel("non-oggetto", "claude")).toBe("non-oggetto");
  });
});

describe("rewriteSseModelLine", () => {
  it("riscrive message.model nell'evento message_start", () => {
    const line = `data: {"type":"message_start","message":{"model":"glm-5.2","usage":{}}}\n`;
    const out = rewriteSseModelLine(line, "claude-opus");
    expect(out).toContain('"model":"claude-opus"');
    expect(out.startsWith("data: ")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });
  it("riscrive anche il model di primo livello e preserva i CRLF", () => {
    const out = rewriteSseModelLine(`data: {"type":"x","model":"glm"}\r\n`, "claude");
    expect(out).toContain('"model":"claude"');
    expect(out.endsWith("\r\n")).toBe(true);
  });
  it("righe non-data, non-JSON, [DONE] o senza model → invariate", () => {
    expect(rewriteSseModelLine(`event: message_start\n`, "claude")).toBe(`event: message_start\n`);
    expect(rewriteSseModelLine(`data: [DONE]\n`, "claude")).toBe(`data: [DONE]\n`);
    expect(rewriteSseModelLine(`data: non-json\n`, "claude")).toBe(`data: non-json\n`);
    expect(rewriteSseModelLine(`data: {"type":"ping"}\n`, "claude")).toBe(
      `data: {"type":"ping"}\n`,
    );
  });
  it("clientModel assente → invariata", () => {
    const line = `data: {"type":"message_start","message":{"model":"glm"}}\n`;
    expect(rewriteSseModelLine(line, undefined)).toBe(line);
  });
  it("riga data senza newline finale: riscrive e non aggiunge newline", () => {
    const out = rewriteSseModelLine(`data: {"type":"x","model":"glm"}`, "claude");
    expect(out).toBe(`data: {"type":"x","model":"claude"}`);
  });
  it("data JSON ma non oggetto (array) → invariata", () => {
    expect(rewriteSseModelLine(`data: [1,2]\n`, "claude")).toBe(`data: [1,2]\n`);
  });
});

describe("formatPreflight", () => {
  const basePlan = (over: Partial<Plan["decision"]>): Plan => ({
    classification: {
      mode: "agentic",
      expectedSteps: 5,
      tokenBand: [1, 2],
      confidence: 0.6,
      role: "unknown",
    },
    decision: {
      model: "pay",
      mode: "agentic",
      estimate: { low: 1, high: 2, unit: "currency", confidence: 0.6 },
      suggestion: "Suggerito: pay (~$0.03)",
      alternatives: [],
      autoPass: false,
      ...over,
    },
  });

  it("include suggestion e marca auto-pass", () => {
    const s = formatPreflight(basePlan({ autoPass: true }));
    expect(s).toContain("Suggerito: pay");
    expect(s).toContain("auto-pass");
  });

  it("elenca le alternative quando presenti", () => {
    const s = formatPreflight(
      basePlan({
        alternatives: [
          {
            model: "opus",
            mode: "single_pass",
            estimate: { low: 0, high: 1, unit: "pct_cap", confidence: 0.5 },
          },
        ],
      }),
    );
    expect(s).toContain("alternative");
    expect(s).toContain("opus/single_pass");
  });

  it("senza alternative non aggiunge la sezione", () => {
    expect(formatPreflight(basePlan({}))).not.toContain("alternative");
  });
});
