# rev — build log

Nightshift spike, 2026-08-01. Spec: an always-on review server. See
ARCHITECTURE.md for the design and rejected options.

## Decisions

- **One prototype, one branch** — the spec allowed multiple option branches;
  chose a single polished prototype plus the "Rejected along the way" section
  in ARCHITECTURE.md. Two half-finished variants review worse than one that
  works end-to-end. (DECISIONS.md at the end summarizes the open choices.)
- **Bun + Hono / React 19 + Vite + Tailwind v4** — bun is already the runtime
  used across this machine's projects; built-in sqlite and WS remove deps.
- **Stateless review URLs** (`/review?dir&base`) — agents construct them with
  zero API calls.
- **Contract-first**: `shared/types.ts` frozen before implementation; both
  sides and the agent docs import/reference it.

## Milestones

- [x] M0 — architecture, contract, tuning, scaffold (typechecks clean)
- [ ] M1 — backend (git/discovery/watcher/db/routes/WS) + frontend
      (pages, diff renderer, comments UI) in parallel, disjoint files
- [ ] M2 — integration: live end-to-end against real repos on this machine
- [ ] M3 — polish (impeccable pass), quick-edit, agent docs, systemd unit
- [ ] M4 — gate, push, PR

## Corrections

(recorded as they happen)
