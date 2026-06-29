/**
 * Config store — I/O ai bordi (CFG-05..06).
 *
 * Legge `~/.tare/config.jsonc` e delega il parsing al nucleo puro; scrive il
 * template iniziale per `tare init`. Escluso dal coverage core (`.io.ts`),
 * testato comunque su tmp.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Result, TareConfig } from "../types/index.js";
import { err, ok } from "../types/index.js";
import { DEFAULT_CONFIG_JSONC, parseConfig } from "./config.js";

/** Percorso di default della config: `~/.tare/config.jsonc`. */
export function defaultConfigPath(): string {
  return join(homedir(), ".tare", "config.jsonc");
}

/**
 * Carica e valida la config. File assente → err con suggerimento `tare init`
 * (la config NON ha un default silenzioso: senza modelli non si instrada nulla).
 */
export async function loadConfig(path = defaultConfigPath()): Promise<Result<TareConfig>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return err(`config non trovata: ${path} — esegui "tare init"`);
    }
    return err(`lettura config fallita (${path}): ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Scrive il template di default (`tare init`). NON sovrascrive una config esistente
 * a meno di `overwrite: true`. Scrittura ATOMICA (tmp + rename), simmetrica con
 * `saveLedger`: un crash a metà non lascia mai una config troncata (audit B6).
 * Ritorna il percorso scritto.
 */
export async function writeDefaultConfig(
  path = defaultConfigPath(),
  overwrite = false,
): Promise<Result<string>> {
  try {
    if (!overwrite && (await exists(path))) {
      return err(`config già esistente: ${path} (usa overwrite per rigenerarla)`);
    }
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, DEFAULT_CONFIG_JSONC, "utf8");
    await rename(tmp, path);
    return ok(path);
  } catch (e) {
    return err(`scrittura config fallita (${path}): ${(e as Error).message}`);
  }
}
