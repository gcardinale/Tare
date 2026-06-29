/**
 * Ledger store — I/O ai bordi (LDG-06..07).
 *
 * Tutto ciò che tocca il filesystem vive qui, isolato dal nucleo puro
 * (`ledger.ts`). La scrittura è ATOMICA (write su tmp + rename) così un crash a
 * metà non lascia mai un `ledger.json` corrotto. Errori attesi → `Result`, non
 * throw. Escluso dal coverage core (suffisso `.io.ts`): testato lo stesso su tmp.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BudgetState, Ledger, Result, Usage } from "../types/index.js";
import { err, ok } from "../types/index.js";
import { tareDir } from "../paths.io.js";
import { emptyLedger, recordUsage } from "./ledger.js";

/** Percorso di default del ledger: `<TARE_DIR>/ledger.json` (default `~/.tare`). */
export function defaultLedgerPath(): string {
  return join(tareDir(), "ledger.json");
}

/**
 * Oggetto plain (non null, non array). Serve perché `typeof null === "object"` e
 * `typeof [] === "object"`: senza questo controllo `{ "models": null }` o
 * `{ "models": [] }` passerebbero per una mappa di modelli valida.
 */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Valida la forma di UNO stato di budget letto da disco. Il bordo deve garantire
 * al nucleo puro input ben formati: senza questo, un metered senza `spent`
 * propagherebbe `NaN` nel budget (spent = undefined + costo).
 */
function isBudgetState(x: unknown): x is BudgetState {
  if (!isPlainObject(x)) return false;
  if (x.economy === "metered") {
    return typeof x.currency === "string" && isFiniteNumber(x.spent);
  }
  if (x.economy === "subscription_cap" || x.economy === "tiered_quota") {
    return (
      (x.period === "weekly" || x.period === "monthly") &&
      isFiniteNumber(x.cap) &&
      isFiniteNumber(x.used)
    );
  }
  return false;
}

/**
 * Carica il ledger. File assente → ledger vuoto (ok): è lo stato iniziale legittimo,
 * non un errore. JSON malformato → err (non si sovrascrive ciò che non si capisce).
 */
export async function loadLedger(path = defaultLedgerPath()): Promise<Result<Ledger>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok(emptyLedger());
    return err(`lettura ledger fallita (${path}): ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(`ledger JSON non valido (${path}): ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.models)) {
    return err(`ledger malformato (${path}): "models" deve essere un oggetto`);
  }
  for (const [name, state] of Object.entries(parsed.models)) {
    if (!isBudgetState(state)) {
      return err(`ledger malformato (${path}): stato di budget non valido per "${name}"`);
    }
  }
  return ok(parsed as unknown as Ledger);
}

/**
 * Salva il ledger in modo atomico: scrive su un file temporaneo nella stessa
 * cartella e poi lo rinomina sul target (rename atomico su stesso filesystem).
 */
export async function saveLedger(
  ledger: Ledger,
  path = defaultLedgerPath(),
): Promise<Result<void>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(tmp, path);
    return ok(undefined);
  } catch (e) {
    return err(`scrittura ledger fallita (${path}): ${(e as Error).message}`);
  }
}

/**
 * Registra il consumo reale di un run e persiste: load → recordUsage (puro) →
 * save atomico. Ritorna il ledger aggiornato. Qualsiasi errore (I/O o modello
 * sconosciuto) ferma la catena con un `Result.err`, senza scrivere nulla.
 */
export async function recordActual(
  model: string,
  usage: Usage,
  path = defaultLedgerPath(),
): Promise<Result<Ledger>> {
  const loaded = await loadLedger(path);
  if (!loaded.ok) return loaded;

  const updated = recordUsage(loaded.value, model, usage);
  if (!updated.ok) return updated;

  const saved = await saveLedger(updated.value, path);
  if (!saved.ok) return saved;

  return ok(updated.value);
}
