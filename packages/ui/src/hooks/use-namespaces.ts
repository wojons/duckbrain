/**
 * Namespaces Hooks
 *
 * TanStack Query hooks for namespace operations.
 */

import { useEffect, useState } from "react";
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
 * Boot-time namespace adoption and its render gate.
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
/**
 * Boot status derived from the boot-time namespace adoption.
 *
 * - "loading"     — the boot namespaces fetch is still in flight; pages must
 *                   not mount (they would read the pre-adoption namespace).
 * - "ready"       — the server-reported namespace has been adopted into the
 *                   store; pages may mount.
 * - "auth-error"  — the boot fetch failed with 401; pages stay mounted so the
 *                   auth banner + token entry are the visible surface and
 *                   saving a token can refetch the boot.
 * - "error"       — the boot fetch failed some other way; pages mount in
 *                   degraded mode against the store's namespace (offline
 *                   behavior).
 *
 * ORDERING CONTRACT (this is the whole point of the hook): "ready" is not
 * derived from query success — it is set in the SAME effect that writes
 * currentNamespace into the store. React runs child effects before parent
 * effects within a commit, so any gate keyed on query success alone would
 * mount the route pages in the same commit's child-effect phase and they
 * would still fetch the un-adopted namespace. Keying on the adoption effect
 * closes that window: when the gate first reports "ready", the store already
 * holds the server value.
 */
export type NamespaceBootStatus = "loading" | "ready" | "auth-error" | "error";

export function useNamespaceBootStatus(): NamespaceBootStatus {
  const setCurrentNamespace = useUIStore((state) => state.setCurrentNamespace);
  const setNamespaceBootError = useUIStore(
    (state) => state.setNamespaceBootError,
  );
  const [status, setStatus] = useState<NamespaceBootStatus>("loading");
  const { data, error, isPending } = useQuery({
    queryKey: namespaceKeys.current(),
    queryFn: () => namespacesApi.list(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    if (data) {
      // Adoption FIRST, then the flip: on the commit that reports "ready"
      // the store already holds the server value.
      setNamespaceBootError(false);
      setCurrentNamespace(data.currentNamespace);
      setStatus("ready");
    }
  }, [data, setCurrentNamespace, setNamespaceBootError]);

  useEffect(() => {
    if (error) {
      const authError = error instanceof ApiAuthError;
      setNamespaceBootError(authError);
      setStatus(authError ? "auth-error" : "error");
    }
  }, [error, setNamespaceBootError]);

  // A boot that was in flight is "loading" even after a refetch trigger;
  // while isPending there is nothing adopted yet, so keep the gate closed.
  if (isPending && status === "loading") return "loading";
  return status;
}

/**
 * Mount the boot-time namespace adoption without the gate.
 *
 * Kept for the banner tests' wiring and any caller that only needs the
 * side effects (adoption + auth flag) and not the gating status. This is a
 * thin wrapper: the same adoption effect runs inside useNamespaceBootStatus.
 */
export function useNamespaceBoot(): void {
  useNamespaceBootStatus();
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
