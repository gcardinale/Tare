/**
 * Classifier — logica PURA, locale, rule-based (CLS-02..04).
 *
 * Misura un task e risponde: single_pass o agentico, quanti step, fascia di
 * token, confidenza. Nessun I/O, nessuna rete: è il fallback gratuito che
 * funziona sempre. Il giudice su modello locale (CLS-06..09) lo raffinerà.
 *
 * Le euristiche sono volutamente trasparenti e bilingue (IT/EN), così un umano
 * può leggerle e correggerle. Vedi `ai/decisions.md → DEC-CLASS-1`.
 */

import type { Classification, ClassifyInput, Mode, Role } from "../types/index.js";

/** Contesto di default quando il chiamante non lo fornisce (prompt piccolo tipico). */
const DEFAULT_CONTEXT_TOKENS = 4000;

/** Verbi/segnali che spingono verso l'agentico (esplorativo, multi-step). */
const AGENTIC_TERMS: readonly string[] = [
  // EN
  "debug",
  "fix",
  "investigate",
  "refactor",
  "implement",
  "build",
  "scaffold",
  "migrate",
  "explore",
  "trace",
  "diagnose",
  "why is",
  "why does",
  "across",
  "codebase",
  "end-to-end",
  "step by step",
  "multiple files",
  "several files",
  // IT
  "correggi",
  "sistema",
  "risolvi",
  "indaga",
  "refactoring",
  "implementa",
  "aggiungi",
  "esplora",
  "diagnostica",
  "perché",
  "perche",
  "più file",
  "piu file",
  "vari file",
];

/** Verbi/segnali che spingono verso la passata singola (delimitato, ben definito). */
const SINGLE_PASS_TERMS: readonly string[] = [
  // EN
  "translate",
  "summarize",
  "summary",
  "review",
  "critique",
  "explain",
  "rename",
  "format",
  "docstring",
  "comment",
  "rephrase",
  "rewrite this",
  "typo",
  // IT
  "traduci",
  "riassumi",
  "riassunto",
  "rivedi",
  "spiega",
  "rinomina",
  "formatta",
  "commenta",
  "riscrivi questo",
  "correggi il refuso",
];

/** Segnali di un task di REVISIONE (esamina codice esistente). */
const REVIEW_TERMS: readonly string[] = [
  // EN
  "review",
  "code review",
  "critique",
  "audit",
  "inspect",
  "analyze",
  "analyse",
  "analysis",
  "find bugs",
  "look for bugs",
  "lint",
  // IT
  "rivedi",
  "revisiona",
  "revisione",
  "critica",
  "valuta",
  "controlla",
  "ispeziona",
  "analizza",
  "trova bug",
  "cerca bug",
  "verifica",
];

/** Segnali di un task di SCRITTURA (produce o modifica codice). */
const WRITE_TERMS: readonly string[] = [
  // EN
  "write",
  "implement",
  "add",
  "create",
  "build",
  "scaffold",
  "refactor",
  "fix",
  "rewrite",
  "generate",
  // IT
  "scrivi",
  "implementa",
  "aggiungi",
  "crea",
  "costruisci",
  "genera",
  "correggi",
  "sistema",
  "rifattorizza",
  "riscrivi",
];

/** Tool che indicano capacità di agire (edit/exec) → più probabilità di loop. */
const ACTION_TOOLS: readonly string[] = [
  "edit",
  "write",
  "bash",
  "shell",
  "apply_patch",
  "str_replace",
  "run",
  "exec",
];

/** Mette in escape i metacaratteri regex di un termine. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Conta quante voci della lista compaiono nel testo come PAROLA intera (max 1 per
 * voce). Il confine è unicode-aware: niente `\b` ASCII, che mancherebbe i termini
 * accentati italiani (`perché`, `più file`). Evita falsi positivi tipo
 * `prefix` → `fix` o `preview` → `review` (F-03 dell'audit 28/06).
 */
function countMatches(haystack: string, terms: readonly string[]): number {
  let n = 0;
  for (const t of terms) {
    // Whitespace interno del termine → `\s+`, così doppi spazi/tab/newline nel testo
    // non rompono i termini multi-parola (es. "più  file", "step\tby\tstep") (C5).
    const body = escapeRegExp(t).replace(/\s+/g, "\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(haystack)) n += 1;
  }
  return n;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Rileva il ruolo del task (review/write), asse ortogonale alla modalità. Un tag
 * esplicito `[review]`/`[write]` nel prompt VINCE sull'euristica (override). Altrimenti
 * si contano i segnali testuali: prevale il gruppo più numeroso; pari/zero → unknown.
 */
function detectRole(task: string): Role | "unknown" {
  const hasReviewTag = /\[\s*review\s*\]/i.test(task);
  const hasWriteTag = /\[\s*write\s*\]/i.test(task);
  if (hasReviewTag && !hasWriteTag) return "review";
  if (hasWriteTag && !hasReviewTag) return "write";

  const text = task.toLowerCase();
  const review = countMatches(text, REVIEW_TERMS);
  const write = countMatches(text, WRITE_TERMS);
  if (review > write) return "review";
  if (write > review) return "write";
  return "unknown";
}

/**
 * Classifica un task. Funzione pura e deterministica.
 *
 * Strategia: si calcola un punteggio netto pro-agentico da segnali testuali,
 * lunghezza, tool d'azione e dimensione del contesto. Il segno del punteggio
 * decide la modalità; la sua distanza dalla soglia decide la confidenza.
 */
export function classify(input: ClassifyInput): Classification {
  const text = input.task.toLowerCase();
  const contextTokens = Math.max(0, input.contextTokens ?? DEFAULT_CONTEXT_TOKENS);
  const tools = input.toolsAvailable ?? [];

  const agenticHits = countMatches(text, AGENTIC_TERMS);
  const singlePassHits = countMatches(text, SINGLE_PASS_TERMS);
  const hasActionTool = tools.some((t) => ACTION_TOOLS.includes(t.toLowerCase()));
  const isLong = input.task.length > 280;
  const bigContext = contextTokens > 20000;

  // Punteggio netto: positivo → agentico, negativo/zero → passata singola.
  let score = 0;
  score += agenticHits * 2;
  score -= singlePassHits * 2;
  if (hasActionTool) score += 1;
  if (isLong) score += 1;
  if (bigContext) score += 1;

  const AGENTIC_THRESHOLD = 2;
  const mode: Mode = score >= AGENTIC_THRESHOLD ? "agentic" : "single_pass";

  const expectedSteps =
    mode === "single_pass" ? 1 : clamp(3 + Math.floor((score - AGENTIC_THRESHOLD) / 2), 3, 12);

  const tokenBand = estimateTokenBand(mode, contextTokens, expectedSteps);

  // Confidenza: cresce con la distanza dalla soglia (segnale netto e chiaro),
  // resta bassa nei casi ambigui vicino al confine. Mai finta-precisa.
  const distance = Math.abs(score - AGENTIC_THRESHOLD);
  const confidence = clamp(0.45 + distance * 0.08, 0.3, 0.85);

  const role = detectRole(input.task);

  return { mode, expectedSteps, tokenBand, confidence, role };
}

/**
 * Fascia di token grezza. L'estimator raffinerà il costo per modello; qui basta
 * un ordine di grandezza onesto. L'agentico modella lo *snowball*: il contesto
 * viene ri-inviato e cresce a ogni step.
 */
function estimateTokenBand(
  mode: Mode,
  contextTokens: number,
  steps: number,
): readonly [number, number] {
  if (mode === "single_pass") {
    // Una richiesta + output: contesto + un margine di generazione.
    const low = Math.round(contextTokens + 300);
    const high = Math.round(contextTokens + 4000);
    return [low, high];
  }
  // Snowball sublineare: ~ contextTokens * (1 + steps * fattore). Floor sul
  // contesto: anche senza contesto un loop agentico genera/legge token, quindi
  // la banda non deve mai collassare a [0,0] (F-04 dell'audit 28/06).
  const ctx = Math.max(contextTokens, 300);
  const low = Math.round(ctx * (1 + steps * 0.4));
  const high = Math.round(ctx * (1 + steps * 0.9));
  return [low, high];
}
