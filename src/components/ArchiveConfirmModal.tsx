import React from 'react';
import { Archive, AlertCircle, X } from 'lucide-react';

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

  let warning: string;
  if (fromAi) {
    warning = canArchiveBoth
      ? 'Archive just the execution card, or the execution card and its task in the human workspace?'
      : 'This task has no card in the human workspace, so only the execution card will be archived.';
  } else {
    warning = hasBrief
      ? 'Its execution card in the AI workspace will be archived with it.'
      : 'This task has no execution card in the AI workspace.';
  }

  return (
    <div className="modal-overlay" onClick={onCancel} style={{ zIndex: 130 }}>
      <div className="modal-card archive-delete-modal is-archive" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f59e0b' }}>
            <Archive size={18} />
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Archive Task?</h3>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: '1rem 1.25rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
          <p style={{ margin: 0, marginBottom: '0.75rem' }}>
            <strong>"{title}"</strong> will be removed from the workspace and kept in archived tasks.
          </p>
          <div className="archive-delete-warning-box">
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>{warning}</span>
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '0.75rem 1.25rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          {fromAi ? (
            <>
              <button type="button" className={canArchiveBoth ? 'btn btn-secondary' : 'btn btn-primary'} onClick={() => onConfirm('brief')}>
                Archive execution card
              </button>
              {canArchiveBoth && (
                <button type="button" className="btn btn-primary" onClick={() => onConfirm('both')}>
                  Archive both
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => onConfirm('both')}>
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
