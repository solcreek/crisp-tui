# Startup performance — 2026-10-01

Selected-conversation refresh now starts inbox, details and message reads
concurrently. First RTM authentication schedules catch-up on the next event-loop
turn instead of waiting for the 200 ms event debounce. Cold startup still reads
the inbox first to determine which conversation to open.

## Live comparison

Seven paired runs with alternating before/after order on one Linux x64 machine,
Node 26.8.1, Bun-built native executables, 160 × 50 PTY cells, the same sidebar
configuration and **crispctl 0.5.0 on both sides**. Before: `49827c1`; after:
`c675839`. These commits identify TUI source; the baseline executable's crispctl
path was explicitly overridden to the same installed 0.5.0 dependency.

Credentials came from an existing read-only process's environment. Both builds
used `--read-only`, `CRISPCTL_READ_ONLY=1`, `--poll 0` and performance diagnostics.
Each sample required a loaded initial snapshot, authenticated RTM, completed
catch-up and no reported error. PTY output was drained and discarded. Reports
retained only fixed metric names, timings and aggregate counts. No screenshots,
credentials, conversation identifiers or customer content are included here.

| Milestone or stage | Before median | After median | Before min–max | After min–max |
| --- | ---: | ---: | ---: | ---: |
| First UI frame | 144.38 ms | 144.08 ms | 141.61–147.01 | 142.75–145.74 |
| First loaded message frame | 873.06 ms | 878.72 ms | 826.51–1488.83 | 817.11–1228.79 |
| Complete initial snapshot | 880.24 ms | 879.87 ms | 869.97–1533.86 | 866.35–1228.79 |
| RTM-synchronized frame | 2129.61 ms | 1643.07 ms | 2011.49–2563.54 | 1555.18–2064.36 |
| RTM authentication duration | 1063.45 ms | 1036.12 ms | 947.20–1339.93 | 984.46–1292.62 |
| RTM catch-up duration | 727.92 ms | 436.73 ms | 719.05–962.04 | 430.48–633.65 |

Synchronized startup improved by approximately **23%** at the median, and all
seven paired comparisons improved. First content and the initial snapshot were
essentially unchanged. The catch-up stage improved by approximately **40%**.
All samples made six data GETs (two each for inbox, details and messages), plus
RTM discovery. This change reduces the critical path, not request counts.

Three separate instrumented after-runs placed reconciliation start
1.67–2.39 ms after authentication (median 1.87 ms). Previous instrumentation
observed a 200.80–200.90 ms scheduling wait. The new traces also confirmed the
three catch-up requests started within 0.8 ms of one another. Those traces add
instrumentation overhead and are not mixed into the paired comparison above.

The median of each run's median JS frame time was 0.735 → 0.755 ms. The same
summary for state-to-frame latency was 1.774 → 3.248 ms; this small increase
should remain monitored as parallel responses can arrive together. It does not
negate the earlier complete snapshot. Frame completion means application output,
not physical display presentation. These small samples are not a tail-latency SLA;
network variance remains substantial. Concurrent stage durations must not be added.

## Credential wait

The environment-credential comparison excludes 1Password. A separate earlier
local `op` measurement took 4976 ms, including authorization/unlock overhead.
Interactive `live` now shows a waiting line with elapsed seconds before the
renderer starts and clears it on success or failure. This improves feedback; it
does not make credential retrieval faster. Check mode keeps its JSON output.

## Transport reuse experiment

A separate read-only prototype reused one Node process and crispctl's internal
`run()` implementation, preserving command parsing and read-only flags. Three
parallel reads against a known selection were compared in seven alternating
pairs using crispctl 0.5.0 on the same machine:

| Transport | Median refresh | Min–max |
| --- | ---: | ---: |
| Fresh CLI process per read | 445.41 ms | 428.47–628.70 ms |
| Warm persistent process | 266.05 ms | 263.25–303.23 ms |

The prototype took 90.44 ms to start, then 369.34 ms for its first refresh;
neither cost is included in the warm row. TLS instrumentation counted three
connections on that first refresh and zero new connections on each measured
warm refresh. The observed benefit combines process/module reuse and connection
reuse; this experiment does not isolate their individual contributions and does
not predict cold TUI startup gains.

The production TUI continues to use the public CLI. Internal imports do not offer
a supported compatibility contract, and a production worker also needs request
isolation, cancellation, bounded buffering, shutdown and write-retry guarantees.
Those requirements and the reproduction outline are tracked in
[crisp-cli #17](https://github.com/solcreek/crisp-cli/issues/17).

## Regression checks

Deterministic tests verify that messages can publish while an inbox is pending,
both refresh branches drain on failure, independent errors survive partial
recovery, and old responses cannot replace a newer search, selection or write.
RTM tests cover immediate first authentication, event epochs, reconnect spacing,
burst coalescing and shutdown before/during reconciliation. Real PTY tests cover
credential progress, successful read-only startup and authorization failure.

The offline `bun run benchmark --runs 5 --check` remains the reproducible
performance gate for source/native startup and synthetic rendering. Live numbers
above are observations, not CI thresholds. Keep the executable, dependency,
runtime, terminal dimensions and data workload fixed when repeating a comparison;
alternate order and record failures instead of excluding slow samples.
