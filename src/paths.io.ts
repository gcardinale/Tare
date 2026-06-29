/**
 * Percorsi di Tare — I/O ai bordi.
 *
 * Punto unico per la cartella di stato. Di default `~/.tare`, ma `TARE_DIR`
 * la sovrascrive: utile per test isolati e per chi tiene lo stato altrove.
 */

import { readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** La cartella di stato di Tare: `$TARE_DIR` se impostata, altrimenti `~/.tare`. */
export function tareDir(): string {
  return process.env.TARE_DIR ?? join(homedir(), ".tare");
}

/**
 * Solo i tmp generati dalle scritture atomiche di Tare: `config.jsonc.<n>.tmp`,
 * `ledger.json.<pid>.<seq>.tmp`, ecc. Non tocca `.tmp` di altri tool/utente (R5).
 */
const TARE_TMP_RE = /^(config\.jsonc|ledger\.json)(\.\d+)+\.tmp$/;

/**
 * Rimuove i file `.tmp` orfani di Tare nella cartella di stato (audit D4). Le
 * scritture atomiche di config/ledger usano `<file>.<pid>.<seq>.tmp` + rename; un
 * crash a metà può lasciarne indietro. `tare up` ripulisce all'avvio. Best-effort:
 * la cartella assente non è un errore, i file non rimovibili vengono ignorati.
 * Ritorna il numero di file effettivamente rimossi.
 */
export async function cleanupOrphanTmp(dir = tareDir()): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  let removed = 0;
  for (const name of entries) {
    if (!TARE_TMP_RE.test(name)) continue;
    try {
      await unlink(join(dir, name));
      removed += 1;
    } catch {
      // file già sparito o non rimovibile: lo si ignora.
    }
  }
  return removed;
}
