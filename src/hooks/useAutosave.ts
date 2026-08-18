import { useState, useEffect, useRef, useCallback } from 'react';
import { writeFilesToDisk } from '../lib/fileSystem';

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface FileToSave {
  filePath: string;
  content: string;
}

export interface UseAutosaveOptions {
  defaultDelaySec?: number;
  onSaved?: (savedAt: string, files: string[]) => void;
  onError?: (error: string) => void;
}

export function useAutosave(options: UseAutosaveOptions = {}) {
  const { defaultDelaySec = 5, onSaved, onError } = options;

  // Delay setting in seconds
  const [delaySec, setDelaySecState] = useState<number>(() => {
    const saved = localStorage.getItem('ergo_autosave_delay_sec');
    if (saved) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 0.5) return parsed;
    }
    return defaultDelaySec;
  });

  // Enabled toggle
  const [isEnabled, setIsEnabledState] = useState<boolean>(() => {
    const saved = localStorage.getItem('ergo_autosave_enabled');
    return saved !== null ? saved === 'true' : true;
  });

  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastSavedFiles, setLastSavedFiles] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFilesRef = useRef<FileToSave[] | null>(null);
  const isSavingRef = useRef<boolean>(false);

  // Setters with localStorage persistence
  const setDelaySec = useCallback((seconds: number) => {
    const valid = Math.max(0.5, Math.min(300, seconds));
    setDelaySecState(valid);
    localStorage.setItem('ergo_autosave_delay_sec', String(valid));
  }, []);

  const setIsEnabled = useCallback((enabled: boolean) => {
    setIsEnabledState(enabled);
    localStorage.setItem('ergo_autosave_enabled', String(enabled));
    if (!enabled && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      setStatus('idle');
    }
  }, []);

  // Perform actual disk write
  const executeSave = useCallback(
    async (files: FileToSave[]): Promise<boolean> => {
      if (files.length === 0) return true;
      isSavingRef.current = true;
      setStatus('saving');
      setErrorMessage(null);

      const result = await writeFilesToDisk(files);

      isSavingRef.current = false;
      pendingFilesRef.current = null;

      if (result.success) {
        const savedTime = result.savedAt || new Date().toISOString();
        const savedList = result.files || files.map((f) => f.filePath);
        setStatus('saved');
        setLastSavedAt(savedTime);
        setLastSavedFiles(savedList);
        if (onSaved) onSaved(savedTime, savedList);
        return true;
      } else {
        const err = result.error || 'Failed to write to disk';
        setStatus('error');
        setErrorMessage(err);
        if (onError) onError(err);
        return false;
      }
    },
    [onSaved, onError]
  );

  // Queue autosave with debounce
  const queueSave = useCallback(
    (files: FileToSave[]) => {
      pendingFilesRef.current = files;

      if (!isEnabled) {
        return;
      }

      setStatus('pending');

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (pendingFilesRef.current) {
          executeSave(pendingFilesRef.current);
        }
      }, delaySec * 1000);
    },
    [delaySec, isEnabled, executeSave]
  );

  // Immediate save without waiting for timer
  const saveImmediately = useCallback(
    async (files?: FileToSave[]): Promise<boolean> => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const filesToSave = files || pendingFilesRef.current;
      if (!filesToSave || filesToSave.length === 0) {
        return true;
      }

      return executeSave(filesToSave);
    },
    [executeSave]
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return {
    status,
    delaySec,
    setDelaySec,
    isEnabled,
    setIsEnabled,
    lastSavedAt,
    lastSavedFiles,
    errorMessage,
    queueSave,
    saveImmediately,
  };
}
