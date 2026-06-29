import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultLedgerPath, loadLedger, recordActual, saveLedger } from "../src/ledger/index.js";
import type { Ledger } from "../src/types/index.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tare-ledger-"));
  path = join(dir, "ledger.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: Ledger = {
  models: {
    opus: { economy: "subscription_cap", period: "weekly", cap: 1_000_000, used: 0 },
    pay: { economy: "metered", currency: "USD", spent: 0 },
  },
};

describe("defaultLedgerPath", () => {
  it("punta a ~/.tare/ledger.json", () => {
    expect(defaultLedgerPath().replace(/\\/g, "/")).toMatch(/\/\.tare\/ledger\.json$/);
  });
});

describe("loadLedger", () => {
  it("file assente → ledger vuoto (ok), non errore", async () => {
    const r = await loadLedger(path);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ models: {} });
  });

  it("JSON non valido → err", async () => {
    await writeFile(path, "{ non json", "utf8");
    const r = await loadLedger(path);
    expect(r.ok).toBe(false);
  });

  it("oggetto senza models → err", async () => {
    await writeFile(path, JSON.stringify({ foo: 1 }), "utf8");
    const r = await loadLedger(path);
    expect(r.ok).toBe(false);
  });
});

describe("saveLedger + loadLedger — round trip", () => {
  it("scrive e rilegge identico", async () => {
    const w = await saveLedger(sample, path);
    expect(w.ok).toBe(true);
    const r = await loadLedger(path);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(sample);
  });

  it("crea le cartelle mancanti", async () => {
    const nested = join(dir, "a", "b", "ledger.json");
    const w = await saveLedger(sample, nested);
    expect(w.ok).toBe(true);
    const back = JSON.parse(await readFile(nested, "utf8")) as Ledger;
    expect(back).toEqual(sample);
  });
});

describe("recordActual — load → record → save atomico", () => {
  it("persiste il consumo aggiornato (capped)", async () => {
    await saveLedger(sample, path);
    const r = await recordActual("opus", { inputTokens: 1000, outputTokens: 500 }, path);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.models.opus).toMatchObject({ used: 1500 });
    const onDisk = await loadLedger(path);
    if (onDisk.ok) expect(onDisk.value.models.opus).toMatchObject({ used: 1500 });
  });

  it("parte da ledger vuoto se il file non esiste → modello sconosciuto", async () => {
    const r = await recordActual("opus", { inputTokens: 1, outputTokens: 1 }, path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("opus");
  });

  it("ledger corrotto → err, nessuna scrittura", async () => {
    await writeFile(path, "rotto", "utf8");
    const r = await recordActual("opus", { inputTokens: 1, outputTokens: 1 }, path);
    expect(r.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("rotto");
  });
});
