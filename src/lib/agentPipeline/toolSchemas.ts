/**
 * Tool definitions for the agent pipeline.
 *
 * Context-engineering rules satisfied here:
 *  - Tool stability: buildToolDefinitions() is called ONCE per run (task boundary) and returns a
 *    deterministically sorted list. The same array is handed to the manager and every worker so
 *    the tools block (rendered at position 0 of the prompt) is byte-identical across calls.
 *  - Real schemas: bundled harness tools carry exact JSON schemas (required args, no free-form
 *    `args` bag) so models stop hallucinating argument names and burning retry rounds.
 *  - Filtering happens by MCP server (Summary's requiredMcps) — never per phase. Phase / role
 *    restrictions are enforced by the executor (state gating), not by mutating definitions.
 */
import { type MCPServer } from '../../types';
import { type JsonSchema, type ToolDefinition } from './contracts';

const str = (description: string): JsonSchema => ({ type: 'string', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
const obj = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

interface BundledToolSpec {
  description: string;
  schema: JsonSchema;
  readOnly: boolean;
}

/** Exact wire schemas for the bundled harness tools implemented in vite.config.ts (/api/mcp/tools/call). */
const BUNDLED_TOOL_SPECS: Record<string, BundledToolSpec> = {
  read_file: {
    description:
      'Read a UTF-8 text file inside the allowed roots. Prefer offset/limit (1-based start line, max lines) for files over ~200 lines instead of reading them whole; the response reports totalLines so you can page.',
    schema: obj(
      {
        path: str('File path (absolute, ~-relative, or relative to the storage root).'),
        offset: int('Optional 1-based line number to start from.'),
        limit: int('Optional maximum number of lines to return.')
      },
      ['path']
    ),
    readOnly: true
  },
  write_file: {
    description:
      'Create a new file or fully overwrite an existing one (parent directories are created). For changes to existing files prefer edit_file — it is cheaper and safer.',
    schema: obj({ path: str('Target file path.'), content: str('Complete file content.') }, ['path', 'content']),
    readOnly: false
  },
  edit_file: {
    description:
      'Replace an exact text span in an EXISTING file (preferred over write_file for edits). old_string must match exactly once — include surrounding lines to make it unique, or set replace_all. Read the file first.',
    schema: obj(
      {
        path: str('Existing file path.'),
        old_string: str('Exact text to replace (copy it verbatim from read_file output, including whitespace).'),
        new_string: str('Replacement text.'),
        replace_all: bool('Replace every occurrence instead of requiring a unique match (default false).')
      },
      ['path', 'old_string', 'new_string']
    ),
    readOnly: false
  },
  list_directory: {
    description: 'List the entries (name, isDirectory, isFile) of one directory. Do not walk whole trees — use search_files to locate things.',
    schema: obj({ path: str('Directory path.') }, ['path']),
    readOnly: true
  },
  create_directory: {
    description: 'Create a directory (recursively).',
    schema: obj({ path: str('Directory path to create.') }, ['path']),
    readOnly: false
  },
  search_files: {
    description:
      'Locate files under a directory by filename substring (query) and/or grep their contents with a case-insensitive regex (contentPattern → path, line, text). Use this to find code instead of reading whole files. Skips .git, node_modules, dist.',
    schema: obj(
      {
        path: str('Directory to search (recursively).'),
        query: str('Optional case-insensitive filename substring.'),
        contentPattern: str('Optional regex matched against each line of text files.'),
        maxResults: int('Optional cap on results (default 50, max 200).')
      },
      ['path']
    ),
    readOnly: true
  },
  get_file_info: {
    description: 'Return size, type and modification time for a path (works for binaries and huge files).',
    schema: obj({ path: str('File or directory path.') }, ['path']),
    readOnly: true
  },
  fetch_markdown: {
    description: 'Fetch a web page or API response and convert it to clean markdown (capped at 15k chars).',
    schema: obj({ url: str('Absolute http(s) URL.') }, ['url']),
    readOnly: true
  },
  fetch_url: {
    description: 'Fetch the raw HTTP response body of a URL (capped at 15k chars).',
    schema: obj({ url: str('Absolute http(s) URL.') }, ['url']),
    readOnly: true
  },
  git_status: {
    description: 'Show `git status --short --branch` for a repository inside the allowed roots.',
    schema: obj({ cwd: str('Repository directory (defaults to the storage root).') }, []),
    readOnly: true
  },
  git_diff: {
    description: 'Show the working-tree diff (optionally for one path).',
    schema: obj({ cwd: str('Repository directory.'), path: str('Optional file or directory to restrict the diff to.') }, []),
    readOnly: true
  },
  git_log: {
    description: 'Show recent commits (one line each).',
    schema: obj({ cwd: str('Repository directory.'), count: int('Number of commits (default 10, max 50).') }, []),
    readOnly: true
  },
  git_commit: {
    description: 'Commit staged changes with a message (requires user approval).',
    schema: obj({ cwd: str('Repository directory.'), message: str('Commit message.') }, ['message']),
    readOnly: false
  },
  run_command: {
    description:
      'Run a shell command inside an allowed folder (tests, lint, build, scripts). Requires user approval. Returns exitCode, stdout, stderr (each capped at 20k chars), timedOut. A non-zero exit code is a normal result — read stderr and fix the cause; never repeat an identical failing command.',
    schema: obj(
      {
        command: str('The shell command to run.'),
        cwd: str('Working directory (defaults to the storage root; must be inside an allowed root).'),
        timeoutMs: int('Optional timeout in milliseconds (default 60000, max 300000).')
      },
      ['command']
    ),
    readOnly: false
  }
};

/** Tools that mutate state. Everything else is treated as read-only (safe to run concurrently, allowed in verification phases). */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'create_directory', 'git_commit', 'run_command']);

/** Filesystem tools whose target path is checked against a piece's write scope and the lock registry. */
export const FILE_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'create_directory']);

/** Filesystem tools that actually create or modify files (excluding directories). */
export const FILE_WRITING_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

export function isReadOnlyTool(name: string): boolean {
  return !MUTATING_TOOL_NAMES.has(name);
}

/** Extracts the path-like argument a tool operates on (used for scope + lock checks). */
export function extractTargetPath(name: string, args: Record<string, any>): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  if (name === 'run_command' || name.startsWith('git_')) {
    return typeof args.cwd === 'string' ? args.cwd : undefined;
  }
  const candidate = args.path ?? args.filePath ?? args.file ?? args.directory;
  return typeof candidate === 'string' ? candidate : undefined;
}

export const ASK_HUMAN_TOOL: ToolDefinition = {
  name: 'ask_human',
  description:
    'Prompt the human user for necessary information, clarification, or choices mid-task. Use this when you are blocked by missing credentials, ambiguous requirements, or architectural decisions. Ask one precise question; offer options when possible.',
  inputSchema: obj(
    {
      question: str('The question or prompt to present to the user.'),
      options: { type: 'array', items: { type: 'string' }, description: 'Optional multiple-choice options.' },
      context: str('Optional context explaining why this information is required.'),
      allowFreeform: bool('Whether the user may type a custom response (default true).')
    },
    ['question']
  ),
  serverId: 'builtin',
  serverName: 'Ergo',
  readOnly: true,
  autoApprove: true
};

function serverMatchesRequirement(server: MCPServer, requirement: string): boolean {
  const req = requirement.trim().toLowerCase();
  if (!req) return false;
  if (server.id.toLowerCase() === req || server.name.toLowerCase() === req) return true;
  return server.tools.some((t) => t.name.toLowerCase() === req);
}

/**
 * Builds the byte-stable tool list for a run.
 * Includes ask_human plus every tool of each CONNECTED server referenced by requiredMcps
 * (matched by server id, server name, or any of its tool names — case-insensitive).
 */
export function buildToolDefinitions(connectedMcps: MCPServer[], requiredMcps: string[]): ToolDefinition[] {
  const defs: ToolDefinition[] = [ASK_HUMAN_TOOL];
  const seen = new Set<string>([ASK_HUMAN_TOOL.name]);
  const requirements = (requiredMcps || []).map((r) => (typeof r === 'string' ? r : String(r ?? '')));

  for (const server of connectedMcps) {
    if (server.status !== 'connected') continue;
    if (!requirements.some((r) => serverMatchesRequirement(server, r))) continue;
    for (const tool of server.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      const spec = BUNDLED_TOOL_SPECS[tool.name];
      defs.push({
        name: tool.name,
        description: spec ? spec.description : `[${server.name}] ${tool.description}`,
        inputSchema: spec
          ? spec.schema
          : {
              type: 'object',
              properties: { args: { type: 'object', description: 'Tool arguments as a JSON object.' } },
              required: []
            },
        serverId: server.id,
        serverName: server.name,
        readOnly: spec ? spec.readOnly : isReadOnlyTool(tool.name),
        autoApprove: Boolean(tool.autoApprove)
      });
    }
  }

  defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return defs;
}

// ─── Provider conversions ───────────────────────────────────────────────────

export function toAnthropicTools(defs: ToolDefinition[]): any[] {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema }));
}

export function toOpenAiTools(defs: ToolDefinition[]): any[] {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.inputSchema }
  }));
}

const GEMINI_TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT'
};

function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  if (typeof schema.type === 'string') out.type = GEMINI_TYPE_MAP[schema.type] || 'STRING';
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v as JsonSchema);
    }
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items as JsonSchema);
  return out;
}

export function toGeminiTools(defs: ToolDefinition[]): any[] {
  return defs.map((d) => ({ name: d.name, description: d.description, parameters: toGeminiSchema(d.inputSchema) }));
}
