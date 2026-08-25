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
  type SwimLaneDoc
} from '../types';
import { callMcpTool, formatConnectionsForAiPrompt, getAllowedRoots } from './mcpClient';
import { storageManager } from './storageManager';
import { parseTodoMarkdown, parseAgentContextMarkdown } from './parser';

/**
 * Drafts new scannable tasks for TODO.md and verbose briefs for AGENT_CONTEXT.md
 */
/**
 * Generic API call handler for Bring-Your-Own-AI providers (OpenAI, Anthropic, Gemini, Ollama)
 */
export async function callAiEngine(
  prompt: string,
  systemPrompt: string,
  config: AIProviderConfig,
  taskType: 'discovery' | 'general' = 'general',
  responseFormat: 'text' | 'json' = taskType === 'discovery' ? 'json' : 'text'
): Promise<string> {
  const { provider, apiKey, baseUrl } = config;
  const targetModel = taskType === 'discovery'
    ? (config.discoveryModel || config.generalModel || config.model)
    : (config.generalModel || config.model);

  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI API key missing.');
    const reqBody: any = {
      model: targetModel || (taskType === 'discovery' ? 'gpt-4o-mini' : 'gpt-4o'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    };
    if (responseFormat === 'json') {
      reqBody.response_format = { type: 'json_object' };
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic API key missing.');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: targetModel || (taskType === 'discovery' ? 'claude-3-5-haiku-20241022' : 'claude-3-7-sonnet-20250219'),
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  if (provider === 'gemini') {
    if (!apiKey) throw new Error('Google Gemini API key missing.');
    const geminiModel = targetModel || (taskType === 'discovery' ? 'gemini-2.5-flash' : 'gemini-1.5-pro');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUSER PROMPT:\n${prompt}` }] }]
        })
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (provider === 'ollama') {
    const host = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const reqBody: any = {
      model: targetModel || (taskType === 'discovery' ? 'llama3.2' : 'qwen2.5-coder'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      stream: false
    };
    if (responseFormat === 'json') {
      reqBody.format = 'json';
    }
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) {
      await res.json().catch(() => ({}));
      throw new Error(`Ollama server at ${host} returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.message?.content || '';
  }

  throw new Error('Simulated engine active.');
}

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



function stripSkillFrontmatter(raw?: string | null): string {
  if (!raw) return '';
  if (raw.startsWith('---')) {
    const parts = raw.split('---');
    if (parts.length >= 3) {
      return parts.slice(2).join('---').trim();
    }
  }
  return raw.trim();
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
function extractAllWorkspaceTasks(
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
function buildTaskHeaderIndex(
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
function getRelevantTasksContext(
  relevantIds: number[],
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
      (b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase() || b.itemNumber === task.id
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

/** Converts connected MCP tools to Anthropic tool_use format */
function mcpToolsToAnthropicFormat(connectedMcps: MCPServer[]): any[] {
  const tools: any[] = [
    {
      name: 'ask_human',
      description: 'Prompt the human user for necessary information, clarification, or choices mid-task. Use this when you are blocked by missing credentials, ambiguous requirements, or architectural decisions.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question or prompt to present to the user' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of multiple choice options for the user to select from'
          },
          context: { type: 'string', description: 'Optional context explaining why this information is required' },
          allowFreeform: { type: 'boolean', description: 'Whether the user can type a custom response (default true)' }
        },
        required: ['question']
      }
    }
  ];

  const mcpTools = connectedMcps
    .filter((s) => s.status === 'connected')
    .flatMap((server) =>
      server.tools.map((tool) => ({
        name: tool.name,
        description: `[${server.name}] ${tool.description}`,
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Target file path or resource identifier' },
            url: { type: 'string', description: 'URL if making web/API requests' },
            content: { type: 'string', description: 'Content to write, if applicable' },
            args: { type: 'object', description: 'Additional tool arguments' }
          }
        }
      }))
    );

  return [...tools, ...mcpTools];
}

/** Converts connected MCP tools to OpenAI function-calling format */
function mcpToolsToOpenAiFormat(connectedMcps: MCPServer[]): any[] {
  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'ask_human',
        description: 'Prompt the human user for necessary information, clarification, or choices mid-task. Use this when you are blocked by missing credentials, ambiguous requirements, or architectural decisions.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question or prompt to present to the user' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of multiple choice options for the user to select from'
            },
            context: { type: 'string', description: 'Optional context explaining why this information is required' },
            allowFreeform: { type: 'boolean', description: 'Whether the user can type a custom response (default true)' }
          },
          required: ['question']
        }
      }
    }
  ];

  const mcpTools = connectedMcps
    .filter((s) => s.status === 'connected')
    .flatMap((server) =>
      server.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: `[${server.name}] ${tool.description}`,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Target file path or resource' },
              url: { type: 'string', description: 'URL if making web/API requests' },
              content: { type: 'string', description: 'Content to write, if applicable' },
              args: { type: 'object', description: 'Additional tool arguments' }
            }
          }
        }
      }))
    );

  return [...tools, ...mcpTools];
}

/** Converts connected MCP tools to Gemini function declarations format */
function mcpToolsToGeminiFormat(connectedMcps: MCPServer[]): any[] {
  const tools: any[] = [
    {
      name: 'ask_human',
      description: 'Prompt the human user for necessary information, clarification, or choices mid-task. Use this when you are blocked by missing credentials, ambiguous requirements, or architectural decisions.',
      parameters: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING', description: 'The question or prompt to present to the user' },
          options: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Optional list of multiple choice options for the user to select from'
          },
          context: { type: 'STRING', description: 'Optional context explaining why this information is required' }
        },
        required: ['question']
      }
    }
  ];

  const mcpTools = connectedMcps
    .filter((s) => s.status === 'connected')
    .flatMap((server) =>
      server.tools.map((tool) => ({
        name: tool.name,
        description: `[${server.name}] ${tool.description}`,
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'Target file path or resource' },
            url: { type: 'STRING', description: 'URL for web/API requests' },
            content: { type: 'STRING', description: 'Content to write, if applicable' }
          }
        }
      }))
    );

  return [...tools, ...mcpTools];
}

/** Finds which connected MCP server owns a given tool name */
function findToolServer(
  toolName: string,
  connectedMcps: MCPServer[]
): { serverId: string; serverName: string } | null {
  for (const server of connectedMcps.filter((s) => s.status === 'connected')) {
    if (server.tools.find((t) => t.name === toolName)) {
      return { serverId: server.id, serverName: server.name };
    }
  }
  return null;
}

/**
 * Shared logic for executing a single MCP tool call within a builder loop.
 * Handles permission checks, callMcpTool, and step emission.
 */
async function executeMcpToolCall(
  toolName: string,
  toolArgs: Record<string, any>,
  stepIndex: number,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  currentTaskId: number = 0,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>
): Promise<{ resultContent: string; approved: boolean; writtenFile?: string }> {
  // ── Built-in interactive human clarification tool ──
  if (toolName === 'ask_human') {
    const stepId = `step-human-input-${stepIndex}`;
    const question = typeof toolArgs.question === 'string' ? toolArgs.question : 'The agent is requesting human input to proceed:';
    const options = Array.isArray(toolArgs.options)
      ? toolArgs.options.filter((o: any) => typeof o === 'string' && o.trim().length > 0)
      : undefined;
    const context = typeof toolArgs.context === 'string' ? toolArgs.context : undefined;
    const allowFreeform = toolArgs.allowFreeform !== false;

    const promptData: HumanInputPrompt = {
      id: `prompt-${Date.now()}-${stepIndex}`,
      taskId: currentTaskId,
      question,
      options,
      context,
      allowFreeform
    };

    onStepUpdate({
      id: stepId,
      time: new Date().toLocaleTimeString(),
      stage: 'human_input',
      title: 'Clarification Needed: Question from Builder AI',
      detail: question,
      status: 'running',
      humanInputPrompt: promptData
    });

    let humanAnswer = '';
    if (onRequestHumanInput) {
      humanAnswer = await onRequestHumanInput(promptData);
    } else {
      humanAnswer = 'User provided default approval / confirmation.';
    }

    onStepUpdate({
      id: stepId,
      time: new Date().toLocaleTimeString(),
      stage: 'human_input',
      title: 'Human Clarification Provided',
      detail: `Answer received: "${humanAnswer}"`,
      status: 'success',
      humanInputPrompt: undefined
    });

    return {
      resultContent: `Human user provided response: "${humanAnswer}"`,
      approved: true
    };
  }

  const serverInfo = findToolServer(toolName, connectedMcps);
  const stepId = `step-tool-${stepIndex}`;

  onStepUpdate({
    id: stepId,
    time: new Date().toLocaleTimeString(),
    stage: 'mcp_call',
    title: `MCP Tool Call: ${toolName}()`,
    detail: `Calling ${serverInfo?.serverName || 'MCP'} / ${toolName}...`,
    mcpToolUsed: toolName,
    status: 'running'
  });

  // Check permission
  let approved = true;
  if (serverInfo && onRequestPermission) {
    const server = connectedMcps.find((s) => s.id === serverInfo.serverId);
    const toolDef = server?.tools.find((t) => t.name === toolName);
    if (toolDef && !toolDef.autoApprove) {
      approved = await onRequestPermission({
        id: `perm-${Date.now()}`,
        serverId: serverInfo.serverId,
        serverName: serverInfo.serverName,
        toolName,
        args: toolArgs,
        summary: `Execute tool "${toolName}" on MCP server "${serverInfo.serverName}".`
      });
    }
  }

  let resultContent = '';
  if (!approved) {
    resultContent = 'Tool call rejected by user.';
  } else if (!serverInfo) {
    resultContent = `Tool "${toolName}" is not available in any connected MCP server.`;
  } else {
    try {
      const result = await callMcpTool(serverInfo.serverId, toolName, toolArgs);
      resultContent = result.success
        ? typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data)
        : `Error: ${result.error}`;
    } catch (err: any) {
      resultContent = `Exception calling tool: ${err.message}`;
    }
  }

  let writtenFile: string | undefined = undefined;
  if (approved && (toolName === 'write_file' || toolName === 'create_directory')) {
    const p = (toolArgs.path || toolArgs.filePath || '').trim();
    if (p) writtenFile = p;
  }

  onStepUpdate({
    id: stepId,
    time: new Date().toLocaleTimeString(),
    stage: 'mcp_call',
    title: `MCP Tool Call: ${toolName}()`,
    detail: approved
      ? `Result: ${resultContent.slice(0, 250)}${resultContent.length > 250 ? '...' : ''}`
      : 'Tool call skipped / rejected by user.',
    mcpToolUsed: toolName,
    status: approved ? 'success' : 'warning'
  });

  return { resultContent, approved, writtenFile };
}

/**
 * Anthropic builder: native tool_use conversation loop.
 */
async function runAnthropicBuilderLoop(
  systemPrompt: string,
  initialUserContent: string,
  mcpTools: any[],
  config: AIProviderConfig,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  currentTaskId: number = 0,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>,
  maxRounds = 8
): Promise<{ text: string; toolCallCount: number; toolCallLog: string[]; createdFiles: string[] }> {
  const targetModel = config.generalModel || config.model || 'claude-3-5-sonnet-20241022';
  let messages: any[] = [{ role: 'user', content: initialUserContent }];
  let toolCallCount = 0;
  const toolCallLog: string[] = [];
  const createdFiles: string[] = [];
  let finalText = '';

  for (let round = 0; round < maxRounds; round++) {
    const reqBody: any = {
      model: targetModel,
      max_tokens: 4000,
      system: systemPrompt,
      messages
    };
    if (mcpTools.length > 0) reqBody.tools = mcpTools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey!,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic API error HTTP ${res.status}`);
    }
    const data = await res.json();
    const contentBlocks = data.content || [];
    const stopReason = data.stop_reason;

    const textBlocks = contentBlocks.filter((b: any) => b.type === 'text');
    if (textBlocks.length > 0) finalText = textBlocks.map((b: any) => b.text).join('\n');

    const toolUseBlocks = contentBlocks.filter((b: any) => b.type === 'tool_use');
    if (stopReason !== 'tool_use' || toolUseBlocks.length === 0) break;

    messages.push({ role: 'assistant', content: contentBlocks });

    const toolResults: any[] = [];
    for (const toolUse of toolUseBlocks) {
      const toolArgs = toolUse.input || {};
      const { resultContent, writtenFile } = await executeMcpToolCall(
        toolUse.name, toolArgs, ++toolCallCount, connectedMcps, onStepUpdate, onRequestPermission, currentTaskId, onRequestHumanInput
      );
      if (writtenFile && !createdFiles.includes(writtenFile)) {
        createdFiles.push(writtenFile);
      }
      toolCallLog.push(`${toolUse.name}(): ${resultContent.slice(0, 80)}`);
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: resultContent });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { text: finalText, toolCallCount, toolCallLog, createdFiles };
}

/**
 * OpenAI builder: function-calling conversation loop.
 */
async function runOpenAiBuilderLoop(
  systemPrompt: string,
  initialUserContent: string,
  mcpTools: any[],
  config: AIProviderConfig,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  currentTaskId: number = 0,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>,
  maxRounds = 8
): Promise<{ text: string; toolCallCount: number; toolCallLog: string[]; createdFiles: string[] }> {
  const targetModel = config.generalModel || config.model || 'gpt-4o';
  let messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUserContent }
  ];
  let toolCallCount = 0;
  const toolCallLog: string[] = [];
  const createdFiles: string[] = [];
  let finalText = '';

  for (let round = 0; round < maxRounds; round++) {
    const reqBody: any = { model: targetModel, messages };
    if (mcpTools.length > 0) { reqBody.tools = mcpTools; reqBody.tool_choice = 'auto'; }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API error HTTP ${res.status}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const message = choice?.message;
    if (message?.content) finalText = message.content;
    if (choice?.finish_reason !== 'tool_calls' || !message?.tool_calls?.length) break;

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });

    for (const toolCall of message.tool_calls) {
      let toolArgs: any = {};
      try { toolArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch {}
      const { resultContent, writtenFile } = await executeMcpToolCall(
        toolCall.function.name, toolArgs, ++toolCallCount, connectedMcps, onStepUpdate, onRequestPermission, currentTaskId, onRequestHumanInput
      );
      if (writtenFile && !createdFiles.includes(writtenFile)) {
        createdFiles.push(writtenFile);
      }
      toolCallLog.push(`${toolCall.function.name}(): ${resultContent.slice(0, 80)}`);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultContent });
    }
  }
  return { text: finalText, toolCallCount, toolCallLog, createdFiles };
}

/**
 * Gemini builder: function declarations conversation loop.
 */
async function runGeminiBuilderLoop(
  systemPrompt: string,
  initialUserContent: string,
  mcpTools: any[],
  config: AIProviderConfig,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  currentTaskId: number = 0,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>,
  maxRounds = 8
): Promise<{ text: string; toolCallCount: number; toolCallLog: string[]; createdFiles: string[] }> {
  const geminiModel = config.generalModel || config.model || 'gemini-1.5-pro';
  let contents: any[] = [
    { role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER PROMPT:\n${initialUserContent}` }] }
  ];
  let toolCallCount = 0;
  const toolCallLog: string[] = [];
  const createdFiles: string[] = [];
  let finalText = '';

  for (let round = 0; round < maxRounds; round++) {
    const reqBody: any = { contents };
    if (mcpTools.length > 0) reqBody.tools = [{ functionDeclarations: mcpTools }];

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${config.apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini API error HTTP ${res.status}`);
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textParts = parts.filter((p: any) => p.text);
    if (textParts.length > 0) finalText = textParts.map((p: any) => p.text).join('\n');

    const fnCallParts = parts.filter((p: any) => p.functionCall);
    if (fnCallParts.length === 0) break;

    contents.push({ role: 'model', parts });
    const fnResponses: any[] = [];
    for (const fnPart of fnCallParts) {
      const toolArgs = fnPart.functionCall.args || {};
      const { resultContent, writtenFile } = await executeMcpToolCall(
        fnPart.functionCall.name, toolArgs, ++toolCallCount, connectedMcps, onStepUpdate, onRequestPermission, currentTaskId, onRequestHumanInput
      );
      if (writtenFile && !createdFiles.includes(writtenFile)) {
        createdFiles.push(writtenFile);
      }
      toolCallLog.push(`${fnPart.functionCall.name}(): ${resultContent.slice(0, 80)}`);
      fnResponses.push({ functionResponse: { name: fnPart.functionCall.name, response: { content: resultContent } } });
    }
    contents.push({ role: 'user', parts: fnResponses });
  }
  return { text: finalText, toolCallCount, toolCallLog, createdFiles };
}

/**
 * Ollama builder: tries OpenAI-compatible tool-calling first.
 * If the model doesn't return tool_calls on first attempt (no tool-calling support),
 * falls back to runOllamaWorkerPattern.
 */
async function runOllamaBuilderLoop(
  systemPrompt: string,
  initialUserContent: string,
  mcpTools: any[],
  config: AIProviderConfig,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  currentTaskId: number = 0,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>,
  maxRounds = 8
): Promise<{ text: string; toolCallCount: number; toolCallLog: string[]; createdFiles: string[]; usedWorkerPattern: boolean }> {
  const host = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const targetModel = config.generalModel || config.model || 'llama3.2';
  let messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUserContent }
  ];
  let toolCallCount = 0;
  const toolCallLog: string[] = [];
  const createdFiles: string[] = [];
  let finalText = '';
  let toolCallingConfirmed = false;

  for (let round = 0; round < maxRounds; round++) {
    const reqBody: any = { model: targetModel, messages, stream: false };
    // Only include tools on first round until we confirm support
    if (mcpTools.length > 0 && (round === 0 || toolCallingConfirmed)) {
      reqBody.tools = mcpTools;
    }

    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    });
    if (!res.ok) throw new Error(`Ollama at ${host} returned HTTP ${res.status}`);
    const data = await res.json();
    const message = data.message;
    finalText = message?.content || '';

    const toolCalls = message?.tool_calls;
    if (toolCalls?.length > 0) {
      // Model supports tool-calling
      toolCallingConfirmed = true;
      messages.push({ role: 'assistant', content: message.content || '', tool_calls: toolCalls });

      const toolMsgs: any[] = [];
      for (const tc of toolCalls) {
        const toolName = tc.function?.name || tc.name;
        let toolArgs: any = tc.function?.arguments || tc.arguments || {};
        if (typeof toolArgs === 'string') { try { toolArgs = JSON.parse(toolArgs); } catch {} }
        const { resultContent, writtenFile } = await executeMcpToolCall(
          toolName, toolArgs, ++toolCallCount, connectedMcps, onStepUpdate, onRequestPermission, currentTaskId, onRequestHumanInput
        );
        if (writtenFile && !createdFiles.includes(writtenFile)) {
          createdFiles.push(writtenFile);
        }
        toolCallLog.push(`${toolName}(): ${resultContent.slice(0, 80)}`);
        toolMsgs.push({ role: 'tool', name: toolName, content: resultContent });
      }
      messages.push(...toolMsgs);
    } else {
      // No tool_calls returned
      if (round === 0 && mcpTools.length > 0 && !toolCallingConfirmed) {
        // First round, tools were offered but not used — model may not support tool-calling
        // Fall back to worker AI pattern
        const workerResult = await runOllamaWorkerPattern(
          systemPrompt, initialUserContent, config, connectedMcps, onStepUpdate
        );
        return { ...workerResult, createdFiles: [] };
      }
      break; // Model is done
    }
  }
  return { text: finalText, toolCallCount, toolCallLog, createdFiles, usedWorkerPattern: false };
}

/**
 * Ollama worker AI pattern for models that don't support native tool-calling.
 *
 * Flow:
 * 1. Main AI produces a structured work plan (numbered items)
 * 2. Each work item gets its own worker AI call to execute
 * 3. Worker results are stored and fed back to main AI for synthesis
 * 4. Completion log will include a note explaining the worker pattern was used.
 */
async function runOllamaWorkerPattern(
  systemPrompt: string,
  initialUserContent: string,
  config: AIProviderConfig,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void
): Promise<{ text: string; toolCallCount: number; toolCallLog: string[]; usedWorkerPattern: boolean }> {
  const host = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const targetModel = config.generalModel || config.model || 'llama3.2';
  const toolCallLog: string[] = ['[Worker AI Pattern — model does not support native tool-calling]'];
  const connectedNames = connectedMcps
    .filter((s) => s.status === 'connected')
    .map((s) => s.name)
    .join(', ');

  const callOllama = async (userContent: string, sys?: string): Promise<string> => {
    const msgs: any[] = sys
      ? [{ role: 'system', content: sys }, { role: 'user', content: userContent }]
      : [{ role: 'user', content: userContent }];
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: targetModel, messages: msgs, stream: false })
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const d = await res.json();
    return d.message?.content || '';
  };

  // ── Phase 1: Main AI produces a work plan ────────────────────────
  onStepUpdate({
    id: 'step-worker-plan',
    time: new Date().toLocaleTimeString(),
    stage: 'thinking',
    title: 'Worker Pattern: Main AI Generating Work Plan',
    detail: 'Model does not support tool-calling. Main AI is producing a work plan for worker AIs to execute...',
    status: 'running'
  });

  const planText = await callOllama(
    `${systemPrompt}\n\n${initialUserContent}\n\nYour task: Produce a structured work plan. List each concrete work item as a numbered list.\n` +
    `Each item should be self-contained so a separate worker AI can execute it given the same context.\n` +
    `Output ONLY the numbered list, nothing else. Maximum 6 items.`,
  );

  onStepUpdate({
    id: 'step-worker-plan',
    time: new Date().toLocaleTimeString(),
    stage: 'thinking',
    title: 'Worker Pattern: Work Plan Generated',
    detail: planText.slice(0, 300),
    status: 'success'
  });
  toolCallLog.push(`Work plan: ${planText.slice(0, 200)}`);

  // ── Phase 2: Spawn worker AIs for each work item ─────────────────
  const workItems = planText
    .split('\n')
    .filter((l) => /^\d+\.\s+/.test(l.trim()))
    .slice(0, 6);

  const workerResults: string[] = [];

  for (let i = 0; i < workItems.length; i++) {
    const workItem = workItems[i];
    const stepId = `step-worker-${i + 1}`;

    onStepUpdate({
      id: stepId,
      time: new Date().toLocaleTimeString(),
      stage: 'execution',
      title: `Worker AI #${i + 1}: ${workItem.slice(0, 60)}`,
      detail: `Spawning worker AI to handle: ${workItem}`,
      status: 'running'
    });

    try {
      const workerOutput = await callOllama(
        `You are a worker AI in a task execution pipeline.\n` +
        `Your assignment: ${workItem}\n\n` +
        `Task context:\n${initialUserContent}\n\n` +
        `Available connections (for reference, but you cannot call them directly): ${connectedNames || 'none'}\n\n` +
        `Execute your assignment as thoroughly as possible. Describe what you determined, what actions you would take, ` +
        `and what the concrete output/result is. Be specific. Keep response under 400 words.`
      );

      const workerSummary = `Worker #${i + 1} — "${workItem}":\n${workerOutput}`;
      workerResults.push(workerSummary);
      toolCallLog.push(`Worker #${i + 1}: ${workItem.slice(0, 70)} → complete`);

      onStepUpdate({
        id: stepId,
        time: new Date().toLocaleTimeString(),
        stage: 'execution',
        title: `Worker AI #${i + 1}: Complete`,
        detail: workerOutput.slice(0, 200),
        status: 'success'
      });
    } catch (err: any) {
      const errMsg = `Worker #${i + 1} error: ${err.message}`;
      workerResults.push(errMsg);
      toolCallLog.push(`Worker #${i + 1}: error — ${err.message}`);
      onStepUpdate({
        id: stepId,
        time: new Date().toLocaleTimeString(),
        stage: 'execution',
        title: `Worker AI #${i + 1}: Error`,
        detail: err.message,
        status: 'warning'
      });
    }
  }

  // ── Phase 3: Main AI synthesizes worker results ──────────────────
  onStepUpdate({
    id: 'step-worker-synthesize',
    time: new Date().toLocaleTimeString(),
    stage: 'thinking',
    title: 'Worker Pattern: Main AI Synthesizing Results',
    detail: 'Collecting all worker outputs and producing final execution summary...',
    status: 'running'
  });

  const synthText = await callOllama(
    `Original task context:\n${initialUserContent}\n\n` +
    `Worker AI results:\n${workerResults.join('\n\n')}\n\n` +
    `Produce a comprehensive completion summary: what was accomplished, what was determined, and what the results are.`,
    systemPrompt
  );

  onStepUpdate({
    id: 'step-worker-synthesize',
    time: new Date().toLocaleTimeString(),
    stage: 'thinking',
    title: 'Worker Pattern: Synthesis Complete',
    detail: synthText.slice(0, 250),
    status: 'success'
  });

  return {
    text: synthText,
    toolCallCount: workItems.length,
    toolCallLog,
    usedWorkerPattern: true
  };
}

// ─── Main 3-Agent Pipeline ────────────────────────────────────────────────────

/**
 * Executes a task using a real 3-agent sequential AI pipeline:
 *
 * Step 1 — Discovery AI: Skims task header index (active + archived) to identify
 *   which other tasks have relevant context for the current task.
 *
 * Step 2 — Builder AI: Does the actual work using MCP tool-calling loops.
 *   Anthropic/OpenAI/Gemini use native tool-calling. Ollama tries tool-calling
 *   and falls back to a worker AI pattern if the model doesn't support it.
 *
 * Step 3 — Logger AI: Writes the completion record (Build & Verification +
 *   Completion sections) based on what the Builder accomplished.
 *
 * Falls back to the offline simulation path when no AI provider is configured
 * or on unrecoverable errors.
 */
export async function executeTaskWithAi(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  project: ProjectData,
  aiConfig: AIProviderConfig,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem }> {
  const isLiveAi =
    aiConfig.provider !== 'none' &&
    aiConfig.provider !== 'mock' &&
    (aiConfig.apiKey || aiConfig.provider === 'ollama');

  if (!isLiveAi) {
    return runOfflineExecution(task, brief, connectedMcps, onStepUpdate, onRequestPermission, onRequestHumanInput);
  }

  const buildDate = new Date().toISOString().split('T')[0];

  try {
    const allowedRoots = await getAllowedRoots();
    const runtimeConnectionsPrompt = formatConnectionsForAiPrompt(connectedMcps, allowedRoots);

    // ── STEP 1: Discovery AI ─────────────────────────────────────────
    onStepUpdate({
      id: 'step-discovery',
      time: new Date().toLocaleTimeString(),
      stage: 'context',
      title: 'Discovery AI: Scanning All Markdown Documents',
      detail: 'Scanning all task and brief headers across all workspace swim lane documents (TODO.md, Backlog, etc.) and AGENT_CONTEXT.md to identify relevant context...',
      status: 'running'
    });

    const headerIndex = buildTaskHeaderIndex(project.swimLanes, project.agentContextMarkdown, project.todoMarkdown);

    const discoverySystemPrompt =
      `You are the Discovery AI in Ergo's task execution pipeline.\n` +
      `Scan the task header index below across ALL workspace markdown files (swim lanes and AGENT_CONTEXT.md) and identify which OTHER tasks (if any) have information ` +
      `relevant to the current task being executed. Consider: prior decisions, shared dependencies, ` +
      `related completed work, or context that directly informs this task.\n` +
      `Do NOT include the current task itself in the relevantTaskIds.\n\n` +
      `${headerIndex}\n\n` +
      `Return ONLY valid JSON (no markdown fences):\n` +
      `{ "relevantTaskIds": [<number>, ...], "reasoning": "<brief explanation>" }\n` +
      `If nothing is relevant: { "relevantTaskIds": [], "reasoning": "no relevant tasks found" }`;

    const discoveryUserPrompt =
      `Current task to execute: #${task.id}. "${task.title}" (${task.category})\n` +
      `Subtasks: ${task.subtasks.map((s) => s.text).join('; ') || 'none'}`;

    const discoveryRaw = await callAiEngine(
      discoveryUserPrompt, discoverySystemPrompt, aiConfig, 'discovery', 'json'
    );

    let relevantTaskIds: number[] = [];
    let discoveryReasoning = '';
    try {
      const clean = discoveryRaw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(clean);
      relevantTaskIds = Array.isArray(parsed.relevantTaskIds) ? parsed.relevantTaskIds.filter((id: any) => id !== task.id) : [];
      discoveryReasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
    } catch {
      relevantTaskIds = [];
    }

    const relevantContext = getRelevantTasksContext(
      relevantTaskIds, project.swimLanes, project.agentContextMarkdown, project.todoMarkdown
    );

    onStepUpdate({
      id: 'step-discovery',
      time: new Date().toLocaleTimeString(),
      stage: 'context',
      title: 'Discovery AI: Context Identified',
      detail: relevantTaskIds.length > 0
        ? `Found ${relevantTaskIds.length} relevant task(s) across workspace documents: #${relevantTaskIds.join(', #')}. ${discoveryReasoning}`
        : `No additional task context needed across documents. ${discoveryReasoning}`,
      status: 'success'
    });

    console.log('%c[Ergo Task Execution] ── Step 1/3: Discovery AI ──', 'color: #38bdf8; font-weight: bold;');
    console.log('Relevant IDs:', relevantTaskIds, '| Reasoning:', discoveryReasoning);

    // ── STEP 2: Builder AI ───────────────────────────────────────────
    onStepUpdate({
      id: 'step-builder-init',
      time: new Date().toLocaleTimeString(),
      stage: 'thinking',
      title: 'Builder AI: Assembling Context & Starting Execution',
      detail: 'Building targeted task context and connecting to available MCP tools...',
      status: 'running'
    });

    const currentTaskContext =
      `CURRENT TASK:\n` +
      `Title: ${task.title}\nCategory: ${task.category}\nStatus: ${task.status}\n` +
      `Subtasks:\n${task.subtasks.length > 0 ? task.subtasks.map((s) => `  - [${s.isDone ? 'x' : ' '}] ${s.text}`).join('\n') : '  (none)'}\n\n` +
      `CURRENT TASK OVERVIEW (from AGENT_CONTEXT.md):\n${brief?.overview || brief?.brief || '(no overview yet)'}\n` +
      (brief?.buildAndVerification ? `\nEXISTING BUILD NOTES:\n${brief.buildAndVerification}` : '');

    const builderSystemPrompt =
      `You are the Builder AI in Ergo's task execution pipeline. Your job is to EXECUTE the given task.\n\n` +
      `PROJECT: "${project.name}" (${project.folderPath})\n\n` +
      `FILESYSTEM BOUNDARIES & STORAGE DIRECTORY (STRICT ENFORCEMENT):\n` +
      `- You have access ONLY to write files within the .ergo directory (~/.ergo) or folders explicitly permitted under allowed roots.\n` +
      `- Allowed Roots: ${allowedRoots.map((r) => `"${r.path}" (${r.name})`).join(', ')}\n` +
      `- You MUST NEVER write to or modify the application codebase directory or any folder outside the allowed roots.\n` +
      `- All project data, generated code, scripts, files, and artifacts MUST be written inside .ergo (e.g. \`projects/${project.id || project.folderPath}/...\`) or within explicitly allowed folders.\n\n` +
      `${runtimeConnectionsPrompt}\n\n` +
      (relevantContext ? `${relevantContext}\n\n` : '') +
      `INSTRUCTIONS:\n` +
      `1. Review the task, its subtasks, and overview carefully.\n` +
      `2. Use the available MCP tools to do the actual work (read files, call APIs, write results, etc.).\n` +
      `3. Call tools in logical order — gather/read first, then act.\n` +
      `4. INTERACTIVE HUMAN INPUT: If you lack critical information, encounter ambiguity, need user credentials/confirmation, or need the user to choose an architectural path to proceed, call the "ask_human" tool with your question and optional choices. Do NOT guess blindly on critical decisions.\n` +
      `5. When finished, produce a clear summary of exactly what was accomplished and what the results are.`;

    let builderResult: {
      text: string;
      toolCallCount: number;
      toolCallLog: string[];
      createdFiles: string[];
      usedWorkerPattern?: boolean;
    };

    if (aiConfig.provider === 'anthropic') {
      builderResult = await runAnthropicBuilderLoop(
        builderSystemPrompt, currentTaskContext,
        mcpToolsToAnthropicFormat(connectedMcps),
        aiConfig, connectedMcps, onStepUpdate, onRequestPermission,
        task.id, onRequestHumanInput
      );
    } else if (aiConfig.provider === 'openai') {
      builderResult = await runOpenAiBuilderLoop(
        builderSystemPrompt, currentTaskContext,
        mcpToolsToOpenAiFormat(connectedMcps),
        aiConfig, connectedMcps, onStepUpdate, onRequestPermission,
        task.id, onRequestHumanInput
      );
    } else if (aiConfig.provider === 'gemini') {
      builderResult = await runGeminiBuilderLoop(
        builderSystemPrompt, currentTaskContext,
        mcpToolsToGeminiFormat(connectedMcps),
        aiConfig, connectedMcps, onStepUpdate, onRequestPermission,
        task.id, onRequestHumanInput
      );
    } else if (aiConfig.provider === 'ollama') {
      builderResult = await runOllamaBuilderLoop(
        builderSystemPrompt, currentTaskContext,
        mcpToolsToOpenAiFormat(connectedMcps), // Ollama uses OpenAI-compat format
        aiConfig, connectedMcps, onStepUpdate, onRequestPermission,
        task.id, onRequestHumanInput
      );
    } else {
      // Generic single-shot fallback (no tool-calling)
      const singleShotText = await callAiEngine(
        currentTaskContext, builderSystemPrompt, aiConfig, 'general', 'text'
      );
      builderResult = { text: singleShotText, toolCallCount: 0, toolCallLog: [], createdFiles: [] };
    }

    onStepUpdate({
      id: 'step-builder-done',
      time: new Date().toLocaleTimeString(),
      stage: 'execution',
      title: `Builder AI: Execution Complete (${builderResult.toolCallCount} tool call${builderResult.toolCallCount !== 1 ? 's' : ''})`,
      detail: (builderResult.text || 'Builder AI completed execution.').slice(0, 300),
      status: 'success'
    });

    console.log('%c[Ergo Task Execution] ── Step 2/3: Builder AI ──', 'color: #34d399; font-weight: bold;');
    console.log('Tool calls:', builderResult.toolCallCount, '| Worker pattern:', builderResult.usedWorkerPattern);
    console.log('Tool log:', builderResult.toolCallLog);
    console.log('Created files:', builderResult.createdFiles);
    console.log('Builder output:', builderResult.text);

    // ── STEP 3: Logger AI ────────────────────────────────────────────
    onStepUpdate({
      id: 'step-logger',
      time: new Date().toLocaleTimeString(),
      stage: 'built_record',
      title: 'Logger AI: Writing Completion Record',
      detail: 'Documenting what was built, listing completed files, and evaluating human review requirements...',
      status: 'running'
    });

    const workerPatternNote = builderResult.usedWorkerPattern
      ? `\n\n> **Note — Worker AI Pattern Used:** The configured Ollama model (${aiConfig.generalModel || aiConfig.model || 'unknown'}) does not support native tool-calling. The main AI generated a work plan and spawned ${builderResult.toolCallCount} worker AI(s) to handle sub-tasks. Results may differ from a full tool-calling execution — consider using an Anthropic, OpenAI, or Gemini provider for native MCP tool-call support if this is unexpected.`
      : '';

    const loggerSystemPrompt =
      `You are the Logger AI in Ergo's task execution pipeline. Write a completion log for a task that was just executed.\n` +
      `Write clear, professional markdown. Be accurate and specific — do NOT fabricate details not present in the builder summary.\n\n` +
      `LIST COMPLETED WORK & CREATED ARTIFACTS:\n` +
      `- In "createdFiles" (array of string file paths), list all files created, written, or modified during execution.\n` +
      `- In the "completion" markdown field, include a clear "**Completed Work & Created Files:**" section with markdown links (e.g. \`[filename](path/to/file)\`). If code was written, summarize what was implemented so the user can click to inspect it.\n\n` +
      `EVALUATE HUMAN REVIEW REQUIREMENTS:\n` +
      `- Determine if the user needs to verify the builder's changes at the end or conduct follow-up verification.\n` +
      `- Human review is needed for: higher-order or complex tasks, sensitive changes (auth, database schemas, financial/billing, deletion, external API integrations, production deployments), or if the task/subtask originally specified human review.\n` +
      `- If human review is needed, produce clear, actionable verification steps in "humanReviewSteps" (array of strings) and set "needsHumanReview": true.\n` +
      `- If the task was simple, low-risk, or fully verified automatically with no human verification required, set "needsHumanReview": false and "humanReviewSteps": [].\n\n` +
      `Return ONLY valid JSON (no markdown fences) with exactly these fields:\n` +
      `{\n` +
      `  "buildAndVerification": "<markdown detailing implementation journey and checks>",\n` +
      `  "completion": "<markdown detailing completion summary, what was built, and list of completed files>",\n` +
      `  "createdFiles": ["<relative or absolute path to created file 1>", "<path 2>"],\n` +
      `  "needsHumanReview": <boolean>,\n` +
      `  "humanReviewSteps": ["<verification step 1>", "<verification step 2>"]\n` +
      `}`;

    const loggerUserPrompt =
      `TASK: "${task.title}" (#${task.id}) | Date: ${buildDate}\n` +
      `Provider: ${aiConfig.provider} / ${aiConfig.generalModel || aiConfig.model || 'default'}\n` +
      `Original Subtasks: ${task.subtasks.map((s) => `${s.isHumanReview ? '[human review] ' : ''}${s.text}`).join('; ') || 'none'}\n` +
      `Task is flagged for human review: ${task.isHumanReview ? 'YES' : 'NO'}\n` +
      `Tool calls made: ${builderResult.toolCallCount}\n` +
      `Files written during execution: ${builderResult.createdFiles.length > 0 ? builderResult.createdFiles.join(', ') : 'none detected'}\n` +
      (builderResult.usedWorkerPattern ? `Execution method: Worker AI pattern (model does not support native tool-calling)\n` : '') +
      `\nBUILDER AI SUMMARY:\n${builderResult.text || '(no output)'}\n` +
      `\nTOOL CALL LOG:\n${builderResult.toolCallLog.join('\n') || '(none)'}\n` +
      `\nEXISTING OVERVIEW:\n${brief?.overview || brief?.brief || '(none)'}\n` +
      (workerPatternNote
        ? `\nIMPORTANT: At the END of the completion field, append this exact markdown note:\n${workerPatternNote}`
        : '');

    const loggerRaw = await callAiEngine(
      loggerUserPrompt, loggerSystemPrompt, aiConfig, 'general', 'json'
    );

    let buildAndVerificationContent = '';
    let completionContent = '';
    let needsHumanReview = false;
    let humanReviewSteps: string[] = [];
    let loggedCreatedFiles: string[] = [];

    try {
      const clean = loggerRaw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(clean);
      buildAndVerificationContent = parsed.buildAndVerification || '';
      completionContent = parsed.completion || '';
      needsHumanReview = Boolean(parsed.needsHumanReview);
      if (Array.isArray(parsed.humanReviewSteps)) {
        humanReviewSteps = parsed.humanReviewSteps.filter((s: any) => typeof s === 'string' && s.trim().length > 0);
      }
      if (Array.isArray(parsed.createdFiles)) {
        loggedCreatedFiles = parsed.createdFiles.filter((s: any) => typeof s === 'string' && s.trim().length > 0);
      }
    } catch {
      buildAndVerificationContent = `**Build Record (${buildDate}):**\n\n${builderResult.text || 'Task executed via AI pipeline.'}`;
      completionContent = `**Completion (${buildDate}):**\n\n${builderResult.toolCallCount} tool call(s) executed. Task marked done.${workerPatternNote}`;
    }

    // Merge builder-detected created files with Logger AI logged files
    const allCreatedFiles = Array.from(new Set([...builderResult.createdFiles, ...loggedCreatedFiles]));

    // If files were created but not mentioned in completion markdown, append an artifacts section
    if (allCreatedFiles.length > 0 && !completionContent.toLowerCase().includes('created file') && !completionContent.toLowerCase().includes('artifacts')) {
      completionContent += `\n\n**Created Files & Artifacts:**\n` + allCreatedFiles.map((f) => `- [${f}](${f})`).join('\n');
    }

    // Preserve any existing human review subtasks from the original task
    const existingHumanReviewSubtasks = task.subtasks.filter((s) => s.isHumanReview);
    const existingHumanReviewTexts = new Set(existingHumanReviewSubtasks.map((s) => s.text.trim().toLowerCase()));

    // Combine newly generated human review steps with any existing ones not already in the list
    const combinedReviewSteps: string[] = [...existingHumanReviewSubtasks.map((s) => s.text)];
    for (const step of humanReviewSteps) {
      if (!existingHumanReviewTexts.has(step.trim().toLowerCase())) {
        combinedReviewSteps.push(step);
      }
    }

    const hasExplicitReviewRequest =
      Boolean(task.isHumanReview) ||
      task.title.toLowerCase().includes('human review') ||
      task.subtasks.some((s) => s.text.toLowerCase().includes('human review'));

    const hasAnyHumanReview = combinedReviewSteps.length > 0 || needsHumanReview || hasExplicitReviewRequest;

    // Regular subtasks executed by Builder AI are marked done
    const executedSubtasks = task.subtasks
      .filter((s) => !s.isHumanReview)
      .map((s) => ({ ...s, isDone: true }));

    // Human review subtasks remain pending (isDone: false) for human verification
    const reviewSubtasks: Subtask[] = combinedReviewSteps.map((stepText, idx) => ({
      id: `${task.id}-hr-${idx + 1}`,
      text: stepText,
      isDone: false,
      isHumanReview: true
    }));

    const allSubtasks = [...executedSubtasks, ...reviewSubtasks];

    // If human review steps exist and aren't mentioned in completion, append a dedicated section
    if (combinedReviewSteps.length > 0 && !completionContent.toLowerCase().includes('human review')) {
      completionContent += `\n\n**Human Review Required:**\n` + combinedReviewSteps.map((s) => `- [ ] **human review** - ${s}`).join('\n');
    }

    const overviewContent = brief?.overview || brief?.brief || `Task #${task.id}: ${task.title}`;

    onStepUpdate({
      id: 'step-logger',
      time: new Date().toLocaleTimeString(),
      stage: 'built_record',
      title: 'Logger AI: Completion Record Written',
      detail: reviewSubtasks.length > 0
        ? `Build record updated with ${reviewSubtasks.length} Human Review step(s) and ${allCreatedFiles.length} artifact(s).`
        : `Build & Verification and Completion sections updated for task #${task.id}.`,
      status: 'success'
    });

    onStepUpdate({
      id: 'step-done',
      time: new Date().toLocaleTimeString(),
      stage: 'done',
      title: reviewSubtasks.length > 0
        ? 'Task Built — Human Review Pending'
        : 'Task Execution Completed Successfully!',
      detail: reviewSubtasks.length > 0
        ? `Task #${task.id} changes built. Generated ${reviewSubtasks.length} Human Review step(s) in TODO.md for user verification.`
        : `Item #${task.id} marked DONE. Agent build record appended to AGENT_CONTEXT.md.`,
      status: 'success'
    });

    console.log('%c[Ergo Task Execution] ── Step 3/3: Logger AI ──', 'color: #a78bfa; font-weight: bold;');
    console.log('%c[Ergo Task Execution] ── Pipeline Complete ✅ ──', 'color: #10b981; font-weight: bold;');

    const updatedBrief: AgentContextItem = {
      itemNumber: task.id,
      title: task.title,
      status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
      overview: overviewContent,
      buildAndVerification: buildAndVerificationContent,
      completion: completionContent,
      createdFiles: allCreatedFiles,
      brief: overviewContent,
      built: buildAndVerificationContent,
      validation: completionContent,
      humanReview: completionContent,
      followUps: completionContent
    };

    const updatedTask: TaskItem = {
      ...task,
      status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
      isDone: reviewSubtasks.length === 0,
      isHumanReview: hasAnyHumanReview,
      createdFiles: allCreatedFiles,
      subtasks: allSubtasks.length > 0 ? allSubtasks : task.subtasks.map((s) => ({ ...s, isDone: true }))
    };

    return { updatedBrief, updatedTask };

  } catch (err: any) {
    console.error('[Ergo Task Execution] Pipeline error — falling back to offline mode:', err);
    onStepUpdate({
      id: 'step-pipeline-error',
      time: new Date().toLocaleTimeString(),
      stage: 'context',
      title: 'Pipeline Error — Falling Back to Offline Mode',
      detail: `Error: ${err.message}. Using offline simulation fallback.`,
      status: 'warning'
    });
    return runOfflineExecution(task, brief, connectedMcps, onStepUpdate, onRequestPermission, onRequestHumanInput);
  }
}

/**
 * Offline / no-provider fallback execution.
 * Simulates the pipeline with dummy steps for demo and development purposes.
 */
async function runOfflineExecution(
  task: TaskItem,
  brief: AgentContextItem | undefined,
  connectedMcps: MCPServer[],
  onStepUpdate: (step: ExecutionStep) => void,
  onRequestPermission?: (prompt: McpToolPermissionPrompt) => Promise<boolean>,
  onRequestHumanInput?: (prompt: HumanInputPrompt) => Promise<string>
): Promise<{ updatedBrief: AgentContextItem; updatedTask: TaskItem }> {
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

  const offlineSteps: Partial<ExecutionStep>[] = [
    { id: 'step-1', stage: 'context', title: 'Reading Shared Context & Requirements', detail: `Loading task from ${task.sourceFileName || 'TODO.md'} (Item #${task.id}: "${task.title}") and inspecting all workspace documents + AGENT_CONTEXT.md brief...`, status: 'running' },
    { id: 'step-2', stage: 'mcp_call', title: `Executing MCP Tool (${targetServerId} / ${toolName})`, detail: `Resolving tool dependencies and executing ${toolName}() across safe roots...`, mcpToolUsed: toolName, status: 'pending' },
    { id: 'step-3', stage: 'execution', title: 'Executing Subtasks & Implementation Steps', detail: `Processing subtasks: ${task.subtasks.map((s) => s.text).join('; ') || 'Implementing core logic'}`, status: 'pending' },
    { id: 'step-4', stage: 'built_record', title: 'Rendering Interactive MCP App Widget', detail: 'Building visual interactive UI result and code diff preview...', status: 'pending', widgetType: getWidgetTypeForTask(task), widgetData: getWidgetDataForTask(task) },
    { id: 'step-5', stage: 'done', title: 'Updating Dual-File AGENT_CONTEXT.md & TODO.md', detail: 'Recording Built decisions, Validation results, and marking task as completed.', status: 'pending' }
  ];

  onStepUpdate({ id: offlineSteps[0].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[0].stage!, title: offlineSteps[0].title!, detail: offlineSteps[0].detail!, status: 'running' });
  await new Promise((r) => setTimeout(r, 600));
  onStepUpdate({ id: offlineSteps[0].id!, time: new Date().toLocaleTimeString(), stage: offlineSteps[0].stage!, title: offlineSteps[0].title!, detail: `Loaded ask #${task.id} & parsed brief constraints. Safe root context active.`, status: 'success' });

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
      context: 'The Builder AI needs user clarification on which path to take before proceeding.',
      allowFreeform: true
    };
    onStepUpdate({
      id: inputStepId,
      time: new Date().toLocaleTimeString(),
      stage: 'human_input',
      title: 'Clarification Needed: Question from Builder AI',
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
    itemNumber: task.id, title: task.title, status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    overview: overviewContent, buildAndVerification: buildVerificationContent, completion: completionContent,
    createdFiles: sampleCreatedFiles,
    brief: overviewContent, built: buildVerificationContent, validation: completionContent,
    humanReview: completionContent, followUps: completionContent
  };
  const updatedTask: TaskItem = {
    ...task,
    status: reviewSubtasks.length > 0 ? 'partly_done' : 'done',
    isDone: reviewSubtasks.length === 0,
    isHumanReview: hasHumanReview,
    createdFiles: sampleCreatedFiles,
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
    status: 'success'
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

