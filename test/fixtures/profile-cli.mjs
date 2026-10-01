#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.TEST_CALLS, JSON.stringify({ args, pid: process.pid }) + '\n')
const flag = name => args[args.indexOf(name) + 1]
if (!args.includes('--read-only') || !args.includes('--json') || flag('--profile') !== 'synthetic' || flag('--website') !== '11111111-1111-1111-1111-111111111111') {
  console.error(JSON.stringify({ message: 'Expected synthetic profile, website and read-only flags' }))
  process.exit(91)
}
const conversation = { session_id: 'session_fixture', state: 'unresolved', meta: { nickname: 'Synthetic Contact' } }
if (args.includes('auth') && args.includes('show')) {
  console.log(JSON.stringify({ tier: process.env.TEST_AUTH === 'tier' ? 'plugin' : 'website',
    key: process.env.TEST_AUTH === 'missing' ? 'unset' : 'set', identifier: 'synthetic-id', website_id: flag('--website') }))
} else if (args.includes('listen')) {
  console.error(JSON.stringify({ status: 'authenticated' }))
  setInterval(() => {}, 1000)
} else if (args.includes('conversations') && (args.includes('list') || args.includes('get'))) {
  console.log(JSON.stringify(args.includes('get') ? conversation : [conversation]))
} else if (args.includes('messages') && args.includes('list')) {
  console.log(JSON.stringify([{ type: 'text', content: 'Synthetic profile message', timestamp: 1 }]))
} else {
  console.error(JSON.stringify({ message: 'Fixture refuses this command' }))
  process.exit(92)
}
