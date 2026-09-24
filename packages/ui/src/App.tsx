import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { shouldRetryQuery } from "./lib/api-client";
import { useNamespaceBoot } from "./hooks/use-namespaces";
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
 */
function AppShell() {
  useNamespaceBoot();
  return (
    <>
      <ApiAuthBanner />
      <Routes>
        <Route path="/" element={<Navigate to="/timeline" replace />} />
        <Route path="/tree" element={<TreePage />} />
        <Route path="/timeline" element={<TimelinePage />} />
      </Routes>
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
