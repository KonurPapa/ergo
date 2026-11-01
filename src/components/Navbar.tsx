import React from 'react';
import { type ProjectData } from '../types';
import { ChevronDown, Download, FileCode, FolderGit2, FolderOpen, ListPlus, Moon, PanelRight, Plus, Search, Settings, Sun } from 'lucide-react';
import { Button, IconButton, Icon, Kbd, MenuButton, type MenuItem } from './ui';
import { MOD, SHIFT } from '../lib/shortcuts';
import ergoIcon from '../assets/ergo_icon_2.png';

interface NavbarProps {
  projects: ProjectData[];
  activeProject: ProjectData;
  onSelectProject: (proj: ProjectData) => void;
  onNewProject: () => void;
  onOpenFolderPicker?: () => void;
  onOpenRawMarkdownModal: () => void;
  onExportProject?: () => void;
  /** ⌘K: search tasks or run a command. */
  onOpenPalette: () => void;
  /** ⇧⌘D: Draft tasks. */
  onOpenDraft: () => void;
  isDetailOpen: boolean;
  onToggleDetail: () => void;
  isSettingsOpen: boolean;
  onOpenSettings: () => void;
  /** The logo: opens the welcome / onboarding screen. */
  onOpenWelcome: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

/**
 * The top bar (TopBar in the design): brand, project switcher, search / ⌘K, Draft tasks, detail-pane toggle and
 * settings. Nothing else — save state, bridge and agent live in the status bar.
 */
export const Navbar: React.FC<NavbarProps> = ({
  projects,
  activeProject,
  onSelectProject,
  onNewProject,
  onOpenFolderPicker,
  onOpenRawMarkdownModal,
  onExportProject,
  onOpenPalette,
  onOpenDraft,
  isDetailOpen,
  onToggleDetail,
  isSettingsOpen,
  onOpenSettings,
  onOpenWelcome,
  theme,
  onToggleTheme,
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
  ];

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

      <Button variant="ghost" icon={ListPlus} kbd={[SHIFT, MOD, 'D']} onClick={onOpenDraft} className="eg-topbar-draft">
        <span className="eg-hide-sm">Draft tasks</span>
      </Button>
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
