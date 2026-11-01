import React from 'react';
import { Button, Dialog } from './ui';

export type ArchiveScope = 'both' | 'brief';

export interface ArchiveConfirmRequest {
  target: string | number;
  /** Which workspace the archive was started from. */
  origin: 'human' | 'ai';
  title: string;
  hasTask: boolean;
  hasBrief: boolean;
}

interface ArchiveConfirmModalProps {
  request: ArchiveConfirmRequest | null;
  onConfirm: (scope: ArchiveScope) => void;
  onCancel: () => void;
}

/**
 * Confirms an archive. From the human workspace the task and its execution card always move
 * together; from the AI workspace the user picks the execution card alone or both cards.
 */
export const ArchiveConfirmModal: React.FC<ArchiveConfirmModalProps> = ({ request, onConfirm, onCancel }) => {
  if (!request) return null;
  const { origin, title, hasTask, hasBrief } = request;
  const fromAi = origin === 'ai';
  const canArchiveBoth = hasTask && hasBrief;

  let note: string;
  if (fromAi) {
    note = canArchiveBoth
      ? 'Archive just the execution card, or the execution card and its task in the human workspace?'
      : 'This task has no card in the human workspace, so only the execution card is archived.';
  } else {
    note = hasBrief ? 'Its execution card in the AI workspace is archived with it.' : 'This task has no execution card in the AI workspace.';
  }

  return (
    <Dialog
      title="Archive this task?"
      onClose={onCancel}
      width={480}
      footer={
        <>
          <span className="eg-spacer" />
          <Button variant="ghost" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          {fromAi ? (
            <>
              <Button variant={canArchiveBoth ? 'secondary' : 'primary'} size="lg" onClick={() => onConfirm('brief')} autoFocus={!canArchiveBoth}>
                Archive execution card
              </Button>
              {canArchiveBoth && (
                <Button variant="primary" size="lg" onClick={() => onConfirm('both')} autoFocus>
                  Archive both
                </Button>
              )}
            </>
          ) : (
            <Button variant="primary" size="lg" onClick={() => onConfirm('both')} autoFocus>
              Archive
            </Button>
          )}
        </>
      }
    >
      <p style={{ margin: 0 }}>
        <span style={{ color: 'var(--ink)', fontWeight: 500 }}>“{title}”</span> is removed from the workspace and kept in archived tasks.
      </p>
      <p style={{ margin: 'var(--space-2) 0 0' }}>{note}</p>
    </Dialog>
  );
};
