import React, { useState } from 'react';
import { X, Play, ArrowDown, Zap, Layers } from 'lucide-react';
import { type TaskItem } from '../types';

interface BatchRunModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'sequence' | 'parallel';
  startTask: TaskItem;
  remainingTasks: TaskItem[];
  onConfirm: (selectedTasks: TaskItem[], mode: 'sequence' | 'parallel') => void;
}

export const BatchRunModal: React.FC<BatchRunModalProps> = ({
  isOpen,
  onClose,
  mode,
  startTask,
  remainingTasks,
  onConfirm,
}) => {
  // All candidate tasks starting with startTask, followed by subsequent tasks in this lane
  const candidateTasks = [startTask, ...remainingTasks];
  const maxCount = candidateTasks.length;

  const [count, setCount] = useState<number>(maxCount);

  if (!isOpen) return null;

  const activeSelected = candidateTasks.slice(0, Math.min(Math.max(1, count), maxCount));

  const handleRun = () => {
    onConfirm(activeSelected, mode);
    onClose();
  };

  const isSequence = mode === 'sequence';
  const title = isSequence ? 'Run Tasks in Sequence' : 'Run Tasks in Parallel';
  const description = isSequence
    ? 'Execute tasks one after another in order. Each subsequent task will start once the previous task finishes.'
    : 'Execute all selected tasks concurrently and agentically at the same time in the AI workspace.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-[#141415] border border-[#27272a] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#27272a] bg-[#18181b]/60">
          <div className="flex items-center gap-2.5">
            <div
              className={`p-2 rounded-lg ${
                isSequence
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
              }`}
            >
              {isSequence ? <ArrowDown className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                {title}
              </h3>
              <p className="text-xs text-zinc-400 mt-0.5">{description}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Count Selector */}
          <div className="bg-[#1c1c1f] p-3.5 rounded-lg border border-[#27272a] space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-zinc-400" />
                <span>Number of tasks to run</span>
              </label>
              <span className="text-xs font-mono text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded border border-zinc-700/50">
                {activeSelected.length} of {maxCount} tasks
              </span>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={maxCount}
                value={count}
                onChange={(e) => setCount(parseInt(e.target.value, 10) || 1)}
                className="w-full accent-indigo-500 bg-zinc-800 rounded-lg h-2 cursor-pointer"
              />
              <input
                type="number"
                min={1}
                max={maxCount}
                value={count}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) setCount(Math.min(Math.max(1, val), maxCount));
                }}
                className="w-16 px-2 py-1 text-center text-xs font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setCount(1)}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 underline"
              >
                Only this task (1)
              </button>
              <span className="text-zinc-600 text-xs">•</span>
              <button
                type="button"
                onClick={() => setCount(maxCount)}
                className="text-[11px] text-indigo-400 hover:text-indigo-300 underline font-medium"
              >
                All subsequent ({maxCount})
              </button>
            </div>
          </div>

          {/* Task Preview List */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold mb-2 flex items-center justify-between">
              <span>Tasks to execute ({activeSelected.length}):</span>
              <span className="text-zinc-500 lowercase font-normal">
                {isSequence ? 'in sequential order' : 'simultaneously'}
              </span>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {activeSelected.map((task, idx) => (
                <div
                  key={task.id || idx}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-[#18181b] border border-[#27272a] text-xs text-zinc-200"
                >
                  <span className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] font-mono text-zinc-400 shrink-0">
                    {idx + 1}
                  </span>
                  <span className="truncate flex-1 font-medium">{task.title}</span>
                  {idx === 0 && (
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded border border-zinc-700/40 shrink-0">
                      Start
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-5 py-3.5 border-t border-[#27272a] bg-[#18181b]/80">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white bg-zinc-800/80 hover:bg-zinc-700/80 rounded-lg transition-colors border border-zinc-700/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRun}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white rounded-lg transition-colors shadow-sm ${
              isSequence
                ? 'bg-amber-600 hover:bg-amber-500'
                : 'bg-indigo-600 hover:bg-indigo-500'
            }`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>
              {isSequence
                ? `Run ${activeSelected.length} in Sequence`
                : `Run ${activeSelected.length} in Parallel`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
