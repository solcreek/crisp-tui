import { liveReadonlyMain } from "../src/live-readonly"

process.exitCode = await liveReadonlyMain(process.argv.slice(2))
