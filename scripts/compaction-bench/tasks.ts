/**
 * Benchmark tasks for context compaction: each is one worker piece on a copy of ergo-tests/ (a ~3.9k-line canvas game)
 * with planted bugs and/or a feature to build, graded afterwards by hidden tests the worker never sees.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export interface GradeResult {
  score: number;
  max: number;
  checks: Array<{ name: string; ok: boolean; error?: string }>;
}

export interface BenchTask {
  id: string;
  title: string;
  instructions: string;
  files: string[];
  /** Plants the task's bugs into a fresh copy of the project. */
  setup: (dir: string) => void;
  grade: (dir: string) => GradeResult;
}

// ─── Planted bugs ───────────────────────────────────────────────────────────

interface Bug {
  file: string;
  find: string;
  replace: string;
  symptom: string;
  /** Hidden check, run inside the game's vm context (throws on failure). */
  check: string;
}

const BUGS: Bug[] = [
  {
    file: 'src/crops.js',
    find: "const speedMult = (crop.isFertilized ? 1.5 : 1.0)",
    replace: "const speedMult = (crop.isFertilized ? 1.0 : 1.5)",
    symptom: 'Fertilized crops grow noticeably SLOWER than unfertilized ones; fertilizer is supposed to speed growth up by 50%.',
    check: `
      const cm = new CropManager();
      cm.plant(1, 1, 'wheat', true); cm.plant(2, 2, 'wheat', false);
      cm.update(5, () => true, 'Sunny', null);
      const f = cm.getCrop(1, 1).growth, n = cm.getCrop(2, 2).growth;
      if (!(Math.abs(f / n - 1.5) < 0.01)) throw new Error('fertilized/unfertilized growth ratio ' + (f / n));`,
  },
  {
    file: 'src/world.js',
    find: 's => Math.abs(s.x - x) <= 1 && Math.abs(s.y - y) <= 1',
    replace: 's => Math.abs(s.x - x) < 1 && Math.abs(s.y - y) < 1',
    symptom: 'On sunny days, soil right next to a sprinkler still dries out overnight, even though sprinklers are supposed to keep their 8 neighbouring tiles wet.',
    check: `
      const w = new FarmWorld();
      w.tillTile(11, 11); w.waterTile(11, 11);
      w.sprinklers.push({ x: 12, y: 11 });
      w.weatherForecast = WEATHER.SUNNY;
      const r = Math.random; Math.random = () => 0.1;
      try { w.advanceToNextDay(null, null); } finally { Math.random = r; }
      if (!w.isTileWatered(11, 11)) throw new Error('tile next to a sprinkler dried out');`,
  },
  {
    file: 'src/hazards.js',
    find: 'if (dx <= 2 && dy <= 2) {',
    replace: 'if (dx <= 2 || dy <= 2) {',
    symptom: 'A single scarecrow protects crops across its entire row and column of the farm, instead of only crops within 2 tiles of it.',
    check: `
      const h = new HazardManager();
      if (h.isProtectedByScarecrow(18, 10, [{ x: 12, y: 10 }])) throw new Error('far tile in same row protected');
      if (!h.isProtectedByScarecrow(14, 12, [{ x: 12, y: 10 }])) throw new Error('tile 2 away not protected');`,
  },
  {
    file: 'src/player.js',
    find: `      this.xp -= this.xpNeeded;
      this.level++;
      this.xpNeeded = Math.floor(this.xpNeeded * 1.5);`,
    replace: `      this.level++;
      this.xpNeeded = Math.floor(this.xpNeeded * 1.5);
      this.xp -= this.xpNeeded;`,
    symptom: 'Right after a level-up the XP bar sometimes shows negative XP: leftover XP should carry over (e.g. 120 XP at 100 needed leaves 20 XP).',
    check: `
      const p = new Player(5, 5);
      p.gainXp(120, null, null);
      if (p.level !== 2 || p.xp !== 20 || p.xpNeeded !== 150) throw new Error('after 120xp: level ' + p.level + ' xp ' + p.xp + ' needed ' + p.xpNeeded);`,
  },
  {
    file: 'src/crops.js',
    find: `    const crop = this.getCrop(x, y);
    if (!crop || !crop.isRipe) return null;

    this.crops.delete(this.getKey(x, y));
    return crop;`,
    replace: `    const crop = this.getCrop(x, y);
    if (!crop) return null;

    this.crops.delete(this.getKey(x, y));
    if (!crop.isRipe) return null;
    return crop;`,
    symptom: 'Trying to harvest a crop that is not ripe yet makes the crop vanish from the field (it should stay and keep growing).',
    check: `
      const cm = new CropManager();
      cm.plant(3, 3, 'wheat');
      if (cm.harvest(3, 3) !== null) throw new Error('unripe harvest returned a crop');
      if (!cm.hasCrop(3, 3)) throw new Error('unripe crop vanished');`,
  },
  {
    file: 'src/hazards.js',
    find: 'const idx = this.fires.findIndex(f => f.x === tileX && f.y === tileY);',
    replace: 'const idx = this.fires.findIndex(f => f.x === tileX && f.y === tileX);',
    symptom: 'The watering can only puts out lightning fires on some tiles; on most tiles nothing happens.',
    check: `
      const h = new HazardManager();
      h.fires.push({ x: 4, y: 9, px: 0, py: 0, life: 10 });
      if (!h.douseFire(4, 9, null, null) || h.fires.length !== 0) throw new Error('fire at (4,9) not doused');`,
  },
];

function plant(dir: string, bugs: Bug[]): void {
  for (const bug of bugs) {
    const file = path.join(dir, bug.file);
    const text = fs.readFileSync(file, 'utf-8');
    if (!text.includes(bug.find)) throw new Error(`bench setup: pattern not found in ${bug.file}: ${bug.find.slice(0, 60)}`);
    fs.writeFileSync(file, text.replace(bug.find, bug.replace));
  }
}

// ─── Hidden tests ───────────────────────────────────────────────────────────

const GAME_FILES = ['constants.js', 'audio.js', 'particles.js', 'crops.js', 'hazards.js', 'world.js', 'player.js'];

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
}

/** The game's classes loaded into a fresh vm context, as tests/simulation.test.js does. */
function gameContext(dir: string): vm.Context {
  const el = () => ({
    getContext: () => new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) }),
    addEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    appendChild: () => {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1152, height: 768 }),
    style: {},
  });
  const context = vm.createContext({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math, Array, Object, JSON, Map, Set, Error, Number, String, Boolean, Date,
    setTimeout, clearTimeout,
    performance: { now: () => 1000 },
    localStorage: makeStorage(),
    window: {},
    document: { getElementById: el, querySelectorAll: () => [], createElement: el },
  });
  // Classes declared with `class X` in a script are not context properties: re-export them.
  const code = GAME_FILES.map((f) => fs.readFileSync(path.join(dir, 'src', f), 'utf-8')).join('\n;\n');
  vm.runInContext(
    `${code}\n;globalThis.__game = { FarmWorld, CropManager, Player, HazardManager, ParticleSystem, CROPS, WEATHER, TILE };`,
    context,
    { timeout: 10_000 }
  );
  return context;
}

function runChecks(dir: string, checks: Array<{ name: string; code: string }>): GradeResult {
  const out: GradeResult['checks'] = [];
  let context: vm.Context | null = null;
  try {
    context = gameContext(dir);
  } catch (err) {
    return { score: 0, max: checks.length, checks: checks.map((c) => ({ name: c.name, ok: false, error: `game failed to load: ${(err as Error).message}` })) };
  }
  for (const c of checks) {
    try {
      vm.runInContext(`(() => { const { FarmWorld, CropManager, Player, HazardManager, ParticleSystem, CROPS, WEATHER, TILE } = __game; ${c.code}\n})()`, context, { timeout: 10_000 });
      out.push({ name: c.name, ok: true });
    } catch (err) {
      out.push({ name: c.name, ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) });
    }
  }
  return { score: out.filter((c) => c.ok).length, max: out.length, checks: out };
}

/** The project's own test (npm test), as one check: the worker must not break what worked. */
function visibleTestCheck(dir: string): { name: string; code: string } {
  const src = fs.readFileSync(path.join(dir, 'tests', 'simulation.test.js'), 'utf-8');
  const body = src.slice(src.indexOf('vm.runInContext(`') + 'vm.runInContext(`'.length, src.lastIndexOf('`, context);'));
  return { name: 'existing simulation tests', code: body.replace(/console\.log\([^)]*\);?/g, '') };
}

// ─── Save / load feature ────────────────────────────────────────────────────

const SAVE_SPEC = `Add save / load to the game, so a farm can be saved and restored exactly:
- FarmWorld: serialize() returns a plain JSON-safe object; load(data) restores a FarmWorld from such an object. It must
  round-trip tiles (the whole grid), day, timeMinutes, weather, weatherForecast, scarecrows and sprinklers.
- CropManager: serialize() / load(data) round-trip every crop (position, cropId, growth, stage, isFertilized, isWilted,
  wiltTimer, isInfested, isRipe). After load, each crop's config must again be the matching CROPS entry (do not store
  the config object itself in the save).
- Player: serialize() / load(data) round-trip gridX, gridY, coins, stamina, maxStamina, waterLevel, waterCapacity,
  canLevel, hoeLevel, hasSpeedBoots, level, xp, xpNeeded, seeds, harvested and items; after load the pixel position
  (x, y) and speed must match the restored grid position and boots.
- HazardManager: serialize() / load(data) round-trip its stats object.
- Each serialize() result must survive JSON.stringify / JSON.parse unchanged, and load() must not share objects with
  the saved data (changing the loaded world must not change the save).
- In src/game.js add saveGame() and loadGame() methods that store / read all four under the localStorage key
  "harvest-haven-save" (loadGame returns false when there is no save).
Keep npm test passing.`;

const SAVE_CHECKS = [
  {
    name: 'world round-trip',
    code: `
      const w = new FarmWorld();
      w.tillTile(11, 11); w.waterTile(11, 11); w.tillTile(12, 11);
      w.placeStructure(13, 10, 'scarecrow'); w.placeStructure(14, 12, 'sprinkler');
      w.day = 7; w.timeMinutes = 812; w.weather = WEATHER.RAIN; w.weatherForecast = WEATHER.HEATWAVE;
      const data = JSON.parse(JSON.stringify(w.serialize()));
      const w2 = new FarmWorld(); w2.load(data);
      if (JSON.stringify(w2.tiles) !== JSON.stringify(w.tiles)) throw new Error('tiles differ');
      for (const k of ['day', 'timeMinutes', 'weather', 'weatherForecast']) if (w2[k] !== w[k]) throw new Error(k + ' differs');
      if (JSON.stringify(w2.scarecrows) !== JSON.stringify(w.scarecrows)) throw new Error('scarecrows differ');
      if (JSON.stringify(w2.sprinklers) !== JSON.stringify(w.sprinklers)) throw new Error('sprinklers differ');`,
  },
  {
    name: 'crops round-trip with config restored',
    code: `
      const c = new CropManager();
      c.plant(8, 8, 'carrot', true); c.plant(9, 8, 'pumpkin');
      c.update(10, () => true, 'Sunny', null);
      const g = c.getCrop(8, 8); g.isInfested = true; g.wiltTimer = 3.5;
      const raw = c.serialize();
      if (JSON.stringify(raw).includes('Crisp Carrot')) throw new Error('save stores the config object');
      const c2 = new CropManager(); c2.load(JSON.parse(JSON.stringify(raw)));
      for (const [x, y] of [[8, 8], [9, 8]]) {
        const a = c.getCrop(x, y), b = c2.getCrop(x, y);
        if (!b) throw new Error('crop missing at ' + x + ',' + y);
        for (const k of ['cropId', 'growth', 'stage', 'isFertilized', 'isWilted', 'wiltTimer', 'isInfested', 'isRipe']) if (a[k] !== b[k]) throw new Error(k + ' differs');
        if (b.config !== CROPS[b.cropId]) throw new Error('config not restored to the CROPS entry');
      }
      c2.update(1, () => true, 'Sunny', null);`,
  },
  {
    name: 'player round-trip',
    code: `
      const p = new Player(5, 5);
      p.gridX = 10; p.gridY = 9; p.coins = 777; p.level = 3; p.xp = 42; p.xpNeeded = 225; p.hasSpeedBoots = true;
      p.canLevel = 2; p.hoeLevel = 1; p.stamina = 61; p.maxStamina = 130; p.waterLevel = 3; p.waterCapacity = 40;
      p.seeds.tomato = 4; p.harvested.wheat = 9; p.items.sprinkler = 2;
      const p2 = new Player(1, 1); p2.load(JSON.parse(JSON.stringify(p.serialize())));
      for (const k of ['gridX', 'gridY', 'coins', 'level', 'xp', 'xpNeeded', 'hasSpeedBoots', 'canLevel', 'hoeLevel', 'stamina', 'maxStamina', 'waterLevel', 'waterCapacity']) if (p2[k] !== p[k]) throw new Error(k + ' differs: ' + p2[k]);
      for (const k of ['seeds', 'harvested', 'items']) if (JSON.stringify(p2[k]) !== JSON.stringify(p[k])) throw new Error(k + ' differ');
      const ref = new Player(10, 9);
      if (p2.x !== ref.x || p2.y !== ref.y) throw new Error('pixel position not restored');`,
  },
  {
    name: 'player speed follows boots',
    code: `
      const p = new Player(5, 5); p.hasSpeedBoots = true;
      const ref = new Player(5, 5);
      const p2 = new Player(5, 5); p2.load(JSON.parse(JSON.stringify(p.serialize())));
      if (!(p2.speed > ref.speed)) throw new Error('speed with boots ' + p2.speed + ' vs base ' + ref.speed);`,
  },
  {
    name: 'hazard stats round-trip',
    code: `
      const h = new HazardManager();
      for (const k of Object.keys(h.stats)) h.stats[k] = 3;
      const h2 = new HazardManager(); h2.load(JSON.parse(JSON.stringify(h.serialize())));
      if (JSON.stringify(h2.stats) !== JSON.stringify(h.stats)) throw new Error('stats differ');`,
  },
  {
    name: 'load does not share objects with the save',
    code: `
      const w = new FarmWorld(); w.tillTile(11, 11);
      const data = w.serialize(); const snapshot = JSON.stringify(data);
      const w2 = new FarmWorld(); w2.load(data); w2.waterTile(11, 11); w2.scarecrows.push({ x: 1, y: 1 });
      const p = new Player(5, 5); const pd = p.serialize(); const ps = JSON.stringify(pd);
      const p2 = new Player(5, 5); p2.load(pd); p2.seeds.wheat = 99;
      if (JSON.stringify(data) !== snapshot || JSON.stringify(pd) !== ps) throw new Error('loaded objects share state with the save');`,
  },
];

/** saveGame / loadGame in game.js: checked by source (the Game class needs the whole DOM). */
function gameSaveCheck(dir: string): { name: string; ok: boolean; error?: string } {
  const src = fs.readFileSync(path.join(dir, 'src', 'game.js'), 'utf-8');
  const ok = /saveGame\s*\(/.test(src) && /loadGame\s*\(/.test(src) && src.includes('harvest-haven-save');
  return { name: 'game.js saveGame / loadGame with the save key', ok, ...(ok ? {} : { error: 'missing saveGame/loadGame or the "harvest-haven-save" key' }) };
}

// ─── Documentation pass ─────────────────────────────────────────────────────

const DOC_SPEC = `Finally, document the codebase: every method of every class in all nine files under src/ (constructors
included) must have a JSDoc comment (/** ... */) directly above it that says what it does, with an @param line for
each parameter and an @returns line when it returns a value. Read each method before documenting it: the
descriptions must be accurate. Do not change any behaviour while doing this.`;

const METHOD_RE = /^ {2}(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{\s*$/;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);

/** Share of class methods with a JSDoc block right above them that has an @param per parameter. */
export function docCoverage(dir: string): { documented: number; total: number; missing: string[] } {
  let documented = 0;
  let total = 0;
  const missing: string[] = [];
  for (const f of fs.readdirSync(path.join(dir, 'src')).filter((x) => x.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(dir, 'src', f), 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(METHOD_RE);
      if (!m || NOT_METHODS.has(m[1])) return;
      total++;
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === '') j--;
      if (j < 0 || !lines[j].trim().endsWith('*/')) { missing.push(`${f}:${m[1]}`); return; }
      let k = j;
      while (k >= 0 && !lines[k].includes('/**')) k--;
      const block = lines.slice(Math.max(0, k), j + 1).join('\n');
      const params = m[2].split(',').map((p) => p.trim().replace(/\s*=.*$/, '')).filter(Boolean);
      if (k < 0 || params.some((p) => !new RegExp(`@param\\s+(\\{[^}]*\\}\\s+)?\\[?${p.replace('$', '\\$')}\\b`).test(block))) { missing.push(`${f}:${m[1]}`); return; }
      documented++;
    });
  }
  return { documented, total, missing };
}

function docCheck(dir: string): { name: string; ok: boolean; error?: string } {
  const c = docCoverage(dir);
  const share = c.total ? c.documented / c.total : 0;
  const ok = share >= 0.95;
  return { name: `JSDoc on class methods (${c.documented}/${c.total})`, ok, ...(ok ? {} : { error: `${Math.round(share * 100)}% documented; missing e.g. ${c.missing.slice(0, 6).join(', ')}` }) };
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

const bugReport = (bugs: Bug[]) =>
  `Players reported these bugs. Find the cause of each in the source and fix it with a minimal change (the reports say ` +
  `what happens, not where):\n${bugs.map((b, i) => `${i + 1}. ${b.symptom}`).join('\n')}\nKeep npm test passing.`;

const bugChecks = (bugs: Bug[]) => bugs.map((b, i) => ({ name: `bug ${i + 1}: ${b.symptom.slice(0, 50)}…`, code: b.check }));

export const TASKS: BenchTask[] = [
  {
    id: 'bugs',
    title: 'Fix six reported gameplay bugs',
    instructions: bugReport(BUGS),
    files: ['src/crops.js', 'src/world.js', 'src/hazards.js', 'src/player.js', 'src/game.js', 'src/constants.js'],
    setup: (dir) => plant(dir, BUGS),
    grade: (dir) => runChecks(dir, [...bugChecks(BUGS), visibleTestCheck(dir)]),
  },
  {
    id: 'save',
    title: 'Add save / load',
    instructions: SAVE_SPEC,
    files: ['src/world.js', 'src/crops.js', 'src/player.js', 'src/hazards.js', 'src/game.js'],
    setup: () => {},
    grade: (dir) => {
      const r = runChecks(dir, [...SAVE_CHECKS, visibleTestCheck(dir)]);
      const g = gameSaveCheck(dir);
      return { score: r.score + (g.ok ? 1 : 0), max: r.max + 1, checks: [...r.checks, g] };
    },
  },
  {
    id: 'combined',
    title: 'Fix six reported bugs, then add save / load',
    instructions: `${bugReport(BUGS)}\n\nThen:\n${SAVE_SPEC}`,
    files: ['src/crops.js', 'src/world.js', 'src/hazards.js', 'src/player.js', 'src/game.js', 'src/constants.js'],
    setup: (dir) => plant(dir, BUGS),
    grade: (dir) => {
      const r = runChecks(dir, [...bugChecks(BUGS), ...SAVE_CHECKS, visibleTestCheck(dir)]);
      const g = gameSaveCheck(dir);
      return { score: r.score + (g.ok ? 1 : 0), max: r.max + 1, checks: [...r.checks, g] };
    },
  },
  {
    id: 'marathon',
    title: 'Fix six reported bugs, add save / load, then document every method',
    instructions: `${bugReport(BUGS)}\n\nThen:\n${SAVE_SPEC}\n\n${DOC_SPEC}`,
    files: ['src/constants.js', 'src/audio.js', 'src/particles.js', 'src/crops.js', 'src/hazards.js', 'src/world.js', 'src/player.js', 'src/ui.js', 'src/game.js'],
    setup: (dir) => plant(dir, BUGS),
    grade: (dir) => {
      const r = runChecks(dir, [...bugChecks(BUGS), ...SAVE_CHECKS, visibleTestCheck(dir)]);
      const extra = [gameSaveCheck(dir), docCheck(dir)];
      return { score: r.score + extra.filter((c) => c.ok).length, max: r.max + extra.length, checks: [...r.checks, ...extra] };
    },
  },
];

/** A fresh copy of ergo-tests/ for one run, with the task's bugs planted and a git baseline for the diff. */
export function prepareWorkspace(task: BenchTask, sourceDir: string, dir: string): void {
  // ergo-tests/ is a symlink: copy the folder it points to, never the link (planting bugs would edit the original).
  const source = fs.realpathSync(sourceDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(source, dir, { recursive: true, dereference: true, filter: (src) => !/[\\/](node_modules|\.git|\.ergo)([\\/]|$)/.test(src) });
  if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) === source) throw new Error(`bench setup: ${dir} is not a separate copy`);
  task.setup(dir);
}
