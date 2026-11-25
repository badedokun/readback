# ADR-0002: TypeScript on Node with a single local daemon

- Status: Accepted
- Date: 2026-11-24

## Context
Hooks run as short processes. Speech playback, queueing and the listener need long-lived state. Claude Code already requires Node.

## Decision
Write everything in TypeScript for Node 20 or later. Hook shims are small entry points. One daemon per user holds all state and talks to the shims over a Unix socket.

## Amendment (2026-11-24, M1)
The code is plain ES modules (`.mjs`) with JSDoc types, checked by `tsc --checkJs` (`npm run typecheck`), not compiled TypeScript. Reason: a plugin installed from git must run as-is, and a build step would mean committing generated `dist/` files or asking users to build. The type checking ADR-0002 wanted is kept; only the build is gone. There are no runtime npm dependencies: the small TOML subset the config uses is read in-house (`src/daemon/config.mjs`).

## Consequences
- Users install no new runtime. Contributors work in one language.
- The shims must stay light, with no heavy imports, to meet the 50 ms budget.
- The daemon lifecycle (lock file, idle exit) has to be managed. See the detailed design, section 4.
