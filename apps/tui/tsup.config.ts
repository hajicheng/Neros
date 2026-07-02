import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/entrypoints/cli.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
