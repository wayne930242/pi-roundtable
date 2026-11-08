// The console's API shapes, shared by the server (`src/`) and the page (`web/`). Times are ISO strings.
// This file only gathers them: each shape lives in the module of its area.

export type * from "./agent-admin-types.ts";
export * from "./api-common-types.ts";
export type * from "./block-answer-types.ts";
export type * from "./console-types.ts";
export type * from "./message-types.ts";
export { OWNER_ONLY_PANES, PANES, type PaneName } from "./panes.ts";
export type * from "./preset-types.ts";
export type * from "./prompt-types.ts";
export * from "./room-types.ts";
export type * from "./session-types.ts";
export type * from "./skill-admin-types.ts";
export type * from "./socket-types.ts";
export type * from "./workspace-types.ts";
