#!/usr/bin/env node
/**
 * Tare CLI — entry point (M3).
 *
 * Comandi reali su config + ledger:
 *   tare init     scrive ~/.tare/config.jsonc (template)
 *   tare status   mostra l'headroom residuo per modello
 * `tare up` avvia il proxy interceptor. La cartella di stato è `~/.tare`,
 * sovrascrivibile con `TARE_DIR`. Questo file è I/O ai bordi: nessuna logica
 * pura qui (vive nei moduli config/ledger/orchestrator, già testati).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { defaultConfigPath, loadConfig, writeDefaultConfig } from "../config/index.js";
import { emptyLedger, headrooms, loadLedger, saveLedger, syncLedger } from "../ledger/index.js";
import { cleanupOrphanTmp, clearPin, readPin, tareDir, writePin } from "../paths.io.js";
import { startProxy } from "../proxy/index.js";

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
  init          Scrive ~/.tare/config.jsonc (usa --force per sovrascrivere)
  status        Mostra il budget residuo (headroom) per modello
  up            Avvia il proxy interceptor su loopback
  use <modello> Forza tutte le richieste su un modello (no riavvio)
  auto          Ripristina il routing automatico (rimuove il forzamento)

Opzioni:
  -f, --force      init: sovrascrive una config esistente
  -p, --port <n>   up: porta del proxy (default 3210)
  -v, --version    Mostra la versione
  -h, --help       Mostra questo aiuto

Suggerimento: puoi anche forzare una SINGOLA richiesta scrivendo nel prompt un tag
[model:nome] (es. "[model:claude] fai questo"). Ha priorità sul forzamento globale.

Cartella di stato: ~/.tare (override: TARE_DIR).`);
}

/** `tare init` — scrive il template di config e inizializza il ledger se assente. */
async function cmdInit(force: boolean): Promise<number> {
  const r = await writeDefaultConfig(defaultConfigPath(), force);
  if (!r.ok) {
    console.error(`tare: ${r.error}`);
    return 1;
  }
  console.log(`tare: config scritta in ${r.value}`);

  // Lascia il sistema pronto all'uso: crea il ledger pre-popolato dai modelli di
  // config (audit C4) SOLO se non esiste già, per non azzerare un budget tracciato.
  const cfg = await loadConfig();
  const led = await loadLedger();
  if (cfg.ok && led.ok && Object.keys(led.value.models).length === 0) {
    const saved = await saveLedger(syncLedger(emptyLedger(), cfg.value.models));
    if (saved.ok) console.log(`tare: ledger inizializzato`);
  }

  console.log(`Modifica la config e poi lancia "tare status".`);
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

  const pin = await readPin();
  console.log(
    pin !== null
      ? `Routing: FORZATO su "${pin}" (ripristina con: tare auto)\n`
      : `Routing: automatico\n`,
  );
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

/** `tare use <modello>` — forza tutte le richieste su un modello (pin persistente). */
async function cmdUse(name: string | undefined): Promise<number> {
  if (name === undefined || name.startsWith("-")) {
    console.error(`tare: uso: tare use <modello>`);
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.ok) {
    console.error(`tare: ${cfg.error}`);
    return 1;
  }
  if (!cfg.value.models.some((m) => m.name === name)) {
    const names = cfg.value.models.map((m) => m.name).join(", ");
    console.error(`tare: modello sconosciuto "${name}". Disponibili: ${names}`);
    return 1;
  }
  await writePin(name);
  console.log(`tare: routing forzato su "${name}". Ripristina con: tare auto`);
  console.log(`(Il proxy in esecuzione lo applica dalla prossima richiesta, senza riavvii.)`);
  return 0;
}

/** `tare auto` — rimuove il forzamento, torna al routing automatico. */
async function cmdAuto(): Promise<number> {
  await clearPin();
  console.log(`tare: routing automatico ripristinato.`);
  return 0;
}

function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return argv.some((a) => names.includes(a));
}

/** Valore di un'opzione `--nome valore` (la prima occorrenza), o undefined. */
function flagValue(argv: readonly string[], ...names: string[]): string | undefined {
  const i = argv.findIndex((a) => names.includes(a));
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * `tare up` — avvia il proxy interceptor su loopback. Carica config+ledger,
 * sincronizza e persiste il ledger (modelli nuovi/cambiati), ripulisce i .tmp
 * orfani (D4), poi resta in ascolto finché non si interrompe (Ctrl-C).
 */
async function cmdUp(argv: readonly string[]): Promise<number> {
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

  const portArg = flagValue(argv, "--port", "-p");
  let port = 3210;
  if (portArg !== undefined) {
    const n = Number(portArg);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      console.error(`tare: porta non valida "${portArg}" (atteso 1..65535)`);
      return 1;
    }
    port = n;
  }

  // Allinea e persisti il ledger ai modelli di config prima di servire.
  await saveLedger(syncLedger(led.value, cfg.value.models));

  const removed = await cleanupOrphanTmp(tareDir());
  if (removed > 0) console.log(`tare: rimossi ${removed} file .tmp orfani`);

  const { url } = await startProxy({ port });
  console.log(`tare: proxy in ascolto su ${url}`);
  console.log(`Punta il tuo agente:  export ANTHROPIC_BASE_URL=${url}`);
  console.log(`Modelli: ${cfg.value.models.map((m) => m.name).join(", ")}. Ctrl-C per fermare.`);

  // Il preflight è in-band: la scheda col prezzo appare NEL terminale dell'agente,
  // non qui. Un promemoria di cosa aspettarsi e come rispondere.
  const mode = cfg.value.policy.preflight ?? "auto";
  if (mode === "off") {
    console.log(`Preflight: off — instrada senza chiedere (mostra solo un log).`);
  } else {
    const when = mode === "always" ? "ogni task" : "i task non economici";
    console.log(
      `Preflight: ${mode} — per ${when} l'agente riceve una scheda col prezzo; ` +
        `rispondi nel suo terminale con  ok · ok:<modello> · no.`,
    );
  }

  // Resta vivo: il server tiene aperto l'event loop, non risolviamo l'exit code.
  return new Promise<number>(() => {});
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
    case "up":
      return cmdUp(argv.slice(1));
    case "use":
      return cmdUse(argv[1]);
    case "auto":
      return cmdAuto();
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
