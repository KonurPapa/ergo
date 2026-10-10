import React, { createContext, useContext, useState, useEffect } from 'react';

interface BetaContextType {
  isBetaEnabled: boolean;
  setIsBetaEnabled: (enabled: boolean) => void;
}

const BetaContext = createContext<BetaContextType>({
  isBetaEnabled: false,
  setIsBetaEnabled: () => {},
});

export const BETA_STORAGE_KEY = 'ergo_beta_features_enabled';

export const BetaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isBetaEnabled, setIsBetaEnabledState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BETA_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const setIsBetaEnabled = (enabled: boolean) => {
    setIsBetaEnabledState(enabled);
    try {
      localStorage.setItem(BETA_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {}
  };

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === BETA_STORAGE_KEY) {
        setIsBetaEnabledState(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return (
    <BetaContext.Provider value={{ isBetaEnabled, setIsBetaEnabled }}>
      {children}
    </BetaContext.Provider>
  );
};

export const useBeta = () => useContext(BetaContext);

export interface BetaFeatureProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Easy tag wrapper to gate elements behind the 'Enable Beta features' toggle.
 * Example: <BetaFeature><MyExperimentalComponent /></BetaFeature>
 */
export const BetaFeature: React.FC<BetaFeatureProps> = ({ children, fallback = null }) => {
  const { isBetaEnabled } = useBeta();
  if (!isBetaEnabled) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
};
