#!/usr/bin/env bun
export {}
// Only synthetic input supplied by the test is ever returned.
if (!process.env.TEST_OP_OUTPUT) process.exit(90)
if (process.env.TEST_ARGV_FILE) await Bun.write(process.env.TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
if (process.env.TEST_OP_WAIT_FILE) while (!await Bun.file(process.env.TEST_OP_WAIT_FILE).exists()) await Bun.sleep(10)
process.stdout.write(process.env.TEST_OP_OUTPUT)
process.stderr.write("synthetic-private-stderr")
if (process.env.TEST_OP_HANG === "1") setInterval(() => {}, 1000)
else process.exit(Number(process.env.TEST_OP_EXIT || 0))
