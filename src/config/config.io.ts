/**
 * Config store — I/O ai bordi (CFG-05..06).
 *
 * Legge `~/.tare/config.jsonc` e delega il parsing al nucleo puro; scrive il
 * template iniziale per `tare init`. Escluso dal coverage core (`.io.ts`),
 * testato comunque su tmp.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * Scrive il template di default (`tare init`). Per sicurezza NON sovrascrive una
 * config esistente a meno di `overwrite: true` (flag `wx` = fallisce se esiste).
 * Ritorna il percorso scritto.
 */
export async function writeDefaultConfig(
  path = defaultConfigPath(),
  overwrite = false,
): Promise<Result<string>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, DEFAULT_CONFIG_JSONC, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
    return ok(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return err(`config già esistente: ${path} (usa overwrite per rigenerarla)`);
    }
    return err(`scrittura config fallita (${path}): ${(e as Error).message}`);
  }
}
