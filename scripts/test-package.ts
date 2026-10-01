import { copyFile, mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { strict as assert } from "node:assert"
import pkg from "../package.json"
import { packageRegistry } from "./package-registry"

const root = resolve(import.meta.dir, "..")
const scratch = await mkdtemp(join(tmpdir(), "crisp-tui-package-"))
const npm = Bun.which("npm")!, node = await realpath(Bun.which("node")!)
const platform = `${process.platform}-${process.arch}`
async function run(argv: string[], cwd = root, extra: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...extra }, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw new Error(`${argv[0]} failed (${code})\n${out}\n${err}`)
  return out
}
async function pack(workspace?: string) {
  const [artifact] = JSON.parse(await run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", scratch,
    ...(workspace ? ["--workspace", workspace] : ["--workspaces=false"])])) as { filename: string; files: { path: string }[] }[]
  assert(artifact, "npm pack must produce an artifact")
  assert.deepEqual(artifact.files.map(file => file.path).sort(), workspace
    ? ["LICENSE", "README.md", "bin/crisp-tui", "package.json"]
    : ["LICENSE", "README.md", "bin/crisp-tui.js", "package.json"])
  return join(scratch, artifact.filename)
}
try {
  await run([process.execPath, "run", "build:package"])
  const launcher = await pack(), native = await pack(`packages/${platform}`)
  // Only Node and sh are discoverable. No globally installed Bun can hide a packaging defect.
  const runtimePath = join(scratch, "path")
  await mkdir(runtimePath)
  await symlink(node, join(runtimePath, "node"))
  await symlink("/bin/sh", join(runtimePath, "sh"))
  assert.equal(Bun.which("bun", { PATH: runtimePath }), null)
  const isolated = { PATH: runtimePath, npm_config_cache: join(scratch, "cache"),
    npm_config_userconfig: join(scratch, "npmrc"), npm_config_engine_strict: "true",
    CRISPCTL_BIN: "", CRISPCTL_READ_ONLY: "0" }
  const install = join(scratch, "installed")
  await run([npm, "install", "--prefix", install, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", launcher, native], scratch, isolated)
  const executable = join(install, "node_modules/.bin/crisp-tui")
  assert.match(await run([executable, "--help"], scratch, isolated), /Crisp inbox/)
  const version = JSON.parse(await run([executable, "cli", "--version", "--json"], scratch, isolated))
  assert.equal(version.version, pkg.dependencies.crispctl)
  await assert.rejects(run([executable, "--unknown-option"], scratch, isolated), /failed \(2\)/)
  const testEnv = { ...isolated, CRISP_TUI_TEST_INSTALLED: executable, CRISP_TUI_TEST_INSTALLED_ONLY: "1" }
  await run([process.execPath, "test", "test/e2e.test.ts"], root, testEnv)
  console.log("Installed TUI and ctl verified without Bun on PATH")
  // npm sees all four platform manifests and must select exactly one by itself.
  const registry = await packageRegistry(launcher, native, platform)
  try {
    const npxEnv = { ...testEnv, npm_config_registry: registry.url, npm_config_cache: join(scratch, "npx-cache"),
      npm_config_audit: "false", npm_config_fund: "false" }
    const npx = [npm, "exec", "--yes", `--package=crisp-tui@${pkg.version}`, "--", "crisp-tui"]
    assert.match(await run([...npx, "--help"], scratch, npxEnv), /Crisp inbox/)
    assert.equal(JSON.parse(await run([...npx, "cli", "--version", "--json"], scratch, npxEnv)).version, pkg.dependencies.crispctl)
    await run([process.execPath, "test", "test/e2e.test.ts"], root, { ...npxEnv, CRISP_TUI_TEST_ARGV: JSON.stringify(npx) })
    assert.deepEqual([...registry.downloaded].sort(), ["crisp-tui", `crisp-tui-${platform}`])
  } finally { registry.stop() }
  console.log("npx TUI and ctl verified without Bun on PATH")
  const nativePath = join(install, "node_modules", `crisp-tui-${platform}`, "bin/crisp-tui")
  await rename(nativePath, `${nativePath}.missing`)
  try { await assert.rejects(run([executable, "--help"], scratch, isolated), /optional dependencies enabled/) }
  finally { await rename(`${nativePath}.missing`, nativePath) }
  const output = join(root, "dist/npm")
  await mkdir(output, { recursive: true })
  for (const artifact of [launcher, native]) await copyFile(artifact, join(output, artifact.slice(artifact.lastIndexOf("/") + 1)))
  console.log(`Verified npm artifacts: crisp-tui ${pkg.version}, ${platform}, crispctl ${version.version}`)
} finally { await rm(scratch, { recursive: true, force: true }) }
