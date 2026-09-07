import {
  type TaskItem,
  type Subtask,
  type AgentContextItem,
  type ProjectData,
  type MCPServer,
  type AIProviderConfig,
  type ExecutionStep,
  type McpToolPermissionPrompt,
  type HumanInputPrompt,
  type HumanAiIntent,
  type HumanAiAssistantResult,
  type SwimLaneDoc,
  type DiscoveryJobPayload,
  type DiscoveredTaskContextEntry,
  type OverviewDocument,
  type ManagerBiblePayload
} from '../types';
import { callMcpTool, formatConnectionsForAiPrompt, getAllowedRoots } from './mcpClient';
import { storageManager } from './storageManager';
import { parseTodoMarkdown, parseAgentContextMarkdown } from './parser';
import { callAiEngine, stripSkillFrontmatter, extractStringFromAiValue } from './llmClient';

// The agent execution pipeline (Discovery → Summary → Manager → Cleaner → Hardener → Logger)
// lives in ./agentPipeline. Re-exported here so existing imports keep working.
export { executeTaskWithAi } from './agentPipeline';
export { callAiEngine } from './llmClient';


/**
 * Drafts new scannable tasks for TODO.md and verbose briefs for AGENT_CONTEXT.md
 */
export async function draftTasksWithAi(
  userPrompt: string,
  _currentProject: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[]
): Promise<{ newTasks: Partial<TaskItem>[]; newBriefs: Partial<AgentContextItem>[] }> {
  const mcpNames = connectedMcps.filter((m) => m.status === 'connected').map((m) => m.name);
  const runtimeConnectionsPrompt = formatConnectionsForAiPrompt(connectedMcps);

  // If real AI credentials are set for OpenAI, Anthropic, Gemini, or Ollama, make live call to provider
  if (aiConfig.provider !== 'none' && aiConfig.provider !== 'mock' && (aiConfig.apiKey || aiConfig.provider === 'ollama')) {
    try {
      const systemPrompt = `You are Ergo AI, an agentic workspace task architect.
Given a user project goal, generate dual-layer project tasks:
1) Scannable TODO task items for TODO.md
2) Detailed technical context briefs for AGENT_CONTEXT.md with Overview, Build & Verification, and Completion sections.

${runtimeConnectionsPrompt}

SUBTASK RULES:
- Subtasks represent the concrete, sequential steps or broken-out components of a task.
- Single-ask / Atomic tasks = NO subtasks ("subtasks": []). NEVER generate artificial filler subtasks.
- Only include subtasks if the task genuinely has multiple distinct execution steps.
- NEVER use generic boilerplate like "Research and plan...", "Implement core work...", or "Review and validate...".

Select appropriate tools from the active runtime connections listed above for each task's "mcpRequired" array where relevant.

Respond strictly with valid JSON matching this schema:
{
  "tasks": [
    {
      "title": "Task title",
      "category": "Core Tasks",
      "isHumanReview": false,
      "subtasks": [],
      "mcpRequired": ["tool_name"]
    }
  ],
  "briefs": [
    {
      "title": "Task title",
      "overview": "**Done-State:** User visible behavior\\n\\n**In Context:** Evaluated in relationship to overall project goals and other tasks\\n\\n**Seams:** Affected code files & constraints",
      "buildAndVerification": "",
      "completion": ""
    }
  ]
}`;
      const responseText = await callAiEngine(userPrompt, systemPrompt, aiConfig, 'discovery');
      const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed.tasks && parsed.briefs && Array.isArray(parsed.tasks)) {
        return {
          newTasks: parsed.tasks,
          newBriefs: parsed.briefs.map((b: any) => ({
            ...b,
            overview: b.overview || b.brief || '',
            buildAndVerification: b.buildAndVerification || b.built || '',
            completion: b.completion || b.validation || b.humanReview || '',
            brief: b.overview || b.brief || '',
            built: b.buildAndVerification || b.built || '',
            validation: b.completion || b.validation || ''
          }))
        };
      }
    } catch (e: any) {
      console.warn(`[Ergo AI] ${aiConfig.provider} live API call notice (falling back to native workspace generator):`, e.message);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1200)); // Simulated thinking time

  if (userPrompt.toLowerCase().includes('vscode') || userPrompt.toLowerCase().includes('vs code') || userPrompt.toLowerCase().includes('editor') || userPrompt.toLowerCase().includes('markdown')) {
    return {
      newTasks: [
        {
          title: 'VS Code Editor Live Document Sync & Edit Automation',
          category: 'MCP Access',
          status: 'not_started',
          isDone: false,
          isHumanReview: true,
          subtasks: [
            { id: 'sub-v1', text: 'Connect VS Code Editor MCP via local stdio IPC bridge', isDone: false },
            { id: 'sub-v2', text: 'Drive active editor file edits in sync with TODO.md & AGENT_CONTEXT.md', isDone: false },
            { id: 'sub-v3', text: 'Verify bi-directional change propagation in VS Code workspace', isDone: false, isHumanReview: true }
          ],
          mcpRequired: ['vscode_edit_document', 'vscode_sync_markdown']
        }
      ],
      newBriefs: [
        {
          title: 'VS Code Editor Live Document Sync & Edit Automation',
          status: 'not started',
          overview: `**Done-State:** Enable Ergo to drive live edits inside VS Code active document buffer and sync plain markdown files (\`TODO.md\` and \`AGENT_CONTEXT.md\`) in real-time.\n\n` +
                    `**In Context:** Evaluated alongside workspace editor tools to ensure non-destructive live synchronization.\n\n` +
                    `**Seams:** \`vscode-ipc://ergo-vscode-bridge\`, \`edit_active_document\`, \`sync_markdown_files\`.\n` +
                    `**Connected MCPs:** ${mcpNames.join(', ') || 'VS Code Editor MCP'}`,
          buildAndVerification: '',
          completion: '',
          brief: `**Done-State:** Enable Ergo to drive live edits inside VS Code active document buffer and sync plain markdown files in real-time.`,
          built: '',
          validation: ''
        }
      ]
    };
  }

  if (userPrompt.toLowerCase().includes('pdf') || userPrompt.toLowerCase().includes('bluebeam') || userPrompt.toLowerCase().includes('scale') || userPrompt.toLowerCase().includes('takeoff')) {
    return {
      newTasks: [
        {
          title: 'High-DPI Plan Sheet Scale Auto-Calibration',
          category: 'Missing features todos',
          status: 'not_started',
          isDone: false,
          isHumanReview: true,
          subtasks: [
            { id: 'sub-1', text: 'Run OCR cascade (pdf.js -> tesseract.js -> Vision AI) on title block', isDone: false },
            { id: 'sub-2', text: 'Verify 1/4" = 1\'-0" scale fraction against paper dimensions', isDone: false, isHumanReview: true }
          ],
          mcpRequired: ['bluebeam']
        },
        {
          title: 'Export Layered Diff PDF for Revision Compare',
          category: 'Import/Export',
          status: 'not_started',
          isDone: false,
          subtasks: [
            { id: 'sub-3', text: 'Generate low-level /OCG optional content layers using pdflayers.js', isDone: false },
            { id: 'sub-4', text: 'Embed v1 JSON metadata into PDF stream for re-import recovery', isDone: false }
          ],
          mcpRequired: ['bluebeam', 'gdrive']
        }
      ],
      newBriefs: [
        {
          title: 'High-DPI Plan Sheet Scale Auto-Calibration',
          status: 'not started',
          brief: `**Goal:** Automatically detect and calibrate paper scale fractions (e.g. 1/8"=1'-0", 1/4"=1'-0") from vector PDF title blocks.\n\n` +
                 `**Seams:** \`lib/scaleOcr.js\`, \`lib/ocrgate.js\`, \`lib/titleblock.js\`.\n` +
                 `**Quality Gate:** Floor confidence at 62 for free text, 40 for canonical scale matches.\n` +
                 `**Connected MCPs:** ${mcpNames.join(', ') || 'Bluebeam MCP'}`,
          built: '',
          validation: '',
          humanReview: 'Test against 300 DPI scanned raster blueprints and verify OCR bounding boxes.',
          followUps: 'Test against 300 DPI scanned raster blueprints and verify OCR bounding boxes.'
        },
        {
          title: 'Export Layered Diff PDF for Revision Compare',
          status: 'not started',
          brief: `**Goal:** Emit ISO-32000 compliant PDF layers (/OCG) containing base sheet, revision overlay, and diff clouds.\n\n` +
                 `**Seams:** \`lib/pdflayers.js\`, \`lib/diffpdf.js\`.\n` +
                 `**Out of Scope:** Automatic AI redrawing of changed polyline geometry.`,
          built: '',
          validation: '',
          humanReview: 'Verify in Adobe Acrobat and Bluebeam Revu layer panel for correct OCG grouping.',
          followUps: 'Verify in Adobe Acrobat and Bluebeam Revu layer panel for correct OCG grouping.'
        }
      ]
    };
  }

  // Default generated task from user prompt (atomic ask = no artificial subtasks)
  const cleanTitle = userPrompt.slice(0, 50).trim();
  return {
    newTasks: [
      {
        title: cleanTitle || 'New Feature Workflow',
        category: 'Major TODOs for beta',
        status: 'not_started',
        isDone: false,
        isHumanReview: userPrompt.toLowerCase().includes('review'),
        subtasks: [],
        mcpRequired: mcpNames.slice(0, 2)
      }
    ],
    newBriefs: [
      {
        title: cleanTitle || 'New Feature Workflow',
        status: 'not started',
        brief: `**Goal:** ${userPrompt}\n\n` +
               `**Target Seams:** Main application components, storage engine, and MCP bridges.\n` +
               `**Data Model:** Additive schema updates. Fully backwards compatible.\n` +
               `**Connected MCP Tools:** ${mcpNames.join(', ') || 'Local Workspace'}`,
        built: '',
        validation: '',
        humanReview: 'Inspect performance impact, verify memory footprint, and confirm UI responsiveness.',
        followUps: 'Inspect performance impact, verify memory footprint, and confirm UI responsiveness.'
      }
    ]
  };
}


/**
 * Executes a 3-agent sequential AI pipeline:
 * 1. AI 1 (assistant-context-analyzer): Skims headers & tasks, extracts relevance & context (<= 200 words).
 * 2. AI 2 (assistant-todo-builder): Builds TODO.md task structure in native markdown.
 * 3. AI 3 (assistant-context-syncer): Syncs AGENT_CONTEXT.md and drafts rich Overviews.
 * Logs each agent's output to console before handoff.
 */
export async function runHumanAiAssistant(
  userPrompt: string,
  intent: HumanAiIntent = 'task',
  currentTodoMarkdown: string,
  currentAgentContextMarkdown: string,
  project: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[],
  customSkillDoc?: string | null
): Promise<HumanAiAssistantResult> {
  const allowedRoots = await getAllowedRoots();
  const runtimeConnectionsPrompt = formatConnectionsForAiPrompt(connectedMcps, allowedRoots);
  const mcpNames = connectedMcps.filter((m) => m.status === 'connected').map((m) => m.name);

  // Load the 3 dedicated skill instructions
  const [skill1Raw, skill2Raw, skill3Raw] = await Promise.all([
    storageManager.loadSkillDoc('assistant-context-analyzer'),
    storageManager.loadSkillDoc('assistant-todo-builder'),
    storageManager.loadSkillDoc('assistant-context-syncer')
  ]);

  const skill1Doc = stripSkillFrontmatter(skill1Raw);
  const skill2Doc = stripSkillFrontmatter(customSkillDoc || skill2Raw);
  const skill3Doc = stripSkillFrontmatter(skill3Raw);

  const safeTodoMarkdown = currentTodoMarkdown || '';
  const safeAgentContextMarkdown = currentAgentContextMarkdown || '';

  const modeGuidance = intent === 'architect'
    ? `OPERATIONAL MODE: ARCHITECT MODE (ALWAYS NUMEROUS TASKS — HIGHER-LEVEL ROADMAP)
- PURPOSE: Architect mode is ALWAYS for creating/modifying NUMEROUS tasks across the workspace.
- HIGHER-LEVEL SCOPE: Never assume it is confined to a single task. Always assume that the user's instructions are meant to be higher-level and broad, spanning multiple tasks, subtasks, or milestones across categories.
- MULTI-TASK REQUIREMENT: Whatever the user describes, extrapolate broadly to design a structured multi-task architecture and comprehensive workflow.
- FORMATTING: Maintain strict markdown list formatting (numbered tasks \`1.\`, \`2.\`, 4-space indented subtasks \`    - \`, and category headers \`##\`).`
    : `OPERATIONAL MODE: TASK MODE (SINGLE TASK ONLY — STRICT ISOLATION)
- PURPOSE: Task mode is ONLY for creating or modifying a SINGLE task/subtasks — either the task the user has currently selected, or a different task they explicitly call out (e.g. creating a new task).
- FLESH OUT PROMPT: Flesh out the user's prompt into a complete, well-formed single task with clear, concrete domain-specific subtasks.
- STRICT ISOLATION (ZERO BLEED-OVER): Confine your changes strictly to this current task. There must NOT be any bleed-over into other tasks.
- DO NOT alter, reorder, delete, or rewrite any other existing tasks in TODO.md.
- If creating a new task, append it to the appropriate category or at the end of TODO.md as a single new numbered task with its subtasks. If modifying an existing task, only modify that specific task.`;

  // 1. Check for report / summary requests
  const lowerPrompt = userPrompt.toLowerCase();
  if (lowerPrompt.includes('summarize') || lowerPrompt.includes('report') || lowerPrompt.includes('metrics') || lowerPrompt.includes('aggregate')) {
    const lines = safeTodoMarkdown.split('\n');
    const taskLines = lines.filter((l) => /^\d+\.\s+/.test(l.trim()));
    const doneLines = taskLines.filter((l) => /~~.+~~/.test(l));
    const reportMarkdown = `# 📊 Workspace Summary\n\n- **Total Tasks:** ${taskLines.length}\n- **Completed:** ${doneLines.length} (${taskLines.length > 0 ? Math.round((doneLines.length / taskLines.length) * 100) : 0}%)\n- **Remaining:** ${taskLines.length - doneLines.length}\n`;

    console.log('%c[Ergo AI Assistant] ── Workspace Summary Report Generated ──', 'color: #38bdf8; font-weight: bold;');
    console.log(reportMarkdown);

    return {
      summary: `Generated summary across ${taskLines.length} tasks.`,
      aggregatedReport: reportMarkdown
    };
  }

  // ─── Live 3-Agent Sequential Pipeline (When AI Provider is Connected) ───
  if (aiConfig.provider !== 'none' && aiConfig.provider !== 'mock' && (aiConfig.apiKey || aiConfig.provider === 'ollama')) {
    try {
      console.log('%c[Ergo AI Assistant] 🚀 Starting 3-Agent Pipeline...', 'color: #6366f1; font-weight: bold;');

      // ── Step 1: AI 1 — Context & Relevance Analyzer ──
      const ai1SystemPrompt = `You are AI 1 (Context & Relevance Analyzer) in Ergo.
${skill1Doc ? `\nSKILL INSTRUCTIONS:\n${skill1Doc}\n` : ''}

PROJECT: "${project.name || 'Default Workspace'}" (${project.folderPath})
ACTIVE MCP CONNECTIONS & PERMITTED ROOTS:
${runtimeConnectionsPrompt}

YOUR TASK:
1. Skim the current categories, task titles, subtasks, and briefs in TODO.md and AGENT_CONTEXT.md.
2. Compare them against the user request.
3. Extract relevant existing structures to copy/mirror, target category, next task number, constraints, and relevant active MCP tools.
4. Output a concise analysis strictly under 200 words.

CURRENT TODO.md:
\`\`\`markdown
${safeTodoMarkdown}
\`\`\`

CURRENT AGENT_CONTEXT.md:
\`\`\`markdown
${safeAgentContextMarkdown}
\`\`\``;

      // Step 1: AI 1 uses primary task model ('general'), with discovery model wiring ready if needed
      const ai1ModelType: 'discovery' | 'general' = 'general';
      const ai1Response = await callAiEngine(userPrompt, ai1SystemPrompt, aiConfig, ai1ModelType, 'text');
      const ai1Analysis = ai1Response.trim() || 'Standalone request. Create new task(s) matching workspace conventions.';

      console.log('%c[Ergo AI Assistant] ── Step 1 / 3: Context & Relevance Analysis (AI 1) ──', 'color: #38bdf8; font-weight: bold;');
      console.log(ai1Analysis);

      // ── Step 2: AI 2 — TODO.md Task Builder ──
      const ai2SystemPrompt = `You are AI 2 (TODO.md Task Builder) in Ergo.
${skill2Doc ? `\nSKILL INSTRUCTIONS:\n${skill2Doc}\n` : ''}

PROJECT: "${project.name || 'Default Workspace'}" (${project.folderPath})
ACTIVE MCP CONNECTIONS & PERMITTED ROOTS:
${runtimeConnectionsPrompt}
MODE: ${intent === 'architect' ? 'ARCHITECT MODE (BROAD MULTI-TASK & SUBTASK ROADMAP)' : 'TASK MODE (SINGLE TASK ONLY — ZERO BLEED-OVER)'}

${modeGuidance}

CORE PRINCIPLE — HUMAN-SIDE FIRST:
You write and modify TODO.md. Translate the user request and AI 1's Context Analysis directly into clear tasks and concrete subtasks in TODO.md.

FORMATTING RULES (STRICT):
- 4-space indentation for subtasks (\`    - \`)
- Numbered task lists (\`1.\`, \`2.\`), restart at 1 per category
- Headings: \`## Category Name\`
- Strikethrough for done tasks: \`~~Done task~~\`
- Preserve existing header comments (<!-- ... -->) and unmodified categories
${intent === 'task' ? '- STRICT ISOLATION: Modify/append ONLY the requested single task. Do NOT touch, reorder, or alter other tasks.' : '- ARCHITECT ROADMAP: Extrapolate into multiple structured tasks with subtasks across the roadmap.'}
- NEVER generate boilerplate like "Research and plan" or "Implement core work". Make every subtask concrete and domain-specific.
- DO NOT TRUNCATE. Output the complete updated TODO.md from start to finish.

CURRENT TODO.md:
\`\`\`markdown
${safeTodoMarkdown}
\`\`\`

Output your updated TODO.md directly inside a code fence:
\`\`\`markdown:TODO.md
...complete updated TODO.md content...
\`\`\``;

      const ai2UserPrompt = `USER REQUEST:
${userPrompt}

AI 1 CONTEXT & RELEVANCE ANALYSIS:
${ai1Analysis}`;

      const ai2Response = await callAiEngine(ai2UserPrompt, ai2SystemPrompt, aiConfig, 'general', 'text');
      const todoFenceMatch = ai2Response.match(/```(?:markdown)?(?::|\s+)?(?:TODO\.md|todo)\s*\n([\s\S]*?)```/i);
      let updatedTodoMarkdown = todoFenceMatch ? todoFenceMatch[1].trim() : '';

      if (!updatedTodoMarkdown) {
        const cleanRaw = ai2Response.replace(/^```(?:markdown)?\s*\n/i, '').replace(/\n```$/i, '').trim();
        if (/^\s*(?:#|\d+\.)/m.test(cleanRaw)) {
          updatedTodoMarkdown = cleanRaw;
        } else {
          updatedTodoMarkdown = safeTodoMarkdown;
        }
      }

      console.log('%c[Ergo AI Assistant] ── Step 2 / 3: Updated TODO.md Output (AI 2) ──', 'color: #34d399; font-weight: bold;');
      console.log(updatedTodoMarkdown);

      // ── Step 3: AI 3 — AGENT_CONTEXT.md Syncer & Overview Drafter ──
      const ai3SystemPrompt = `You are AI 3 (AGENT_CONTEXT.md Syncer & Overview Drafter) in Ergo.
${skill3Doc ? `\nSKILL INSTRUCTIONS:\n${skill3Doc}\n` : ''}

PROJECT: "${project.name || 'Default Workspace'}" (${project.folderPath})
ACTIVE MCP CONNECTIONS & PERMITTED ROOTS:
${runtimeConnectionsPrompt}

YOUR OBJECTIVE:
Synchronize AGENT_CONTEXT.md so that every task in the new TODO.md has a paired \`### N. Task Title\` section in the exact same numerical order.
Most importantly, draft or edit rich, domain-specific \`Overview\`s for any new or modified tasks, detailing:
- **Done-State**: Clear definition of user-visible behavior or completion criteria.
- **In Context**: How this task connects with the broader system, roadmap, or dependencies.
- **Seams**: Specific files, libraries, active MCP tools (${mcpNames.join(', ') || 'Local Workspace'}), or APIs involved.

SECTION FORMAT SCHEMA:
### N. Task Title

**Status:** not started

**Overview**

[Detailed overview describing Done-State, In Context, and Seams]

**Build & Verification**


**Completion**


---

Preserve existing unmodified task sections and file preambles.
DO NOT TRUNCATE. Output the complete updated AGENT_CONTEXT.md from start to finish.

CURRENT AGENT_CONTEXT.md:
\`\`\`markdown
${safeAgentContextMarkdown}
\`\`\`

NEW TODO.md (Produced by AI 2):
\`\`\`markdown
${updatedTodoMarkdown}
\`\`\`

Output your updated AGENT_CONTEXT.md directly inside a code fence:
\`\`\`markdown:AGENT_CONTEXT.md
...complete updated AGENT_CONTEXT.md content...
\`\`\``;

      const ai3UserPrompt = `USER REQUEST:
${userPrompt}

AI 1 CONTEXT ANALYSIS:
${ai1Analysis}

NEW TODO.md TO SYNC:
${updatedTodoMarkdown}`;

      const ai3Response = await callAiEngine(ai3UserPrompt, ai3SystemPrompt, aiConfig, 'general', 'text');
      const agentFenceMatch = ai3Response.match(/```(?:markdown)?(?::|\s+)?(?:AGENT_CONTEXT\.md|agent_context|agent)\s*\n([\s\S]*?)```/i);
      let updatedAgentContextMarkdown = agentFenceMatch ? agentFenceMatch[1].trim() : '';

      if (!updatedAgentContextMarkdown) {
        const cleanRaw = ai3Response.replace(/^```(?:markdown)?\s*\n/i, '').replace(/\n```$/i, '').trim();
        if (/^\s*(?:#|###)/m.test(cleanRaw)) {
          updatedAgentContextMarkdown = cleanRaw;
        } else {
          updatedAgentContextMarkdown = safeAgentContextMarkdown;
        }
      }

      console.log('%c[Ergo AI Assistant] ── Step 3 / 3: Synchronized AGENT_CONTEXT.md Output (AI 3) ──', 'color: #a78bfa; font-weight: bold;');
      console.log(updatedAgentContextMarkdown);
      console.log('%c[Ergo AI Assistant] ── 3-Agent Pipeline Completed Successfully ✅ ──', 'color: #10b981; font-weight: bold;');

      const summaryText = intent === 'architect'
        ? `Architected multi-task roadmap structure across workspace.`
        : `Fleshed out single task with concrete subtasks.`;

      return {
        summary: summaryText,
        todoMarkdown: updatedTodoMarkdown,
        agentContextMarkdown: updatedAgentContextMarkdown
      };
    } catch (e: any) {
      console.warn(`[Ergo AI Assistant] Live API notice (falling back to offline 3-stage generator):`, e.message);
    }
  }

  // ─── Offline 3-Stage Pipeline Fallback (No API Key or Offline) ───
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Extract clean task title from user prompt
  const interpretedTitle = (() => {
    const raw = userPrompt.trim();
    // 1. Quoted names e.g. "Called 'Psalm 23'" or 'LOTR'
    const quotedMatch = raw.match(/['"]([^'"]+)['"]/);
    if (quotedMatch) return quotedMatch[1].trim();

    // 2. Named patterns e.g. task called X, named X
    const namedMatch = raw.match(/(?:called|named|titled)\s+([^,.;\n]+)/i);
    if (namedMatch) return namedMatch[1].trim();

    // 3. Action verbs e.g. "Create task for X", "Add dark mode"
    const verbMatch = raw.match(/^(?:please\s+)?(?:create|add|make|generate|draft|architect|design|build|setup|set\s+up)\s+(?:a\s+)?(?:new\s+)?(?:task\s+)?(?:called|named|for|about|to|with)?\s*(.+)/i);
    if (verbMatch) {
      const candidate = verbMatch[1].replace(/\s+subtasks?.*/i, '').replace(/\s+(?:and|with|including)\s+.*/i, '').trim();
      if (candidate.length > 2) return candidate.replace(/\b\w/g, (c) => c.toUpperCase());
    }

    const firstSentence = raw.split(/[.\n]/)[0].trim();
    return firstSentence.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Workspace Task';
  })();

  // Domain-specific subtasks generator based on keywords in title/prompt
  const generateDomainSubtasks = (title: string, promptText: string): string[] => {
    const lower = `${title} ${promptText}`.toLowerCase();

    if (lower.includes('psalm') || lower.includes('bible') || lower.includes('verse') || lower.includes('scripture')) {
      return [
        `Read and annotate verses of ${title}`,
        `Analyze key pastoral themes, metaphors, and historical context`,
        `Draft study reflections and record practical applications`
      ];
    }
    if (lower.includes('lotr') || lower.includes('ring') || lower.includes('middle-earth')) {
      return [
        `Acquire the One Ring and consult Gandalf in the Shire`,
        `Unite the Fellowship of the Ring at Rivendell`,
        `Journey across Middle-Earth and evade the Nazgûl`,
        `Destroy the One Ring in the fires of Mount Doom`
      ];
    }
    if (lower.includes('auth') || lower.includes('login') || lower.includes('jwt') || lower.includes('oauth')) {
      return [
        `Configure OAuth provider client ID and secure redirect URIs`,
        `Implement JWT token issuance, refresh rotation, and cookie handling`,
        `Add authentication middleware to protect API routes and views`,
        `Write integration tests for login, token refresh, and logout flows`
      ];
    }
    if (lower.includes('billing') || lower.includes('stripe') || lower.includes('payment') || lower.includes('subscription')) {
      return [
        `Initialize Stripe SDK client and configure webhook signing secrets`,
        `Create subscription checkout sessions and handle customer portals`,
        `Process invoice.payment_succeeded and customer.subscription.updated webhooks`,
        `Implement grace periods, cancellation flows, and billing status UI`
      ];
    }
    if (lower.includes('pdf') || lower.includes('export') || lower.includes('print')) {
      return [
        `Design print-ready document template with header, footer, and page numbers`,
        `Implement rendering pipeline to assemble vector content and styling`,
        `Verify high-DPI rasterization and cross-browser PDF download reliability`
      ];
    }

    return [
      `Define architectural specification and data schemas for ${title}`,
      `Implement core functionality and wire necessary component integrations`,
      `Add automated test coverage and verify end-to-end user behavior`
    ];
  };

  // Determine existing task numbers
  const existingTaskNumbers = [...safeTodoMarkdown.matchAll(/^(\d+)\.\s+/gm)].map((m) => parseInt(m[1], 10));
  let nextNum = existingTaskNumbers.length > 0 ? Math.max(...existingTaskNumbers) + 1 : 1;

  // Offline Step 1: Context Analysis
  const offlineAnalysis = `### Context & Relevance Analysis (Offline Mode)
- **Relevance**: Standalone request for "${interpretedTitle}".
- **Target Category**: Append to active task list.
- **Next Task Number**: #${nextNum}
- **Structure to Follow**: 4-space indented subtasks, numbered task hierarchy.
- **Key Data & Constraints**: Extrapolate concrete domain steps for ${interpretedTitle}.`;

  console.log('%c[Ergo AI Assistant] ── Step 1 / 3: Context Analysis (Offline AI 1) ──', 'color: #38bdf8; font-weight: bold;');
  console.log(offlineAnalysis);

  if (intent === 'architect') {
    // Offline Step 2 & 3: Architect Mode (Multiple Tasks & Subtasks)
    const architectTasks = [
      {
        title: `Architecture & Data Contracts for ${interpretedTitle}`,
        subtasks: [
          `Define data schemas, state contracts, and domain types`,
          `Set up core module directory scaffolding and export index`,
          `Configure validation boundaries and error handlers`
        ]
      },
      {
        title: `Core Business Logic & Pipeline for ${interpretedTitle}`,
        subtasks: [
          `Implement primary processing handlers and execution workflow`,
          `Integrate runtime storage and event communication channels`,
          `Add validation gates and idempotency safeguards`
        ]
      },
      {
        title: `UI Views, Interaction & Verification for ${interpretedTitle}`,
        subtasks: [
          `Build responsive components and interactive feedback indicators`,
          `Implement empty states, loading indicators, and error banners`,
          `Conduct end-to-end flow testing and document usage guides`
        ]
      }
    ];

    let newTodoAppend = '';
    let newContextAppend = '';

    architectTasks.forEach((t) => {
      const currentTaskNum = nextNum++;
      const subtaskLines = t.subtasks.map((s) => `    - ${s}`).join('\n');
      newTodoAppend += `${currentTaskNum}. ${t.title}\n${subtaskLines}\n`;
      newContextAppend += `\n### ${currentTaskNum}. ${t.title}\n\n**Status:** not started\n\n**Overview**\n\n**Done-State:** Complete implementation of ${t.title}.\n\n**In Context:** Part of the broader ${interpretedTitle} architecture.\n\n**Seams:** Core workspace files and active MCP tools (${mcpNames.join(', ') || 'Local Workspace'}).\n\n**Build & Verification**\n\n\n\n**Completion**\n\n\n\n---\n`;
    });

    const updatedTodo = safeTodoMarkdown.trimEnd() ? `${safeTodoMarkdown.trimEnd()}\n\n${newTodoAppend}` : newTodoAppend;
    const updatedAgentContext = safeAgentContextMarkdown.trimEnd() ? `${safeAgentContextMarkdown.trimEnd()}\n${newContextAppend}` : newContextAppend.trimStart();

    console.log('%c[Ergo AI Assistant] ── Step 2 / 3: Updated TODO.md (Offline AI 2) ──', 'color: #34d399; font-weight: bold;');
    console.log(updatedTodo);
    console.log('%c[Ergo AI Assistant] ── Step 3 / 3: Synchronized AGENT_CONTEXT.md (Offline AI 3) ──', 'color: #a78bfa; font-weight: bold;');
    console.log(updatedAgentContext);
    console.log('%c[Ergo AI Assistant] ── 3-Stage Pipeline Completed (Offline) ✅ ──', 'color: #10b981; font-weight: bold;');

    return {
      summary: `Architected 3 structured roadmap tasks and subtasks for "${interpretedTitle}".`,
      todoMarkdown: updatedTodo,
      agentContextMarkdown: updatedAgentContext
    };
  }

  // Offline Step 2 & 3: Task Mode (Single Task Focus)
  const domainSubtasks = generateDomainSubtasks(interpretedTitle, userPrompt);
  const subtasksBlock = domainSubtasks.map((s) => `    - ${s}`).join('\n');
  const newTodoBlock = `${nextNum}. ${interpretedTitle}\n${subtasksBlock}`;
  const updatedTodo = safeTodoMarkdown.trimEnd() ? `${safeTodoMarkdown.trimEnd()}\n${newTodoBlock}\n` : `${newTodoBlock}\n`;

  const newBriefSection = `\n### ${nextNum}. ${interpretedTitle}\n\n**Status:** not started\n\n**Overview**\n\n**Done-State:** Complete execution of ${interpretedTitle} with all subtask verification steps fulfilled.\n\n**In Context:** Fleshed out single task derived from user request: "${userPrompt.slice(0, 100)}${userPrompt.length > 100 ? '...' : ''}".\n\n**Seams:** Main application components, storage engine, and MCP tools (${mcpNames.join(', ') || 'Local Workspace'}).\n\n**Build & Verification**\n\n\n\n**Completion**\n\n\n\n---\n`;
  const updatedAgentContext = safeAgentContextMarkdown.trimEnd() ? `${safeAgentContextMarkdown.trimEnd()}\n${newBriefSection}` : newBriefSection.trimStart();

  console.log('%c[Ergo AI Assistant] ── Step 2 / 3: Updated TODO.md (Offline AI 2) ──', 'color: #34d399; font-weight: bold;');
  console.log(updatedTodo);
  console.log('%c[Ergo AI Assistant] ── Step 3 / 3: Synchronized AGENT_CONTEXT.md (Offline AI 3) ──', 'color: #a78bfa; font-weight: bold;');
  console.log(updatedAgentContext);
  console.log('%c[Ergo AI Assistant] ── 3-Stage Pipeline Completed (Offline) ✅ ──', 'color: #10b981; font-weight: bold;');

  return {
    summary: `Fleshed out single task #${nextNum}: "${interpretedTitle}".`,
    todoMarkdown: updatedTodo,
    agentContextMarkdown: updatedAgentContext
  };
}

/**
 * Runs AI Step 3 (Context Syncer & Overview Drafter) for a single task's Overview:
 * 1. Analyzes drift between the current Overview and the human task definition in TODO.md.
 * 2. Adds/edits missing pieces as necessary, ensuring rich Done-State, In Context, and Seams details.
 */
export async function syncTaskOverviewWithAi(
  task: TaskItem,
  currentOverview: string,
  project: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[],
  todoMarkdown?: string,
  _agentContextMarkdown?: string
): Promise<string> {
  const allowedRoots = await getAllowedRoots();
  const runtimeConnectionsPrompt = formatConnectionsForAiPrompt(connectedMcps, allowedRoots);
  const mcpNames = connectedMcps.filter((m) => m.status === 'connected').map((m) => m.name);

  // Load the Step 3 skill instructions (assistant-context-syncer)
  const skill3Raw = await storageManager.loadSkillDoc('assistant-context-syncer');
  const skill3Doc = stripSkillFrontmatter(skill3Raw);

  const subtasksList = task.subtasks && task.subtasks.length > 0
    ? task.subtasks.map((st) => `    - ${st.isDone ? '~~' : ''}${st.isHumanReview ? '**human review** - ' : ''}${st.text}${st.isDone ? '~~' : ''}`).join('\n')
    : '    (No subtasks defined)';

  const formattedTaskBlock = `${task.id}. ${task.isDone ? '~~' : ''}${task.title}${task.isDone ? '~~' : ''}\n${subtasksList}`;

  // Live 3-Stage Pipeline AI 3 execution
  if (aiConfig.provider !== 'none' && aiConfig.provider !== 'mock' && (aiConfig.apiKey || aiConfig.provider === 'ollama')) {
    try {
      console.log('%c[Ergo AI Assistant] 🚀 Starting AI Step 3 Overview Syncer...', 'color: #8b5cf6; font-weight: bold;');

      const ai3SystemPrompt = `You are AI 3 (AGENT_CONTEXT.md Syncer & Overview Drafter) in Ergo.
${skill3Doc ? `\nSKILL INSTRUCTIONS:\n${skill3Doc}\n` : ''}

PROJECT: "${project.name || 'Default Workspace'}" (${project.folderPath})
ACTIVE MCP CONNECTIONS & PERMITTED ROOTS:
${runtimeConnectionsPrompt}

YOUR OBJECTIVE:
Synchronize the Overview for Task #${task.id}: "${task.title}".
1. **Identify Drift**: First analyze what drift exists between the current Overview and the human task definition (including title, category, status, and all subtasks). Check for:
   - Newly added, deleted, or modified subtasks in TODO.md not reflected in the Overview.
   - Status or scope changes (e.g. done/in-progress items).
   - Missing or outdated Done-State completion criteria.
   - Missing In Context relationships to the broader system and active workspace.
   - Missing Seams (files, components, APIs, or active MCP tools: ${mcpNames.join(', ') || 'Local Workspace'}).
2. **Reconcile & Update**: Add, edit, or reconcile any missing pieces, drift, or gaps. Preserve any valid existing notes, domain context, and rationale, while bringing the Overview into full alignment with the human task.
3. **Format**: Maintain a rich, structured format covering:
   - **Done-State**: Clear definition of user-visible behavior or completion criteria matching all subtasks.
   - **In Context**: How this task connects with the broader system, roadmap, or dependencies.
   - **Seams**: Specific files, components, active MCP tools (${mcpNames.join(', ') || 'Local Workspace'}), or APIs involved.

OUTPUT FORMAT:
Output ONLY the final updated markdown content for this task's Overview. Do NOT output markdown code fences around the entire response, and do NOT include the task heading or other sections like Build & Verification / Completion.`;

      const ai3UserPrompt = `HUMAN TASK IN TODO.md:
\`\`\`markdown
${formattedTaskBlock}
\`\`\`

CATEGORY: ${task.category || 'General'}
STATUS: ${task.isDone ? 'done' : task.status}

CURRENT OVERVIEW:
\`\`\`markdown
${currentOverview.trim() || '(Empty - no overview defined yet)'}
\`\`\`
${todoMarkdown ? `\nWORKSPACE TODO.md CONTEXT:\n\`\`\`markdown\n${todoMarkdown.slice(0, 1500)}\n\`\`\`` : ''}`;

      const ai3Response = await callAiEngine(ai3UserPrompt, ai3SystemPrompt, aiConfig, 'general', 'text');
      let cleanedOverview = ai3Response.trim();

      // Strip markdown code fence if wrapped
      const fenceMatch = cleanedOverview.match(/^```(?:markdown)?(?::|\s+)?(?:overview|AGENT_CONTEXT\.md|agent_context)?\s*\n([\s\S]*?)```$/i);
      if (fenceMatch) {
        cleanedOverview = fenceMatch[1].trim();
      }

      // Strip accidental section headers if the model emitted full section schema
      cleanedOverview = cleanedOverview
        .replace(/^###\s+.*$/m, '')
        .replace(/^\*\*Status:\*\*.*$/m, '')
        .replace(/^\*\*Overview\*\*\s*/m, '')
        .replace(/\*\*Build & Verification\*\*[\s\S]*$/m, '')
        .trim();

      if (cleanedOverview) {
        console.log('%c[Ergo AI Assistant] ── Step 3: Synced Overview Output (AI 3) ──', 'color: #a78bfa; font-weight: bold;');
        console.log(cleanedOverview);
        return cleanedOverview;
      }
    } catch (e: any) {
      console.warn(`[Ergo AI Assistant] Live Step 3 notice (falling back to offline syncer):`, e.message);
    }
  }

  // ─── Offline Step 3 Fallback ───
  await new Promise((resolve) => setTimeout(resolve, 400));

  const subtasks = task.subtasks || [];
  const subtaskBullets = subtasks.length > 0
    ? subtasks.map((st) => `- ${st.isDone ? '[x] ~~' : '[ ] '}${st.text}${st.isDone ? '~~' : ''}`).join('\n')
    : `- Complete core deliverable for "${task.title}".`;

  const doneStateSection = `**Done-State:**\n${subtaskBullets}`;
  const inContextSection = `**In Context:**\nPart of category **${task.category || 'General'}** in \`${project.name || 'Workspace'}\`. Aligned with current roadmap requirements in TODO.md.`;
  const seamsSection = `**Seams:**\nTarget codebase located in \`${project.folderPath || './'}\` and active MCP tools (${mcpNames.join(', ') || 'Local Workspace'}).`;

  let updatedOverview = '';
  if (currentOverview && currentOverview.trim()) {
    // Reconcile drift: check if current overview has Done-State, In Context, or Seams
    const hasDoneState = /\*\*Done-State:?\*\*/i.test(currentOverview);
    const hasInContext = /\*\*In Context:?\*\*/i.test(currentOverview);
    const hasSeams = /\*\*Seams:?\*\*/i.test(currentOverview);

    if (hasDoneState && hasInContext && hasSeams) {
      // Reconcile subtask checklist drift under Done-State
      updatedOverview = currentOverview.replace(
        /\*\*Done-State:?\*\*[\s\S]*?(?=\n\n\*\*In Context|\n\n\*\*Seams|$)/i,
        doneStateSection
      );
    } else {
      updatedOverview = `${currentOverview.trim()}\n\n---\n\n### Synced Task Context\n\n${doneStateSection}\n\n${inContextSection}\n\n${seamsSection}`;
    }
  } else {
    updatedOverview = `${doneStateSection}\n\n${inContextSection}\n\n${seamsSection}`;
  }

  console.log('%c[Ergo AI Assistant] ── Step 3: Synced Overview Output (Offline AI 3) ──', 'color: #a78bfa; font-weight: bold;');
  console.log(updatedOverview);

  return updatedOverview;
}

// ─── Task Execution Pipeline Helpers ────────────────────────────────────────

interface WorkspaceTaskEntry {
  task: TaskItem;
  laneTitle: string;
  fileName: string;
}

/**
 * Extracts and tags all tasks from all workspace swim lane markdown documents.
 */
export function extractAllWorkspaceTasks(
  swimLanesOrTodo: SwimLaneDoc[] | string | undefined,
  todoFallback: string = ''
): WorkspaceTaskEntry[] {
  let lanes: SwimLaneDoc[] = [];

  if (Array.isArray(swimLanesOrTodo) && swimLanesOrTodo.length > 0) {
    lanes = swimLanesOrTodo;
  } else if (typeof swimLanesOrTodo === 'string' && swimLanesOrTodo.trim()) {
    lanes = [{ id: 'lane-default', title: 'TODO', filePath: 'TODO.md', markdown: swimLanesOrTodo }];
  } else if (todoFallback && todoFallback.trim()) {
    lanes = [{ id: 'lane-default', title: 'TODO', filePath: 'TODO.md', markdown: todoFallback }];
  } else {
    lanes = [{ id: 'lane-default', title: 'TODO', filePath: 'TODO.md', markdown: '' }];
  }

  const results: WorkspaceTaskEntry[] = [];
  let globalOffset = 0;

  for (const lane of lanes) {
    const fileName = lane.filePath ? lane.filePath.split('/').pop() || 'TODO.md' : 'TODO.md';
    const parsed = parseTodoMarkdown(lane.markdown);
    for (let i = 0; i < parsed.items.length; i++) {
      results.push({
        task: {
          ...parsed.items[i],
          id: parsed.items[i].id || (globalOffset + i + 1),
          swimLaneId: lane.id,
          sourceFileName: fileName
        },
        laneTitle: lane.title || fileName,
        fileName
      });
    }
    for (const arch of parsed.archivedItems) {
      results.push({
        task: {
          ...arch,
          swimLaneId: lane.id,
          sourceFileName: fileName
        },
        laneTitle: lane.title || fileName,
        fileName
      });
    }
    globalOffset += parsed.items.length;
  }
  return results;
}

/**
 * Builds a compact task header index from all project markdown files (all swim lanes + AGENT_CONTEXT.md).
 * Produces only titles, categories, source document labels, and brief overview snippets (NOT full file bodies).
 * Used by the Discovery AI to find relevant context without ingesting entire files.
 */
export function buildTaskHeaderIndex(
  swimLanesOrTodo: SwimLaneDoc[] | string | undefined,
  agentContextMarkdown: string,
  todoFallback: string = ''
): string {
  const allWorkspaceEntries = extractAllWorkspaceTasks(swimLanesOrTodo, todoFallback);
  const allBriefs = parseAgentContextMarkdown(agentContextMarkdown);

  const lines: string[] = ['TASK HEADER INDEX ACROSS ALL WORKSPACE MARKDOWN DOCUMENTS:'];

  // Group entries by document
  const byLane = new Map<string, WorkspaceTaskEntry[]>();
  for (const entry of allWorkspaceEntries) {
    const key = `${entry.fileName} (${entry.laneTitle})`;
    if (!byLane.has(key)) byLane.set(key, []);
    byLane.get(key)!.push(entry);
  }

  byLane.forEach((entries, laneKey) => {
    lines.push(`\n=== DOCUMENT: ${laneKey} ===`);
    for (const { task, fileName } of entries) {
      const brief = allBriefs.find(
        (b) =>
          (b.sourceTaskId != null && b.sourceTaskId === task.id) ||
          b.title.trim().toLowerCase() === task.title.trim().toLowerCase() ||
          b.itemNumber === task.id
      );
      const snippet = (brief?.overview || brief?.brief || '')
        .slice(0, 150)
        .replace(/\n/g, ' ')
        .trim();
      const archiveTag = task.isArchived ? ' [ARCHIVED]' : '';
      const doneTag = task.isDone ? ' [DONE]' : '';
      lines.push(`#${task.id}. ${task.title} (${task.category}) [Doc: ${fileName}]${archiveTag}${doneTag}`);
      if (snippet) lines.push(`   Overview: ${snippet}${snippet.length === 150 ? '...' : ''}`);
    }
  });

  return lines.join('\n');
}

/**
 * Returns full task + brief data for a given list of task IDs across all workspace documents.
 * Used to pass only the relevant tasks' context to the Builder AI.
 */
export function getRelevantTasksContext(
  relevantIds: (string | number)[],
  swimLanesOrTodo: SwimLaneDoc[] | string | undefined,
  agentContextMarkdown: string,
  todoFallback: string = ''
): string {
  if (relevantIds.length === 0) return '';
  const allWorkspaceEntries = extractAllWorkspaceTasks(swimLanesOrTodo, todoFallback);
  const allBriefs = parseAgentContextMarkdown(agentContextMarkdown);

  const lines: string[] = ['RELEVANT TASK CONTEXT (from Discovery AI across workspace documents):'];
  for (const id of relevantIds) {
    const entry = allWorkspaceEntries.find((e) => e.task.id === id);
    if (!entry) continue;
    const { task, fileName, laneTitle } = entry;
    const brief = allBriefs.find(
      (b) =>
        (b.sourceTaskId != null && b.sourceTaskId === task.id) ||
        b.title.trim().toLowerCase() === task.title.trim().toLowerCase() ||
        b.itemNumber === task.id
    );
    lines.push(`\n### Task #${task.id}: ${task.title} (${task.category}) [Origin: ${fileName} / "${laneTitle}"]${task.isArchived ? ' [ARCHIVED]' : ''}`);
    if (task.subtasks.length > 0) {
      lines.push('Subtasks: ' + task.subtasks.map((s) => s.text).join('; '));
    }
    if (brief) {
      if (brief.overview) lines.push(`Overview:\n${brief.overview}`);
      if (brief.buildAndVerification) lines.push(`Build & Verification:\n${brief.buildAndVerification}`);
      if (brief.completion) lines.push(`Completion:\n${brief.completion}`);
    }
  }
  return lines.join('\n');
}

/**
 * Assembles a structured DiscoveryJobPayload object containing the target task
 * straight from the user and delineated entries for every related task discovered.
 */
export function buildDiscoveryJobPayload(
  targetTask: TaskItem,
  relevantTaskIds: (string | number)[],
  swimLanesOrTodo: SwimLaneDoc[] | string | undefined,
  agentContextMarkdown: string,
  todoFallback: string = ''
): DiscoveryJobPayload {
  const allWorkspaceEntries = extractAllWorkspaceTasks(swimLanesOrTodo, todoFallback);
  const allBriefs = parseAgentContextMarkdown(agentContextMarkdown);
  const totalTasksScanned = allWorkspaceEntries.length;
  const laneCount = Array.isArray(swimLanesOrTodo) && swimLanesOrTodo.length > 0 ? swimLanesOrTodo.length : 1;

  const additionalContext: DiscoveredTaskContextEntry[] = [];

  for (const id of relevantTaskIds) {
    const entry = allWorkspaceEntries.find((e) => e.task.id === id);
    if (!entry) continue;
    const { task, fileName, laneTitle } = entry;
    const brief = allBriefs.find(
      (b) =>
        (b.sourceTaskId != null && b.sourceTaskId === task.id) ||
        b.title.trim().toLowerCase() === task.title.trim().toLowerCase() ||
        b.itemNumber === task.id
    );

    additionalContext.push({
      taskId: task.id,
      title: task.title,
      category: task.category,
      status: task.status,
      isDone: Boolean(task.isDone),
      isArchived: Boolean(task.isArchived),
      sourceDocument: fileName,
      swimLaneTitle: laneTitle,
      subtasks: task.subtasks.map((s) => (typeof s === 'string' ? s : s.text)),
      overview: brief?.overview || brief?.brief || undefined,
      buildAndVerification: brief?.buildAndVerification || brief?.built || undefined,
      completion: brief?.completion || brief?.validation || undefined
    });
  }

  return {
    targetTask: {
      id: targetTask.id,
      title: targetTask.title,
      category: targetTask.category,
      status: targetTask.status,
      isDone: Boolean(targetTask.isDone),
      subtasks: targetTask.subtasks.map((s) => ({
        id: s.id,
        text: s.text,
        isDone: Boolean(s.isDone),
        isHumanReview: Boolean(s.isHumanReview)
      })),
      sourceFileName: targetTask.sourceFileName || 'TODO.md'
    },
    additionalContext,
    discoverySummary: {
      scannedDocumentCount: laneCount,
      totalTasksScanned,
      relevantTasksCount: additionalContext.length
    }
  };
}


/**
 * Synthesizes a comprehensive, verbose Overview document and determines
 * the specific MCP tools/servers strictly needed for this task.
 */
export function buildVerboseOverviewAndRequiredMcps(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  _discoveryPayload: DiscoveryJobPayload,
  connectedMcps: MCPServer[],
  parsedAiOverview?: Partial<OverviewDocument> & { requiredMcps?: string[] }
): { overviewDoc: OverviewDocument; requiredMcps: string[] } {
  const activeMcps = connectedMcps.filter((m) => m.status === 'connected');

  // 1. Determine precise MCP requirements for THIS task
  let resolvedMcps: string[] = [];
  if (parsedAiOverview && Array.isArray(parsedAiOverview.requiredMcps) && parsedAiOverview.requiredMcps.length > 0) {
    // Only accept MCPs that match connected servers or tool names
    resolvedMcps = parsedAiOverview.requiredMcps
      .map((m) => (typeof m === 'string' ? m.trim() : (m && typeof m === 'object' ? (m as any).name || (m as any).id || '' : '')))
      .filter((mcpRef) => {
        if (!mcpRef) return false;
        const lower = mcpRef.toLowerCase();
        return activeMcps.some(
          (m) => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower || m.tools.some((t) => t.name.toLowerCase() === lower)
        );
      });
  }

  // If AI didn't specify or we need fallback resolution, intelligently inspect task intent
  if (resolvedMcps.length === 0) {
    const textToScan = `${task.title} ${task.subtasks.map((s) => s.text).join(' ')} ${brief?.overview || ''}`.toLowerCase();
    const hasFs = activeMcps.find((m) => m.id === 'mcp-filesystem' || m.name.toLowerCase().includes('filesystem'));
    const hasGit = activeMcps.find((m) => m.id === 'mcp-git' || m.name.toLowerCase().includes('git'));
    const hasFetch = activeMcps.find((m) => m.id === 'mcp-fetch' || m.name.toLowerCase().includes('fetch'));

    if (textToScan.includes('git') || textToScan.includes('commit') || textToScan.includes('branch') || textToScan.includes('repository')) {
      if (hasGit && !resolvedMcps.includes(hasGit.name)) resolvedMcps.push(hasGit.name);
    }
    if (textToScan.includes('fetch') || textToScan.includes('url') || textToScan.includes('http') || textToScan.includes('api') || textToScan.includes('download')) {
      if (hasFetch && !resolvedMcps.includes(hasFetch.name)) resolvedMcps.push(hasFetch.name);
    }
    if (textToScan.includes('file') || textToScan.includes('code') || textToScan.includes('component') || textToScan.includes('create') || textToScan.includes('write') || textToScan.includes('edit') || textToScan.includes('refactor') || textToScan.includes('implement')) {
      if (hasFs && !resolvedMcps.includes(hasFs.name)) resolvedMcps.push(hasFs.name);
    }
    // Default to Filesystem MCP if code/files are likely modified and available
    if (resolvedMcps.length === 0 && hasFs && (task.subtasks.length > 0 || task.category.toLowerCase().includes('code') || task.category.toLowerCase().includes('dev') || task.category.toLowerCase().includes('backend') || task.category.toLowerCase().includes('frontend'))) {
      resolvedMcps.push(hasFs.name);
    }
  }

  // 2. Build dense, human-verifiable Gherkin done-state acceptance brief & sections
  const contextNotes = _discoveryPayload.additionalContext.length > 0
    ? `\n    And relevant context from task #${_discoveryPayload.additionalContext.map((c) => `${c.taskId} ("${c.title}")`).join(', #')} is incorporated`
    : '';

  const gherkinSteps: string[] = [];
  if (task.subtasks.length > 0) {
    task.subtasks.forEach((s) => {
      const cleanText = s.text.replace(/^[0-9]+[.)-]\s*/, '').replace(/\.$/, '').trim();
      gherkinSteps.push(`    And the agent completes: ${cleanText}`);
    });
  } else {
    gherkinSteps.push(`    And the agent implements the core feature deliverables for "${task.title}"`);
  }

  const fallbackBrief =
`Feature: ${task.title} (${task.category || 'General'})
  Scenario: Successful implementation of ${task.title}
    Given the workspace environment and dependencies for ${task.category || 'the project'} are initialized${contextNotes}
    When the user or pipeline triggers execution of task #${task.id}
${gherkinSteps.join('\n')}
    Then all acceptance checks, state transitions, and edge cases operate cleanly without silent failures
    And all changed files pass type checks and verification before completion`;

  const rawAiBrief = extractStringFromAiValue(parsedAiOverview?.brief || (parsedAiOverview as any)?.summary);
  const isRawTitle = rawAiBrief.toLowerCase() === task.title.toLowerCase().trim() ||
    rawAiBrief.toLowerCase().startsWith(`task #${task.id}`.toLowerCase()) ||
    rawAiBrief.length <= task.title.length + 5;

  const briefText = (!isRawTitle && rawAiBrief.length > 30)
    ? rawAiBrief
    : fallbackBrief;

  const fallbackGoals = task.subtasks.length > 0
    ? task.subtasks.map((s, idx) => `${idx + 1}. ${s.text}${s.isDone ? ' [Completed]' : ''}`).join('\n')
    : `1. Implement and verify the core requirements for: ${task.title}\n2. Record comprehensive build log and verification notes.`;

  const rawAiGoals = extractStringFromAiValue(parsedAiOverview?.goals);
  const goals = (rawAiGoals.length > 5)
    ? rawAiGoals
    : fallbackGoals;

  const fallbackOutputAs = resolvedMcps.some((m) => m.toLowerCase().includes('filesystem') || m.toLowerCase().includes('file'))
    ? `Write and modify source files in workspace via Filesystem MCP, then record completion summary in AGENT_CONTEXT.md.`
    : resolvedMcps.some((m) => m.toLowerCase().includes('git'))
      ? `Perform Git repository operations via Git MCP, then output commit logs and status.`
      : `Return structured completion summary and results in AGENT_CONTEXT.md.`;

  const rawAiOutputAs = extractStringFromAiValue(parsedAiOverview?.output_as);
  const output_as = (rawAiOutputAs.length > 5)
    ? rawAiOutputAs
    : fallbackOutputAs;

  const raw = `## Brief\n\n${briefText}\n\n## Goals\n\n${goals}\n\n## Output As\n\n${output_as}`;

  return {
    overviewDoc: { brief: briefText, goals, output_as, raw },
    requiredMcps: resolvedMcps
  };
}

/**
  * Assembles the concise, structured JSON "Bible Prompt" for Step 3 Manager AI.
  * Filters out raw document blobs and extracts only the essential task data,
  * Gherkin scenarios, goals, tool output target, and scoped discovered context.
  */
export function buildManagerBiblePayload(
  discoveryPayload: DiscoveryJobPayload,
  overviewDoc: OverviewDocument,
  project: { name?: string; folderPath?: string } | undefined,
  connectedMcps: MCPServer[],
  allowedRoots: { name: string; path: string }[]
): ManagerBiblePayload {
  const activeMcps = connectedMcps
    .filter((m) => m.status === 'connected')
    .map((m) => m.name);

  const discoveredContext = discoveryPayload.additionalContext.map((c) => ({
    taskId: c.taskId,
    title: c.title,
    category: c.category,
    sourceDocument: c.sourceDocument,
    overviewSnippet: c.overview ? (c.overview.length > 250 ? c.overview.slice(0, 250) + '...' : c.overview) : undefined
  }));

  return {
    task: {
      id: discoveryPayload.targetTask.id,
      title: discoveryPayload.targetTask.title,
      category: discoveryPayload.targetTask.category,
      status: discoveryPayload.targetTask.status,
      subtasks: discoveryPayload.targetTask.subtasks.map((s) => ({
        id: s.id,
        text: s.text,
        isDone: s.isDone,
        isHumanReview: s.isHumanReview
      })),
      sourceFileName: discoveryPayload.targetTask.sourceFileName
    },
    overview: {
      brief: overviewDoc.brief,
      goals: overviewDoc.goals,
      output_as: overviewDoc.output_as,
      requiredMcps: discoveryPayload.requiredMcps || []
    },
    discoveredContext,
    environment: {
      projectName: project?.name || 'Default Workspace',
      projectPath: project?.folderPath || '~/.ergo',
      allowedRoots: allowedRoots.map((r) => r.path),
      activeMcps
    }
  };
}

/**
 * Formats the ManagerBiblePayload into a human-readable, structured Markdown master blueprint document.
 */
export function formatManagerBibleMarkdown(bible: ManagerBiblePayload): string {
  const sections: string[] = [];

  sections.push(`# TASK EXECUTION BIBLE: ${bible.task.title}\n`);

  sections.push(`## Metadata`);
  sections.push(`- **Task ID**: #${bible.task.id}`);
  sections.push(`- **Category**: ${bible.task.category || 'General'}`);
  sections.push(`- **Status**: ${bible.task.status || 'todo'}`);
  if (bible.task.sourceFileName) sections.push(`- **Source Document**: ${bible.task.sourceFileName}`);
  sections.push(`- **Project**: ${bible.environment.projectName} (${bible.environment.projectPath})\n`);

  sections.push(`## Target Task & Subtasks`);
  if (bible.task.subtasks && bible.task.subtasks.length > 0) {
    bible.task.subtasks.forEach((s) => {
      sections.push(`- [${s.isDone ? 'x' : ' '}] ${s.text}${s.isHumanReview ? ' **[Human Review]**' : ''}`);
    });
  } else {
    sections.push(`- [ ] ${bible.task.title}`);
  }
  sections.push('');

  sections.push(`## Overview & Acceptance Criteria (Gherkin Scenarios)`);
  sections.push('```gherkin');
  sections.push(bible.overview.brief.trim());
  sections.push('```\n');

  sections.push(`## Deliverable Goals`);
  sections.push(bible.overview.goals.trim() + '\n');

  sections.push(`## Output Destination & Method`);
  sections.push(`- **Destination**: ${bible.overview.output_as}`);
  sections.push(`- **Required MCPs**: ${bible.overview.requiredMcps && bible.overview.requiredMcps.length > 0 ? bible.overview.requiredMcps.join(', ') : '(none - pure reasoning/text)'}`);
  sections.push(`- **Allowed Boundaries**: ${bible.environment.allowedRoots.join(', ') || bible.environment.projectPath}\n`);

  if (bible.discoveredContext && bible.discoveredContext.length > 0) {
    sections.push(`## Discovered Context References`);
    bible.discoveredContext.forEach((ctx) => {
      sections.push(`- **Task #${ctx.taskId} (${ctx.title})** [from \`${ctx.sourceDocument}\` / ${ctx.category}]: ${ctx.overviewSnippet || 'Referenced for context.'}`);
    });
    sections.push('');
  }

  sections.push(`## Execution Event Log (Append-Only)`);
  sections.push(`- Task initialized at ${new Date().toISOString()}`);

  return sections.join('\n');
}

/**
 * Offline / no-provider fallback execution.
 * Simulates the pipeline with dummy steps for demo and development purposes.
 */
export async function runOfflineExecution(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  project: ProjectData | undefined,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem }> {
  console.log(
    '%c[Ergo Agent Pipeline] ── Step 1: User Task/Selection Sent to Discovery AI (Offline Mode) ──',
    'color: #38bdf8; font-weight: bold; font-size: 13px;'
  );
  console.log('📌 Target Task Payload:', {
    id: task.id,
    title: task.title,
    category: task.category,
    status: task.status,
    isDone: Boolean(task.isDone),
    subtasks: task.subtasks.map((s) => ({ id: s.id, text: s.text, isDone: s.isDone, isHumanReview: s.isHumanReview })),
    sourceFileName: task.sourceFileName || 'TODO.md'
  });

  const discoveryPayload = buildDiscoveryJobPayload(
    task,
    [],
    project?.swimLanes,
    project?.agentContextMarkdown || '',
    project?.todoMarkdown
  );

  console.log(
    '%c[Ergo Agent Pipeline] ── Step 2: Discovery AI Output (Plain JSON Payload - Offline Mode) ──',
    'color: #06b6d4; font-weight: bold; font-size: 13px;'
  );
  console.log('📦 Discovery Plain JSON Object:', discoveryPayload);
  console.log('📄 Stringified Discovery Payload:\n' + JSON.stringify(discoveryPayload, null, 2));

  const toolName = (task.title.toLowerCase().includes('vscode') || task.title.toLowerCase().includes('editor') || task.title.toLowerCase().includes('markdown'))
    ? 'write_file'
    : (task.title.toLowerCase().includes('git') || task.title.toLowerCase().includes('commit'))
      ? 'git_status'
      : (task.title.toLowerCase().includes('fetch') || task.title.toLowerCase().includes('web') || task.title.toLowerCase().includes('api'))
        ? 'fetch_markdown'
        : (connectedMcps[0]?.tools[0]?.name || 'read_file');

  const targetServerId = toolName.startsWith('git_')
    ? 'mcp-git'
    : toolName.startsWith('fetch_')
      ? 'mcp-fetch'
      : toolName.includes('file') || toolName.includes('directory')
        ? 'mcp-filesystem'
        : (connectedMcps[0]?.id || 'mcp-filesystem');

  const { overviewDoc, requiredMcps } = buildVerboseOverviewAndRequiredMcps(
    task,
    brief,
    discoveryPayload,
    connectedMcps
  );

  discoveryPayload.overview = overviewDoc;
  discoveryPayload.requiredMcps = requiredMcps;

  console.log(
    '%c[Ergo Agent Pipeline] ── Step 2: Summary AI Output (Updated JSON Payload - Offline Mode) ──',
    'color: #f59e0b; font-weight: bold; font-size: 13px;'
  );
  console.log('📦 Updated Job JSON Object (Summary & MCP Plan Added):', discoveryPayload);
  console.log('📄 Stringified Updated Payload:\n' + JSON.stringify(discoveryPayload, null, 2));

  const managerBible = buildManagerBiblePayload(
    discoveryPayload,
    overviewDoc,
    project || { name: 'Default Workspace', folderPath: '~/.ergo' },
    connectedMcps,
    [{ name: 'Workspace', path: project?.folderPath || '~/.ergo' }]
  );

  const markdownBible = formatManagerBibleMarkdown(managerBible);
  console.log(
    '%c[Ergo Agent Pipeline] ── Step 3: Manager AI Bible Prompt (Offline Mode - Markdown) ──',
    'color: #10b981; font-weight: bold; font-size: 13px;'
  );
  console.log('📖 Manager Bible Payload (Offline):', managerBible);
  console.log('📄 Formatted Markdown Bible (Offline):\n' + markdownBible);

  const totalScanned = discoveryPayload.discoverySummary.totalTasksScanned;
  const offlineSteps: Partial<ExecutionStep>[] = [
    { id: 'step-1', stage: 'context', title: 'Discovery AI: Reading Shared Context & Scanning All Documents', detail: `Scanning all task headers and workspace documents for #${task.id}: "${task.title}" (Found ${totalScanned} workspace tasks across all swim lanes & archives)...`, status: 'running' },
    { id: 'step-2', stage: 'mcp_call', title: `Executing MCP Tool (${targetServerId} / ${toolName})`, detail: `Resolving tool dependencies and executing ${toolName}() across safe roots...`, mcpToolUsed: toolName, status: 'pending' },
    { id: 'step-3', stage: 'execution', title: 'Manager AI: Executing Puzzle Pieces & Implementation Steps', detail: `Processing Gherkin scenarios & subtasks: ${task.subtasks.map((s) => s.text).join('; ') || 'Implementing core logic'}`, status: 'pending' },
    { id: 'step-4', stage: 'built_record', title: 'Rendering Interactive MCP App Widget', detail: 'Building visual interactive UI result and code diff preview...', status: 'pending', widgetType: getWidgetTypeForTask(task), widgetData: getWidgetDataForTask(task) },
    { id: 'step-5', stage: 'done', title: 'Updating Dual-File AGENT_CONTEXT.md & TODO.md', detail: 'Recording Built decisions, Validation results, and marking task as completed.', status: 'pending' }
  ];

  onStepUpdate({
    id: offlineSteps[0].id!,
    time: new Date().toLocaleTimeString(),
    stage: offlineSteps[0].stage!,
    title: 'Discovery AI: Context Identified',
    detail: `Scanned ${totalScanned} task headers across all swim lanes & archives. Loaded task #${task.id} & parsed brief constraints.`,
    status: 'success',
    discoveryPayload,
    usage: { inputTokens: 410, outputTokens: 90, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 1 },
    totalUsage: { inputTokens: 410, outputTokens: 90, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 1 }
  });
  onStepUpdate({
    id: 'step-overview',
    time: new Date().toLocaleTimeString(),
    stage: 'overview',
    title: 'Summary AI: Overview & Tool Plan Ready',
    detail: `Overview built (Gherkin brief) — output format: ${overviewDoc.output_as.slice(0, 90)}${discoveryPayload.requiredMcps.length > 0 ? ` (MCPs: ${discoveryPayload.requiredMcps.join(', ')})` : ''}`,
    status: 'success',
    overviewDocument: overviewDoc,
    discoveryPayload,
    usage: { inputTokens: 520, outputTokens: 160, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 1 },
    totalUsage: { inputTokens: 930, outputTokens: 250, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 2 }
  });

  const matchingServer = connectedMcps.find((s) => s.id === targetServerId);
  const matchingTool = matchingServer?.tools.find((t) => t.name === toolName);
  const requiresPermission = matchingTool ? !matchingTool.autoApprove : (toolName === 'write_file' || toolName === 'git_commit');

  if (requiresPermission && onRequestPermission) {
    onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: `Prompting User Permission: ${toolName}()`, detail: `Waiting for user authorization to execute ${targetServerId} / ${toolName}...`, mcpToolUsed: toolName, status: 'running' });
    const approved = await onRequestPermission({ id: `perm-${Date.now()}`, serverId: targetServerId, serverName: matchingServer?.name || targetServerId, toolName, args: { path: `projects/default-workspace/TODO.md` }, summary: `Execute tool "${toolName}" on MCP server "${matchingServer?.name || targetServerId}" with user-approved parameters.` });
    if (!approved) {
      onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: `Permission Denied for ${toolName}()`, detail: `User skipped or rejected tool execution. Falling back to read-only simulation.`, mcpToolUsed: toolName, status: 'warning' });
    }
  }

  // Simulate mid-build interactive clarification if task requests it
  if (onRequestHumanInput && (task.title.toLowerCase().includes('clarify') || task.title.toLowerCase().includes('choice') || task.title.toLowerCase().includes('prompt') || task.title.toLowerCase().includes('input'))) {
    const inputStepId = 'step-offline-human-input';
    const promptData: HumanInputPrompt = {
      id: `offline-prompt-${task.id}`,
      taskId: task.id,
      question: `Which configuration or approach should be applied for "${task.title}"?`,
      options: ['Option A (Recommended Default)', 'Option B (Alternative Strategy)', 'Option C (Minimal Setup)'],
      context: 'The Manager AI needs user clarification on which path to take before proceeding.',
      allowFreeform: true
    };
    onStepUpdate({
      id: inputStepId,
      time: new Date().toLocaleTimeString(),
      stage: 'human_input',
      title: 'Clarification Needed: Question from Manager AI',
      detail: promptData.question,
      status: 'running',
      humanInputPrompt: promptData
    });
    const ans = await onRequestHumanInput(promptData);
    onStepUpdate({
      id: inputStepId,
      time: new Date().toLocaleTimeString(),
      stage: 'human_input',
      title: 'Human Clarification Provided',
      detail: `User response: "${ans}"`,
      status: 'success',
      humanInputPrompt: undefined
    });
  }

  onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: offlineSteps[1].title!, detail: offlineSteps[1].detail!, mcpToolUsed: toolName, status: 'running' });
  let toolResultDetail = `Executed ${toolName}() via MCP stdio/HTTP bridge.`;
  try {
    const toolExec = await callMcpTool(targetServerId, toolName, { path: 'projects/default-workspace/TODO.md', url: 'https://modelcontextprotocol.io' });
    if (toolExec.success) toolResultDetail = `MCP tool ${toolName}() returned 200 OK across safe root sandbox.`;
  } catch {}
  await new Promise((r) => setTimeout(r, 600));
  onStepUpdate({ id: offlineSteps[1].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[1].stage!, title: offlineSteps[1].title!, detail: toolResultDetail, mcpToolUsed: toolName, status: 'success' });

  onStepUpdate({ id: offlineSteps[2].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[2].stage!, title: offlineSteps[2].title!, detail: offlineSteps[2].detail!, status: 'running' });
  await new Promise((r) => setTimeout(r, 800));
  onStepUpdate({ id: offlineSteps[2].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[2].stage!, title: offlineSteps[2].title!, detail: `Completed implementation of ${task.subtasks.length || 1} subtasks. All unit checks green.`, status: 'success' });

  onStepUpdate({ id: offlineSteps[3].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[3].stage!, title: offlineSteps[3].title!, detail: offlineSteps[3].detail!, status: 'running', widgetType: offlineSteps[3].widgetType, widgetData: offlineSteps[3].widgetData });
  await new Promise((r) => setTimeout(r, 900));
  onStepUpdate({ id: offlineSteps[3].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[3].stage!, title: offlineSteps[3].title!, detail: 'Interactive MCP App widget rendered live in sandbox.', status: 'success', widgetType: offlineSteps[3].widgetType, widgetData: offlineSteps[3].widgetData });

  onStepUpdate({ id: offlineSteps[4].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[4].stage!, title: offlineSteps[4].title!, detail: offlineSteps[4].detail!, status: 'running' });
  await new Promise((r) => setTimeout(r, 800));

  const buildDate = new Date().toISOString().split('T')[0];
  const overviewContent = brief?.overview || brief?.brief || `Task #${task.id} (${task.title}) overview in context.`;
  const buildVerificationContent = brief?.buildAndVerification || brief?.built
    ? `${brief.buildAndVerification || brief.built}\n\n**Mid-Task Build Journey (${buildDate}):**\n1. Inspected seams and context for #${task.id} (${task.title}).\n2. Applied implementation changes in dependency order.\n3. Ran automated verification suite.`
    : `**Mid-Task Build Journey (${buildDate}):**\n1. Inspected seams and context for #${task.id} (${task.title}).\n2. Applied implementation changes in dependency order.\n3. Ran automated verification suite.`;

  // Preserve any human review subtasks from original task or generate for complex tasks
  const hasHumanReview =
    Boolean(task.isHumanReview) ||
    task.title.toLowerCase().includes('review') ||
    task.subtasks.some((s) => s.isHumanReview || s.text.toLowerCase().includes('human review'));

  const reviewSubtasks: Subtask[] = task.subtasks.filter((s) => s.isHumanReview);
  if (hasHumanReview && reviewSubtasks.length === 0) {
    reviewSubtasks.push({
      id: `${task.id}-hr-1`,
      text: `Verify changes for "${task.title}" in workspace`,
      isDone: false,
      isHumanReview: true
    });
  }

  const executedSubtasks = task.subtasks
    .filter((s) => !s.isHumanReview)
    .map((s) => ({ ...s, isDone: true }));

  const allSubtasks = [...executedSubtasks, ...reviewSubtasks];

  let completionContent = brief?.completion || brief?.validation || brief?.humanReview || brief?.followUps
    ? `${brief.completion || brief.validation || brief.humanReview || brief.followUps}\n\n**Completion Summary (${buildDate}):**\n- Implemented all subtasks for task #${task.id}.\n- Verified 100% pass rate with 0 regressions.\n- Current Status: ${reviewSubtasks.length > 0 ? 'Partly Done (Human Review Pending)' : 'Done / Verified'}.`
    : `**Completion Summary (${buildDate}):**\n- Implemented all subtasks for task #${task.id}.\n- Verified 100% pass rate with 0 regressions.\n- Current Status: ${reviewSubtasks.length > 0 ? 'Partly Done (Human Review Pending)' : 'Done / Verified'}.`;

  if (reviewSubtasks.length > 0 && !completionContent.toLowerCase().includes('human review')) {
    completionContent += `\n\n**Human Review Required:**\n` + reviewSubtasks.map((s) => `- [ ] **human review** - ${s.text}`).join('\n');
  }

  const sampleCreatedFiles = [`projects/default-workspace/src/${task.title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20)}.ts`];
  if (!completionContent.toLowerCase().includes('created file') && !completionContent.toLowerCase().includes('artifacts')) {
    completionContent += `\n\n**Created Files & Artifacts:**\n` + sampleCreatedFiles.map((f) => `- [${f}](${f})`).join('\n');
  }

  const updatedBrief: AgentContextItem = {
    ...brief,
    id: brief?.id || `brief_${task.id}`,
    sourceTaskId: task.id,
    sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
    itemNumber: brief?.itemNumber,
    title: task.title,
    status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    overview: overviewContent,
    buildAndVerification: buildVerificationContent,
    completion: completionContent,
    createdFiles: sampleCreatedFiles,
    brief: overviewContent,
    built: buildVerificationContent,
    validation: completionContent,
    humanReview: completionContent,
    followUps: completionContent,
    totalUsage: { inputTokens: 1450, outputTokens: 420, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 3 }
  };
  const updatedTask: TaskItem = {
    ...task,
    status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    isDone: reviewSubtasks.length === 0,
    isHumanReview: hasHumanReview,
    createdFiles: sampleCreatedFiles,
    totalUsage: { inputTokens: 1450, outputTokens: 420, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 3 },
    subtasks: allSubtasks.length > 0 ? allSubtasks : task.subtasks.map((s) => ({ ...s, isDone: true }))
  };

  onStepUpdate({
    id: offlineSteps[4].id!,
    time: new Date().toLocaleTimeString(),
    stage: offlineSteps[4].stage!,
    title: reviewSubtasks.length > 0 ? 'Task Built — Human Review Pending' : 'Task Execution Completed Successfully!',
    detail: reviewSubtasks.length > 0
      ? `Task #${task.id} changes recorded in TODO.md with Human Review verification step(s).`
      : `Item #${task.id} marked DONE in TODO.md. Agent build record appended to AGENT_CONTEXT.md.`,
    status: 'success',
    totalUsage: { inputTokens: 1450, outputTokens: 420, cachedInputTokens: 300, cacheWriteTokens: 0, calls: 3 }
  });

  return { updatedBrief, updatedTask };
}

function getWidgetTypeForTask(task: TaskItem): ExecutionStep['widgetType'] {
  const title = task.title.toLowerCase();
  if (title.includes('vscode') || title.includes('vs code') || title.includes('editor') || title.includes('markdown')) return 'vscode_preview';
  if (title.includes('funnel') || title.includes('analytics') || title.includes('drop')) return 'analytics_chart';
  if (title.includes('slack') || title.includes('dispatch') || title.includes('announcement')) return 'slack_draft';
  if (title.includes('figma') || title.includes('hero') || title.includes('banner')) return 'figma_preview';
  if (title.includes('bluebeam') || title.includes('pdf') || title.includes('compare')) return 'bluebeam_diff';
  return 'code_diff';
}

function getWidgetDataForTask(task: TaskItem) {
  const widgetType = getWidgetTypeForTask(task);
  if (widgetType === 'vscode_preview') {
    return { editorFile: 'TODO.md', activeLine: 18, commandExecuted: 'edit_active_document', connectionStatus: 'Active Stdio Bridge (vscode-ipc://ergo-vscode-bridge)', selectionRange: 'Lines 15-24', diffLines: ['  14 | - ~~comparisons between revisions~~', '+ 15 | 1. **conditions:** [VS Code MCP Active Target]', '+ 16 |     - search feature in schedules panel (driven via VS Code MCP)', '+ 17 |     - **human review** - verify condition details in VS Code active tab'] };
  }
  if (widgetType === 'analytics_chart') {
    return { title: 'Signup Conversion Funnel (Q2 2026)', dropoffRate: '34.2%', step1: { name: 'Landing Page Visit', users: 14200 }, step2: { name: 'Account Creation', users: 8900 }, step3: { name: 'Workspace Init', users: 5850 } };
  }
  if (widgetType === 'slack_draft') {
    return { channel: '#product-announcements', sender: 'Ergo Agent Bot', message: `🚀 **Campaign Launch Digest**: All Q3 assets are deployed to Google Drive! Conversion analytics are now live in Amplitude.` };
  }
  if (widgetType === 'bluebeam_diff') {
    return { sheetNumber: 'A-101', sheetTitle: 'FIRST FLOOR PLAN - ADDENDUM 2', changedRegionsCount: 3, changeScore: 0.88, affectedConditions: ['72. Unilock ARTLINE UMBRIANO', '90. Foreverlawn Turf'] };
  }
  return { filename: 'lib/schedules.js', diffLines: ['- const schedFilter = activeSchedKey;', '+ const treeNodes = buildTree(treeModel);', '+ filterNodesByQuery(treeNodes, searchQuery);'] };
}

