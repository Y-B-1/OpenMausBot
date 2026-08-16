# Global Engineering Guidelines (owner's global CLAUDE.md — repo copy)

> Repo-versioned copy of the owner's global `~/.claude/CLAUDE.md` (imported
> from claude-project-starter, 2026-08-16) so cloud sessions inherit it.
> Three layers: how to think while coding (Karpathy guidelines), how to run
> the session (Orchestra core), and which process to reach for (skill routing).

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- Plan read-only before editing.
- State your assumptions explicitly. If uncertain, ask in frontier rounds: every question whose prerequisites are already settled, all at once, each with your recommended answer — never two questions in one round where one depends on the other.
- Never ask what the codebase can answer; explore it instead.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative** — no unasked features, no abstractions for single-use code, no unrequested configurability, no error handling for impossible scenarios. If 200 lines could be 50, rewrite. Test: "Would a senior engineer call this overcomplicated?"

## 3. Surgical Changes

**Every changed line traces to the request.** Match existing style; don't refactor or "improve" adjacent code; mention unrelated dead code, never delete it. Remove only the orphans YOUR change created.

## 4. Goal-Driven Execution

**Define success criteria that return yes/no. Loop until verified.**

Transform tasks into verifiable goals (tests pass, command exits 0):
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with a verify check per step.
Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Context & Session Mechanics

**Attention is the scarce resource. Spend it on the task.**

- Load the minimum context that makes the task solvable; read the pointed file, not the whole area.
- Answer tersely: return diffs not files, skip restating context.
- Work one ticket per session; keep state on disk (spec, progress file, commits), not in conversation.
- A repo with a memory file (docs/AGENT-MEMORY.md) gets it updated in the SAME commit that closes a batch/wave; then pruned. The drawer (~/.claude session memory) holds ONLY what cannot live in a repo.
- Commit every working iteration; a bad step is a revert, not a debugging session.
- Write tests red-green-refactor; assert behavior, never the mock.
- Ship a thin end-to-end slice first and verify the whole pipe before widening.
- Match check scope to blast radius — fast checks per edit, run LOCALLY; scoped e2e per work unit on an isolated port; pre-merge, a DERIVED impact set; the FULL suite only on the owner's trigger. Any commit after a green run voids it as evidence.
- Push searches, bulk reads, and verification into subagents that return one result.
- Subagents that EDIT files run in isolated worktrees whenever two or more run concurrently; lone editors and read-only fan-outs skip the worktree.
- A rule that constrains a subagent must be restated INLINE in that subagent's brief, or enforced by a hook where the subagent acts.
- Before any status claim about background work, verify liveness (live process + transcript mtime).
- Monitor context fill; treat 40–60% as the working ceiling, but never clear unexported design decisions.
- At a phase boundary, in order, first yes wins: continue → clear → handoff → subagent → compact.
- Keep prompts cache-friendly: append-only; hold model, effort, and thinking settings constant mid-session.
- Completion claims carry evidence: test output, the command and its exit code, or a screenshot — never bare assertions.
- If a rule must always hold, propose a hook or check — don't add another sentence here.
- Config files have homes and caps: route every new instruction to its cheapest home; cap always-loaded files with a test; add rules only per observed failure.

## 6. Process Routing

**Reach for the packaged process instead of improvising it.**

- The chain is design → plan → execute (charge v3). When unsure which skill applies, `charge:using-charge` is the router.
- Before building anything non-trivial: `charge:design` — alignment interview plus spec, glossary, sparing ADRs. Rounds until the plan is concrete.
- Approved spec, execution not started: `charge:plan` — red-teamed, ticketed execution plan.
- Plan ready: `charge:execute`; `charge:goal` first when the run will be unattended.
- Vocabulary: `/domain-modeling`; feature/bugfix test-first: `/tdd`.
- Unknown API or external dependency: `charge:research` first, cache findings as RESEARCH.md; expire it with the sprint.
- Route by where the answer lives: my head or the codebase → `charge:design`; someone else's head → `/to-questionnaire`; nobody's yet → `/prototype`.
- A step only a human can take: `/wizard`. Writing anything an agent will read: `/writing-for-agents`.
- Work complete or pre-merge: `/code-review` against the diff.

## 7. Model & Effort Matrix

**Tier by the knowledge the task leans on, not by habit.**

| Work type | Leans on | Tier |
|---|---|---|
| Planning, design interviews, architecture, design review | Parametric knowledge (creative, less reliable) | Top frontier model |
| Implementation from a spec/tests, refactors, migrations | Contextual knowledge (files, prompts, tool results) | Mid tier (Sonnet-class) |
| Subagent fan-out, searches, bulk reads, mechanical transforms | Contextual, low-stakes | Small/fast tier, low effort |

- The user's selected model is a hard CEILING for all work. Any model named in a project file is an ASPIRATION capped by that selection. Below the ceiling, mix and match freely.
- Hold model, effort, and thinking settings constant mid-session — all are part of the prompt-cache key.
- Whatever the tier, load the docs — bigger models fabricate post-cutoff APIs more confidently.
- Choose models on a small eval set over your actual tasks, never on public benchmarks or vibes.
