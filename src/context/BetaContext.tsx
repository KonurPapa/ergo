import React, { createContext, useContext, useState, useEffect } from 'react';
import { getPref, setPref, subscribePrefs } from '../lib/userPrefs';

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
  const [isBetaEnabled, setIsBetaEnabledState] = useState<boolean>(() => getPref(BETA_STORAGE_KEY) === 'true');

  const setIsBetaEnabled = (enabled: boolean) => {
    setIsBetaEnabledState(enabled);
    setPref(BETA_STORAGE_KEY, enabled ? 'true' : 'false');
  };

  // Saved with the user's preferences on their machine; follows the loaded value.
  useEffect(() => subscribePrefs(() => setIsBetaEnabledState(getPref(BETA_STORAGE_KEY) === 'true')), []);

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
