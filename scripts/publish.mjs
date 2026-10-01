import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [directory, ...flags] = process.argv.slice(2)
assert(directory && flags.every(flag => flag === '--dry-run'), 'Usage: node scripts/publish.mjs ARTIFACT_DIR [--dry-run]')
const dryRun = flags.includes('--dry-run')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const tag = pkg.version.includes('-') ? 'next' : 'latest'
const integrity = file => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
function artifact(platform, name) {
  const file = resolve(directory, `npm-${platform}`, `${name}-${pkg.version}.tgz`)
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(manifest.name, name)
  assert.equal(manifest.version, pkg.version)
  if (name === pkg.name) assert.deepEqual(manifest.optionalDependencies, pkg.optionalDependencies)
  else {
    const [os, cpu] = platform.split('-')
    assert.deepEqual(manifest.os, [os])
    assert.deepEqual(manifest.cpu, [cpu])
  }
  return { name, file, integrity: integrity(file) }
}
// Validate every artifact before publishing anything. All builds must agree on the launcher.
const natives = platforms.map(platform => artifact(platform, `${pkg.name}-${platform}`))
const launchers = platforms.map(platform => artifact(platform, pkg.name))
assert.equal(new Set(launchers.map(item => item.integrity)).size, 1, 'Launcher archives differ across platforms')
const launcher = launchers[0]

async function visible(item) {
  const response = await fetch(`https://registry.npmjs.org/${item.name}/${pkg.version}`, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return false
  assert(response.ok, `Registry lookup failed for ${item.name}: ${response.status}`)
  const published = await response.json()
  assert.equal(published.dist.integrity, item.integrity, `${item.name}@${pkg.version} already exists with different contents`)
  return true
}
async function publish(item) {
  if (!dryRun && await visible(item)) {
    console.log(`${item.name}@${pkg.version} already published with matching integrity`)
    return
  }
  execFileSync('npm', ['publish', item.file, '--access', 'public', '--ignore-scripts', '--tag', tag,
    // A dry run must also work after this version has already shipped.
    ...(dryRun ? ['--dry-run', '--force'] : [])], { stdio: 'inherit' })
}
async function waitForRegistry(items) {
  if (dryRun) return
  const pending = new Set(items)
  const deadline = Date.now() + 20 * 60_000
  while (pending.size && Date.now() < deadline) {
    for (const item of pending) if (await visible(item)) {
      console.log(`${item.name}@${pkg.version} available; integrity verified`)
      pending.delete(item)
    }
    if (pending.size) {
      console.log(`Waiting for npm to process: ${[...pending].map(item => item.name).join(', ')}`)
      await delay(15_000)
    }
  }
  assert.equal(pending.size, 0, 'npm processing timed out; check registry state before retrying')
}
for (const item of natives) await publish(item)
// npm may acknowledge a publish several minutes before the version can be downloaded.
await waitForRegistry(natives)
await publish(launcher)
await waitForRegistry([launcher])
