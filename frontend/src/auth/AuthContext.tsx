import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  isApiError,
  subscribeAuthSession,
} from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type {
  AuthSnapshot,
  FamilyDetail,
  LoginResponse,
  MembershipSummary,
  UserSummary,
} from '../api/types';

type AuthContextValue = {
  user: UserSummary | null;
  membership: MembershipSummary | null;
  family: FamilyDetail | null;
  isLoading: boolean;
  isInitializing: boolean;
  isAuthenticated: boolean;
  recoveryError: string | null;
  isRecovering: boolean;
  retrySession: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [bootstrapped, setBootstrapped] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [isRefreshingSession, setIsRefreshingSession] = useState(false);
  const bootstrapPromise = useRef<Promise<void> | null>(null);
  const authIdentity = useRef<string | null>(null);
  const sessionVersion = useRef(0);

  const meQuery = useQuery({
    queryKey: queryKeys.authMe,
    queryFn: () => api.me(),
    enabled: bootstrapped && hasSession,
    retry: false,
  });

  useEffect(() => {
    const authSnapshot = (payload: LoginResponse): AuthSnapshot => ({
      user: payload.user,
      membership: payload.membership,
      family: payload.family,
    });
    return subscribeAuthSession((payload) => {
      sessionVersion.current += 1;
      const nextIdentity = payload
        ? `${payload.user.id}:${payload.membership.family_id}`
        : null;
      const identityChanged = authIdentity.current !== null
        && authIdentity.current !== nextIdentity;
      authIdentity.current = nextIdentity;
      if (identityChanged) {
        void queryClient.cancelQueries();
        queryClient.clear();
      }
      setHasSession(Boolean(payload));
      setBootstrapError(false);
      if (payload) {
        queryClient.setQueryData(queryKeys.authMe, authSnapshot(payload));
        return;
      }
      void queryClient.cancelQueries();
      queryClient.clear();
    });
  }, [queryClient]);

  const restoreSession = useCallback(() => {
    if (bootstrapPromise.current) return bootstrapPromise.current;
    const requestedVersion = sessionVersion.current;
    setIsRefreshingSession(true);
    bootstrapPromise.current = api.refresh()
      .then(() => { setBootstrapError(false); })
      .catch((reason: unknown) => {
        if (sessionVersion.current === requestedVersion) {
          setBootstrapError(!(isApiError(reason) && reason.status === 401));
        }
      })
      .finally(() => {
        setBootstrapped(true);
        setIsRefreshingSession(false);
        bootstrapPromise.current = null;
      });
    return bootstrapPromise.current;
  }, []);

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  const loginMutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      api.login(username, password),
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await api.logout();
      await queryClient.cancelQueries();
      queryClient.clear();
    },
  });

  const value = useMemo<AuthContextValue>(
    () => {
      const isAuthenticated = Boolean(hasSession && meQuery.data);
      return {
        user: isAuthenticated ? meQuery.data?.user ?? null : null,
        membership: isAuthenticated ? meQuery.data?.membership ?? null : null,
        family: isAuthenticated ? meQuery.data?.family ?? null : null,
        isLoading:
          !bootstrapped ||
          (meQuery.isLoading && !meQuery.data) ||
          loginMutation.isPending ||
          logoutMutation.isPending,
        isInitializing: !bootstrapped,
        isAuthenticated,
        recoveryError: bootstrapError || (hasSession && meQuery.isError)
          ? '暂时无法验证登录状态，请检查网络后重试。'
          : null,
        isRecovering: isRefreshingSession || meQuery.isFetching,
        retrySession: async () => {
          if (bootstrapError || !hasSession) await restoreSession();
          else await meQuery.refetch();
        },
        login: async (username: string, password: string) => {
          await loginMutation.mutateAsync({ username, password });
        },
        logout: async () => {
          await logoutMutation.mutateAsync();
        },
      };
    },
    [bootstrapped, bootstrapError, hasSession, isRefreshingSession, loginMutation, logoutMutation, meQuery, restoreSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
