/**
 * Auto model selection — deterministic per-stage model + effort from the task rating, model strengths and live prices.
 *
 * The tiny model only *rates* the task (taskRating.ts: kind, complexity = scope, reasoning = difficulty); this code
 * *picks*:
 *   1. Each candidate gets a quality score per axis (intelligence, coding; 0–100): Artificial Analysis benchmarks
 *      when present (rescaled so the catalog's best = 100), else the built-in strengths table, else an estimate from
 *      its price against the provider's scored models.
 *   2. The provider's lineup is ranked into three tiers on the stage's axis (buildTierLadder): top = the strongest
 *      model, standard = the cheapest model within a few points of it, light = the cheapest model that is still
 *      decent. Models another candidate beats on both quality and price are never used.
 *   3. The stage's tier follows the task's scope and its effort follows the task's difficulty (stagePlan), with
 *      floors for coding (benchmark scores understate how much more often small models fail long agent runs).
 *      The Effort slider shifts both; each escalation step (a verifier retry, or a rerun after a failed run) moves one rung
 *      up: the next tier, or more effort once at the top tier.
 */
import type { AgentRole, EffortLevel, TaskRating } from '../../types';
import type { CatalogModel, ModelCatalog } from '../modelCatalog/types';
import type { CandidateModel } from '../modelCatalog/availability';
import { BUILTIN_STRENGTHS, type BuiltinStrength } from '../modelCatalog/builtinStrengths';

export type QualityAxis = 'intelligence' | 'coding';
export type ScoreSource = 'aa' | 'builtin' | 'estimated';

export interface AxisScore {
  score: number;
  source: ScoreSource;
}

export interface ModelQuality {
  intelligence: AxisScore;
  coding: AxisScore;
  /** Relative output speed 0–100 (tie-break only; 50 when unknown). */
  speed: number;
  /** The built-in table's one-line note, when the model is in it. */
  note?: string;
}

/** Scale wording shared by every prompt that asks for a rating. */
export const TASK_RATING_SCALES =
  'complexity: 1 = trivial one-liner, 3 = a feature touching a few files, 5 = large multi-part / architectural. ' +
  'reasoning: 1 = mechanical, 5 = hard design / debugging.';

/** Used when no rating is available at all (the stage plans then sit mid-scale). */
export const DEFAULT_TASK_RATING: TaskRating = { kind: 'other', complexity: 3, reasoning: 3, source: 'heuristic' };

/** Score points per e-fold of price, when a provider has a single scored model to extrapolate from. */
const DEFAULT_PRICE_SLOPE = 10;

/**
 * Share of an agent run's input tokens served from the prompt cache. Agent loops resend the same growing conversation
 * every round with caching on (providerLoop.ts cache breakpoints; CLI agents cache on their own), so most input is a
 * cache read. Calibration (#3) replaces this with the measured share once runs report it.
 */
export const DEFAULT_CACHE_HIT_SHARE = 0.75;

/**
 * Blended USD per million tokens as an agent run actually pays it: about three input tokens for every output token,
 * with `cacheHitShare` of the input read from the prompt cache (cache price when known) and the rest written to it.
 * Models without cache prices are priced at list.
 */
export function blendedPrice(
  m: Pick<CatalogModel, 'inputPerM' | 'outputPerM' | 'cacheReadPerM' | 'cacheWritePerM'>,
  cacheHitShare = DEFAULT_CACHE_HIT_SHARE
): number {
  const input =
    m.cacheReadPerM && m.cacheReadPerM > 0
      ? (1 - cacheHitShare) * (m.cacheWritePerM ?? m.inputPerM) + cacheHitShare * m.cacheReadPerM
      : m.inputPerM;
  return (3 * input + m.outputPerM) / 4;
}

/** "coding · complexity 3/5 · reasoning 4/5 (from overview)". */
export function describeTaskRating(rating: TaskRating): string {
  const from = rating.source === 'overview' ? 'from overview' : rating.source === 'tiny' ? 'rated by the tiny model' : 'estimated from the task text';
  return `${rating.kind} · complexity ${rating.complexity}/5 · reasoning ${rating.reasoning}/5 (${from})`;
}

// ─── Quality ──────────────────────────────────────────────────────────────────

function matchesStrength(entry: BuiltinStrength, id: string): boolean {
  return entry.match.endsWith('*') ? id.startsWith(entry.match.slice(0, -1)) : id === entry.match;
}

/** The first built-in strengths entry matching any of `ids` (in order: the id itself, then the resolved id). */
export function findBuiltinStrength(ids: string[], table: readonly BuiltinStrength[] = BUILTIN_STRENGTHS): BuiltinStrength | undefined {
  for (const id of ids) {
    const hit = table.find((e) => matchesStrength(e, id));
    if (hit) return hit;
  }
  return undefined;
}

interface ScoringContext {
  aaMax: Record<QualityAxis, number>;
  aaMaxSpeed: number;
  /** Per provider and axis: (log blended price, score) of models with a known score. */
  points: Map<string, Array<{ x: number; y: number }>>;
}

const contextCache = new WeakMap<ModelCatalog, { table: readonly BuiltinStrength[]; ctx: ScoringContext }>();

function knownScore(model: CatalogModel, axis: QualityAxis, ctx: Pick<ScoringContext, 'aaMax'>, table: readonly BuiltinStrength[], aliasId?: string): AxisScore | null {
  const aa = model.benchmarks?.[axis];
  if (typeof aa === 'number' && Number.isFinite(aa) && ctx.aaMax[axis] > 0) {
    return { score: Math.max(0, Math.min(100, (aa / ctx.aaMax[axis]) * 100)), source: 'aa' };
  }
  const builtin = findBuiltinStrength(aliasId && aliasId !== model.id ? [aliasId, model.id] : [model.id], table);
  if (builtin && Number.isFinite(builtin[axis])) return { score: builtin[axis], source: 'builtin' };
  return null;
}

function scoringContext(catalog: ModelCatalog, table: readonly BuiltinStrength[]): ScoringContext {
  const cached = contextCache.get(catalog);
  if (cached && cached.table === table) return cached.ctx;
  const aaMax: Record<QualityAxis, number> = { intelligence: 0, coding: 0 };
  let aaMaxSpeed = 0;
  for (const m of catalog.models) {
    const b = m.benchmarks;
    if (!b) continue;
    if (typeof b.intelligence === 'number') aaMax.intelligence = Math.max(aaMax.intelligence, b.intelligence);
    if (typeof b.coding === 'number') aaMax.coding = Math.max(aaMax.coding, b.coding);
    if (typeof b.tokensPerSecond === 'number') aaMaxSpeed = Math.max(aaMaxSpeed, b.tokensPerSecond);
  }
  const points = new Map<string, Array<{ x: number; y: number }>>();
  for (const m of catalog.models) {
    const price = blendedPrice(m);
    if (!(price > 0)) continue;
    for (const axis of ['intelligence', 'coding'] as const) {
      const known = knownScore(m, axis, { aaMax }, table);
      if (!known) continue;
      const key = `${m.provider}:${axis}`;
      points.set(key, [...(points.get(key) || []), { x: Math.log(price), y: known.score }]);
    }
  }
  const ctx = { aaMax, aaMaxSpeed, points };
  contextCache.set(catalog, { table, ctx });
  return ctx;
}

/**
 * Estimated score for a model with no benchmark or table entry: log(blended price) interpolated against the
 * provider's scored models, extrapolated past the ends, clamped to the provider's scored range ± 10. 50 when the
 * provider has no scored model.
 */
export function estimateScore(price: number, points: ReadonlyArray<{ x: number; y: number }>): number {
  if (points.length === 0 || !(price > 0)) return 50;
  // Average the scores of models at the same price.
  const byX = new Map<number, number[]>();
  for (const p of points) byX.set(p.x, [...(byX.get(p.x) || []), p.y]);
  const pts = [...byX.entries()].map(([x, ys]) => ({ x, y: ys.reduce((a, b) => a + b, 0) / ys.length })).sort((a, b) => a.x - b.x);
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const x = Math.log(price);
  let y: number;
  if (pts.length === 1) {
    y = pts[0].y + DEFAULT_PRICE_SLOPE * (x - pts[0].x);
  } else if (x <= pts[0].x) {
    const slope = Math.max(0, (pts[1].y - pts[0].y) / (pts[1].x - pts[0].x));
    y = pts[0].y + slope * (x - pts[0].x);
  } else if (x >= pts[pts.length - 1].x) {
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const slope = Math.max(0, (b.y - a.y) / (b.x - a.x));
    y = b.y + slope * (x - b.x);
  } else {
    const i = pts.findIndex((p) => p.x >= x);
    const a = pts[i - 1];
    const b = pts[i];
    y = a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return Math.max(0, Math.min(100, Math.max(minY - 10, Math.min(maxY + 10, y))));
}

/** Quality of one candidate on both axes, with where each score came from. */
export function modelQuality(candidate: CandidateModel, catalog: ModelCatalog, table: readonly BuiltinStrength[] = BUILTIN_STRENGTHS): ModelQuality {
  const ctx = scoringContext(catalog, table);
  const { model } = candidate;
  const axisScore = (axis: QualityAxis): AxisScore =>
    knownScore(model, axis, ctx, table, candidate.id) ?? {
      score: estimateScore(blendedPrice(model), ctx.points.get(`${model.provider}:${axis}`) || []),
      source: 'estimated',
    };
  const builtin = findBuiltinStrength(candidate.id !== model.id ? [candidate.id, model.id] : [model.id], table);
  const tps = model.benchmarks?.tokensPerSecond;
  const speed = typeof tps === 'number' && ctx.aaMaxSpeed > 0 ? (tps / ctx.aaMaxSpeed) * 100 : builtin?.speed ?? 50;
  return { intelligence: axisScore('intelligence'), coding: axisScore('coding'), speed, ...(builtin?.note ? { note: builtin.note } : {}) };
}

// ─── Tiers ───────────────────────────────────────────────────────────────────

export type Tier = 1 | 2 | 3;
export const TIER_LABELS: Record<Tier, string> = { 1: 'light', 2: 'standard', 3: 'top' };

/** A light-tier model must still reach this score on the stage's axis. */
const LIGHT_FLOOR = 60;
/** The standard tier is the cheapest model within this many points of the strongest one. */
const STANDARD_GAP = 5;

interface ScoredCandidate {
  candidate: CandidateModel;
  quality: number;
  source: ScoreSource;
  speed: number;
  price: number;
}

/**
 * The provider's lineup ranked into light / standard / top on one axis. Free-priced and dominated models (another
 * candidate is at least as strong and no more expensive) are left out, so legacy models never make a tier. When a
 * provider has fewer than three useful models, tiers share a model (e.g. Gemini: Flash / Argon / Argon).
 */
export function buildTierLadder(
  candidates: CandidateModel[],
  catalog: ModelCatalog,
  axis: QualityAxis,
  table: readonly BuiltinStrength[] = BUILTIN_STRENGTHS
): Record<Tier, ScoredCandidate> | null {
  const scored: ScoredCandidate[] = candidates
    .map((candidate) => {
      const q = modelQuality(candidate, catalog, table);
      return { candidate, quality: q[axis].score, source: q[axis].source, speed: q.speed, price: blendedPrice(candidate.model) };
    })
    .filter((s) => s.price > 0);
  if (scored.length === 0) return null;
  const frontier = scored.filter(
    (s) => !scored.some((o) => o !== s && o.quality >= s.quality && o.price <= s.price && (o.quality > s.quality || o.price < s.price))
  );
  const cheapestFirst = (a: ScoredCandidate, b: ScoredCandidate) => a.price - b.price || b.quality - a.quality || b.speed - a.speed;
  const top = [...frontier].sort((a, b) => b.quality - a.quality || a.price - b.price)[0];
  const standard = frontier.filter((s) => s.quality >= top.quality - STANDARD_GAP).sort(cheapestFirst)[0] ?? top;
  const lightPick = frontier.filter((s) => s.quality >= LIGHT_FLOOR).sort(cheapestFirst)[0];
  const light = lightPick && lightPick.price <= standard.price ? lightPick : standard;
  return { 1: light, 2: standard, 3: top };
}

// ─── Stage plan ──────────────────────────────────────────────────────────────

const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function shiftEffort(effort: EffortLevel, steps: number, cap: EffortLevel = 'max'): EffortLevel {
  const i = Math.max(0, Math.min(EFFORT_ORDER.indexOf(cap), EFFORT_ORDER.indexOf(effort) + steps));
  return EFFORT_ORDER[i];
}

function atLeast(effort: EffortLevel, min: EffortLevel): EffortLevel {
  return EFFORT_ORDER.indexOf(effort) >= EFFORT_ORDER.indexOf(min) ? effort : min;
}

/** Reasoning effort per difficulty (rating.reasoning 1–5): how hard each step is, not how big the task is. */
const EFFORT_BY_REASONING: EffortLevel[] = ['low', 'medium', 'medium', 'high', 'xhigh'];
/** Workers carry out one scoped piece of the manager's plan, so they think one step less (except the hardest work). */
const WORKER_EFFORT_BY_REASONING: EffortLevel[] = ['low', 'low', 'medium', 'medium', 'high'];

/** How the Effort slider moves every rated stage's reasoning effort (steps). */
const SLIDER_STEPS: Record<Exclude<EffortLevel, 'max'>, number> = { low: -1, medium: 0, high: 1, xhigh: 2 };
/**
 * How the slider moves tiers: Low drops every rated stage one tier (never below its floor); High lifts the manager and
 * Verifier (the plan and the check) but gives workers more effort instead; Extra High lifts every stage.
 */
function sliderTierShift(role: AgentRole, slider: Exclude<EffortLevel, 'max'>): number {
  if (slider === 'low') return -1;
  if (slider === 'high') return role === 'worker' ? 0 : 1;
  if (slider === 'xhigh') return 1;
  return 0;
}

export interface StagePlan {
  axis: QualityAxis;
  tier: Tier;
  effort: EffortLevel;
  /** The lowest tier the slider may take this stage to. */
  floor: Tier;
}

/**
 * The tier and effort a stage starts from at Medium, before the slider and escalation. Scope (complexity, and for
 * the manager / verifier also difficulty) sets the tier; difficulty sets the effort. Coding floors: manager and verifier never
 * below standard (Sonnet-class), because a weak plan or a weak check sinks the whole run; workers never below
 * standard from complexity 3 up.
 *
 *   coding            manager           workers           verifier
 *   complexity 1      standard          light             standard
 *   complexity 2–3    standard          standard          standard
 *   complexity 4 / reasoning ≥ 4  top    standard          top
 *   complexity 5      top               top               top
 */
export function basePlan(role: AgentRole, rating: TaskRating): StagePlan {
  const coding = rating.kind === 'coding';
  const axis: QualityAxis = coding ? 'coding' : 'intelligence';
  const c = rating.complexity;
  const r = rating.reasoning;
  const d = Math.max(c, r);
  const byReasoning = EFFORT_BY_REASONING[r - 1];
  switch (role) {
    case 'manager':
      return coding
        ? { axis, tier: d >= 4 ? 3 : 2, floor: 2, effort: atLeast(byReasoning, c >= 4 ? 'medium' : 'low') }
        : { axis, tier: d >= 5 ? 3 : d >= 3 ? 2 : 1, floor: 1, effort: atLeast(byReasoning, c >= 4 ? 'medium' : 'low') };
    case 'worker':
      return coding
        ? { axis, tier: c >= 5 ? 3 : c >= 2 ? 2 : 1, floor: c >= 3 ? 2 : 1, effort: WORKER_EFFORT_BY_REASONING[r - 1] }
        : { axis, tier: c >= 4 ? 2 : 1, floor: 1, effort: WORKER_EFFORT_BY_REASONING[r - 1] };
    case 'verifier':
      return coding
        ? { axis: 'coding', tier: d >= 4 ? 3 : 2, floor: 2, effort: atLeast(byReasoning, 'medium') }
        : { axis, tier: d >= 4 ? 2 : 1, floor: 1, effort: byReasoning };
    default:
      // cleaner, logger, summary, autocomplete: bookkeeping
      return { axis: 'intelligence', tier: 1, floor: 1, effort: 'low' };
  }
}

const RATED_ROLES = new Set<AgentRole>(['manager', 'worker', 'verifier']);

/**
 * The stage plan after the Effort slider and `escalation` steps: each step up is the next tier, or +1 effort at the top
 * tier; a negative step (calibration evidence that cheaper works) is one tier down, or −1 effort at the stage's floor.
 */
export function stagePlan(role: AgentRole, rating: TaskRating, slider: EffortLevel, escalation = 0): StagePlan {
  const base = basePlan(role, rating);
  let { tier, effort } = base;
  if (!RATED_ROLES.has(role)) {
    // Bookkeeping stays on the light tier; the slider only nudges its effort (never past Medium).
    effort = slider === 'max' ? 'medium' : shiftEffort('low', Math.max(0, SLIDER_STEPS[slider] - 1), 'medium');
    return { ...base, effort };
  }
  if (slider === 'max') {
    tier = 3;
    effort = 'max';
  } else {
    tier = Math.max(base.floor, Math.min(3, tier + sliderTierShift(role, slider))) as Tier;
    effort = shiftEffort(effort, SLIDER_STEPS[slider], 'xhigh');
  }
  for (let i = 0; i < escalation; i++) {
    if (tier < 3) tier = (tier + 1) as Tier;
    else effort = shiftEffort(effort, 1);
  }
  for (let i = 0; i > escalation; i--) {
    if (tier > base.floor) tier = (tier - 1) as Tier;
    else effort = shiftEffort(effort, -1);
  }
  if (escalation > 0) effort = atLeast(effort, 'medium');
  return { ...base, tier, effort };
}

// ─── Pick ────────────────────────────────────────────────────────────────────

export interface AutoPick {
  candidate: CandidateModel;
  axis: QualityAxis;
  quality: number;
  scoreSource: ScoreSource;
  tier: Tier;
  effort: EffortLevel;
  /** e.g. "standard tier · coding 98 · $2.00/$10.00 per M · Medium effort for reasoning 3/5". */
  reason: string;
  /** Calibration moved the start one rung (and why); probe: a try one rung cheaper. */
  calibration?: { steps: -1 | 1; note: string; probe?: boolean };
}

/** One concrete setting a stage could run at: what calibration compares. */
export interface RungChoice {
  tier: Tier;
  effort: EffortLevel;
  model: string;
  /** Cache-aware blended price per million tokens. */
  price: number;
}

/**
 * Optional calibration hook (calibration.ts): given the planned setting and its neighbours one rung up / down (down is
 * null after an escalation), returns −1 / 0 / +1 and a note. Never moves past the stage's floor (the plan enforces it).
 */
export type CalibrateFn = (options: { planned: RungChoice; up: RungChoice | null; down: RungChoice | null }) => {
  steps: -1 | 0 | 1;
  note?: string;
  /** A try one rung cheaper, to find out whether it will do (calibration.ts PROBE_*). */
  probe?: boolean;
};

/** "$4.00/$20.00 per M" ("relative cost …" for subscriptions). */
export function formatModelPrice(m: CatalogModel, relative: boolean): string {
  const fmt = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
  return `${relative ? 'relative cost ' : ''}${fmt(m.inputPerM)}/${fmt(m.outputPerM)} per M`;
}

const EFFORT_WORDS: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };

/**
 * Picks the model and effort for one stage. `slider` is the user's Effort setting; `escalation` the number of rungs
 * to climb (Verifier retries, reruns after a failure). `relativeCost` words prices as a relative cost (subscription CLIs:
 * API prices stand in for usage-limit burn). Null when there are no priced candidates.
 */
export function pickModelForStage(params: {
  role: AgentRole;
  slider: EffortLevel;
  rating: TaskRating;
  candidates: CandidateModel[];
  catalog: ModelCatalog;
  escalation?: number;
  relativeCost?: boolean;
  table?: readonly BuiltinStrength[];
  calibrate?: CalibrateFn;
  /** Share of input served from the prompt cache, for prices calibration compares (measured when known). */
  cacheHitShare?: number;
}): AutoPick | null {
  const { role, slider, rating, candidates, catalog, escalation = 0, relativeCost = false, table = BUILTIN_STRENGTHS } = params;
  const basePlanned = stagePlan(role, rating, slider, escalation);
  const ladder = buildTierLadder(candidates, catalog, basePlanned.axis, table);
  if (!ladder) return null;
  // A plan made concrete: top requested but the provider has nothing stronger than its standard model → think harder.
  const resolve = (plan: StagePlan) => {
    const collapsed = plan.tier === 3 && ladder[3].candidate.id === ladder[2].candidate.id && RATED_ROLES.has(role);
    return { plan, chosen: ladder[plan.tier], effort: collapsed ? shiftEffort(plan.effort, 1) : plan.effort, collapsed };
  };
  const choice = (r: ReturnType<typeof resolve>): RungChoice => ({
    tier: r.plan.tier,
    effort: r.effort,
    model: r.chosen.candidate.id,
    price: blendedPrice(r.chosen.candidate.model, params.cacheHitShare),
  });
  let calibration: AutoPick['calibration'];
  let resolved = resolve(basePlanned);
  if (params.calibrate && RATED_ROLES.has(role) && slider !== 'max') {
    const up = resolve(stagePlan(role, rating, slider, escalation + 1));
    const down = escalation > 0 ? null : resolve(stagePlan(role, rating, slider, escalation - 1));
    const adj = params.calibrate({ planned: choice(resolved), up: choice(up), down: down ? choice(down) : null });
    if (adj.steps === 1) resolved = up;
    else if (adj.steps === -1 && down) resolved = down;
    if (adj.steps !== 0 && adj.note && (adj.steps === 1 || down)) calibration = { steps: adj.steps, note: adj.note, ...(adj.probe ? { probe: true } : {}) };
  }
  const plan = resolved.plan;
  const chosen = resolved.chosen;
  const effort = resolved.effort;
  const collapsed = resolved.collapsed;

  const score = `${plan.axis} ${Math.round(chosen.quality)}${chosen.source === 'estimated' ? ' (estimated)' : ''}`;
  const effortWhy = !RATED_ROLES.has(role)
    ? 'bookkeeping'
    : slider === 'max'
      ? 'Max effort'
      : `reasoning ${rating.reasoning}/5`;
  const notes = [
    collapsed ? 'no stronger model, so more effort' : '',
    escalation > 0 ? `stepped up ${escalation} after an earlier failure` : '',
    calibration ? calibration.note : '',
  ].filter(Boolean);
  return {
    candidate: chosen.candidate,
    axis: plan.axis,
    quality: chosen.quality,
    scoreSource: chosen.source,
    tier: plan.tier,
    effort,
    ...(calibration ? { calibration } : {}),
    reason: `${TIER_LABELS[plan.tier]} tier · ${score} · ${formatModelPrice(chosen.candidate.model, relativeCost)} · ${EFFORT_WORDS[effort]} effort for ${effortWhy}${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
  };
}
