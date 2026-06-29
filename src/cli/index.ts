#!/usr/bin/env node
/**
 * Tare CLI — entry point (M3).
 *
 * Comandi reali su config + ledger:
 *   tare init     scrive ~/.tare/config.jsonc (template)
 *   tare status   mostra l'headroom residuo per modello
 * `tare up` (proxy interceptor) arriva in M4. La cartella di stato è `~/.tare`,
 * sovrascrivibile con `TARE_DIR`. Questo file è I/O ai bordi: nessuna logica
 * pura qui (vive nei moduli config/ledger/orchestrator, già testati).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { defaultConfigPath, loadConfig, writeDefaultConfig } from "../config/index.js";
import { headrooms, loadLedger, syncLedger } from "../ledger/index.js";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dev: src/cli → ../../package.json ; build: dist → ../package.json
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // prova il percorso successivo
    }
  }
  return "0.0.0";
}

function printHelp(): void {
  const v = readVersion();
  console.log(`tare — preflight budget-aware per agenti di coding AI (v${v})

Uso:
  tare <comando> [opzioni]

Comandi:
  init        Scrive ~/.tare/config.jsonc (usa --force per sovrascrivere)
  status      Mostra il budget residuo (headroom) per modello
  up          Avvia il proxy interceptor (in arrivo — M4)

Opzioni:
  -f, --force     init: sovrascrive una config esistente
  -v, --version   Mostra la versione
  -h, --help      Mostra questo aiuto

Stato: pre-alpha. Cartella di stato: ~/.tare (override: TARE_DIR).`);
}

/** `tare init` — scrive il template di config. */
async function cmdInit(force: boolean): Promise<number> {
  const r = await writeDefaultConfig(defaultConfigPath(), force);
  if (!r.ok) {
    console.error(`tare: ${r.error}`);
    return 1;
  }
  console.log(`tare: config scritta in ${r.value}`);
  console.log(`Modificala e poi lancia "tare status".`);
  return 0;
}

/** `tare status` — headroom residuo per modello, leggendo config + ledger. */
async function cmdStatus(): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.ok) {
    console.error(`tare: ${cfg.error}`);
    return 1;
  }
  const led = await loadLedger();
  if (!led.ok) {
    console.error(`tare: ${led.error}`);
    return 1;
  }

  // Allinea il ledger ai modelli di config (modelli nuovi → budget pieno).
  const hr = headrooms(syncLedger(led.value, cfg.value.models));

  console.log(`Budget Tare — headroom residuo per modello:\n`);
  for (const m of cfg.value.models) {
    const pct = Math.round((hr[m.name] ?? 0) * 100);
    const note = m.economy === "metered" ? "  (a consumo, nessun tetto)" : "";
    console.log(
      `  ${m.name.padEnd(12)} ${m.economy.padEnd(18)} ${String(pct).padStart(3)}%${note}`,
    );
  }
  return 0;
}

function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return argv.some((a) => names.includes(a));
}

/** Ritorna l'exit code. Nessun comando = uso errato (1). */
async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case "--version":
    case "-v":
      console.log(readVersion());
      return 0;
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "init":
      return cmdInit(hasFlag(argv, "--force", "-f"));
    case "status":
      return cmdStatus();
    case undefined:
      printHelp();
      return 1;
    default:
      console.error(`tare: comando sconosciuto "${cmd}". Prova "tare --help".`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(`tare: errore inatteso: ${(e as Error).message}`);
    process.exit(1);
  });
