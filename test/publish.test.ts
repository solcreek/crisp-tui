import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import pkg from "../package.json"

const publisher = resolve(import.meta.dir, "../scripts/publish.mjs")
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
async function fixture(run: (context: { dir: string; log: string; invoke: (mode: string, dry?: boolean) => Promise<{ code: number; err: string; calls: string[][] }> }) => Promise<void>) {
  const dir = await mkdtemp("/tmp/crisp-publish-")
  const log = join(dir, "calls.jsonl")
  try {
    const stage = join(dir, "stage")
    await mkdir(join(stage, "package"), { recursive: true })
    const integrities: Record<string, string> = {}
    for (const platform of platforms) {
      const output = join(dir, `npm-${platform}`)
      await mkdir(output)
      const [os, cpu] = platform.split("-")
      for (const name of [pkg.name, `${pkg.name}-${platform}`]) {
        const file = join(output, `${name}-${pkg.version}.tgz`)
        await writeFile(join(stage, "package/package.json"), JSON.stringify({ name, version: pkg.version,
          ...(name === pkg.name ? { optionalDependencies: pkg.optionalDependencies } : { os: [os], cpu: [cpu] }) }))
        execFileSync("tar", ["-czf", file, "-C", stage, "package"])
        integrities[name] = `sha512-${createHash("sha512").update(await readFile(file)).digest("base64")}`
      }
    }
    // The launcher must be byte-for-byte identical across builds.
    for (const platform of platforms.slice(1)) await copyFile(join(dir, "npm-darwin-arm64", `${pkg.name}-${pkg.version}.tgz`), join(dir, `npm-${platform}`, `${pkg.name}-${pkg.version}.tgz`))
    integrities[pkg.name] = `sha512-${createHash("sha512").update(await readFile(join(dir, "npm-darwin-arm64", `${pkg.name}-${pkg.version}.tgz`))).digest("base64")}`
    await writeFile(log, "")
    const bin = join(dir, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "npm"), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PUBLISH_TEST_LOG, JSON.stringify(process.argv.slice(2))+'\\n')
`)
    await chmod(join(bin, "npm"), 0o755)
    const mock = join(dir, "registry.mjs")
    await writeFile(mock, `import { readFileSync } from 'node:fs';
const integrities = JSON.parse(process.env.PUBLISH_TEST_INTEGRITIES);
const visiblePlatforms = new Set();
globalThis.fetch = async url => {
  const name = new URL(url).pathname.split('/')[1];
  const mode = process.env.PUBLISH_TEST_MODE;
  if (mode === 'dry') throw new Error('dry run must not query registry');
  if (mode === 'new' && name === 'crisp-tui' && visiblePlatforms.size !== 4) throw new Error('launcher published before all platforms became visible');
  const calls = readFileSync(process.env.PUBLISH_TEST_LOG, 'utf8');
  if (mode === 'new' && !calls.includes(name + '-' + ${JSON.stringify(pkg.version)} + '.tgz')) return new Response('', {status:404});
  if (name !== 'crisp-tui') visiblePlatforms.add(name);
  return Response.json({dist:{integrity: mode === 'mismatch' ? 'wrong' : integrities[name]}});
};`)
    await run({ dir, log, async invoke(mode, dry = false) {
      const child = Bun.spawn([Bun.which("node")!, "--import", mock, publisher, dir, ...(dry ? ["--dry-run"] : [])], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLISH_TEST_LOG: log,
          PUBLISH_TEST_MODE: mode, PUBLISH_TEST_INTEGRITIES: JSON.stringify(integrities) }, stdout: "pipe", stderr: "pipe",
      })
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
      const lines = (await readFile(log, "utf8")).trim()
      return { code, err, calls: lines ? lines.split("\n").map(line => JSON.parse(line)) : [] }
    } })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test("release preflight rejects missing platform artifacts before any publish", () => fixture(async ({ dir, invoke }) => {
  await rm(join(dir, "npm-linux-x64"), { recursive: true })
  const result = await invoke("dry", true)
  expect(result.code).not.toBe(0)
  expect(result.calls).toEqual([])
}))

test("release dry run validates all five packages without registry mutations", () => fixture(async ({ invoke }) => {
  const result = await invoke("dry", true)
  expect(result.code).toBe(0)
  expect(result.calls).toHaveLength(5)
  for (const args of result.calls) expect(args).toEqual(expect.arrayContaining(["publish", "--dry-run", "--force", "--ignore-scripts"]))
  expect(result.calls.at(-1)![1]).toEndWith(`/crisp-tui-${pkg.version}.tgz`)
}))

test("release reruns skip only versions with identical registry integrity", () => fixture(async ({ invoke }) => {
  const result = await invoke("existing")
  expect(result.code).toBe(0)
  expect(result.calls).toEqual([])
  const mismatch = await invoke("mismatch")
  expect(mismatch.code).not.toBe(0)
  expect(mismatch.err).toContain("already exists with different contents")
  expect(mismatch.calls).toEqual([])
}))

test("release publishes four platforms before the launcher and verifies registry visibility", () => fixture(async ({ invoke }) => {
  const result = await invoke("new")
  expect(result.code).toBe(0)
  expect(result.calls).toHaveLength(5)
  expect(result.calls.map(args => args[1]!.split("/").at(-1))).toEqual([
    ...platforms.map(platform => `crisp-tui-${platform}-${pkg.version}.tgz`), `crisp-tui-${pkg.version}.tgz`,
  ])
  for (const args of result.calls) { expect(args).not.toContain("--dry-run"); expect(args).not.toContain("--force") }
}))
