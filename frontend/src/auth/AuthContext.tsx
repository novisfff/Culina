import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getAccessToken, setAccessToken } from '../api/client';
import type { FamilyDetail, MembershipSummary, UserSummary } from '../api/types';

type AuthContextValue = {
  user: UserSummary | null;
  membership: MembershipSummary | null;
  family: FamilyDetail | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [bootstrapped, setBootstrapped] = useState(false);

  const meQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.me(),
    enabled: Boolean(getAccessToken()),
    retry: false,
  });

  useEffect(() => {
    if (meQuery.isError) {
      setAccessToken(null);
      queryClient.removeQueries();
    }
    setBootstrapped(true);
  }, [meQuery.isError, queryClient]);

  const loginMutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      api.login(username, password),
    onSuccess: (payload) => {
      setAccessToken(payload.access_token);
      queryClient.setQueryData(['auth', 'me'], payload);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await api.logout().catch(() => undefined);
      setAccessToken(null);
      await queryClient.cancelQueries();
      queryClient.clear();
    },
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user: meQuery.data?.user ?? null,
      membership: meQuery.data?.membership ?? null,
      family: meQuery.data?.family ?? null,
      isLoading: !bootstrapped || (meQuery.isLoading && !meQuery.data) || loginMutation.isPending || logoutMutation.isPending,
      isAuthenticated: Boolean(meQuery.data?.access_token ?? getAccessToken()),
      login: async (username: string, password: string) => {
        await loginMutation.mutateAsync({ username, password });
      },
      logout: async () => {
        await logoutMutation.mutateAsync();
      },
    }),
    [bootstrapped, loginMutation, logoutMutation, meQuery.data, meQuery.isLoading]
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
