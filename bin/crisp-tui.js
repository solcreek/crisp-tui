#!/usr/bin/env bun
// Register Solid's client runtime before loading the precompiled application.
import "@opentui/solid/preload"
await import("../dist/cli.js")
