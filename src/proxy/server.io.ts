/**
 * Proxy interceptor — I/O ai bordi (PROXY-03). M4.
 *
 * Server HTTP su loopback con cui l'agente parla (via `ANTHROPIC_BASE_URL`) al
 * posto del provider. Su `POST /v1/messages` applica il nucleo: estrae il task →
 * `plan()` → logga il preflight → inoltra al `baseUrl`+chiave del modello scelto
 * (routing ENFORCING) → registra il consumo reale.
 *  - Non-streaming: bufferizza la risposta, registra dall'`usage` JSON PRIMA di
 *    rispondere (la richiesta successiva vede il budget aggiornato).
 *  - Streaming (SSE): relaya gli eventi al client in tempo reale e in parallelo
 *    accumula lo stream per estrarne l'`usage` (`message_start`/`message_delta`);
 *    registra a stream concluso (l'usage si conosce solo alla fine).
 * Ogni altra rotta va in passthrough trasparente all'upstream di fallback.
 *
 * Filosofia ai bordi: se qualcosa nel routing non torna (config assente, nessun
 * modello idoneo, chiave mancante) NON si blocca l'agente — si logga e si fa
 * passthrough. Meglio una run non instradata che un agente fermo. La logica di
 * decisione è pura e testata (`forward.ts`, `plan()`); qui c'è solo il wiring.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ModelConfig } from "../types/index.js";
import { loadConfig } from "../config/index.js";
import { loadLedger, recordActual, syncLedger } from "../ledger/index.js";
import { plan } from "../orchestrator/index.js";
import { extractClassifyInput } from "./extract.js";
import {
  buildForwardHeaders,
  extractSseUsage,
  extractUsageTokens,
  formatPreflight,
  isStreamingRequest,
  resolveApiKey,
  resolveUpstreamBase,
  toUsage,
  withUpstreamModel,
} from "./forward.js";

/** Upstream di default quando un modello non specifica `baseUrl` o per il passthrough. */
const DEFAULT_UPSTREAM = "https://api.anthropic.com";

/** Tetto di sicurezza sul corpo richiesta (audit R2). Generoso: i contesti grandi
 * pesano vari MB; serve solo a fermare un client che inonda la memoria. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Timeout di lettura del corpo (audit R2): una connessione lenta non resta appesa. */
const BODY_TIMEOUT_MS = 120_000;

export interface ProxyOptions {
  readonly host?: string;
  readonly port?: number;
  /** Upstream per passthrough e per i modelli senza `baseUrl`. */
  readonly fallbackBaseUrl?: string;
  /** Ambiente da cui leggere le chiavi (`apiKeyEnv`). Default `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Logger di una riga (preflight, warning). Default `console.error`. */
  readonly logger?: (message: string) => void;
}

type FetchLike = typeof fetch;

interface Resolved {
  host: string;
  port: number;
  fallbackBaseUrl: string;
  env: Record<string, string | undefined>;
  log: (m: string) => void;
}

function resolveOptions(opts: ProxyOptions): Resolved {
  return {
    host: opts.host ?? "127.0.0.1",
    port: opts.port ?? 3210,
    fallbackBaseUrl: opts.fallbackBaseUrl ?? process.env.TARE_UPSTREAM_BASE_URL ?? DEFAULT_UPSTREAM,
    env: opts.env ?? process.env,
    log: opts.logger ?? ((m: string): void => console.error(m)),
  };
}

/**
 * Legge tutto il corpo della richiesta come stringa UTF-8, con tetto sulla
 * dimensione e timeout (audit R2): un client che non invia mai i dati o inonda
 * la memoria non tiene appesa né satura il processo.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("timeout lettura corpo richiesta"));
    }, BODY_TIMEOUT_MS);
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        done(() => reject(new Error("corpo richiesta troppo grande")));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (e) => done(() => reject(e)));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/** Header di risposta upstream da reinoltrare al client (saltando quelli da ricalcolare). */
function relayHeaders(upstream: Response): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (key === "content-length" || key === "content-encoding" || key === "transfer-encoding")
      return;
    out[key] = v;
  });
  return out;
}

/**
 * Pipe del corpo (web stream) della risposta upstream al client, byte per byte.
 * Se lo stream upstream si interrompe (audit R4) si distrugge la connessione col
 * client: una risposta troncata senza segnale lascerebbe il client a interpretare
 * dati incompleti come validi.
 */
async function pipeBody(
  res: ServerResponse,
  upstream: Response,
  log: (m: string) => void,
): Promise<void> {
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    log(`[tare] stream upstream interrotto: ${(e as Error).message}`);
    res.destroy();
  }
}

/**
 * Passthrough trasparente all'upstream di fallback: stessa rotta, metodo e body,
 * auth in ingresso inoltrata. Usato per lo streaming (no routing nell'MVP) e per
 * qualsiasi rotta diversa da `POST /v1/messages` (es. count_tokens).
 */
async function passthrough(
  req: IncomingMessage,
  res: ServerResponse,
  fetchImpl: FetchLike,
  fallbackBaseUrl: string,
  raw: string,
  log: (m: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", fallbackBaseUrl).toString();
  const headers = buildForwardHeaders(req.headers, null);
  const init: RequestInit = { method: req.method ?? "GET", headers };
  if (raw !== "" && req.method !== "GET" && req.method !== "HEAD") init.body = raw;
  try {
    const upstream = await fetchImpl(url, init);
    res.writeHead(upstream.status, relayHeaders(upstream));
    await pipeBody(res, upstream, log);
  } catch (e) {
    log(`passthrough fallito (${url}): ${(e as Error).message}`);
    sendJson(res, 502, { error: `upstream non raggiungibile: ${(e as Error).message}` });
  }
}

/**
 * Relaya una risposta SSE upstream al client in tempo reale e, a stream concluso,
 * registra il consumo estratto dagli eventi (`message_start`→input, ultimo
 * `message_delta`→output). Per lo streaming l'usage si conosce solo alla fine,
 * quindi il record avviene DOPO il relay; `recordActual` è serializzato (R1),
 * quindi resta consistente anche con richieste concorrenti.
 */
async function relayStreamAndRecord(
  res: ServerResponse,
  upstream: Response,
  chosen: ModelConfig,
  log: (m: string) => void,
): Promise<void> {
  res.writeHead(upstream.status, relayHeaders(upstream));
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sse = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        sse += decoder.decode(value, { stream: true });
      }
    }
    res.end();
  } catch (e) {
    log(`[tare] stream upstream interrotto: ${(e as Error).message}`);
    res.destroy();
    return;
  }

  const tokens = extractSseUsage(sse);
  if (tokens !== null) {
    const rec = await recordActual(chosen.name, toUsage(chosen, tokens));
    log(
      rec.ok
        ? `[tare] ledger (stream): ${chosen.name} +${tokens.inputTokens}in/${tokens.outputTokens}out tok`
        : `[tare] recordActual fallito: ${rec.error}`,
    );
  }
}

/** Gestisce una richiesta. Vedi il commento di modulo per la filosofia di fallback. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  r: Resolved,
  fetchImpl: FetchLike,
): Promise<void> {
  const raw = await readBody(req);
  const path = (req.url ?? "/").split("?")[0];
  const isMessages = req.method === "POST" && path === "/v1/messages";

  if (!isMessages) {
    await passthrough(req, res, fetchImpl, r.fallbackBaseUrl, raw, r.log);
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    sendJson(res, 400, { error: "corpo JSON non valido" });
    return;
  }

  // ── Routing enforcing (stream e non-stream allo stesso modo) ──────────────
  const fallbackTo = (why: string): Promise<void> => {
    r.log(`[tare] ${why} → passthrough`);
    return passthrough(req, res, fetchImpl, r.fallbackBaseUrl, raw, r.log);
  };

  const input = extractClassifyInput(body);
  if (!input.ok) return fallbackTo(`task non estraibile: ${input.error}`);

  const cfg = await loadConfig();
  if (!cfg.ok) return fallbackTo(`config non caricata: ${cfg.error}`);

  const led = await loadLedger();
  if (!led.ok) return fallbackTo(`ledger non caricato: ${led.error}`);

  const synced = syncLedger(led.value, cfg.value.models);
  const planned = plan(input.value, cfg.value, synced);
  if (!planned.ok) return fallbackTo(`nessun modello idoneo: ${planned.error}`);

  const chosen = cfg.value.models.find((m) => m.name === planned.value.decision.model);
  if (chosen === undefined) return fallbackTo(`modello scelto assente dalla config`);

  r.log(formatPreflight(planned.value));

  const keyR = resolveApiKey(chosen, r.env);
  if (!keyR.ok) return fallbackTo(keyR.error);

  const headers = buildForwardHeaders(req.headers, keyR.value);
  headers["content-type"] = "application/json"; // body riserializzato in JSON
  const fwdBody = JSON.stringify(withUpstreamModel(body, chosen));
  // Ricostruisce l'URL upstream da `req.url`, così path E query (se presenti)
  // della richiesta originale sono preservati verso il provider.
  const url = new URL(
    req.url ?? "/v1/messages",
    resolveUpstreamBase(chosen, r.fallbackBaseUrl),
  ).toString();

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, { method: "POST", headers, body: fwdBody });
  } catch (e) {
    sendJson(res, 502, { error: `upstream non raggiungibile: ${(e as Error).message}` });
    return;
  }

  if (isStreamingRequest(body)) {
    await relayStreamAndRecord(res, upstream, chosen, r.log);
    return;
  }

  const text = await upstream.text();

  // Consumo reale → ledger PRIMA di rispondere: così la richiesta successiva
  // dell'agente vede già il budget aggiornato (niente race sul ledger). Errori
  // solo loggati: non devono impedire all'agente di ricevere la risposta.
  try {
    const tokens = extractUsageTokens(JSON.parse(text));
    if (tokens !== null) {
      const rec = await recordActual(chosen.name, toUsage(chosen, tokens));
      r.log(
        rec.ok
          ? `[tare] ledger: ${chosen.name} +${tokens.inputTokens}in/${tokens.outputTokens}out tok`
          : `[tare] recordActual fallito: ${rec.error}`,
      );
    }
  } catch {
    // risposta non-JSON (es. errore upstream non strutturato): niente da registrare.
  }

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  res.end(text);
}

/**
 * Crea il server proxy (senza metterlo in ascolto). `fetchImpl` è iniettabile
 * per i test; di default usa il `fetch` globale (Node ≥ 20).
 */
export function createProxyServer(opts: ProxyOptions = {}, fetchImpl: FetchLike = fetch): Server {
  const r = resolveOptions(opts);
  return createServer((req, res) => {
    handle(req, res, r, fetchImpl).catch((e: unknown) => {
      r.log(`[tare] errore interno: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "errore interno del proxy" });
      else res.end();
    });
  });
}

/** Avvia il proxy e risolve quando è in ascolto. Ritorna server + URL di base. */
export function startProxy(
  opts: ProxyOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ server: Server; url: string }> {
  const r = resolveOptions(opts);
  const server = createProxyServer(opts, fetchImpl);
  return new Promise((resolve) => {
    server.listen(r.port, r.host, () => {
      // Porta EFFETTIVA: con `port: 0` il SO ne assegna una libera (utile ai test).
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : r.port;
      resolve({ server, url: `http://${r.host}:${port}` });
    });
  });
}
