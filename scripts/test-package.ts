import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { strict as assert } from "node:assert"
import pkg from "../package.json"

const root = resolve(import.meta.dir, "..")
const scratch = await mkdtemp(join(tmpdir(), "crisp-tui-package-"))
async function run(argv: string[], cwd = root, extra: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...extra }, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw new Error(`${argv[0]} failed (${code})\n${out}\n${err}`)
  return out
}
try {
  await run([process.execPath, "run", "prepack"])
  const [artifact] = JSON.parse(await run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", scratch])) as {
    filename: string; files: { path: string }[]
  }[]
  assert(artifact, "npm pack must produce an artifact")
  assert.deepEqual(artifact.files.map(file => file.path).sort(), ["LICENSE", "README.md", "bin/crisp-tui.js", "dist/cli.js", "package.json"])
  // Install outside the checkout so repository dependencies/preloads cannot mask packaging errors.
  const install = join(scratch, "installed")
  await run(["npm", "install", "--prefix", install, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(scratch, artifact.filename)], scratch)
  const executable = join(install, "node_modules/.bin/crisp-tui")
  assert.match(await run([executable, "--help"], scratch), /Crisp inbox/)
  const version = JSON.parse(await run([executable, "cli", "--version", "--json"], scratch))
  assert.equal(version.version, pkg.dependencies.crispctl)
  console.log(await run([process.execPath, "test", "test/e2e.test.ts"], root, {
    CRISP_TUI_TEST_INSTALLED: executable,
    CRISP_TUI_TEST_INSTALLED_ONLY: "1",
    CRISPCTL_READ_ONLY: "0",
    CRISPCTL_BIN: "",
  }))
  console.log(`Installed npm artifact verified: ${artifact.filename} (crispctl ${version.version})`)
} finally { await rm(scratch, { recursive: true, force: true }) }
