import React, { useState, useEffect, useRef } from 'react';
import { type TaskItem, type AgentContextItem } from '../types';
import { FileText, Edit3, Save, Sparkles, Play, AlertCircle } from 'lucide-react';
import { RichTextToolbar } from './RichTextToolbar';
import { MarkdownRenderer } from './MarkdownRenderer';

interface BriefPaneProps {
  activeTask: TaskItem | null;
  activeBrief: AgentContextItem | undefined;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem) => void;
  onUpdateBriefWithAi: (task: TaskItem) => void;
}

export const BriefPane: React.FC<BriefPaneProps> = ({
  activeTask,
  activeBrief,
  onSaveBrief,
  onExecuteTask,
  onUpdateBriefWithAi
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [briefText, setBriefText] = useState('');
  const [builtText, setBuiltText] = useState('');
  const [validationText, setValidationText] = useState('');
  const [followUpsText, setFollowUpsText] = useState('');

  const briefRef = useRef<HTMLTextAreaElement>(null);
  const builtRef = useRef<HTMLTextAreaElement>(null);
  const validationRef = useRef<HTMLTextAreaElement>(null);
  const followUpsRef = useRef<HTMLTextAreaElement>(null);

  const [activeFocusedRef, setActiveFocusedRef] = useState<React.RefObject<HTMLTextAreaElement | null> | null>(null);

  useEffect(() => {
    if (activeBrief) {
      setBriefText(activeBrief.brief || '');
      setBuiltText(activeBrief.built || '');
      setValidationText(activeBrief.validation || '');
      setFollowUpsText(activeBrief.followUps || '');
    } else {
      setBriefText('');
      setBuiltText('');
      setValidationText('');
      setFollowUpsText('');
    }
    setIsEditing(false);
  }, [activeTask?.id, activeBrief]);

  if (!activeTask) {
    return (
      <div className="pane pane-right" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
          <FileText size={48} color="var(--accent-violet)" style={{ opacity: 0.5, marginBottom: '1rem' }} />
          <h3>Select a task item to inspect its Agent Brief</h3>
          <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', maxWidth: '400px' }}>
            The agent view holds the full done-state brief, target code seams, decisions made, validation notes, and execution records.
          </p>
        </div>
      </div>
    );
  }

  const handleSave = () => {
    if (!activeBrief) return;
    onSaveBrief({
      ...activeBrief,
      brief: briefText,
      built: builtText,
      validation: validationText,
      followUps: followUpsText
    });
    setIsEditing(false);
  };

  return (
    <div className="pane pane-right">
      {/* Pane Header */}
      <div className="pane-header">
        <div className="pane-title">
          <FileText size={18} color="var(--accent-violet)" />
          <span>AI Canvas & Brief</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Item #{activeTask.id}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className="btn btn-secondary"
            style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }}
            onClick={() => onUpdateBriefWithAi(activeTask)}
          >
            <Sparkles size={14} color="var(--accent-cyan)" />
            <span>Refine Brief AI</span>
          </button>

          {isEditing ? (
            <button className="btn btn-emerald" style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }} onClick={handleSave}>
              <Save size={14} />
              <span>Save Brief</span>
            </button>
          ) : (
            <button className="btn btn-secondary" style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }} onClick={() => setIsEditing(true)}>
              <Edit3 size={14} />
              <span>Edit Brief</span>
            </button>
          )}

          <button className="btn btn-emerald" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }} onClick={() => onExecuteTask(activeTask)}>
            <Play size={14} />
            <span>Execute Task</span>
          </button>
        </div>
      </div>

      {/* Text Editor Formatting Bar in Edit Mode */}
      {isEditing && (
        <div style={{ padding: '0.6rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(7, 10, 18, 0.8)' }}>
          <RichTextToolbar
            targetRef={activeFocusedRef || briefRef}
            compact={false}
          />
        </div>
      )}

      {/* Pane Body */}
      <div className="pane-content">
        {/* Brief Sections */}
        <div className="brief-container">
          {/* Section 1: Brief */}
          <div className="brief-card">
            <div className="brief-section-header">
              <span>📋 Brief (Done-State, Target Seams, Constraints)</span>
            </div>
            {isEditing ? (
              <textarea
                ref={briefRef}
                className="textarea-text"
                style={{ height: '140px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={briefText}
                onChange={(e) => setBriefText(e.target.value)}
                onFocus={() => setActiveFocusedRef(briefRef)}
              />
            ) : (
              <div className="brief-body">
                {briefText ? (
                  <div className="brief-markdown-render">
                    {briefText.split('\n').map((line, idx) => (
                      <p key={idx} style={{ minHeight: line ? 'auto' : '0.8rem', marginBottom: '0.35rem' }}>
                        <MarkdownRenderer content={line} />
                      </p>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No detailed brief defined yet. Click 'Refine Brief AI' to draft one.</span>
                )}
              </div>
            )}
          </div>

          {/* Section 2: Built */}
          <div className="brief-card">
            <div className="brief-section-header">
              <span>🛠️ Built (Implementation Log & Decisions Made)</span>
            </div>
            {isEditing ? (
              <textarea
                ref={builtRef}
                className="textarea-text"
                style={{ height: '120px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={builtText}
                onChange={(e) => setBuiltText(e.target.value)}
                onFocus={() => setActiveFocusedRef(builtRef)}
              />
            ) : (
              <div className="brief-body">
                {builtText ? (
                  <div className="brief-markdown-render">
                    {builtText.split('\n').map((line, idx) => (
                      <p key={idx} style={{ minHeight: line ? 'auto' : '0.8rem', marginBottom: '0.35rem' }}>
                        <MarkdownRenderer content={line} />
                      </p>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not executed yet. Click 'Execute Task' to perform execution and populate build records.</span>
                )}
              </div>
            )}
          </div>

          {/* Section 3: Validation */}
          <div className="brief-card">
            <div className="brief-section-header">
              <span>🧪 Validation (Automated & Manual Test Output)</span>
            </div>
            {isEditing ? (
              <textarea
                ref={validationRef}
                className="textarea-text"
                style={{ height: '100px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={validationText}
                onChange={(e) => setValidationText(e.target.value)}
                onFocus={() => setActiveFocusedRef(validationRef)}
              />
            ) : (
              <div className="brief-body">
                {validationText ? (
                  <div className="brief-markdown-render">
                    {validationText.split('\n').map((line, idx) => (
                      <p key={idx} style={{ minHeight: line ? 'auto' : '0.8rem', marginBottom: '0.35rem' }}>
                        <MarkdownRenderer content={line} />
                      </p>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Validation notes will record passing unit checks and browser verification.</span>
                )}
              </div>
            )}
          </div>

          {/* Section 4: Follow-ups */}
          <div className="brief-card">
            <div className="brief-section-header">
              <span>📌 Follow-ups (Next steps & edge cases)</span>
            </div>
            {isEditing ? (
              <textarea
                ref={followUpsRef}
                className="textarea-text"
                style={{ height: '90px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={followUpsText}
                onChange={(e) => setFollowUpsText(e.target.value)}
                onFocus={() => setActiveFocusedRef(followUpsRef)}
              />
            ) : (
              <div className="brief-body">
                {followUpsText ? (
                  <div className="brief-markdown-render">
                    {followUpsText.split('\n').map((line, idx) => (
                      <p key={idx} style={{ minHeight: line ? 'auto' : '0.8rem', marginBottom: '0.35rem' }}>
                        <MarkdownRenderer content={line} />
                      </p>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No follow-ups recorded.</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
