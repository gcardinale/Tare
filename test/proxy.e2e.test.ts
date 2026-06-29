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
      res.writeHead(200, { "content-type": "application/json" });
      if ((req.url ?? "").startsWith("/v1/messages")) {
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 12, output_tokens: 8 },
          }),
        );
      } else {
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
    const json = (await resp.json()) as { usage: { input_tokens: number } };
    expect(json.usage.input_tokens).toBe(12);

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

  it("streaming → passthrough: inoltra l'auth del client e NON tocca il ledger", async () => {
    const before = await loadLedger();
    const spentBefore =
      before.ok && before.value.models.pay?.economy === "metered"
        ? before.value.models.pay.spent
        : -1;

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
    await resp.text();

    // Passthrough: l'auth in ingresso è preservata (nessun override di chiave).
    expect(captured.headers["x-api-key"]).toBe("client-key");

    const after = await loadLedger();
    const spentAfter =
      after.ok && after.value.models.pay?.economy === "metered" ? after.value.models.pay.spent : -2;
    expect(spentAfter).toBe(spentBefore);
  });

  it("rotta non /v1/messages → passthrough trasparente", async () => {
    const resp = await fetch(`${proxyUrl}/v1/models`, { method: "GET" });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    expect(captured.url).toBe("/v1/models");
  });
});
