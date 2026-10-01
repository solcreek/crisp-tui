import solidPlugin from "@opentui/solid/bun-plugin"
import { join } from "node:path"

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "../src/index.ts")],
  outdir: join(import.meta.dir, "../dist"), naming: "cli.js",
  target: "bun", packages: "external", plugins: [solidPlugin],
})
if (!result.success) throw new AggregateError(result.logs, "npm package build failed")
console.log("Built dist/cli.js for the npm package")
