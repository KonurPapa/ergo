/**
 * Live Web Preview client: asks the bridge for a sandboxed URL to a folder's files (bridge/preview.ts) and for the dev
 * servers running on this computer. The Preview tab (LivePreviewPane) renders either in an iframe.
 */
import { useEffect, useState } from 'react';
import { bridgeClient } from './bridgeClient';
import { PREVIEW_PROTOCOL } from './bridgeProtocol';
import { getRootsProject } from './mcpClient';

export function bridgeSupportsPreview(): boolean {
  const status = bridgeClient.getStatus();
  return Boolean(status.isConnected) && (status.bridgeInfo?.protocol ?? 0) >= PREVIEW_PROTOCOL;
}

/** Re-renders when the bridge handshake finishes or the bridge changes. */
export function useBridgeSupportsPreview(): boolean {
  const [supported, setSupported] = useState(bridgeSupportsPreview);
  useEffect(() => bridgeClient.subscribe(() => setSupported(bridgeSupportsPreview())), []);
  return supported;
}

/** Files the Preview tab can render on their own. */
export function isPreviewableFile(path: string): boolean {
  return /\.html?$/i.test(path);
}

export interface PreviewSession {
  /** URL of the folder, ending in '/': append a relative path ('index.html', 'game/play.html'). */
  baseUrl: string;
  root: string;
}

/** A sandboxed URL for the files in `root` (the run's working folder; the project's own folder when omitted). */
export async function openPreviewSession(root?: string): Promise<PreviewSession> {
  const res = await bridgeClient.fetch('/api/preview/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, projectId: getRootsProject() || undefined }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error || `The bridge could not start the preview (${res.status}).`);
  return { baseUrl: bridgeClient.getApiUrl(data.base), root: data.root };
}

/** Joins a '/'-separated relative path onto a session's base URL, escaping each segment. */
export function previewFileUrl(session: PreviewSession, relPath: string): string {
  return session.baseUrl + relPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export interface DevServer {
  port: number;
  url: string;
  title?: string;
}

export async function listDevServers(): Promise<DevServer[]> {
  const res = await bridgeClient.fetch('/api/preview/ports');
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error || `The bridge could not scan for dev servers (${res.status}).`);
  return Array.isArray(data.servers) ? data.servers : [];
}

/** Only local web servers may be framed: the preview is for the user's own dev servers. */
export function normalizeLocalUrl(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (/^\d{2,5}$/.test(text)) text = `localhost:${text}`;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const u = new URL(text);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.localhost')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export interface PreviewConsoleEntry {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  ts: number;
}
