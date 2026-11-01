import React, { useEffect, useState } from 'react';
import { Switch } from './ui';
import { exportIncludesErgoFormatting, setExportIncludesErgoFormatting } from '../lib/taskAnchors';
import { subscribePrefs } from '../lib/userPrefs';

/**
 * The export option: keep Ergo's formatting (hidden task anchors, color tags) in downloaded files, or leave it out
 * for use in other tools (the default).
 */
export const ExportFormattingToggle: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const [include, setInclude] = useState(exportIncludesErgoFormatting);
  useEffect(() => subscribePrefs(() => setInclude(exportIncludesErgoFormatting())), []);
  return (
    <label
      className="eg-export-toggle"
      title="Ergo keeps a hidden anchor on each task line, and color tags on colored text and headers. Leave them out when the file is going to another tool."
    >
      <Switch
        checked={include}
        onChange={(e) => {
          setInclude(e.target.checked);
          setExportIncludesErgoFormatting(e.target.checked);
        }}
      />
      <span>{compact ? 'Ergo formatting' : 'Include Ergo formatting'}</span>
    </label>
  );
};
