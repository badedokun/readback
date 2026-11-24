# ADR-0001: Use Claude Code hooks, not an MCP server

- Status: Accepted
- Date: 2026-11-24

## Context
Existing voice projects such as VoiceMode expose speech as an MCP tool. With that approach, Claude has to decide to call the tool. That spends tokens and turns, and speech becomes part of the conversation. Readback's job is a status layer that reacts to events like a turn ending or a permission being needed.

## Decision
Implement Readback as a Claude Code plugin made of hooks (SessionStart, Stop, Notification, PermissionRequest, UserPromptSubmit, SessionEnd), plus a local daemon. Readback ships no MCP server.

## Consequences
- Readback spends zero model tokens on deciding to speak, and speech timing follows real events.
- Readback depends on hook payload stability. This is mitigated by contract tests (see the test plan).
- Claude cannot choose to say something mid-turn. That is acceptable, because staying silent while tools run is a requirement.
