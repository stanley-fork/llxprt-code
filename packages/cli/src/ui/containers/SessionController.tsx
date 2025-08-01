import React, {
  createContext,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useReducer,
} from 'react';
import { HistoryItem, MessageType } from '../types.js';
import { useHistory } from '../hooks/useHistoryManager.js';
import { getProviderManager } from '../../providers/providerManagerInstance.js';
import {
  Config,
  isProQuotaExceededError,
  isGenericQuotaExceededError,
  UserTierId,
  getErrorMessage,
} from '@vybestack/llxprt-code-core';
import { loadHierarchicalLlxprtMemory } from '../../config/config.js';
import { loadSettings } from '../../config/settings.js';
import process from 'node:process';
import {
  SessionStateProvider,
  useSessionState,
} from '../contexts/SessionStateContext.js';
import { SessionState, SessionAction } from '../reducers/sessionReducer.js';
import { AppDispatchProvider } from '../contexts/AppDispatchContext.js';
import {
  appReducer,
  initialAppState,
  AppAction,
  AppState,
} from '../reducers/appReducer.js';

// Helper functions
function getDisplayModelName(config: Config): string {
  try {
    const providerManager = getProviderManager();
    if (providerManager.hasActiveProvider()) {
      const provider = providerManager.getActiveProvider();
      const model = provider.getCurrentModel?.() || 'unknown';
      return `${provider.name}:${model}`;
    }
  } catch (_e) {
    // Fall back to config model if provider manager fails
  }
  return config.getModel();
}

function getProviderPaymentMode(): boolean | undefined {
  try {
    const providerManager = getProviderManager();
    if (providerManager.hasActiveProvider()) {
      const provider = providerManager.getActiveProvider();
      return provider.isPaidMode?.();
    }
  } catch (_e) {
    // Return undefined if we can't determine payment mode
  }
  return undefined;
}

// Context type
export interface SessionContextType {
  // History management
  history: HistoryItem[];
  addItem: (itemData: Omit<HistoryItem, 'id'>, baseTimestamp: number) => number;
  updateItem: (
    id: number,
    updates:
      | Partial<Omit<HistoryItem, 'id'>>
      | ((prevItem: HistoryItem) => Partial<Omit<HistoryItem, 'id'>>),
  ) => void;
  clearItems: () => void;
  loadHistory: (newHistory: HistoryItem[]) => void;

  // Session state
  sessionState: SessionState;
  dispatch: React.Dispatch<SessionAction>;

  // App state and dispatch
  appState: AppState;
  appDispatch: React.Dispatch<AppAction>;

  // Helper functions
  checkPaymentModeChange: (forcePreviousProvider?: string) => void;
  performMemoryRefresh: () => Promise<void>;
}

// Create context
export const SessionContext = createContext<SessionContextType | undefined>(
  undefined,
);

// Provider component props
interface SessionControllerProps {
  children: React.ReactNode;
  config: Config;
  isAuthenticating?: boolean;
}

export const SessionController: React.FC<SessionControllerProps> = ({
  children,
  config,
  isAuthenticating = false,
}) => {
  // Initialize state with current values
  const getInitialProvider = () => {
    try {
      const providerManager = getProviderManager();
      return providerManager.getActiveProvider().name;
    } catch (_e) {
      return undefined;
    }
  };

  // Get initial state for the provider
  const initialState: SessionState = {
    currentModel: getDisplayModelName(config),
    isPaidMode: getProviderPaymentMode(),
    lastProvider: getInitialProvider(),
    modelSwitchedFromQuotaError: false,
    userTier: undefined,
    transientWarnings: [],
  };

  return (
    <SessionStateProvider initialState={initialState}>
      <SessionControllerInner {...{ children, config, isAuthenticating }} />
    </SessionStateProvider>
  );
};

// Inner component that uses the session state
const SessionControllerInner: React.FC<SessionControllerProps> = ({
  children,
  config,
}) => {
  const [sessionState, dispatch] = useSessionState();
  const [appState, appDispatch] = useReducer(appReducer, initialAppState);

  // Use the history hook
  const { history, addItem, updateItem, clearItems, loadHistory } =
    useHistory();

  // Transient warning timer ref
  const warningTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Check payment mode change function
  const checkPaymentModeChange = useCallback(
    (forcePreviousProvider?: string) => {
      const newPaymentMode = getProviderPaymentMode();
      let currentProviderName: string | undefined;

      try {
        const providerManager = getProviderManager();
        const provider = providerManager.getActiveProvider();
        currentProviderName = provider.name;
      } catch (_e) {
        // ignore
      }

      const previousProvider =
        forcePreviousProvider || sessionState.lastProvider;
      const providerChanged =
        currentProviderName && currentProviderName !== previousProvider;
      const paymentModeChanged =
        newPaymentMode !== sessionState.isPaidMode &&
        newPaymentMode !== undefined;

      if (
        (paymentModeChanged || providerChanged) &&
        (providerChanged || history.length > 0)
      ) {
        dispatch({ type: 'SET_PAID_MODE', payload: newPaymentMode });
        dispatch({ type: 'SET_LAST_PROVIDER', payload: currentProviderName });

        try {
          const providerManager = getProviderManager();
          const provider = providerManager.getActiveProvider();

          // Only show payment mode warnings for Gemini provider
          if (provider.name === 'gemini') {
            if (newPaymentMode === true) {
              dispatch({
                type: 'SET_TRANSIENT_WARNINGS',
                payload: [
                  `! PAID MODE: You are now using Gemini with API credentials - usage will be charged to your account`,
                ],
              });
            } else if (newPaymentMode === false) {
              dispatch({
                type: 'SET_TRANSIENT_WARNINGS',
                payload: [
                  `FREE MODE: You are now using Gemini with OAuth authentication - no charges will apply`,
                ],
              });
            }
          }

          // Clear warning timer if exists
          if (warningTimerRef.current) {
            clearTimeout(warningTimerRef.current);
          }

          // Clear the warning after 10 seconds
          warningTimerRef.current = setTimeout(() => {
            dispatch({ type: 'CLEAR_TRANSIENT_WARNINGS' });
            warningTimerRef.current = null;
          }, 10000);
        } catch (_e) {
          // ignore
        }
      }
    },
    [
      sessionState.isPaidMode,
      sessionState.lastProvider,
      history.length,
      dispatch,
    ],
  );

  // Memory refresh function
  const performMemoryRefresh = useCallback(async () => {
    addItem(
      {
        type: MessageType.INFO,
        text: 'Refreshing hierarchical memory (LLXPRT.md or other context files)...',
      },
      Date.now(),
    );

    try {
      // Note: loadHierarchicalLlxprtMemory now requires settings, but SessionController
      // doesn't have access to settings. This needs to be refactored.
      // For now, using the internal config loading that has settings.
      const { memoryContent, fileCount } = await loadHierarchicalLlxprtMemory(
        process.cwd(),
        config.getDebugMode(),
        config.getFileService(),
        loadSettings(process.cwd()).merged, // Get merged settings object
        config.getExtensionContextFilePaths(),
      );
      config.setUserMemory(memoryContent);
      config.setLlxprtMdFileCount(fileCount);

      addItem(
        {
          type: MessageType.INFO,
          text: `Memory refreshed successfully. ${memoryContent.length > 0 ? `Loaded ${memoryContent.length} characters from ${fileCount} file(s).` : 'No memory content found.'}`,
        },
        Date.now(),
      );

      if (config.getDebugMode()) {
        console.log(
          `Refreshed memory content in config: ${memoryContent.substring(0, 200)}...`,
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      addItem(
        {
          type: MessageType.ERROR,
          text: `Error refreshing memory: ${errorMessage}`,
        },
        Date.now(),
      );
      console.error('Error refreshing memory:', error);
    }
  }, [config, addItem]);

  // Watch for model changes
  useEffect(() => {
    const checkModelChange = () => {
      const displayModel = getDisplayModelName(config);
      if (displayModel !== sessionState.currentModel) {
        dispatch({ type: 'SET_CURRENT_MODEL', payload: displayModel });
      }

      const paymentMode = getProviderPaymentMode();
      if (paymentMode !== sessionState.isPaidMode) {
        dispatch({ type: 'SET_PAID_MODE', payload: paymentMode });

        if (
          paymentMode !== undefined &&
          sessionState.isPaidMode !== undefined &&
          history.length > 0
        ) {
          try {
            const providerManager = getProviderManager();
            const provider = providerManager.getActiveProvider();

            // Only show payment mode warnings for Gemini provider
            if (provider.name === 'gemini') {
              if (paymentMode === true) {
                dispatch({
                  type: 'SET_TRANSIENT_WARNINGS',
                  payload: [
                    `! PAID MODE: You are now using Gemini with API credentials - usage will be charged to your account`,
                  ],
                });
              } else if (paymentMode === false) {
                dispatch({
                  type: 'SET_TRANSIENT_WARNINGS',
                  payload: [
                    `FREE MODE: You are now using Gemini with OAuth authentication - no charges will apply`,
                  ],
                });
              }
            }

            // Clear warning timer if exists
            if (warningTimerRef.current) {
              clearTimeout(warningTimerRef.current);
            }

            // Clear the warning after 10 seconds
            warningTimerRef.current = setTimeout(() => {
              dispatch({ type: 'CLEAR_TRANSIENT_WARNINGS' });
              warningTimerRef.current = null;
            }, 10000);
          } catch (_e) {
            // ignore
          }
        }
      }
    };

    checkModelChange();
    const interval = setInterval(checkModelChange, 1000);

    return () => {
      clearInterval(interval);
      if (warningTimerRef.current) {
        clearTimeout(warningTimerRef.current);
      }
    };
  }, [
    config,
    sessionState.currentModel,
    sessionState.isPaidMode,
    history.length,
    dispatch,
  ]);

  // Set up Flash fallback handler
  useEffect(() => {
    const flashFallbackHandler = async (
      currentModel: string,
      fallbackModel: string,
      error?: unknown,
    ): Promise<boolean> => {
      let message: string;

      const isPaidTier =
        sessionState.userTier === UserTierId.LEGACY ||
        sessionState.userTier === UserTierId.STANDARD;

      if (error && isProQuotaExceededError(error)) {
        if (isPaidTier) {
          message = `⚡ You have reached your daily ${currentModel} quota limit.
⚡ To continue using ${currentModel}, you can use /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey
⚡ Or you can switch to a different model using the /model command`;
        } else {
          message = `⚡ You have reached your daily ${currentModel} quota limit.
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth or switch to a different model using /model`;
        }
      } else if (error && isGenericQuotaExceededError(error)) {
        if (isPaidTier) {
          message = `⚡ You have reached your daily quota limit.
⚡ To continue, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey
⚡ Or you can switch to a different model using the /model command`;
        } else {
          message = `⚡ You have reached your daily quota limit.
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth or switch to a different model using /model`;
        }
      } else {
        if (isPaidTier) {
          message = `⚡ You are experiencing capacity issues with ${currentModel}.
⚡ Possible reasons are consecutive capacity errors or reaching your daily ${currentModel} quota limit.
⚡ To continue, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey
⚡ Or you can switch to a different model using the /model command`;
        } else {
          message = `⚡ You are experiencing capacity issues with ${currentModel}.
⚡ Possible reasons are consecutive capacity errors or reaching your daily ${currentModel} quota limit.
⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist
⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key
⚡ You can switch authentication methods by typing /auth or switch to a different model using /model`;
        }
      }

      addItem(
        {
          type: MessageType.INFO,
          text: message,
        },
        Date.now(),
      );

      dispatch({ type: 'SET_MODEL_SWITCHED_FROM_QUOTA_ERROR', payload: true });
      config.setQuotaErrorOccurred(true);
      // Don't switch models - let the user decide
      return false;
    };

    config.setFlashFallbackHandler(flashFallbackHandler);
  }, [config, addItem, sessionState.userTier, dispatch]);

  // Handle ADD_ITEM actions
  useEffect(() => {
    if (appState.lastAddItemAction) {
      const { itemData, baseTimestamp } = appState.lastAddItemAction;
      addItem(itemData, baseTimestamp);
    }
  }, [appState.lastAddItemAction, addItem]);

  const contextValue = useMemo(
    () => ({
      history,
      addItem,
      updateItem,
      clearItems,
      loadHistory,
      sessionState,
      dispatch,
      appState,
      appDispatch,
      checkPaymentModeChange,
      performMemoryRefresh,
    }),
    [
      history,
      addItem,
      updateItem,
      clearItems,
      loadHistory,
      sessionState,
      dispatch,
      appState,
      appDispatch,
      checkPaymentModeChange,
      performMemoryRefresh,
    ],
  );

  return (
    <SessionContext.Provider value={contextValue}>
      <AppDispatchProvider value={appDispatch}>{children}</AppDispatchProvider>
    </SessionContext.Provider>
  );
};

// Re-export the outer SessionController as default
