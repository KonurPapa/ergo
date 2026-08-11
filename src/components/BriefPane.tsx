import React, { useState, useEffect } from 'react';
import { type TaskItem, type AgentContextItem } from '../types';
import { FileText, Edit3, Save, Sparkles, Play, AlertCircle } from 'lucide-react';

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
          <h3>Select a task to inspect its Agent Brief</h3>
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
          <span>AI Canvas</span>
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
              <span>Edit</span>
            </button>
          )}

          <button className="btn btn-emerald" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }} onClick={() => onExecuteTask(activeTask)}>
            <Play size={14} />
            <span>Execute Task</span>
          </button>
        </div>
      </div>

      {/* Pane Body */}
      <div className="pane-content">
        {/* Task Summary Banner */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-violet)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Shared Human/Agent Task Map
            </span>
            <span className={`badge badge-${activeTask.status}`}>
              {activeTask.status.replace('_', ' ')}
            </span>
          </div>

          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', marginBottom: '0.5rem' }}>
            #{activeTask.id}. {activeTask.title}
          </h2>

          {activeTask.isHumanReview && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-rose)', fontSize: '0.8rem', fontWeight: 600, marginTop: '0.2rem' }}>
              <AlertCircle size={14} />
              <span>Requires Human Verification / Review step after execution</span>
            </div>
          )}
        </div>

        {/* Brief Sections */}
        <div className="brief-container">
          {/* Section 1: Brief */}
          <div className="brief-card">
            <div className="brief-section-header">
              <span>📋 Brief (Done-State, Target Seams, Constraints)</span>
            </div>
            {isEditing ? (
              <textarea
                className="textarea-text"
                style={{ height: '140px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={briefText}
                onChange={(e) => setBriefText(e.target.value)}
              />
            ) : (
              <div className="brief-body">
                {briefText || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No detailed brief defined yet. Click 'Refine Brief AI' to draft one.</span>}
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
                className="textarea-text"
                style={{ height: '120px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={builtText}
                onChange={(e) => setBuiltText(e.target.value)}
              />
            ) : (
              <div className="brief-body">
                {builtText || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not executed yet. Click 'Execute Task' to perform execution and populate build records.</span>}
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
                className="textarea-text"
                style={{ height: '100px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={validationText}
                onChange={(e) => setValidationText(e.target.value)}
              />
            ) : (
              <div className="brief-body">
                {validationText || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Validation notes will record passing unit checks and browser verification.</span>}
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
                className="textarea-text"
                style={{ height: '90px', border: 'none', borderRadius: 0, padding: '1rem' }}
                value={followUpsText}
                onChange={(e) => setFollowUpsText(e.target.value)}
              />
            ) : (
              <div className="brief-body">
                {followUpsText || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No follow-ups recorded.</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
