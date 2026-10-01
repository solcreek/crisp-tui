import { exitCode, main } from "./cli"

try { process.exitCode = await main(process.argv.slice(2)) }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unexpected error" }))
  process.exitCode = exitCode(error)
}
