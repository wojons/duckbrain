/**
 * HTTP Routes Barrel File
 *
 * Central export point for all API route modules.
 */
// @ts-nocheck


// Route modules will be exported here once created
export { createMemoryRoutes } from "./memories";
export { createKeyRoutes } from "./keys";
export { createNamespaceRoutes } from "./namespaces";
export { createEventsRoutes } from "./events";
export { createCompactionRoutes } from "./compaction";
export { createTableRoutes, createNamespaceOpenApiRoutes } from "./tables";
export { createRealtimeRoutes, REALTIME_ROUTE_PATH } from "./realtime";
