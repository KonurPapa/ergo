import { useEffect, useState } from 'react';
import { getBridgeDownload, isBridgeDownloadPublished } from '../lib/bridgeClient';

/**
 * The Ergo Bridge installer for this computer, plus whether it is published yet: `false` hides a link that would
 * only reach GitHub's 404 page, `null` means still checking or GitHub didn't say (the link is offered anyway).
 */
export function useBridgeDownload() {
  const [download] = useState(getBridgeDownload);
  const [published, setPublished] = useState<boolean | null>(null);
  useEffect(() => {
    if (!download) return;
    let cancelled = false;
    void isBridgeDownloadPublished(download.url).then((value) => {
      if (!cancelled) setPublished(value);
    });
    return () => {
      cancelled = true;
    };
  }, [download]);
  return download ? { ...download, published } : null;
}
