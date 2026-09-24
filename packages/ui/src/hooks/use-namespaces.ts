/**
 * Namespaces Hooks
 *
 * TanStack Query hooks for namespace operations.
 */

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { namespacesApi, ApiAuthError } from "../lib/api-client";
import { useUIStore } from "../stores/ui-store";

// Query keys
const namespaceKeys = {
  all: ["namespaces"] as const,
  list: () => [...namespaceKeys.all, "list"] as const,
  current: () => [...namespaceKeys.all, "current"] as const,
};

/**
 * Hook to fetch all namespaces
 */
export function useNamespaces() {
  return useQuery({
    queryKey: namespaceKeys.list(),
    queryFn: () => namespacesApi.list(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Boot-time namespace adoption.
 *
 * The UI used to hardcode currentNamespace: "default", which does not exist
 * on normal installs — every panel then 404s and stays on its loading
 * skeleton. On boot this fetches GET /api/namespaces once and adopts the
 * server-reported `currentNamespace` into the store. The hardcoded "default"
 * initial value survives ONLY as the fallback when the fetch fails, and a
 * namespace persisted to localStorage never masks the server value on boot:
 * the server wins.
 *
 * A 401 (hardened --auth=apikey deployment without a token) is recorded in
 * the store so the UI can show the token entry point. The namespaces LIST is
 * allowed unauthenticated by the server, so this hook also works there.
 */
export function useNamespaceBoot(): void {
  const setCurrentNamespace = useUIStore((state) => state.setCurrentNamespace);
  const setNamespaceBootError = useUIStore(
    (state) => state.setNamespaceBootError,
  );
  const { data, error } = useQuery({
    queryKey: namespaceKeys.current(),
    queryFn: () => namespacesApi.list(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    if (data) {
      setNamespaceBootError(false);
      setCurrentNamespace(data.currentNamespace);
    }
  }, [data, setCurrentNamespace, setNamespaceBootError]);

  useEffect(() => {
    setNamespaceBootError(error instanceof ApiAuthError);
  }, [error, setNamespaceBootError]);
}

/**
 * Hook to get current namespace from Zustand store
 */
export function useCurrentNamespace() {
  return useUIStore((state) => state.currentNamespace);
}

/**
 * Hook to switch namespace
 */
export function useSwitchNamespace() {
  const queryClient = useQueryClient();
  const setCurrentNamespace = useUIStore((state) => state.setCurrentNamespace);

  return useMutation({
    mutationFn: (name: string) => namespacesApi.switch(name),
    onSuccess: (result) => {
      // Update Zustand store
      setCurrentNamespace(result.namespace);
      // Invalidate all queries since namespace changed
      queryClient.invalidateQueries();
    },
  });
}

/**
 * Hook to create a new namespace
 */
export function useCreateNamespace() {
  const queryClient = useQueryClient();
  const setCurrentNamespace = useUIStore((state) => state.setCurrentNamespace);

  return useMutation({
    mutationFn: ({
      name,
      setDefault,
    }: {
      name: string;
      setDefault?: boolean;
    }) => namespacesApi.create(name, setDefault),
    onSuccess: (result, variables) => {
      // Invalidate namespaces list
      queryClient.invalidateQueries({ queryKey: namespaceKeys.list() });
      // If set as default, update current namespace
      if (variables.setDefault) {
        setCurrentNamespace(result.name);
      }
    },
  });
}
