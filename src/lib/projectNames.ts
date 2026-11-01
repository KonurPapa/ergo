import { getPref, setPref } from './userPrefs';
import type { ProjectData } from '../types';

/**
 * A project's display name, set in Settings › General. A project's id and folder stay as they are (briefs, task ids
 * and memory are keyed by them); the name is only what Ergo shows.
 */
const key = (projectId: string) => `project_name:${projectId}`;

export function projectDisplayName(project: Pick<ProjectData, 'id' | 'name'>): string {
  return getPref(key(project.id))?.trim() || project.name;
}

export function setProjectDisplayName(projectId: string, name: string): void {
  setPref(key(projectId), name.trim());
}

/** Projects with their display names applied. */
export function withDisplayNames<T extends Pick<ProjectData, 'id' | 'name'>>(projects: T[]): T[] {
  return projects.map((p) => {
    const name = projectDisplayName(p);
    return name === p.name ? p : { ...p, name };
  });
}
