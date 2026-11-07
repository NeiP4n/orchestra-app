// Bundled only into the node build (vite.node.config.ts aliases "bun:sqlite"
// here). memory/*, codegraph and the database layer import bun:sqlite
// statically, so the bundler needs a module to resolve. Loading is harmless;
// the node build has no Bun SQLite engine, so constructing a Database throws
// loudly instead of failing with a module-resolution error at startup.
export class Database {
  constructor() {
    throw new Error("bun:sqlite is unavailable in the node build; this database engine only runs under Bun")
  }
}
