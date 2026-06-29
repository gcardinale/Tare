/**
 * Ledger store — I/O ai bordi (LDG-06..07).
 *
 * Tutto ciò che tocca il filesystem vive qui, isolato dal nucleo puro
 * (`ledger.ts`). La scrittura è ATOMICA (write su tmp + rename) così un crash a
 * metà non lascia mai un `ledger.json` corrotto. Errori attesi → `Result`, non
 * throw. Escluso dal coverage core (suffisso `.io.ts`): testato lo stesso su tmp.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Ledger, Result, Usage } from "../types/index.js";
import { err, ok } from "../types/index.js";
import { emptyLedger, recordUsage } from "./ledger.js";

/** Percorso di default del ledger: `~/.tare/ledger.json`. */
export function defaultLedgerPath(): string {
  return join(homedir(), ".tare", "ledger.json");
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
  try {
    const parsed = JSON.parse(raw) as Ledger;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.models !== "object") {
      return err(`ledger malformato (${path}): manca "models"`);
    }
    return ok(parsed);
  } catch (e) {
    return err(`ledger JSON non valido (${path}): ${(e as Error).message}`);
  }
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
