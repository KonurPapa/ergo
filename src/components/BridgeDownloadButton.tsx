import React from 'react';
import { Download } from 'lucide-react';
import { useBridgeDownload } from '../hooks/useBridgeDownload';

interface BridgeDownloadButtonProps {
  /** Quieter look, for when the bridge is already connected. */
  subtle?: boolean;
  style?: React.CSSProperties;
}

/**
 * Downloads the Ergo Bridge installer for this computer in one click. Until that installer is published it shows a
 * disabled "coming soon" state rather than linking to GitHub's 404 page. Renders nothing on phones and tablets.
 */
export const BridgeDownloadButton: React.FC<BridgeDownloadButtonProps> = ({ subtle = false, style }) => {
  const download = useBridgeDownload();
  if (!download) return null;

  const base: React.CSSProperties = {
    padding: '0.45rem 0.85rem',
    borderRadius: '6px',
    fontSize: '0.76rem',
    fontWeight: 600,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    ...style
  };

  if (download.published === false) {
    return (
      <span
        aria-disabled="true"
        title="The installer hasn't been published yet."
        style={{ ...base, background: 'var(--bg-hover, rgba(0, 0, 0, 0.05))', color: 'var(--text-muted)', border: '1px solid var(--border-subtle, var(--border, #e2e8f0))', cursor: 'not-allowed' }}
      >
        <Download size={13} />
        <span>Ergo Bridge for {download.platform}: coming soon</span>
      </span>
    );
  }

  return (
    <a
      href={download.url}
      style={
        subtle
          ? { ...base, background: 'var(--bg-hover, rgba(0, 0, 0, 0.05))', color: 'var(--text-bright)', border: '1px solid var(--border-subtle, var(--border, #e2e8f0))' }
          : { ...base, background: 'var(--accent-primary)', color: '#ffffff' }
      }
    >
      <Download size={13} />
      <span>Download Ergo Bridge for {download.platform}</span>
    </a>
  );
};
