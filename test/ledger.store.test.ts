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

  // Regressione: validazione di forma al bordo (repro revisione 29/06).
  it('models null → err (non "ok" che poi fa lanciare il nucleo)', async () => {
    await writeFile(path, JSON.stringify({ models: null }), "utf8");
    expect((await loadLedger(path)).ok).toBe(false);
  });

  it("models array → err (array non è una mappa di modelli)", async () => {
    await writeFile(path, JSON.stringify({ models: [] }), "utf8");
    expect((await loadLedger(path)).ok).toBe(false);
  });

  it("BudgetState interno malformato (metered senza spent) → err, niente NaN", async () => {
    await writeFile(
      path,
      JSON.stringify({ models: { pay: { economy: "metered", currency: "USD" } } }),
      "utf8",
    );
    expect((await loadLedger(path)).ok).toBe(false);
  });

  it("economy sconosciuta → err", async () => {
    await writeFile(
      path,
      JSON.stringify({ models: { x: { economy: "bitcoin", cap: 1, used: 0 } } }),
      "utf8",
    );
    expect((await loadLedger(path)).ok).toBe(false);
  });

  it("valori negativi (used/spent) o cap<=0 → err (D3)", async () => {
    const write = (state: object): Promise<void> =>
      writeFile(path, JSON.stringify({ models: { m: state } }), "utf8");

    await write({ economy: "subscription_cap", period: "weekly", cap: 1000, used: -5 });
    expect((await loadLedger(path)).ok).toBe(false);

    await write({ economy: "subscription_cap", period: "weekly", cap: 0, used: 0 });
    expect((await loadLedger(path)).ok).toBe(false);

    await write({ economy: "metered", currency: "USD", spent: -1 });
    expect((await loadLedger(path)).ok).toBe(false);
  });

  it("capped valido completo → ok", async () => {
    await writeFile(
      path,
      JSON.stringify({
        models: { opus: { economy: "subscription_cap", period: "weekly", cap: 100, used: 10 } },
      }),
      "utf8",
    );
    expect((await loadLedger(path)).ok).toBe(true);
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

  // Regressione R1: scritture concorrenti non devono perdersi (lost update).
  // Senza la serializzazione, l'ultimo save sovrascriverebbe i precedenti.
  it("recordActual concorrenti sullo stesso modello sommano tutto (R1)", async () => {
    await saveLedger(sample, path);
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        recordActual("opus", { inputTokens: 60, outputTokens: 40 }, path),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const onDisk = await loadLedger(path);
    expect(onDisk.ok).toBe(true);
    if (onDisk.ok) expect(onDisk.value.models.opus).toMatchObject({ used: N * 100 });
  });
});
