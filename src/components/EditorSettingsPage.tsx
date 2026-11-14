/**
 * Settings › Editor: which app opens files and diffs from Ergo (file paths in briefs, notes and agent output; a run's
 * changed files). Kept in the user's preferences and sent with each open request; the bridge runs the editor.
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronDown } from 'lucide-react';
import { IDE_OPTIONS, AUTO_IDE_ORDER, ideLabel } from '../lib/ideLaunch';
import { bridgeSupportsIdeLinks, detectIdes, getIdeChoice, setIdeChoice } from '../lib/ideLinks';
import { subscribePrefs } from '../lib/userPrefs';
import { Banner, Icon, MenuButton, SettingsGroup, SettingsRow } from './ui';

const subscribe = (cb: () => void) => {
  const off = subscribePrefs(cb);
  return () => void off();
};

export const EditorSettingsPage: React.FC = () => {
  const choice = useSyncExternalStore(subscribe, getIdeChoice);
  const [detected, setDetected] = useState<Record<string, boolean> | null>(null);
  const supported = bridgeSupportsIdeLinks();

  useEffect(() => {
    let alive = true;
    void detectIdes().then((found) => alive && setDetected(found));
    return () => {
      alive = false;
    };
  }, []);

  const option = IDE_OPTIONS.find((o) => o.id === choice) ?? IDE_OPTIONS[0];
  const autoPick = detected ? AUTO_IDE_ORDER.find((id) => detected[id]) : undefined;
  const missing = detected && choice !== 'auto' && choice !== 'system' && detected[choice] === false;

  return (
    <>
      <SettingsGroup title="Open files in">
        <SettingsRow
          title="Editor"
          help={
            choice === 'auto' && detected
              ? autoPick
                ? `${option.detail} On this computer: ${ideLabel(autoPick)}.`
                : `${option.detail} None was found here, so files open with the system's app.`
              : option.detail
          }
        >
          <MenuButton
            align="end"
            width={260}
            items={IDE_OPTIONS.map((o) => ({
              label: o.label,
              checked: o.id === choice,
              hint: detected && o.id in detected ? (detected[o.id] ? 'Installed' : 'Not found') : undefined,
              onSelect: () => setIdeChoice(o.id),
            }))}
            trigger={(t) => (
              <button type="button" className="eg-select" {...t}>
                {option.label}
                <Icon icon={ChevronDown} size="sm" />
              </button>
            )}
          />
        </SettingsRow>
      </SettingsGroup>
      {!supported ? (
        <Banner
          className="eg-settings-banner"
          tone="warning"
          title="Update the bridge to use this choice"
          text="This bridge opens files in the first editor it finds, and can't list a run's changed files or open diffs."
        />
      ) : missing ? (
        <Banner
          className="eg-settings-banner"
          tone="warning"
          title={`${option.label} wasn't found on this computer`}
          text={
            choice === 'jetbrains'
              ? 'Turn on shell scripts in JetBrains Toolbox (Settings › Tools), or create the command-line launcher from the IDE. Until then, files open with the system’s app.'
              : choice === 'zed'
                ? 'Install Zed’s command-line tool (zed: install cli in the command palette). Until then, files open with the system’s app.'
                : `Install its command-line launcher (Shell Command: Install '${choice === 'vscode' ? 'code' : choice}' command in PATH, in the command palette). Until then, files open through ${option.label}'s link handler.`
          }
        />
      ) : null}
      <p className="eg-settings-groupdesc eg-settings-after">
        File paths in briefs, notes and agent output open at their line. Under a run's Notes, its changed files open as side-by-side diffs in VS
        Code, Cursor, Windsurf and JetBrains IDEs; other editors open the file.
      </p>
    </>
  );
};
