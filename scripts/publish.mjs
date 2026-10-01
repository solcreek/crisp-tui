import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { publishRelease } from './release.mjs'

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

function publish(item) {
  execFileSync('npm', ['publish', item.file, '--access', 'public', '--ignore-scripts', '--tag', tag,
    // A dry run must also work after this version has already shipped.
    ...(dryRun ? ['--dry-run', '--force'] : [])], { stdio: 'inherit' })
}
if (dryRun) for (const item of [...natives, launcher]) publish(item)
else await publishRelease(natives, launcher, pkg.version, { publish })
