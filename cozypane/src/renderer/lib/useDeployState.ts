import { useState, useCallback, useEffect } from 'react';

export interface UseDeployStateReturn {
  deployAuth: DeployAuth;
  deployments: Deployment[];
  handleDeployLogin: () => Promise<void>;
  handleDeployLogout: () => Promise<void>;
  refreshDeployments: () => void;
}

export function useDeployState(): UseDeployStateReturn {
  const [deployAuth, setDeployAuth] = useState<DeployAuth>({ authenticated: false });
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  // Load deploy auth on mount + listen for auth events
  useEffect(() => {
    window.cozyPane.deploy.getAuth().then(setDeployAuth).catch(() => {});
    const cleanup1 = window.cozyPane.deploy.onAuthSuccess(() => {
      window.cozyPane.deploy.getAuth().then(setDeployAuth).catch(() => {});
    });
    const cleanup2 = window.cozyPane.deploy.onProtocolCallback(() => {
      window.cozyPane.deploy.getAuth().then(setDeployAuth).catch(() => {});
    });
    return () => { cleanup1(); cleanup2(); };
  }, []);

  const refreshDeployments = useCallback(() => {
    if (!deployAuth.authenticated) return;
    window.cozyPane.deploy.list()
      .then((list: any) => {
        setDeployments(Array.isArray(list) ? list : []);
      })
      .catch(() => setDeployments([]));
  }, [deployAuth.authenticated]);

  // Auto-refresh when auth changes
  useEffect(() => { refreshDeployments(); }, [refreshDeployments]);

  const handleDeployLogin = useCallback(async () => {
    await window.cozyPane.deploy.login();
  }, []);

  const handleDeployLogout = useCallback(async () => {
    await window.cozyPane.deploy.logout();
    setDeployAuth({ authenticated: false });
    setDeployments([]);
  }, []);

  return {
    deployAuth,
    deployments,
    handleDeployLogin,
    handleDeployLogout,
    refreshDeployments,
  };
}
