/**
 * Automated Deliverable Health & Startup Smoke Test
 *
 * Deterministically tests every created file and endpoint (HTML pages, scripts, configs)
 * on startup at ZERO LLM token cost. Catches syntax errors, undefined references
 * (e.g. ReferenceError: dx is not defined), TypeErrors, and unhandled startup exceptions
 * before the pipeline declares a task finished.
 */
import { callMcpTool } from '../mcpClient';

export interface DeliverableError {
  file: string;
  message: string;
  line?: number;
  col?: number;
  stack?: string;
}

export interface DeliverableHealthReport {
  ok: boolean;
  totalTested: number;
  passCount: number;
  failCount: number;
  errors: DeliverableError[];
  testedFiles: string[];
  summaryText: string;
}

function makeSessionId(): string {
  return `smoketest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Tests an HTML file by booting it in a sandboxed, isolated headless iframe with
 * error traps for window.onerror, unhandledrejection, and console.error.
 */
async function testHtmlDeliverable(
  filePath: string,
  content: string,
  timeoutMs = 500
): Promise<DeliverableError[]> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    // Non-browser fallback (SSR/Node)
    return [];
  }

  return new Promise((resolve) => {
    const sessionId = makeSessionId();
    const caughtErrors: DeliverableError[] = [];
    let isCleanedUp = false;

    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '-9999px';
    iframe.style.left = '-9999px';
    iframe.style.width = '800px';
    iframe.style.height = '600px';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    iframe.setAttribute('sandbox', 'allow-scripts');

    const messageHandler = (event: MessageEvent) => {
      try {
        const data = event.data;
        if (data && data.sessionId === sessionId) {
          if (data.type === '__ERGO_SMOKE_ERROR__') {
            caughtErrors.push({
              file: filePath,
              message: String(data.message || 'Unknown startup error'),
              line: typeof data.line === 'number' ? data.line : undefined,
              col: typeof data.col === 'number' ? data.col : undefined,
              stack: typeof data.stack === 'string' ? data.stack : undefined
            });
          }
        }
      } catch {}
    };

    window.addEventListener('message', messageHandler);

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      try {
        window.removeEventListener('message', messageHandler);
      } catch {}
      try {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      } catch {}
      resolve(caughtErrors);
    };

    // Inject early harness before any author scripts execute
    const trapScript = `
<script>
(function() {
  var sessionId = "${sessionId}";
  var filePath = "${filePath.replace(/"/g, '\\"')}";

  // Suppress intrusive dialogs
  window.alert = function() {};
  window.confirm = function() { return true; };
  window.prompt = function() { return null; };

  // Polyfill requestAnimationFrame and cancelAnimationFrame so that canvas animations
  // and game loops execute immediately even in off-screen / headless iframes, preventing
  // browser throttling from hiding startup crashes (e.g. ReferenceError: dx is not defined).
  window.requestAnimationFrame = function(cb) {
    return setTimeout(function() {
      try {
        cb(performance.now());
      } catch (err) {
        var msg = (err && err.message) || String(err);
        var stack = (err && err.stack) || '';
        window.parent.postMessage({
          type: '__ERGO_SMOKE_ERROR__',
          sessionId: sessionId,
          message: msg,
          stack: stack
        }, '*');
      }
    }, 16);
  };
  window.cancelAnimationFrame = function(id) {
    clearTimeout(id);
  };

  window.addEventListener('error', function(e) {
    var msg = e.message || (e.error && e.error.message) || String(e.error || e);
    var stack = e.error && e.error.stack ? e.error.stack : '';
    window.parent.postMessage({
      type: '__ERGO_SMOKE_ERROR__',
      sessionId: sessionId,
      message: msg,
      line: e.lineno,
      col: e.colno,
      stack: stack
    }, '*');
  });

  window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason || {};
    var msg = 'Unhandled Promise Rejection: ' + (reason.message || String(reason));
    var stack = reason.stack || '';
    window.parent.postMessage({
      type: '__ERGO_SMOKE_ERROR__',
      sessionId: sessionId,
      message: msg,
      stack: stack
    }, '*');
  });

  var origErr = console.error;
  console.error = function() {
    var args = Array.prototype.slice.call(arguments);
    var msg = args.map(function(a) {
      if (!a) return String(a);
      if (typeof a === 'object') return a.message || JSON.stringify(a);
      return String(a);
    }).join(' ');
    window.parent.postMessage({
      type: '__ERGO_SMOKE_ERROR__',
      sessionId: sessionId,
      message: 'console.error: ' + msg
    }, '*');
    if (origErr) {
      try { origErr.apply(console, arguments); } catch (err) {}
    }
  };
})();
</script>`;

    // Insert trap script at the very top of HTML
    let instrumentedHtml = content;
    if (/<head[^>]*>/i.test(instrumentedHtml)) {
      instrumentedHtml = instrumentedHtml.replace(/(<head[^>]*>)/i, `$1\n${trapScript}`);
    } else if (/<html[^>]*>/i.test(instrumentedHtml)) {
      instrumentedHtml = instrumentedHtml.replace(/(<html[^>]*>)/i, `$1\n<head>${trapScript}</head>`);
    } else {
      instrumentedHtml = `<head>${trapScript}</head>\n${instrumentedHtml}`;
    }

    const timer = setTimeout(() => {
      cleanup();
    }, timeoutMs);

    iframe.onload = () => {
      // Allow 300ms for initial event loops, requestAnimationFrame frames, and DOMContentLoaded listeners
      setTimeout(() => {
        clearTimeout(timer);
        cleanup();
      }, Math.min(300, timeoutMs));
    };

    iframe.onerror = (err) => {
      caughtErrors.push({
        file: filePath,
        message: `Failed to load document in sandbox iframe: ${String(err)}`
      });
      clearTimeout(timer);
      cleanup();
    };

    try {
      document.body.appendChild(iframe);
      iframe.srcdoc = instrumentedHtml;
    } catch (err: any) {
      caughtErrors.push({
        file: filePath,
        message: `Failed to attach sandbox iframe: ${err?.message || String(err)}`
      });
      clearTimeout(timer);
      cleanup();
    }
  });
}

/**
 * Statically parses inline script tags in an HTML document to catch syntax errors
 * (unexpected tokens, unmatched brackets, malformed syntax, truncation) in 0ms at 0 token cost.
 */
function validateHtmlStaticSyntax(filePath: string, content: string): DeliverableError[] {
  const errors: DeliverableError[] = [];

  // Check for truncated HTML with unclosed script tag
  const scriptOpenRegex = /<script\b[^>]*>/gi;
  const scriptCloseRegex = /<\/script>/gi;
  const openMatches = content.match(scriptOpenRegex) || [];
  const closeMatches = content.match(scriptCloseRegex) || [];
  if (openMatches.length > closeMatches.length) {
    errors.push({
      file: filePath,
      message: 'HTML deliverable has an unclosed <script> tag (deliverable appears truncated).'
    });
  }

  // Parse each inline script block
  const scriptRegex = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(content)) !== null) {
    const attrs = match[1] || '';
    const scriptBody = match[2];

    // Skip JSON / templates / non-JS scripts
    if (/type=["'](?:application\/json|text\/template|text\/html)["']/i.test(attrs)) continue;
    // Skip external scripts that don't have inline code
    if (/src=["']/i.test(attrs) && !scriptBody.trim()) continue;
    // Skip ES modules with import/export (iframe handles module imports)
    if (/type=["']module["']/i.test(attrs) || /\b(import\s+|export\s+)/.test(scriptBody)) continue;

    const upToMatch = content.slice(0, match.index);
    const scriptStartLine = upToMatch.split('\n').length;

    try {
      new Function(scriptBody);
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        errors.push({
          file: filePath,
          line: scriptStartLine,
          message: `SyntaxError in inline <script> (starts at line ${scriptStartLine}): ${err.message}`
        });
      }
    }
  }

  return errors;
}

/**
 * Statically parses a standalone JavaScript file to catch syntax errors.
 */
function validateJsStaticSyntax(filePath: string, content: string): DeliverableError[] {
  const errors: DeliverableError[] = [];
  if (!/\b(import\s+|export\s+)/.test(content)) {
    try {
      new Function(content);
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        errors.push({
          file: filePath,
          message: `JavaScript SyntaxError: ${err.message}`
        });
      }
    }
  }
  return errors;
}

/**
 * Tests a standalone JavaScript file for syntax and load-time exceptions.
 */
async function testJsDeliverable(filePath: string, content: string): Promise<DeliverableError[]> {
  const htmlWrapper = `<!DOCTYPE html><html><head><script type="module">\n${content}\n</script></head><body></body></html>`;
  return testHtmlDeliverable(filePath, htmlWrapper, 350);
}

/**
 * Tests a JSON file for syntax correctness.
 */
function testJsonDeliverable(filePath: string, content: string): DeliverableError[] {
  try {
    JSON.parse(content);
    return [];
  } catch (err: any) {
    return [{
      file: filePath,
      message: `JSON Syntax Error: ${err?.message || String(err)}`
    }];
  }
}

/**
 * Deterministically tests every created deliverable (applying to all pages,
 * scripts, and configs) for startup errors, syntax crashes, or uncaught exceptions.
 */
export async function verifyDeliverableHealth(
  files: string[],
  options?: { timeoutMs?: number }
): Promise<DeliverableHealthReport> {
  const uniqueFiles = Array.from(new Set(files.map((f) => f.trim()))).filter(Boolean);
  const testedFiles: string[] = [];
  const errors: DeliverableError[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const filePath of uniqueFiles) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    // Only test code/web deliverables
    const isHtml = ext === 'html' || ext === 'htm';
    const isJs = ext === 'js' || ext === 'mjs' || ext === 'cjs';
    const isJson = ext === 'json';

    if (!isHtml && !isJs && !isJson) {
      continue;
    }

    testedFiles.push(filePath);

    // Read content via MCP Filesystem
    let content = '';
    try {
      const readRes = await callMcpTool('mcp-filesystem', 'read_file', { path: filePath });
      if (readRes.success && typeof readRes.data?.content === 'string') {
        content = readRes.data.content;
      }
    } catch (err) {
      errors.push({
        file: filePath,
        message: `Could not read file for verification: ${String(err)}`
      });
      failCount++;
      continue;
    }

    if (!content.trim()) {
      errors.push({
        file: filePath,
        message: 'Deliverable file is empty (0 bytes).'
      });
      failCount++;
      continue;
    }

    let fileErrors: DeliverableError[] = [];
    if (isHtml) {
      // Phase 1: In-memory deterministic syntax & truncation validation
      const staticSyntaxErrors = validateHtmlStaticSyntax(filePath, content);
      fileErrors.push(...staticSyntaxErrors);

      // Phase 2: Unthrottled sandbox runtime execution
      const runtimeErrors = await testHtmlDeliverable(filePath, content, options?.timeoutMs || 500);
      fileErrors.push(...runtimeErrors);
    } else if (isJs) {
      const staticSyntaxErrors = validateJsStaticSyntax(filePath, content);
      fileErrors.push(...staticSyntaxErrors);

      const runtimeErrors = await testJsDeliverable(filePath, content);
      fileErrors.push(...runtimeErrors);
    } else if (isJson) {
      fileErrors = testJsonDeliverable(filePath, content);
    }

    // Deduplicate identical error messages for this file
    const seenErrors = new Set<string>();
    const uniqueFileErrors: DeliverableError[] = [];
    for (const fe of fileErrors) {
      const key = `${fe.line ?? 0}:${fe.message.slice(0, 80)}`;
      if (!seenErrors.has(key)) {
        seenErrors.add(key);
        uniqueFileErrors.push(fe);
      }
    }

    if (uniqueFileErrors.length > 0) {
      errors.push(...uniqueFileErrors);
      failCount++;
    } else {
      passCount++;
    }
  }

  const ok = errors.length === 0;
  const summaryText = ok
    ? (testedFiles.length > 0
        ? `All ${testedFiles.length} deliverable file(s) passed automated startup smoke tests with 0 console errors.`
        : 'No code deliverables needed automated smoke testing.')
    : `Startup verification failed with ${errors.length} error(s) across ${failCount} file(s):\n` +
      errors.map((e) => `- [${e.file}${e.line ? `:${e.line}` : ''}] ${e.message}${e.stack ? `\n  Stack: ${e.stack.split('\n')[0]}` : ''}`).join('\n');

  return {
    ok,
    totalTested: testedFiles.length,
    passCount,
    failCount,
    errors,
    testedFiles,
    summaryText
  };
}
