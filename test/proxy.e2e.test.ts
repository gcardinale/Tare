import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startProxy } from "../src/proxy/index.js";
import { parseConfig } from "../src/config/index.js";
import { emptyLedger, syncLedger, saveLedger, loadLedger } from "../src/ledger/index.js";

/**
 * E2E del proxy su loopback (M4.4): agente → proxy → upstream finto → ledger.
 * Tutto in-process su 127.0.0.1, nessuna rete esterna. Verifica il path REALE
 * del bordo `server.io.ts` (escluso da coverage ma deve funzionare davvero).
 */

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const PRICE_IN = 3;
const PRICE_OUT = 15;
const CONFIG = (upstreamUrl: string): string => `{
  "models": {
    "pay": {
      "economy": "metered",
      "currency": "USD",
      "priceInPerMillion": ${PRICE_IN},
      "priceOutPerMillion": ${PRICE_OUT},
      "baseUrl": "${upstreamUrl}",
      "apiKeyEnv": "TEST_KEY",
      "upstreamModel": "real-model"
    }
  },
  "policy": { "singlePassBelowTokens": 1, "opusMinHeadroomPct": 20, "preferCappedOverMetered": true }
}`;

function urlOf(s: Server): string {
  const a = s.address() as AddressInfo;
  return `http://127.0.0.1:${a.port}`;
}

/** `spent` del modello pay, o -1 se non leggibile. */
async function paySpent(): Promise<number> {
  const led = await loadLedger();
  return led.ok && led.value.models.pay?.economy === "metered" ? led.value.models.pay.spent : -1;
}

/**
 * Per lo streaming il record sul ledger avviene DOPO la risposta (l'usage si
 * conosce a fine stream): la consistenza è eventuale. Si fa polling finché il
 * predicato è vero o scade il timeout.
 */
async function pollSpent(pred: (n: number) => boolean, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await paySpent();
    if (pred(s) || Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
}

let tmp: string;
let prevTareDir: string | undefined;
let upstream: Server;
let proxy: Server;
let proxyUrl: string;
let captured: CapturedRequest;

beforeAll(async () => {
  prevTareDir = process.env.TARE_DIR;
  tmp = mkdtempSync(join(tmpdir(), "tare-e2e-"));
  process.env.TARE_DIR = tmp;

  // Upstream finto: registra l'ultima richiesta e risponde con usage.
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const wantsStream = (() => {
        try {
          return (JSON.parse(captured.body) as { stream?: boolean }).stream === true;
        } catch {
          return false;
        }
      })();
      if ((req.url ?? "").startsWith("/v1/messages") && wantsStream) {
        // Risposta SSE: input nel message_start, output (cumulativo) nel message_delta.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [
            `event: message_start`,
            `data: {"type":"message_start","message":{"id":"msg_1","model":"real-model","usage":{"input_tokens":30,"output_tokens":1}}}`,
            ``,
            `event: message_delta`,
            `data: {"type":"message_delta","usage":{"output_tokens":20}}`,
            ``,
            `event: message_stop`,
            `data: {"type":"message_stop"}`,
            ``,
          ].join("\n"),
        );
      } else if ((req.url ?? "").startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "real-model",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 12, output_tokens: 8 },
          }),
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamUrl = urlOf(upstream);

  // Config + ledger pre-popolato nella cartella di stato temporanea.
  await writeFile(join(tmp, "config.jsonc"), CONFIG(upstreamUrl), "utf8");
  const cfg = parseConfig(CONFIG(upstreamUrl));
  if (!cfg.ok) throw new Error(cfg.error);
  await saveLedger(syncLedger(emptyLedger(), cfg.value.models));

  const started = await startProxy({
    port: 0,
    env: { TEST_KEY: "secret" },
    fallbackBaseUrl: upstreamUrl,
    logger: () => {},
  });
  proxy = started.server;
  proxyUrl = started.url;
});

afterAll(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  if (prevTareDir === undefined) delete process.env.TARE_DIR;
  else process.env.TARE_DIR = prevTareDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("proxy e2e — routing enforcing (non-stream)", () => {
  it("inoltra al modello scelto con chiave e upstreamModel, e aggiorna il ledger", async () => {
    const resp = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({
        model: "alias",
        max_tokens: 10,
        messages: [{ role: "user", content: "fai qualcosa" }],
      }),
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { usage: { input_tokens: number }; model: string };
    expect(json.usage.input_tokens).toBe(12);
    // Trasparenza: il client rivede il PROPRIO model id ("alias"), non "real-model".
    expect(json.model).toBe("alias");

    // L'upstream ha ricevuto la chiave del modello (non quella del client) e il model sostituito.
    expect(captured.headers["x-api-key"]).toBe("secret");
    const sentBody = JSON.parse(captured.body) as { model: string };
    expect(sentBody.model).toBe("real-model");

    // Ledger aggiornato col costo metered reale: 12/1e6*3 + 8/1e6*15.
    const led = await loadLedger();
    expect(led.ok).toBe(true);
    if (led.ok) {
      const state = led.value.models.pay;
      expect(state?.economy).toBe("metered");
      if (state?.economy === "metered") {
        const expected = (12 / 1e6) * PRICE_IN + (8 / 1e6) * PRICE_OUT;
        expect(state.spent).toBeCloseTo(expected, 9);
      }
    }
  });

  it("streaming → instradato: relaya l'SSE e registra l'usage dello stream", async () => {
    const spentBefore = await paySpent();

    const resp = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({
        model: "alias",
        stream: true,
        messages: [{ role: "user", content: "in streaming" }],
      }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const text = await resp.text();
    expect(text).toContain("message_start"); // gli eventi SSE sono arrivati al client
    // Trasparenza anche sullo stream: message_start riporta il model del client.
    expect(text).toContain('"model":"alias"');
    expect(text).not.toContain('"model":"real-model"');

    // Instradato come il non-stream: chiave del modello e model sostituito.
    expect(captured.headers["x-api-key"]).toBe("secret");
    expect((JSON.parse(captured.body) as { model: string }).model).toBe("real-model");

    // Ledger aggiornato (consistenza eventuale) con l'usage SSE: 30/1e6*3 + 20/1e6*15.
    const streamCost = (30 / 1e6) * PRICE_IN + (20 / 1e6) * PRICE_OUT;
    const spentAfter = await pollSpent((s) => s > spentBefore + streamCost / 2);
    expect(spentAfter).toBeCloseTo(spentBefore + streamCost, 9);
  });

  it("rotta non /v1/messages → passthrough trasparente", async () => {
    const resp = await fetch(`${proxyUrl}/v1/models`, { method: "GET" });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    expect(captured.url).toBe("/v1/models");
  });
});
