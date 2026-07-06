# CLAUDE.md — ftf-services (auto-loaded every session)

This repo holds two separate deploy targets that ship independently:
- The website (GitHub Pages) — root-level HTML files (index.html, Book.HTML, staff.html, offers.html, etc.)
- The Cloudflare Worker — `worker/worker.js`, deployed via `wrangler deploy`, NOT via GitHub Pages

These two can be healthy or broken independently. Never treat them as one unit.

## RULE 13 — CODE SESSION HANDOFF (auto, no request needed)
At the end of every coding session, write/update the handoff file for whichever deploy target(s) you touched:
- Touched root-level site files → write/update `handoff/site.md`. Deploy Target = "GitHub Pages".
- Touched anything inside `worker/` → write/update `handoff/worker.md`. Deploy Target = "Cloudflare Worker".
- Touched both in one session → update both files, each with its own accurate Status.

Overwrite mode only — each file is always the current snapshot, never a running log. Git commit history is the timeline.

Use this exact template for both files (fields, order, and the GREEN/YELLOW/RED status line — swap the Deploy Target value per file):

# FTF HANDOFF

## Deploy Target
[GitHub Pages | Cloudflare Worker]

## Status
[🟢 GREEN — Ready to continue | 🟡 YELLOW — Needs review | 🔴 RED — Do not continue]

## Depends On
[None | Requires Worker vX.X | Requires Site Commit <sha> | etc.]

## Mission
[1 line — what this session set out to do]

## Completed
1. [specific thing done]

## Current State
[working / broken / partial]

## Blocked By
[what's stopping progress, or "Nothing"]

## Pending Decisions
1. [decision Buddy needs to make]

## Next Action
[single highest-priority next step]

## Known Risks
1. [live risk]

## Impact
[what this session's work touches/breaks/unlocks downstream]

## Confidence
[X/10 — how sure Claude Code is this is solid]

## Review Status
[Reviewed / Not reviewed / Needs Buddy check]

## PRODUCT READ
- Verify: [what needs real-device/real-world check]
- Feel: [X/10 on relevant axis]
- Iteration needed: [yes/no + what]
- One more hour: "If I had one more hour, this is the single improvement I'd make next: [answer]"

Pick exactly one Status option (delete the other two). If nothing blocks, write "Nothing" under Blocked By. If nothing depends on anything else, write "None" under Depends On.
