// Build időben beégetett verzióadatok (vite.config.ts → define)
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILD__: string;

export const APP_VERSION = __APP_VERSION__;
export const APP_COMMIT = __APP_COMMIT__;
/** pl. "2026-10-09 14:05" → "2026. 10. 09. 14:05" */
export const APP_BUILD = __APP_BUILD__.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1. $2. $3.');
export const VERSION_LABEL = `${APP_VERSION} · ${APP_BUILD}`;
