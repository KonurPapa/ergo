import React, { useState, useEffect } from 'react';
import { Download } from 'lucide-react';
import { Button, Dialog, Tabs } from './ui';
import { handleMarkdownAutoWrap } from '../lib/markdownEditorUtils';
import { type SwimLaneDoc } from '../types';

interface RawMarkdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  todoMarkdown: string;
  folderPath?: string;
  todoFilePath?: string;
  swimLanes?: SwimLaneDoc[];
  onSaveMarkdown: (newTodoMd: string, updatedSwimLanes?: SwimLaneDoc[]) => void;
  onExportProject?: () => void;
}

export const RawMarkdownModal: React.FC<RawMarkdownModalProps> = ({
  isOpen,
  onClose,
  todoMarkdown,
  folderPath,
  todoFilePath,
  swimLanes,
  onSaveMarkdown,
  onExportProject
}) => {
  const effectiveLanes: SwimLaneDoc[] = React.useMemo(() => {
    if (swimLanes && swimLanes.length > 0) return swimLanes;
    return [{
      id: 'todo',
      title: 'TODO.md',
      filePath: todoFilePath || 'TODO.md',
      markdown: todoMarkdown
    }];
  }, [swimLanes, todoFilePath, todoMarkdown]);

  const [activeTab, setActiveTab] = useState<string>(effectiveLanes[0]?.id || 'todo');
  const [laneValues, setLaneValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const vals: Record<string, string> = {};
    for (const lane of effectiveLanes) {
      vals[lane.id] = lane.markdown;
    }
    setLaneValues(vals);
    if (!vals[activeTab]) {
      setActiveTab(effectiveLanes[0]?.id || 'todo');
    }
  }, [effectiveLanes]);

  if (!isOpen) return null;

  const handleSave = () => {
    const updatedLanes = effectiveLanes.map((lane) => ({
      ...lane,
      markdown: laneValues[lane.id] !== undefined ? laneValues[lane.id] : lane.markdown
    }));
    const primaryTodoMd = laneValues[effectiveLanes[0]?.id] !== undefined
      ? laneValues[effectiveLanes[0].id]
      : todoMarkdown;

    onSaveMarkdown(primaryTodoMd, updatedLanes);
    onClose();
  };

  const handleLaneChange = (laneId: string, val: string) => {
    setLaneValues((prev) => ({ ...prev, [laneId]: val }));
  };

  const tabs = effectiveLanes.map((lane) => ({
    id: lane.id,
    label: lane.filePath ? lane.filePath.split('/').pop() || lane.title : lane.title,
  }));

  return (
    <Dialog
      title="Markdown files"
      description={folderPath ? <span className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))' }}>{folderPath}</span> : undefined}
      onClose={onClose}
      width={1000}
      className="dlg-raw-md"
      footer={
        <>
          <span className="eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))' }}>Saving writes every file back to disk.</span>
          <span className="eg-spacer" />
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          {onExportProject && (
            <Button size="lg" icon={Download} onClick={onExportProject}>
              Download all files
            </Button>
          )}
          <Button variant="primary" size="lg" onClick={handleSave}>
            Save files
          </Button>
        </>
      }
    >
      <Tabs items={tabs} value={activeTab} onChange={setActiveTab} className="dlg-raw-md-tabs" />
      <textarea
        className="dlg-raw-md-text"
        spellCheck={false}
        aria-label="Markdown"
        value={laneValues[activeTab] ?? ''}
        onChange={(e) => handleLaneChange(activeTab, e.target.value)}
        onKeyDown={(e) => {
          const setter = (valOrFn: string | ((prev: string) => string)) => {
            if (typeof valOrFn === 'function') {
              setLaneValues((prev) => ({ ...prev, [activeTab]: valOrFn(prev[activeTab] ?? '') }));
            } else {
              setLaneValues((prev) => ({ ...prev, [activeTab]: valOrFn }));
            }
          };
          handleMarkdownAutoWrap(e, setter);
        }}
      />
    </Dialog>
  );
};
