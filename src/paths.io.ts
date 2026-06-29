/**
 * Percorsi di Tare — I/O ai bordi.
 *
 * Punto unico per la cartella di stato. Di default `~/.tare`, ma `TARE_DIR`
 * la sovrascrive: utile per test isolati e per chi tiene lo stato altrove.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** La cartella di stato di Tare: `$TARE_DIR` se impostata, altrimenti `~/.tare`. */
export function tareDir(): string {
  return process.env.TARE_DIR ?? join(homedir(), ".tare");
}
