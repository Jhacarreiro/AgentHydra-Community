// How long the CliMayte integration tests wait for the fake CLI, sized from the root suite under load.
//
// Each attempt is real processes: the runner's hand-off (on Windows a PowerShell that has WMI start the
// runner outside the test's process tree), the runner's start of the fake CLI (a bun), then the 1 s tick
// that reads its end; a stop adds a taskkill. Measured 2026-10-11 under `bun test --parallel=4` on a box at
// ~90% CPU from other work: hand-off 1.3-8.2 s (median 3.7 s, 30 samples), the fake's bun 0.3-4.4 s, its
// end read 0.1-1.1 s after it, a stop 3-5.3 s from the decision to the attempt ending. Waits sized on an
// idle box (10-25 s) ran out with the worker still running in 7 of 9 full runs that day.

/** One attempt from its launch to its end being read, a stop that ends it included. A wait for k attempts
 *  is k of these; a run on an idle box still ends the moment its worker does. */
export const ATTEMPT_MS = 20_000
