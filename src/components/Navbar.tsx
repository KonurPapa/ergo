import React from 'react';
import { type ProjectData } from '../types';
import { ChevronDown, Columns3, Download, FileCode, FolderGit2, FolderMinus, FolderOpen, LayoutList, ListPlus, Moon, PanelRight, PanelsTopLeft, Play, Plus, Search, Settings, SquareKanban, Sun } from 'lucide-react';
import type { ProjectViewSettings } from '../lib/projectView';
import { Button, IconButton, Icon, Kbd, MenuButton, type MenuItem } from './ui';
import { MOD, SHIFT } from '../lib/shortcuts';
import ergoIcon from '../assets/ergo_icon_2.png';

interface NavbarProps {
  projects: ProjectData[];
  activeProject: ProjectData;
  onSelectProject: (proj: ProjectData) => void;
  onNewProject: () => void;
  /** Takes the open project off Ergo's list (asks first; its files are kept). */
  onRemoveProject?: () => void;
  onOpenFolderPicker?: () => void;
  onOpenRawMarkdownModal: () => void;
  onExportProject?: () => void;
  /** ⌘K: search tasks or run a command. */
  onOpenPalette: () => void;
  /** ⇧⌘D: Draft tasks. */
  onOpenDraft: () => void;
  /** The Run screen: the selected task, every task of a list, or the next N in order. */
  onOpenRun: () => void;
  isDetailOpen: boolean;
  onToggleDetail: () => void;
  isSettingsOpen: boolean;
  onOpenSettings: () => void;
  /** The logo: opens the welcome / onboarding screen. */
  onOpenWelcome: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  /** The project's view: list or board, and (list) lanes side by side or behind tabs. */
  view?: ProjectViewSettings;
  laneCount?: number;
  onChangeView?: (patch: Partial<ProjectViewSettings>) => void;
}

/**
 * The top bar (TopBar in the design): brand, project switcher, search / ⌘K, Run, Draft tasks, detail-pane toggle and
 * settings. Nothing else — save state, bridge and agent live in the status bar.
 */
export const Navbar: React.FC<NavbarProps> = ({
  projects,
  activeProject,
  onSelectProject,
  onNewProject,
  onRemoveProject,
  onOpenFolderPicker,
  onOpenRawMarkdownModal,
  onExportProject,
  onOpenPalette,
  onOpenDraft,
  onOpenRun,
  isDetailOpen,
  onToggleDetail,
  isSettingsOpen,
  onOpenSettings,
  onOpenWelcome,
  theme,
  onToggleTheme,
  view,
  laneCount = 1,
  onChangeView,
}) => {
  const projectItems: MenuItem[] = [
    { section: 'Projects' },
    ...projects.map((p) => ({
      label: p.name,
      icon: FolderGit2,
      checked: p.id === activeProject?.id,
      title: p.folderPath || `projects/${p.id}`,
      onSelect: () => onSelectProject(p),
    })),
    { separator: true },
    { label: 'New project', icon: Plus, onSelect: onNewProject },
    ...(onOpenFolderPicker ? [{ label: 'Choose root folder', icon: FolderOpen, onSelect: onOpenFolderPicker }] : []),
    { separator: true },
    { label: 'View TODO.md as markdown', icon: FileCode, onSelect: onOpenRawMarkdownModal },
    ...(onExportProject ? [{ label: 'Export project', icon: Download, onSelect: onExportProject }] : []),
    ...(onRemoveProject && activeProject
      ? [
          { separator: true } as const,
          {
            label: projects.length > 1 ? `Remove ${activeProject.name}…` : 'Remove project…',
            icon: FolderMinus,
            danger: true,
            onSelect: onRemoveProject,
          },
        ]
      : []),
  ];

  // View: how this project's lists show — as documents or as a board; several lists side by side or as tabs.
  const isBoard = view?.style === 'kanban';
  const viewItems: MenuItem[] = view
    ? [
        { section: 'Show tasks as' },
        { label: 'Document', icon: LayoutList, checked: !isBoard, onSelect: () => onChangeView?.({ style: 'list' }) },
        { label: 'Kanban board', icon: SquareKanban, checked: isBoard, title: 'Each list is a column of task cards', onSelect: () => onChangeView?.({ style: 'kanban' }) },
        { section: isBoard ? 'Lists (a board shows them all)' : laneCount > 1 ? 'Lists' : 'Lists (with more than one)' },
        {
          label: 'Side by side',
          icon: Columns3,
          checked: view.layout === 'columns',
          disabled: isBoard,
          title: 'Every list is visible; scroll sideways when they don’t fit',
          onSelect: () => onChangeView?.({ layout: 'columns' }),
        },
        {
          label: 'Tabs',
          icon: PanelsTopLeft,
          checked: view.layout === 'tabs',
          disabled: isBoard,
          title: 'One list at a time, with a tab for each',
          onSelect: () => onChangeView?.({ layout: 'tabs' }),
        },
      ]
    : [];

  return (
    <header className="eg-topbar">
      <button type="button" className="eg-brand" onClick={onOpenWelcome} title="Welcome to Ergo: set up and tour">
        <img src={ergoIcon} alt="" className="eg-brand-logo" aria-hidden="true" />
        <span className="eg-brand-name eg-hide-sm">Ergo</span>
      </button>
      <span className="eg-crumb-sep">/</span>
      <MenuButton
        items={projectItems}
        width={300}
        trigger={(p) => (
          <Button {...p} variant="ghost" className="eg-topbar-project" icon={FolderGit2} iconRight={ChevronDown} title={activeProject?.folderPath}>
            <span className="eg-topbar-project-name">{activeProject?.name || 'No project'}</span>
          </Button>
        )}
      />

      <span className="eg-spacer" />
      <button type="button" className="eg-topbar-search" onClick={onOpenPalette} aria-label="Search tasks or run a command">
        <Icon icon={Search} size="sm" />
        <span className="eg-topbar-search-ph">Search tasks or run a command</span>
        <Kbd keys={[MOD, 'K']} />
      </button>
      <span className="eg-spacer" />

      <Button variant="secondary" icon={Play} onClick={onOpenRun} className="eg-topbar-run" title="Run the selected task, a whole list, or the next few tasks">
        <span className="eg-hide-sm">Run</span>
      </Button>
      <Button variant="ghost" icon={ListPlus} kbd={[SHIFT, MOD, 'D']} onClick={onOpenDraft} className="eg-topbar-draft">
        <span className="eg-hide-sm">Draft tasks</span>
      </Button>
      {view && onChangeView && (
        <MenuButton
          align="end"
          width={240}
          items={viewItems}
          trigger={(p) => <IconButton {...p} icon={isBoard ? SquareKanban : view.layout === 'tabs' && laneCount > 1 ? PanelsTopLeft : LayoutList} label="View" />}
        />
      )}
      <IconButton
        icon={PanelRight}
        label={isDetailOpen ? 'Hide detail pane' : 'Show detail pane'}
        aria-pressed={isDetailOpen}
        onClick={onToggleDetail}
        disabled={isSettingsOpen}
      />
      <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={onToggleTheme} />
      <IconButton icon={Settings} label="Settings" aria-pressed={isSettingsOpen} onClick={onOpenSettings} />
    </header>
  );
};
