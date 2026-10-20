/**
 * Local model — browser client for the bridge's `/api/local-model/*` endpoints.
 *
 * The bridge installs and runs Qwen 2.5 Coder 0.5B (llama.cpp `llama-server`, bound to 127.0.0.1) under Ergo's
 * storage folder. It makes small background decisions (the shape of a CLI run) and autocompletes task text.
 *
 * Every call fails soft: a missing bridge, a model that isn't installed or a timeout gives `null` /
 * `{ success: false }`, never an exception, so callers can fall back to the tiny cloud model or heuristics.
 */
import { bridgeClient } from '../bridgeClient';

export type LocalModelState = 'not_installed' | 'installing' | 'installed' | 'starting' | 'ready' | 'error';
export type LocalModelInstallPhase = 'runtime' | 'model' | 'verifying' | 'extracting';

export interface LocalModelStatus {
  success: boolean;
  state: LocalModelState;
  phase?: LocalModelInstallPhase;
  bytesDone?: number;
  bytesTotal?: number;
  error?: string;
  platformSupported: boolean;
  sizes: { runtimeBytes: number; modelBytes: number };
  installDir: string;
  version: { runtime: string; model: string };
}

/** Result of install / cancel / uninstall: the bridge's reply (usually the new status) or `{ success: false, error }`. */
export type LocalModelActionResult = { success: boolean; error?: string } & Partial<Omit<LocalModelStatus, 'success' | 'error'>>;

export interface LocalShapeRequest {
  title: string;
  subtasks?: string[];
  /**
   * The task kind when the client already knows it. A non-coding kind (e.g. 'writing', 'research') lets the bridge
   * skip the QA question (needsQa: false).
   */
  kindHint?: string;
}

export type LocalShapeResult =
  | { success: true; single: boolean; needsQa: boolean; source: 'local'; ms: number }
  | { success: false; error: string };

export interface LocalCompleteRequest {
  prefix: string;
  suffix?: string;
  /** Default 24, max 48 (the bridge clamps it). */
  maxTokens?: number;
}

export type LocalCompleteResult =
  | { success: true; text: string; source: 'local'; ms: number }
  | { success: false; error: string };

export interface LocalCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const STATUS_TIMEOUT_MS = 4_000;
const ACTION_TIMEOUT_MS = 30_000;
const SHAPE_TIMEOUT_MS = 15_000;
const COMPLETE_TIMEOUT_MS = 15_000;

/** An AbortSignal that fires on the caller's signal or after `ms`. */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

async function requestJson(endpoint: string, body: unknown | undefined, timeoutMs: number, parent?: AbortSignal): Promise<any> {
  const { signal, cancel } = timeoutSignal(timeoutMs, parent);
  try {
    const init: RequestInit =
      body === undefined
        ? { method: 'GET', signal }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
    const res = await bridgeClient.fetch(endpoint, init);
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') throw new Error(`${endpoint} failed (HTTP ${res.status})`);
    if (!res.ok && json.success !== false) return { ...json, success: false, error: json.error || `${endpoint} failed (HTTP ${res.status})` };
    return json;
  } finally {
    cancel();
  }
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && (err as any).name === 'AbortError') return 'timed out or cancelled';
  return err instanceof Error ? err.message : String(err);
}

/** Install / server state of the local model, or null when the bridge can't be reached. */
export async function getLocalModelStatus(opts: LocalCallOptions = {}): Promise<LocalModelStatus | null> {
  try {
    const json = await requestJson('/api/local-model/status', undefined, opts.timeoutMs ?? STATUS_TIMEOUT_MS, opts.signal);
    if (typeof json.state !== 'string') return null;
    return json as LocalModelStatus;
  } catch {
    return null;
  }
}

async function action(endpoint: string, opts: LocalCallOptions): Promise<LocalModelActionResult> {
  try {
    const json = await requestJson(endpoint, {}, opts.timeoutMs ?? ACTION_TIMEOUT_MS, opts.signal);
    return { ...json, success: json.success !== false };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

/** Starts the background download + install (idempotent). Poll getLocalModelStatus() for progress. */
export function installLocalModel(opts: LocalCallOptions = {}): Promise<LocalModelActionResult> {
  return action('/api/local-model/install', opts);
}

/** Aborts a running install and removes partial files. */
export function cancelLocalModelInstall(opts: LocalCallOptions = {}): Promise<LocalModelActionResult> {
  return action('/api/local-model/cancel', opts);
}

/** Stops the local model server and deletes its install folder. */
export function uninstallLocalModel(opts: LocalCallOptions = {}): Promise<LocalModelActionResult> {
  return action('/api/local-model/uninstall', opts);
}

/** Run-shape decision (single deliverable? needs a QA verifier?) from the local model. */
export async function localShapeDecision(req: LocalShapeRequest, opts: LocalCallOptions = {}): Promise<LocalShapeResult> {
  try {
    const body: LocalShapeRequest = {
      title: req.title,
      ...(req.subtasks && req.subtasks.length > 0 ? { subtasks: req.subtasks } : {}),
      ...(req.kindHint ? { kindHint: req.kindHint } : {}),
    };
    const json = await requestJson('/api/local-model/shape', body, opts.timeoutMs ?? SHAPE_TIMEOUT_MS, opts.signal);
    if (json.success === false) return { success: false, error: String(json.error || 'local model unavailable') };
    if (typeof json.single !== 'boolean' || typeof json.needsQa !== 'boolean') {
      return { success: false, error: 'local model returned no decision' };
    }
    return { success: true, single: json.single, needsQa: json.needsQa, source: 'local', ms: Number(json.ms) || 0 };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

/** Fill-in-the-middle completion from the local model (one line; empty text = no suggestion). */
export async function localComplete(req: LocalCompleteRequest, opts: LocalCallOptions = {}): Promise<LocalCompleteResult> {
  try {
    const body: LocalCompleteRequest = {
      prefix: req.prefix,
      ...(req.suffix ? { suffix: req.suffix } : {}),
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    };
    const json = await requestJson('/api/local-model/complete', body, opts.timeoutMs ?? COMPLETE_TIMEOUT_MS, opts.signal);
    if (json.success === false) return { success: false, error: String(json.error || 'local model unavailable') };
    if (typeof json.text !== 'string') return { success: false, error: 'local model returned no text' };
    return { success: true, text: json.text, source: 'local', ms: Number(json.ms) || 0 };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}
