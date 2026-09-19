/**
 * UI Store
 *
 * Zustand store for global UI state.
 * Manages inspector visibility, sidebar state, and selected memory.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_FILTERS, type MemoryFilters } from "../lib/filters";

interface UIState {
  // Selected memory
  selectedMemory: string | null;
  setSelectedMemory: (id: string | null) => void;

  // Inspector panel
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
  toggleInspector: () => void;

  // Sidebar
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;

  // Current namespace
  currentNamespace: string;
  setCurrentNamespace: (namespace: string) => void;

  // View state
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Memory list filters (shared: the header controls write here, the
  // memory table reads here and composes them into memoriesApi.list)
  filters: MemoryFilters;
  updateFilters: (patch: Partial<MemoryFilters>) => void;
  clearFilters: () => void;

  // Real-time updates
  realtimeEnabled: boolean;
  setRealtimeEnabled: (enabled: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // Selected memory
      selectedMemory: null,
      setSelectedMemory: (id) => set({ selectedMemory: id }),

      // Inspector panel
      inspectorOpen: false,
      setInspectorOpen: (open) => set({ inspectorOpen: open }),
      toggleInspector: () =>
        set((state) => ({ inspectorOpen: !state.inspectorOpen })),

      // Sidebar
      sidebarCollapsed: false,
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      // Current namespace
      currentNamespace: "default",
      setCurrentNamespace: (namespace) => set({ currentNamespace: namespace }),

      // Search
      searchQuery: "",
      setSearchQuery: (query) => set({ searchQuery: query }),

      // Memory list filters
      filters: { ...DEFAULT_FILTERS },
      updateFilters: (patch) =>
        set((state) => ({ filters: { ...state.filters, ...patch } })),
      clearFilters: () => set({ filters: { ...DEFAULT_FILTERS } }),

      // Real-time updates
      realtimeEnabled: true,
      setRealtimeEnabled: (enabled) => set({ realtimeEnabled: enabled }),
    }),
    {
      name: "duckbrain-ui-storage",
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        currentNamespace: state.currentNamespace,
        realtimeEnabled: state.realtimeEnabled,
      }),
    },
  ),
);
