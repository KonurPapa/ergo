import React, { useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp, X } from 'lucide-react';
import type { RunOutcomeRecord } from '../types';
import type { CalibrationFile, SurveyReason, SurveyVerdict } from '../lib/agentPipeline/calibration';
import {
  answerRunSurvey,
  dismissRunSurvey,
  getCalibration,
  pendingSurvey,
  peekCalibration,
  subscribeCalibration,
} from '../lib/agentPipeline/calibrationStore';

/** Why Ergo is asking, in one line. */
function reasonText(reason: SurveyReason, record: RunOutcomeRecord | undefined): string {
  if (reason === 'no_verdict') return "Verifier couldn't confirm this run, so your answer is the only check.";
  if (reason === 'cheaper') {
    const tried = (['manager', 'worker'] as const)
      .map((role) => record?.startModels?.[role] ?? record?.models?.[role])
      .find((s) => s?.calibrated === -1)?.model;
    return `This run tried a cheaper model${tried ? ` (${tried})` : ''}. Your answer decides whether Ergo keeps using it for tasks like this.`;
  }
  return "Ergo hasn't seen enough tasks like this to judge its model choice yet.";
}

/**
 * "How did this task do?" after an Auto run that Ergo can't judge well on its own (calibration.ts surveyReason).
 * Good / bad goes into the learning table and steers the model choice for similar tasks.
 */
export const RunSurveyCard: React.FC<{ record: RunOutcomeRecord | undefined; hidden?: boolean }> = ({ record, hidden }) => {
  const [file, setFile] = useState<CalibrationFile | null>(() => peekCalibration());
  const [answered, setAnswered] = useState<SurveyVerdict | null>(null);
  const runId = record?.runId;

  useEffect(() => {
    let alive = true;
    void getCalibration().then((f) => alive && setFile(f));
    const off = subscribeCalibration(setFile);
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => setAnswered(null), [runId]);

  useEffect(() => {
    if (!answered) return;
    const timer = setTimeout(() => setAnswered(null), 4000);
    return () => clearTimeout(timer);
  }, [answered]);

  if (hidden || !runId) return null;
  if (answered) {
    return (
      <div className="run-survey-card is-answered" role="status">
        <span>Thanks. Ergo will use this when it picks models for tasks like this.</span>
      </div>
    );
  }
  const reason = pendingSurvey(file, runId);
  if (!reason) return null;

  const answer = (value: SurveyVerdict) => {
    answerRunSurvey(runId, value);
    setAnswered(value);
  };

  return (
    <div className="run-survey-card" role="group" aria-label="How did this task do?">
      <div className="run-survey-text">
        <span className="run-survey-question">How did this task do?</span>
        <span className="run-survey-why">{reasonText(reason, record)}</span>
      </div>
      <div className="run-survey-actions">
        <button type="button" className="run-survey-btn is-good" onClick={() => answer('good')} title="The result was good">
          <ThumbsUp size={12} />
          <span>Good</span>
        </button>
        <button type="button" className="run-survey-btn is-bad" onClick={() => answer('bad')} title="The result wasn't good enough">
          <ThumbsDown size={12} />
          <span>Bad</span>
        </button>
        <button
          type="button"
          className="agent-switch-dismiss-btn"
          onClick={() => dismissRunSurvey(runId)}
          aria-label="Don't ask about this run"
          title="Don't ask about this run"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
};
