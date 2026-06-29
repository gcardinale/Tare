/**
 * Proxy interceptor — I/O ai bordi (PROXY-03). M4.
 *
 * Server HTTP su loopback con cui l'agente parla (via `ANTHROPIC_BASE_URL`) al
 * posto del provider. Su `POST /v1/messages` NON-streaming applica il nucleo:
 * estrae il task → `plan()` → logga il preflight → inoltra al `baseUrl`+chiave
 * del modello scelto (routing ENFORCING) → registra il consumo reale dall'`usage`
 * della risposta. Le richieste in streaming e ogni altra rotta vanno in passthrough
 * trasparente all'upstream di fallback (lo streaming SSE "vero" è il prossimo step).
 *
 * Filosofia ai bordi: se qualcosa nel routing non torna (config assente, nessun
 * modello idoneo, chiave mancante) NON si blocca l'agente — si logga e si fa
 * passthrough. Meglio una run non instradata che un agente fermo. La logica di
 * decisione è pura e testata (`forward.ts`, `plan()`); qui c'è solo il wiring.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { loadConfig } from "../config/index.js";
import { loadLedger, recordActual, syncLedger } from "../ledger/index.js";
import { plan } from "../orchestrator/index.js";
import { extractClassifyInput } from "./extract.js";
import {
  buildForwardHeaders,
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

/** Legge tutto il corpo della richiesta come stringa UTF-8. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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

/** Pipe del corpo (web stream) della risposta upstream al client, byte per byte. */
async function pipeBody(res: ServerResponse, upstream: Response): Promise<void> {
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
  res.end();
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
    await pipeBody(res, upstream);
  } catch (e) {
    log(`passthrough fallito (${url}): ${(e as Error).message}`);
    sendJson(res, 502, { error: `upstream non raggiungibile: ${(e as Error).message}` });
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

  if (isStreamingRequest(body)) {
    r.log("[tare] richiesta in streaming → passthrough (SSE non instradato nell'MVP)");
    await passthrough(req, res, fetchImpl, r.fallbackBaseUrl, raw, r.log);
    return;
  }

  // ── Routing enforcing ────────────────────────────────────────────────────
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
  const fwdBody = JSON.stringify(withUpstreamModel(body, chosen));
  const url = new URL("/v1/messages", resolveUpstreamBase(chosen, r.fallbackBaseUrl)).toString();

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, { method: "POST", headers, body: fwdBody });
  } catch (e) {
    sendJson(res, 502, { error: `upstream non raggiungibile: ${(e as Error).message}` });
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
