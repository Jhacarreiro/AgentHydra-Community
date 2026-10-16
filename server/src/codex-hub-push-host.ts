// The first module the standalone pusher (codex-hub-push-main.ts) loads, before anything that imports config.ts.
//
// config.ts refuses a HOST that is not loopback as it loads, so the daemon never serves its unauthenticated API on
// another interface. The pusher binds no port, but it imports config, so a HOST set for something else (a machine
// name, another server's 0.0.0.0) stopped it before it could print even --version. A file's imports run before its
// own statements, so this is a module of its own, imported first. The pusher puts HOST back once config has loaded,
// for the Codex it starts.
export const callerHost = process.env.HOST
delete process.env.HOST
