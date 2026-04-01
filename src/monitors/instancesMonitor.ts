/**
 * instancesMonitor.ts
 *
 * This file previously contained:
 *   - generateHTML(): generated a basic HTML page listing running app instances
 *   - enableIndexServer(): served that HTML page on port 80
 *
 * Both have been removed. The HTTP server (port 80) is now handled by
 * httpMonitor.ts, which serves the Console production web app and exposes
 * the /api/store-url endpoint.
 *
 * See: src/monitors/httpMonitor.ts
 */
