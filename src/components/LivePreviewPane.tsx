/**
 * Live Web Preview (the task pane's Preview tab): renders a run's HTML output, or a dev server running on this
 * computer, in a sandboxed iframe, with device widths, reload and a console drawer.
 *
 * Files come from the bridge (bridge/preview.ts) under a per-folder token, so their CSS/JS/images load by relative
 * path. The iframe never gets allow-same-origin and the bridge adds a CSP sandbox, so the page can't reach the app or
 * the bridge. The bridge injects a console relay into HTML it serves; dev servers are other origins, so their console
 * isn't captured.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Globe, Laptop, MonitorSmartphone, RefreshCw, Smartphone, SquareTerminal, Tablet, Trash2 } from 'lucide-react';
import { fetchRunChanges, type RunChangedFile } from '../lib/ideLinks';
import {
  isPreviewableFile,
  listDevServers,
  normalizeLocalUrl,
  openPreviewSession,
  previewFileUrl,
  useBridgeSupportsPreview,
  type DevServer,
  type PreviewConsoleEntry,
  type PreviewSession,
} from '../lib/preview';
import { Badge, Button, EmptyState, IconButton, Input, SegmentedControl, cx } from './ui';

type Device = 'desktop' | 'tablet' | 'mobile';
const DEVICE_WIDTH: Record<Device, number | null> = { desktop: null, tablet: 768, mobile: 390 };
const MAX_CONSOLE = 500;
/** How often a running task's preview checks whether the shown file changed. */
const LIVE_POLL_MS = 4000;

type Source = { kind: 'file'; path: string } | { kind: 'url'; url: string };

const sourceKey = (s: Source | null) => (!s ? '' : s.kind === 'file' ? `file:${s.path}` : `url:${s.url}`);

function pickDefaultFile(files: RunChangedFile[]): string | null {
  if (files.length === 0) return null;
  const index = files.filter((f) => /(^|\/)index\.html?$/i.test(f.path)).sort((a, b) => a.path.length - b.path.length)[0];
  return (index ?? files[0]).path;
}

export interface LivePreviewPaneProps {
  runId?: string;
  runActive?: boolean;
  /** Bumped by the parent after a revert: the shown file may have changed. */
  refreshKey?: number;
  /** A file to show (from a Preview button); `nonce` makes the same file re-selectable. */
  requestedFile?: { path: string; nonce: number } | null;
}

export const LivePreviewPane: React.FC<LivePreviewPaneProps> = ({ runId, runActive, refreshKey = 0, requestedFile }) => {
  const supported = useBridgeSupportsPreview();
  const [htmlFiles, setHtmlFiles] = useState<RunChangedFile[]>([]);
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [servers, setServers] = useState<DevServer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [urlError, setUrlError] = useState(false);
  const [device, setDevice] = useState<Device>('desktop');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [entries, setEntries] = useState<PreviewConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const entryId = useRef(0);
  const userPicked = useRef(false);
  const fileSig = useRef('');

  const reload = useCallback(() => {
    setEntries([]);
    setReloadNonce((n) => n + 1);
  }, []);

  // The run's HTML output (and the folder it lives in).
  const loadFiles = useCallback(async () => {
    if (!runId) {
      setHtmlFiles([]);
      setRoot(undefined);
      return [] as RunChangedFile[];
    }
    const changes = await fetchRunChanges(runId);
    const files = (changes?.files ?? []).filter((f) => f.status !== 'deleted' && isPreviewableFile(f.path));
    setHtmlFiles(files);
    setRoot(changes?.root);
    return files;
  }, [runId]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setServers(await listDevServers());
    } catch {
      setServers([]);
    } finally {
      setScanning(false);
      setScanned(true);
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    void loadFiles();
    void scan();
  }, [supported, loadFiles, scan, refreshKey]);

  // A token for the folder; without a run folder, the project's own folder.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    setSessionError(null);
    openPreviewSession(root)
      .then((s) => !cancelled && setSession(s))
      .catch((e) => {
        if (cancelled) return;
        setSession(null);
        setSessionError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [supported, root]);

  // A Preview button elsewhere asked for a file.
  useEffect(() => {
    if (!requestedFile) return;
    userPicked.current = true;
    setSource({ kind: 'file', path: requestedFile.path });
    reload();
  }, [requestedFile, reload]);

  // Until the user picks something, show the most likely page: the run's index.html, else a dev server.
  useEffect(() => {
    if (userPicked.current) return;
    const file = pickDefaultFile(htmlFiles);
    if (file) setSource((s) => (s?.kind === 'file' && s.path === file ? s : { kind: 'file', path: file }));
    else if (servers[0]) setSource((s) => (s?.kind === 'url' ? s : { kind: 'url', url: servers[0].url }));
  }, [htmlFiles, servers]);

  // While the task runs, reload when the shown file changes; once more when it stops.
  useEffect(() => {
    if (!supported || !runActive || source?.kind !== 'file') return;
    const path = source.path;
    const timer = window.setInterval(async () => {
      const files = await loadFiles();
      const f = files.find((x) => x.path === path);
      const sig = f ? `${f.status}:${f.additions}:${f.deletions}` : '';
      if (fileSig.current && sig !== fileSig.current) reload();
      fileSig.current = sig;
    }, LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [supported, runActive, source, loadFiles, reload]);

  const wasActive = useRef(runActive);
  useEffect(() => {
    if (wasActive.current && !runActive && source?.kind === 'file') reload();
    wasActive.current = runActive;
  }, [runActive, source, reload]);

  useEffect(() => {
    fileSig.current = '';
  }, [source]);

  // Console relay from the page (bridge/preview.ts injects the sender).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const data = e.data;
      if (!data || data.ergoPreview !== 'console') return;
      const level = (['log', 'info', 'warn', 'error', 'debug'] as const).includes(data.level) ? data.level : 'log';
      const entry: PreviewConsoleEntry = { id: ++entryId.current, level, text: String(data.text ?? ''), ts: Number(data.ts) || Date.now() };
      setEntries((prev) => (prev.length >= MAX_CONSOLE ? [...prev.slice(prev.length - MAX_CONSOLE + 1), entry] : [...prev, entry]));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const src = useMemo(() => {
    if (!source) return null;
    if (source.kind === 'url') return source.url;
    return session ? previewFileUrl(session, source.path) : null;
  }, [source, session]);

  const choose = (key: string) => {
    userPicked.current = true;
    setEntries([]);
    if (key.startsWith('file:')) setSource({ kind: 'file', path: key.slice(5) });
    else if (key.startsWith('url:')) setSource({ kind: 'url', url: key.slice(4) });
  };

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const url = normalizeLocalUrl(customUrl);
    setUrlError(!url);
    if (!url) return;
    userPicked.current = true;
    setEntries([]);
    setSource({ kind: 'url', url });
    reload();
  };

  const openExternally = () => {
    if (!src) return;
    window.open(new URL(src, window.location.href).toString(), '_blank', 'noopener,noreferrer');
  };

  if (!supported) {
    return (
      <EmptyState
        icon={MonitorSmartphone}
        title="Preview needs a newer Ergo Bridge"
        text="Update the Ergo Bridge to preview web pages and dev servers here."
      />
    );
  }

  const errorCount = entries.filter((x) => x.level === 'error').length;
  const width = DEVICE_WIDTH[device];
  const currentKey = sourceKey(source);
  const customInList =
    source?.kind === 'url' && !servers.some((s) => s.url === source.url) ? source.url : null;
  const nothingToShow = htmlFiles.length === 0 && servers.length === 0 && !source;

  return (
    <div className="eg-preview">
      <div className="eg-preview-toolbar">
        <select
          className="eg-input eg-preview-select"
          aria-label="What to preview"
          value={currentKey}
          onChange={(e) => choose(e.target.value)}
          disabled={htmlFiles.length === 0 && servers.length === 0 && !customInList}
        >
          {!source && <option value="">Nothing to preview</option>}
          {htmlFiles.length > 0 && (
            <optgroup label="Pages from this run">
              {htmlFiles.map((f) => (
                <option key={f.path} value={`file:${f.path}`}>
                  {f.path}
                </option>
              ))}
            </optgroup>
          )}
          {source?.kind === 'file' && !htmlFiles.some((f) => f.path === source.path) && (
            <option value={currentKey}>{source.path}</option>
          )}
          {(servers.length > 0 || customInList) && (
            <optgroup label="Dev servers">
              {servers.map((s) => (
                <option key={s.url} value={`url:${s.url}`}>
                  {`localhost:${s.port}${s.title ? ` · ${s.title}` : ''}`}
                </option>
              ))}
              {customInList && <option value={`url:${customInList}`}>{customInList}</option>}
            </optgroup>
          )}
        </select>
        <IconButton
          icon={RefreshCw}
          size="sm"
          label="Reload"
          title="Reload the preview"
          disabled={!src}
          onClick={reload}
        />
        <IconButton icon={ExternalLink} size="sm" label="Open in browser" disabled={!src} onClick={openExternally} />
        <span className="eg-spacer" />
        <SegmentedControl<Device>
          label="Device width"
          value={device}
          onChange={setDevice}
          options={[
            { id: 'desktop', label: 'Desktop', icon: Laptop, title: 'Full width' },
            { id: 'tablet', label: 'Tablet', icon: Tablet, title: 'Tablet (768px)' },
            { id: 'mobile', label: 'Mobile', icon: Smartphone, title: 'Phone (390px)' },
          ]}
        />
        <Button
          size="sm"
          variant={consoleOpen ? 'secondary' : 'ghost'}
          icon={SquareTerminal}
          aria-pressed={consoleOpen}
          onClick={() => setConsoleOpen((v) => !v)}
        >
          Console
          {errorCount > 0 && <Badge tone="danger">{errorCount}</Badge>}
        </Button>
      </div>

      <form className="eg-preview-urlbar" onSubmit={submitUrl}>
        <Input
          icon={Globe}
          mono
          value={customUrl}
          invalid={urlError}
          placeholder="localhost:3000"
          aria-label="Local URL to preview"
          onChange={(e) => {
            setCustomUrl(e.target.value);
            setUrlError(false);
          }}
        />
        <Button size="sm" type="submit" disabled={!customUrl.trim()}>
          Open
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={scanning} onClick={() => void scan()}>
          {scanning ? 'Scanning…' : 'Find dev servers'}
        </Button>
      </form>
      {urlError && <div className="eg-preview-hint is-error">Only pages on this computer (localhost) can be previewed.</div>}

      {nothingToShow ? (
        <EmptyState
          icon={MonitorSmartphone}
          title="Nothing to preview yet"
          text={
            scanned
              ? 'This run hasn’t made any HTML pages, and no dev server is running on a common port. Start one (for example npm run dev) and scan again, or enter its address above.'
              : 'Looking for pages and dev servers…'
          }
        />
      ) : source?.kind === 'file' && !session ? (
        <div className="eg-preview-hint">{sessionError || 'Opening the preview…'}</div>
      ) : src ? (
        <div className="eg-preview-stage">
          <div className={cx('eg-preview-device', `is-${device}`)} style={width ? { width } : undefined}>
            <iframe
              key={`${src}#${reloadNonce}`}
              ref={iframeRef}
              src={src}
              title="Live preview"
              className="eg-preview-frame"
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              allow="local-network-access; fullscreen; clipboard-write"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      ) : null}

      {consoleOpen && (
        <div className="eg-preview-console" role="log" aria-label="Preview console">
          <div className="eg-preview-console-head">
            <span>Console</span>
            <span className="eg-spacer" />
            <IconButton icon={Trash2} size="sm" label="Clear console" disabled={entries.length === 0} onClick={() => setEntries([])} />
          </div>
          {source?.kind === 'url' ? (
            <div className="eg-preview-hint">Console capture works for pages from this run only. Use your browser’s developer tools for dev servers.</div>
          ) : entries.length === 0 ? (
            <div className="eg-preview-hint">No console output.</div>
          ) : (
            <ol className="eg-preview-console-list">
              {entries.map((x) => (
                <li key={x.id} className={`is-${x.level}`}>
                  <span className="eg-preview-console-time eg-tabular">{new Date(x.ts).toLocaleTimeString()}</span>
                  <span className="eg-preview-console-text">{x.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
};
