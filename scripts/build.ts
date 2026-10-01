import solidPlugin from "@opentui/solid/bun-plugin"
import { join } from "node:path"

export async function build() {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/index.ts")],
    target: "bun", plugins: [solidPlugin], minify: true,
    compile: {
      target: `bun-${process.platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}` as Bun.Build.CompileTarget,
      outfile: join(import.meta.dir, `../dist/crisp-tui-${process.platform}-${process.arch}`),
      autoloadBunfig: false, autoloadPackageJson: false, autoloadTsconfig: false,
    },
  })
  if (!result.success) throw new AggregateError(result.logs, "Build failed")
  console.log("Built standalone TUI in dist/ (live mode still requires crispctl)")
}
if (import.meta.main) await build()
