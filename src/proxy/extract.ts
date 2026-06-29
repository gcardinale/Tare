/**
 * Proxy — estrazione del task dalla richiesta (PROXY-01). PURO.
 *
 * Trasforma il corpo di una richiesta Anthropic Messages (`POST /v1/messages`)
 * in un `ClassifyInput` per il nucleo `plan()`. Nessun I/O: il body lo legge il
 * bordo (`server.io.ts`), qui solo logica deterministica e testabile.
 *
 * Mappatura:
 *  - `task`           → testo dell'ULTIMO turno `user` (l'istruzione più fresca).
 *  - `contextTokens`  → stima dei token di TUTTO il resto (system + turni
 *                       precedenti): è il contesto già a carico, non il task.
 *  - `toolsAvailable` → i `name` dell'array `tools`, se presente.
 *
 * La stima dei token è un'euristica grezza (~4 caratteri/token): serve solo a
 * dare un ordine di grandezza al classifier. Il costo REALE arriva dall'`usage`
 * della risposta del provider (recordActual, dopo la run), non da qui.
 */

import type { ClassifyInput, Result } from "../types/index.js";
import { err, ok } from "../types/index.js";

/** Caratteri per token: euristica dichiarata, non un tokenizer. */
const CHARS_PER_TOKEN = 4;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Estrae il testo da un campo `content` Anthropic: stringa diretta, oppure array
 * di blocchi di cui si concatenano i `text` dei blocchi testuali. I blocchi non
 * testuali (tool_use, immagini…) non contribuiscono al testo.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Testo di un campo `system`: stringa o array di blocchi testuali. */
function systemText(system: unknown): string {
  return typeof system === "string" ? system : textOf(system);
}

/** Estrae i nomi dei tool dall'array `tools` (solo voci con `name` stringa). */
function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const t of tools) {
    if (isPlainObject(t) && typeof t.name === "string" && t.name !== "") names.push(t.name);
  }
  return names;
}

/**
 * Costruisce un `ClassifyInput` dal corpo di una richiesta Messages. Puro.
 * `Result.err` se il body non è un oggetto, `messages` non è un array, o non
 * c'è un turno `user` con testo (senza task non c'è nulla da classificare).
 */
export function extractClassifyInput(body: unknown): Result<ClassifyInput> {
  if (!isPlainObject(body)) return err(`richiesta non valida: corpo non è un oggetto`);
  if (!Array.isArray(body.messages)) {
    return err(`richiesta non valida: "messages" deve essere un array`);
  }

  // L'ultimo turno user è il task; deve avere testo.
  let lastUser = -1;
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const msg = body.messages[i];
    if (isPlainObject(msg) && msg.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return err(`richiesta non valida: nessun messaggio "user"`);

  const lastUserMsg = body.messages[lastUser] as Record<string, unknown>;
  const task = textOf(lastUserMsg.content).trim();
  if (task === "") return err(`richiesta non valida: l'ultimo messaggio "user" non ha testo`);

  // Contesto = system + ogni altro messaggio (escluso il task), stimato in token.
  let contextChars = systemText(body.system).length;
  for (let i = 0; i < body.messages.length; i += 1) {
    if (i === lastUser) continue;
    const msg = body.messages[i];
    if (isPlainObject(msg)) contextChars += textOf(msg.content).length;
  }

  const tools = toolNames(body.tools);
  const input: {
    task: string;
    contextTokens: number;
    toolsAvailable?: readonly string[];
  } = {
    task,
    contextTokens: estimateTokens(contextChars),
  };
  if (tools.length > 0) input.toolsAvailable = tools;
  return ok(input);
}
