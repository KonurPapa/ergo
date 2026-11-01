import React from 'react';
import { Download } from 'lucide-react';
import { useBridgeDownload } from '../hooks/useBridgeDownload';
import { Icon, cx } from './ui';

interface BridgeDownloadButtonProps {
  /** Quieter look (secondary button), for when the bridge is already connected or the button sits in a banner. */
  subtle?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Layout only (margins, alignment); type and color come from the Button styles. */
  style?: React.CSSProperties;
}

/** Typography and padding belong to the Button styles; callers' older inline overrides are dropped. */
function layoutOnly(style?: React.CSSProperties): React.CSSProperties | undefined {
  if (!style) return undefined;
  const { fontSize: _fs, fontWeight: _fw, padding: _p, ...rest } = style;
  return rest;
}

/**
 * Downloads the Ergo Bridge installer for this computer in one click. Until that installer is published it shows a
 * disabled "coming soon" state rather than linking to GitHub's 404 page. Renders nothing on phones and tablets.
 */
export const BridgeDownloadButton: React.FC<BridgeDownloadButtonProps> = ({ subtle = false, size = 'md', style }) => {
  const download = useBridgeDownload();
  if (!download) return null;

  const sizeCls = size !== 'md' && `eg-btn-${size}`;

  if (download.published === false) {
    return (
      <span
        aria-disabled="true"
        title="The installer hasn't been published yet."
        className={cx('eg-btn', 'eg-btn-secondary', sizeCls)}
        style={{ ...layoutOnly(style), color: 'var(--ink-disabled)', cursor: 'not-allowed' }}
      >
        <Icon icon={Download} size="sm" />
        Ergo Bridge for {download.platform} is coming soon
      </span>
    );
  }

  return (
    <a
      href={download.url}
      className={cx('eg-btn', subtle ? 'eg-btn-secondary' : 'eg-btn-primary', sizeCls)}
      style={{ textDecoration: 'none', ...layoutOnly(style) }}
    >
      <Icon icon={Download} size="sm" />
      Download Ergo Bridge for {download.platform}
    </a>
  );
};
