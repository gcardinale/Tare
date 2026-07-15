/**
 * Proxy — gate di preflight IN-BAND (PROXY-04). PURO.
 *
 * Il preflight non è un log: è un CANCELLO. Quando un task non è auto-pass il
 * proxy NON inoltra — sintetizza una risposta in formato Anthropic con la scheda
 * di preflight (stima + alternative) e la restituisce al client come turno
 * dell'assistente. L'utente la legge NEL PROPRIO terminale (quello dell'agente,
 * non quello di `tare up`) e risponde `ok` / `ok:<modello>` / `no`.
 *
 * Perché in-band e non sullo stdin di `tare up`:
 *  - l'utente guarda il terminale dell'agente, non quello del proxy;
 *  - tenere appesa la richiesta HTTP in attesa di un tasto la porta al timeout
 *    del client e non funziona affatto se il proxy gira in background.
 * Precedente nello stesso codice: il tag `[model:nome]` (`parseForcedModel`) è
 * già un canale di controllo in-band.
 *
 * SENZA STATO: l'approvazione vive nella conversazione stessa (il client rimanda
 * l'intera cronologia a ogni passo), quindi il verdetto è una funzione PURA del
 * corpo della richiesta — niente Map di sessioni, niente TTL, niente da ripulire.
 * `stripGateTurns` toglie scheda e risposta prima dell'inoltro: l'upstream vede
 * la conversazione originale, come se il cancello non fosse mai esistito.
 */

import type { Classification, CostRange, ModelConfig, Plan, RouteCandidate } from "../types/index.js";

/**
 * Marcatore della scheda di preflight. Serve a due cose: riconoscere le NOSTRE
 * schede nella cronologia (per toglierle prima dell'inoltro) e validare che un
 * `ok` sia davvero la risposta a un cancello e non una parola qualsiasi.
 */
export const GATE_MARKER = "⚖️ tare — preflight";

/** Testo restituito quando l'utente rifiuta: la run non parte, niente è speso. */
export const GATE_REJECTED_TEXT = `${GATE_MARKER}\nAnnullato. Nessun token speso.`;

/**
 * Soglia di `max_tokens` sotto la quale non si mette il cancello, se la richiesta
 * non porta tool. Gli agenti reali (Claude Code) affiancano al loop principale
 * chiamate di servizio piccole e senza tool (titolo della conversazione, ecc.):
 * gatearle significherebbe rispondere una scheda al posto di un titolo. Il loop
 * vero porta sempre dei `tools`, quindi il discriminante è affidabile.
 */
const GATE_MIN_MAX_TOKENS = 1024;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Testo dei blocchi testuali di un `content` Anthropic (stringa o array di blocchi). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (isPlainObject(b) && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

// ─── Risposta dell'utente al cancello ───────────────────────────────────────

/** Verdetto dell'utente sulla scheda di preflight. */
export type GateReply =
  /** Approvato; `model` non-null se l'utente ha scelto un'alternativa (`ok:deepseek`). */
  | { readonly kind: "approved"; readonly model: string | null }
  /** Rifiutato: la run non parte. */
  | { readonly kind: "rejected" }
  /** Nessuna risposta a un cancello in questa richiesta. */
  | { readonly kind: "none" };

const APPROVE_RE = /^(?:ok|okay|va bene|sì|si|yes|y)(?:\s*[:\s]\s*([A-Za-z0-9._-]+))?$/i;
const REJECT_RE = /^(?:no|n|annulla|stop|cancel)$/i;

/**
 * Interpreta il TESTO di un turno utente come risposta al cancello. Puro.
 * L'intero messaggio dev'essere la risposta (`ok`, `ok:deepseek`, `no`): un `ok`
 * dentro una frase più lunga è testo normale, non un'approvazione.
 */
export function parseApproval(text: string): GateReply {
  const t = text.trim();
  const a = APPROVE_RE.exec(t);
  if (a) return { kind: "approved", model: a[1] ?? null };
  if (REJECT_RE.test(t)) return { kind: "rejected" };
  return { kind: "none" };
}

/**
 * Verdetto sul corpo di una richiesta: un `ok`/`no` conta SOLO se il messaggio
 * assistente immediatamente precedente è una nostra scheda di preflight. Puro.
 * Senza questo vincolo un `ok` scritto per altri motivi farebbe passare un task
 * mai approvato — il cancello deve rispondere a una domanda che abbiamo fatto noi.
 */
export function readGateReply(body: unknown): GateReply {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return { kind: "none" };
  const msgs = body.messages;
  // Ultimo turno utente CON testo (nei loop l'ultimo messaggio è un tool_result).
  let i = msgs.length - 1;
  for (; i >= 0; i -= 1) {
    const m = msgs[i];
    if (isPlainObject(m) && m.role === "user" && textOf(m.content).trim() !== "") break;
  }
  if (i < 0) return { kind: "none" };

  const reply = parseApproval(textOf((msgs[i] as Record<string, unknown>).content));
  if (reply.kind === "none") return reply;

  // Il messaggio precedente dev'essere la NOSTRA scheda.
  const prev = msgs[i - 1];
  const isOurCard =
    isPlainObject(prev) && prev.role === "assistant" && textOf(prev.content).includes(GATE_MARKER);
  return isOurCard ? reply : { kind: "none" };
}

/**
 * Toglie dalla cronologia le schede di preflight e le risposte al cancello. Puro.
 * L'upstream non deve mai vedere il nostro dialogo di controllo: riceve la
 * conversazione originale (…, task utente) come se il cancello non ci fosse.
 * Si applica SEMPRE prima dell'inoltro, anche alle schede di task precedenti.
 */
export function stripGateTurns(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return body;
  const msgs = body.messages;
  const keep: unknown[] = [];
  let dropped = false;
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    const isCard =
      isPlainObject(m) && m.role === "assistant" && textOf(m.content).includes(GATE_MARKER);
    if (isCard) {
      dropped = true;
      // La risposta utente che segue la scheda (`ok`, `no`) è parte del dialogo
      // di controllo: va via anche lei. Altro testo utente è un task vero: resta.
      const next = msgs[i + 1];
      if (
        isPlainObject(next) &&
        next.role === "user" &&
        parseApproval(textOf(next.content)).kind !== "none"
      ) {
        i += 1;
      }
      continue;
    }
    keep.push(m);
  }
  return dropped ? { ...body, messages: keep } : body;
}

/**
 * `true` se questa richiesta è un turno su cui ha senso mettere il cancello: un
 * messaggio utente CON testo in coda (una nuova istruzione), non la continuazione
 * di un loop agentico (dove l'ultimo messaggio è un `tool_result` senza testo:
 * il task era già stato approvato al primo giro). Vedi `GATE_MIN_MAX_TOKENS` per
 * l'esclusione delle chiamate di servizio dell'agente.
 */
export function isGateableTurn(body: unknown): boolean {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return false;
  const last = body.messages[body.messages.length - 1];
  if (!isPlainObject(last) || last.role !== "user" || textOf(last.content).trim() === "") {
    return false;
  }
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  return hasTools || maxTokens >= GATE_MIN_MAX_TOKENS;
}

// ─── La scheda ──────────────────────────────────────────────────────────────

/** Token in forma compatta: 1500 → "1.5k", 180000 → "180k". */
function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
}

/** Percentuale leggibile: 3 → "3%", 0.42 → "0.4%". */
function fmtPct(n: number): string {
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%`;
}

/** Denaro leggibile con la valuta del modello: 0.0412 → "0.04 USD". */
function fmtMoney(n: number, currency: string): string {
  return `${n < 0.01 ? n.toFixed(4) : n.toFixed(2)} ${currency}`;
}

/**
 * Rende una stima nell'unità della sua economia: percentuale di cap/quota (col
 * periodo del modello) o denaro. Puro. `models` serve solo a leggere periodo e
 * valuta del modello candidato; se manca, si degrada a una resa senza unità.
 */
function fmtEstimate(est: CostRange, model: ModelConfig | undefined): string {
  if (est.unit === "currency") {
    const currency = model !== undefined && model.economy === "metered" ? model.currency : "USD";
    return `${fmtMoney(est.low, currency)}–${fmtMoney(est.high, currency)}`;
  }
  const period =
    model !== undefined && model.economy !== "metered"
      ? model.period === "weekly"
        ? " settimanale"
        : " mensile"
      : "";
  const what = est.unit === "pct_cap" ? "del cap" : "della quota";
  return `${fmtPct(est.low)}–${fmtPct(est.high)} ${what}${period}`;
}

/** Riga di un candidato nella scheda. */
function candidateLine(
  c: RouteCandidate,
  models: readonly ModelConfig[],
  chosen: boolean,
): string {
  const model = models.find((m) => m.name === c.model);
  const mode = c.mode === "agentic" ? "agentic" : "single-pass";
  const tag = chosen ? "  ← scelto" : "";
  return `  → ${c.model.padEnd(12)} ${fmtEstimate(c.estimate, model)} · ${mode}${tag}`;
}

/** Riepilogo della classificazione: quanto pesa il task e con che confidenza. */
function taskLine(cl: Classification): string {
  const band = `${fmtTokens(cl.tokenBand[0])}–${fmtTokens(cl.tokenBand[1])} token`;
  const steps = cl.mode === "agentic" ? ` · ~${cl.expectedSteps} step` : "";
  const conf = `confidenza ${Math.round(cl.confidence * 100)}%`;
  return `  ${cl.mode === "agentic" ? "agentic" : "single-pass"}${steps} · ${band} · ${conf}`;
}

/**
 * La scheda di preflight che l'utente legge nel proprio terminale. Pura.
 * Mostra COSA costa (fascia di token), DOVE andrebbe (modello scelto), COSA
 * COSTA LÌ (nell'unità di quell'economia) e le alternative con il loro prezzo —
 * il confronto fra abbonamento e API a consumo nello stesso riquadro.
 */
export function formatPreflightCard(plan: Plan, models: readonly ModelConfig[]): string {
  const { classification, decision } = plan;
  const lines = [GATE_MARKER, taskLine(classification), "", candidateLine(decision, models, true)];
  for (const alt of decision.alternatives) lines.push(candidateLine(alt, models, false));
  lines.push("", "  rispondi:  ok  ·  ok:<modello>  ·  no");
  return lines.join("\n");
}

// ─── Risposta sintetica in formato Anthropic ────────────────────────────────

/** Id della risposta sintetica: fisso e riconoscibile (non è una vera run). */
const GATE_MESSAGE_ID = "msg_tare_preflight";

/**
 * Risposta NON-streaming in formato Anthropic Messages che porta la scheda al
 * client. Pura. `usage` a zero: non abbiamo chiamato nessun modello, e il ledger
 * non deve registrare nulla — è esattamente il punto del cancello.
 */
export function buildGateMessage(text: string, clientModel: string | undefined): unknown {
  return {
    id: GATE_MESSAGE_ID,
    type: "message",
    role: "assistant",
    model: clientModel ?? "tare",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * La stessa scheda come stream SSE Anthropic (gli agenti chiedono `stream: true`).
 * Pura: ritorna l'intero stream come stringa, che il bordo scrive in un colpo solo.
 * Sequenza minima ma completa, quella che un client Anthropic si aspetta:
 * message_start → content_block_start → delta → stop → message_delta → message_stop.
 */
export function buildGateSse(text: string, clientModel: string | undefined): string {
  const message = {
    id: GATE_MESSAGE_ID,
    type: "message",
    role: "assistant",
    model: clientModel ?? "tare",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const events: readonly (readonly [string, unknown])[] = [
    ["message_start", { type: "message_start", message }],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}
