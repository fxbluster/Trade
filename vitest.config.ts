import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "node-sqlite-support",
      resolveId(id) {
        if (id === "node:sqlite" || id === "sqlite") {
          return "\0virtual:node-sqlite";
        }
      },
      load(id) {
        if (id === "\0virtual:node-sqlite") {
          return `
            import { createRequire } from "node:module";
            const req = createRequire(import.meta.url);
            const _sqlite = req("node:sqlite");
            export const DatabaseSync = _sqlite.DatabaseSync;
            export const StatementSync = _sqlite.StatementSync;
            export const Session = _sqlite.Session;
            export const constants = _sqlite.constants;
            export default _sqlite;
          `;
        }
      }
    }
  ],
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    include: [
      "packages/**/__tests__/**/*.test.ts",
      "apps/**/__tests__/**/*.test.ts",
      "apps/**/__tests__/**/*.test.tsx"
    ]
  }
});
