# Design Documents — Engine

This directory contains design proposals for the Engine project. Design docs are
**decision records**, not implementation guides. They capture why a decision was made,
what alternatives were considered, and what the intended approach is.

For the current state of the implementation, see the authoritative docs in `docs/`.

---

## What goes here vs in `docs/`

| | `design/` | `docs/` |
|---|---|---|
| Describes | Intent, rationale, alternatives | The system as implemented |
| Written when | Before or during implementation | Updated with every code change |
| Updated after approval? | Status field only | Yes — always kept current |
| Tense | Future / intent | Present — what exists today |
| Source of truth for? | Why decisions were made | How the system works |

Cross-cutting designs that affect multiple repos (Engine + Console, or org-wide) live
at the org level in `idea/design/`, not here.

---

## Design doc lifecycle

```
Draft → Proposed → Approved → Implemented
                ↘ Rejected
                ↘ Withdrawn
```

| Status | Meaning |
|---|---|
| `Draft` | Being written; not yet submitted for review |
| `Proposed` | PR open; awaiting CEO decision |
| `Approved` | CEO merged PR; implementation authorised |
| `Implemented` | Feature complete; authoritative docs updated |
| `Rejected` | CEO decided not to proceed; rationale noted in doc |
| `Superseded` | A different design was chosen; link to the winning doc |
| `Withdrawn` | Proposing agent retracted before CEO decision |

---

## Rules

### When proposing
- Open a PR targeting `main`; title starts with `design:`
- The PR description summarises the proposal and flags open questions for the CEO
- Do not begin implementation before the PR is merged

### When implementing
- Updating the relevant authoritative doc (`docs/ARCHITECTURE.md`, etc.) is **part of
  the same PR as the code change** — not a separate task
- Update the design doc status to `Implemented` in that same PR
- Veri verifies both as part of PR review

### When a design is rejected or superseded
- Add a one-sentence rationale to the status field: future agents need to know why the
  alternative was ruled out, not just that it was
- Do not delete rejected or superseded docs — they are the historical record

---

## Documents

| File | Status | Summary |
|---|---|---|
| `test-setup-design.md` | Superseded | Proposal A: Docker Battery approach |
| `test-setup-native.md` | Approved | Proposal B: Native Engine approach (adopted) |
| `test-setup-comparison.md` | Approved | 9-dimension comparison; Proposal B selected |
