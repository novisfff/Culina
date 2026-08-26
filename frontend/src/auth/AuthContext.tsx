import {
  createContext,
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
  clearAuthenticatedSession,
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
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [bootstrapped, setBootstrapped] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const bootstrapPromise = useRef<Promise<void> | null>(null);
  const authIdentity = useRef<string | null>(null);

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
      if (payload) {
        queryClient.setQueryData(queryKeys.authMe, authSnapshot(payload));
        return;
      }
      void queryClient.cancelQueries();
      queryClient.clear();
    });
  }, [queryClient]);

  useEffect(() => {
    if (!bootstrapPromise.current) {
      bootstrapPromise.current = api.refresh()
        .then(() => undefined)
        .catch(() => undefined);
    }
    let active = true;
    void bootstrapPromise.current.finally(() => {
      if (active) setBootstrapped(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (meQuery.isError) {
      clearAuthenticatedSession();
    }
  }, [meQuery.isError]);

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
        login: async (username: string, password: string) => {
          await loginMutation.mutateAsync({ username, password });
        },
        logout: async () => {
          await logoutMutation.mutateAsync();
        },
      };
    },
    [bootstrapped, hasSession, loginMutation, logoutMutation, meQuery.data, meQuery.isLoading]
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
