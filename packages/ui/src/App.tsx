import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { shouldRetryQuery } from "./lib/api-client";
import { useNamespaceBootStatus } from "./hooks/use-namespaces";
import { ApiAuthBanner } from "./components/ui/api-token-banner";
import TreePage from "./routes/Tree";
import TimelinePage from "./routes/Timeline";
import { OfflineBanner } from "./components/ui/offline-banner";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000, // 30 seconds
      refetchOnWindowFocus: false,
      // Auth errors (401) must never be retried — repeating them cannot
      // succeed and trips the rate limiter. Everything else retries once.
      retry: shouldRetryQuery,
    },
  },
});

/**
 * App Shell
 *
 * Mounts the boot-time namespace adoption (server-reported currentNamespace
 * wins over the hardcoded default / persisted value) and the auth banner.
 *
 * The route pages are GATED on the boot status: while the boot namespaces
 * fetch is in flight, the pages do not mount — otherwise they would fire
 * their reads against the store's pre-adoption namespace (the hardcoded
 * "default" or a persisted stale value) before the server value arrives.
 * "ready" is reported by the same effect that writes the adoption, so the
 * first gated render already sees the adopted store value. On a boot 401 the
 * routes stay mounted so the banner + token entry are the visible surface
 * (saving a token refetches the boot); any other failure falls back to
 * rendering the routes in degraded mode against the store value.
 */
export function AppShell() {
  const bootStatus = useNamespaceBootStatus();
  return (
    <>
      <ApiAuthBanner />
      {bootStatus === "loading" ? (
        <div className="min-h-screen flex items-center justify-center">
          <p style={{ color: "var(--color-clinical)" }}>Loading...</p>
        </div>
      ) : (
        <Routes>
          <Route path="/" element={<Navigate to="/timeline" replace />} />
          <Route path="/tree" element={<TreePage />} />
          <Route path="/timeline" element={<TimelinePage />} />
        </Routes>
      )}
    </>
  );
}

/**
 * App Component
 *
 * Root component with Router and QueryClientProvider.
 * Routes:
 * - / → redirects to /timeline
 * - /tree → Tree view
 * - /timeline → Timeline view
 */
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <OfflineBanner />
        <AppShell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
