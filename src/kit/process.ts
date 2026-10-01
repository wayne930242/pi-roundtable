// Plugin helpers, versioned like the main entry; see the plugin guide.
// Running a worker process of your own: where an installed package lives, and a unix-socket HTTP server.

export { packageDir } from "../core/shared/package-dir.ts";
export { serveUnix } from "../core/shared/unix-server.ts";
