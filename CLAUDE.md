# OpenMausBot fork — agent operating rules

This is Yosri's fork, being revamped into a next-generation hybrid platform
(Grok Bot × Block Buzz × Type.com). Full-revamp authority: keep only what the
platform needs from upstream OpenMausBot.

**START HERE every session: read `docs/AGENT-MEMORY.md`** if it exists — the
repo-versioned session memory index (≤200 lines): current state, open items,
binding decisions. Update it in the same commit as the work it describes;
prune at every batch close.

## Doctrine (imported from the owner's global rules + equitihub)

- **Evidence before claims is absolute.** A subagent's success report is never
  evidence; the diff and the command output are.
- **Effort proportionality.** Size the ITEM, not the message. Questions →
  answer directly. ≤3 files, no cross-cutting risk → inline. Multi-file,
  security/data, or uncertain → charge skill → subagent → adversarial review.
  Any bug → root cause before fix (`charge:diagnosing-bugs`).
- **Dispatch, THEN announce.** "Running" is written only after the tool call
  returned an id. Never end a turn on an unstarted intention.
- **Stage explicitly** — `git add <path>`, never `-A`/`.`/`-u`, never
  `commit -a`. Never rewrite history while an agent is live.
- **Subagent rules travel inline in the brief.** Sub-agents start with an
  empty context: restate file ownership — theirs and their siblings'.
- **Any visual change requires a screenshot before it is called done** — gates
  prove nothing broke; they cannot prove it looks right.
- **Push back rather than comply silently** when the asked-for shape is wrong.

## Pipeline — route by stage (charge v3)

design (`charge:design`) → plan (`charge:plan`, red-teamed) → execute
(`charge:execute`, worktree-isolated, TDD, evidence-gated DONE). Autonomy runs
via `charge:ralph-loop`. Skills installed at `~/.claude/skills` in cloud
sessions (source: github.com/Y-B-1/charge).

## Model selection

The session model is a hard CEILING. Orchestrator stays inline, briefs and
review at low effort; builders on Opus medium for non-pinnable work, Sonnet
medium/low for pinnable/mechanical sweeps. `effort` always explicit; never a
`[1m]` variant without a 1M-context need.

## This project

- Planning and research docs live in `docs/platform/`.
- Branch for the platform work: `claude/hybrid-ai-platform-planning-upe28l`.
- Upstream stack: TypeScript strict, React 19, Vite, Electron shell, local
  harness server (Express/WS) in `server/`, UI in `src/`.
