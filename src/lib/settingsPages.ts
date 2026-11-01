/** The Settings page's left nav: one entry per page, in the design's groups (Project · Agents · App). */
export type SettingsPage =
  | 'general'
  | 'folders'
  | 'rules'
  | 'memory'
  | 'archive'
  | 'models'
  | 'permissions'
  | 'skills'
  | 'integrations'
  | 'bridge'
  | 'appearance'
  | 'shortcuts';

export type SettingsGroupId = 'project' | 'agents' | 'app';

export const SETTINGS_PAGES: ReadonlyArray<{ id: SettingsPage; label: string; group: SettingsGroupId; keywords?: string }> = [
  { id: 'general', label: 'General', group: 'project', keywords: 'project name folder export storage autosave advanced secrets' },
  { id: 'folders', label: 'Folders', group: 'project', keywords: 'allowed folders index files roots' },
  { id: 'rules', label: 'Rules', group: 'project', keywords: 'learned rules remember corrections' },
  { id: 'memory', label: 'Memory', group: 'project', keywords: 'knowledge notes' },
  { id: 'archive', label: 'Archive', group: 'project', keywords: 'archived tasks restore' },
  { id: 'models', label: 'Models', group: 'agents', keywords: 'provider api key auto manual effort stages profiles' },
  { id: 'permissions', label: 'Permissions', group: 'agents', keywords: 'plan ask accept edits full access' },
  { id: 'skills', label: 'Skills', group: 'agents', keywords: 'skills remember tools' },
  { id: 'integrations', label: 'Integrations', group: 'app', keywords: 'mcp servers connections built-in tools' },
  { id: 'bridge', label: 'Bridge', group: 'app', keywords: 'device bridge download connection' },
  { id: 'appearance', label: 'Appearance', group: 'app', keywords: 'theme dark light' },
  { id: 'shortcuts', label: 'Shortcuts', group: 'app', keywords: 'keyboard keys' },
];
