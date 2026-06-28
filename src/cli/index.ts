#!/usr/bin/env node
/**
 * Tare CLI — entry point (stub).
 *
 * I comandi reali (`tare up` / `tare init` / `tare status`) arrivano in M3:
 * vedi `features/cli/tasks.md` (CLI-04..08). Per ora questo stub esiste per dare
 * a build/dev/`npm i -g` un entry coerente (risolve F-01 dell'audit 28/06).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

Comandi (in arrivo — M3):
  init      Scrive ~/.tare/config.jsonc
  up        Avvia proxy + ledger + classifier locale
  status    Mostra il budget residuo per economia

Opzioni:
  -v, --version   Mostra la versione
  -h, --help      Mostra questo aiuto

Stato: pre-alpha. I comandi non sono ancora implementati.`);
}

/** Ritorna l'exit code; nessun comando = uso errato (1). */
function main(argv: readonly string[]): number {
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") {
    console.log(readVersion());
    return 0;
  }
  if (cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }
  if (cmd === undefined) {
    printHelp();
    return 1;
  }
  console.error(`tare: comando sconosciuto "${cmd}". Prova "tare --help".`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
