/**
 * How a project's human workspace is shown, saved per project in projects/<folder>/project.json under `view` (the
 * file also holds the project's own Allowed Folders and lane rules, which are left as they are):
 *
 * - `style`: `list` (each lane is a document) or `kanban` (each lane is a column of task cards).
 * - `layout`: in the list style, lanes side by side (`columns`, scrolling sideways when they don't fit) or one at a
 *   time behind tabs (`tabs`). The board always shows every lane.
 * - `laneOrder`: lane file names in the order shown. The bridge lists a project's files in no set order, so without
 *   it lanes could swap places between loads.
 *
 * Chosen when the project is created and changed from the top bar's view menu.
 */
import { readFilesFromDisk, writeFilesToDisk } from './fileSystem';

export type ViewStyle = 'list' | 'kanban';
export type LaneLayout = 'columns' | 'tabs';

export interface ProjectViewSettings {
  style: ViewStyle;
  layout: LaneLayout;
  laneOrder?: string[];
}

export const DEFAULT_PROJECT_VIEW: ProjectViewSettings = { style: 'list', layout: 'columns' };

const viewFile = (projectFolder: string) => `${projectFolder}/project.json`;
export const laneFileName = (filePath: string) => filePath.split('/').pop() || filePath;

function parse(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function asView(raw: unknown): ProjectViewSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProjectViewSettings>;
  return {
    style: r.style === 'kanban' ? 'kanban' : 'list',
    layout: r.layout === 'tabs' ? 'tabs' : 'columns',
    ...(Array.isArray(r.laneOrder) ? { laneOrder: r.laneOrder.filter((x): x is string => typeof x === 'string') } : {}),
  };
}

/** The project's view settings (`projectFolder`: e.g. "projects/my-app"); the defaults when it has none. */
export async function loadProjectView(projectFolder: string): Promise<ProjectViewSettings> {
  const file = viewFile(projectFolder);
  const files = await readFilesFromDisk([file]).catch(() => ({} as Record<string, string | null>));
  return asView(parse(files[file]).view);
}

/** Saves the project's view settings, keeping everything else project.json holds. */
export async function saveProjectView(projectFolder: string, view: ProjectViewSettings): Promise<void> {
  const file = viewFile(projectFolder);
  // Read first: the file also holds the project's own Allowed Folders and lane rules.
  const current = parse((await readFilesFromDisk([file]).catch(() => ({} as Record<string, string | null>)))[file]);
  await writeFilesToDisk([{ filePath: file, content: JSON.stringify({ ...current, version: 1, view }, null, 2) }]);
}

/**
 * Lanes in the saved order. A lane the order doesn't name yet (just added, or renamed) keeps its place after the lane
 * before it in `lanes`; with no saved order, TODO.md comes first and the rest keep their order.
 */
export function orderLanes<T extends { filePath: string }>(lanes: T[], laneOrder?: string[]): T[] {
  if (lanes.length < 2) return lanes;
  if (!laneOrder || laneOrder.length === 0) {
    const todo = lanes.findIndex((l) => laneFileName(l.filePath) === 'TODO.md');
    return todo > 0 ? [lanes[todo], ...lanes.slice(0, todo), ...lanes.slice(todo + 1)] : lanes;
  }
  const rank = new Map(laneOrder.map((name, i) => [name, i]));
  const out = lanes.filter((l) => rank.has(laneFileName(l.filePath))).sort((a, b) => rank.get(laneFileName(a.filePath))! - rank.get(laneFileName(b.filePath))!);
  lanes.forEach((lane, i) => {
    if (rank.has(laneFileName(lane.filePath))) return;
    // After the nearest lane before it that is already placed; first when there is none.
    let at = 0;
    for (let k = i - 1; k >= 0; k--) {
      const placed = out.indexOf(lanes[k]);
      if (placed !== -1) {
        at = placed + 1;
        break;
      }
    }
    out.splice(at, 0, lane);
  });
  return out;
}

/** True when the saved order already names exactly these lanes in this order. */
export function sameLaneOrder(lanes: Array<{ filePath: string }>, laneOrder?: string[]): boolean {
  const names = lanes.map((l) => laneFileName(l.filePath));
  return !!laneOrder && names.length === laneOrder.length && names.every((n, i) => n === laneOrder[i]);
}

/** Default lane titles for a new project: a board gets the usual columns. */
export function defaultLaneTitles(count: number, style: ViewStyle): string[] {
  const board = ['To do', 'In progress', 'Done'];
  return Array.from({ length: count }, (_, i) => (style === 'kanban' && i < board.length ? board[i] : i === 0 ? 'Human Workspace' : `Swim lane ${i + 1}`));
}

/** A lane's file name from its title, as renaming a lane names it ("In progress" → IN_PROGRESS.md). */
export function laneFileForTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'swim_lane';
  return `${slug.toUpperCase()}.md`;
}

/** What the new-project dialog chooses: the view and how many lanes to start with. */
export interface NewProjectView {
  style: ViewStyle;
  layout: LaneLayout;
  laneCount: number;
}
