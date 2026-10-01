import { expect, test } from 'bun:test'
import { publishRelease } from '../scripts/release.mjs'

const natives = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(name => ({ name, integrity: `hash-${name}` }))
const launcher = { name: 'crisp-tui', integrity: 'hash-launcher' }
function fixture(existing = []) {
  let time = 100_000
  const registry = new Map(existing.map(item => [item.name, item.integrity]))
  const writes = [], sleeps = []
  const options = {
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms }, log: () => {},
    timeoutMs: 1000, intervalMs: 100,
    fetch: async url => {
      const name = new URL(url).pathname.split('/')[1]
      return registry.has(name) ? Response.json({ dist: { integrity: registry.get(name) } }) : new Response('', { status: 404 })
    },
    publish: async item => {
      if (item === launcher) for (const native of natives) expect(registry.get(native.name)).toBe(native.integrity)
      writes.push(item.name); registry.set(item.name, item.integrity)
    },
  }
  return { registry, writes, sleeps, options, run: () => publishRelease(natives, launcher, '1.0.0', options) }
}

test('partial releases resume without republishing existing artifacts', async () => {
  const f = fixture(natives.slice(0, 2))
  await f.run()
  expect(f.writes).toEqual([...natives.slice(2), launcher].map(item => item.name))
  await f.run()
  expect(f.writes).toHaveLength(3)
})

test('a conflicting launcher or late platform prevents every publish', async () => {
  for (const item of [launcher, natives[3]]) {
    const f = fixture()
    f.registry.set(item.name, 'different')
    await expect(f.run()).rejects.toThrow('different contents')
    expect(f.writes).toEqual([])
  }
})

test('delayed registry visibility gates launcher publication', async () => {
  const f = fixture(), original = f.options.publish, waiting = []
  f.options.publish = async item => {
    if (item === launcher) return original(item)
    f.writes.push(item.name); waiting.push(item)
  }
  const sleep = f.options.sleep
  f.options.sleep = async ms => {
    await sleep(ms)
    if (f.sleeps.length === 3) for (const item of waiting) f.registry.set(item.name, item.integrity)
  }
  await f.run()
  expect(f.sleeps).toEqual([100, 100, 100])
  expect(f.writes.at(-1)).toBe(launcher.name)
})

test('registry transient failures retry reads and respect Retry-After', async () => {
  const f = fixture(), read = f.options.fetch
  let calls = 0
  f.options.fetch = async url => {
    if (++calls === 1) throw new Error('network unavailable')
    if (calls === 2) return new Response('', { status: 503 })
    if (calls === 3) return new Response('', { status: 429, headers: { 'Retry-After': '0.2' } })
    return read(url)
  }
  await f.run()
  expect(f.sleeps).toEqual([100, 100, 200])
  expect(f.writes).toHaveLength(5)
})

test('registry retry deadline is bounded and does not publish on failed preflight', async () => {
  const f = fixture()
  f.options.fetch = async () => new Response('', { status: 503, headers: { 'Retry-After': '300' } })
  await expect(f.run()).rejects.toThrow('timed out')
  expect(f.sleeps).toEqual([1000])
  expect(f.writes).toEqual([])
})

test('processing timeout leaves the launcher unpublished', async () => {
  const f = fixture()
  f.options.publish = async item => { f.writes.push(item.name) }
  await expect(f.run()).rejects.toThrow('timed out')
  expect(f.writes).toEqual(natives.map(item => item.name))
})

test('permanent registry failure is not retried', async () => {
  const f = fixture()
  f.options.fetch = async () => new Response('', { status: 403 })
  await expect(f.run()).rejects.toThrow('403')
  expect(f.sleeps).toEqual([])
  expect(f.writes).toEqual([])
})

test('ambiguous publish failures are not retried; rerun reconciles registry first', async () => {
  const f = fixture(), publish = f.options.publish
  f.options.publish = async item => {
    await publish(item)
    if (item === natives[1]) throw new Error('connection lost after publish')
  }
  await expect(f.run()).rejects.toThrow('connection lost')
  expect(f.writes).toHaveLength(2)
  f.options.publish = publish
  await f.run()
  expect(f.writes).toEqual([...natives, launcher].map(item => item.name))
})
