/**
 * Render helpers for UI tests.
 *
 * Real app providers (react-query + router), test-friendly defaults:
 * retries off, no cache carried between tests.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactElement, ReactNode } from "react";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /** Initial route for the MemoryRouter (useUrlState reads search params) */
  route?: string;
  queryClient?: QueryClient;
  withRouter?: boolean;
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const {
    route = "/",
    queryClient = createTestQueryClient(),
    withRouter = true,
    ...renderOptions
  } = options;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {withRouter ? (
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      ) : (
        children
      )}
    </QueryClientProvider>
  );

  return { ...render(ui, { wrapper, ...renderOptions }), queryClient };
}
