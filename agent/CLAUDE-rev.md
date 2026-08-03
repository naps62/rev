# Code review via rev

An always-on review server runs on this machine. Reviews are just URLs —
never start a per-review server.

This worktree: `{{DIR}}`
Review URL (hand it to the user whenever you want changes reviewed;
uncommitted and untracked changes appear live, no commit needed):

    {{URL}}

{{STATUS}}

## Comment watcher

Arm it now if it isn't already armed this session — via the Bash tool with
`run_in_background: true`:

    {{WATCH}} {{DIR}}

It blocks until the user leaves review comments, waits for the burst to
settle, then exits printing the batch as JSON — which re-invokes you. When
that happens:

1. Address each comment (make the change it asks for).
2. Reply in-thread, briefly, after the change lands:

       curl -s -X POST {{HOST}}/api/comments -H 'content-type: application/json' \
         -d '{"dir":"{{DIR}}","base":"{{BASE}}","parentId":"<root comment id>","author":"agent","body":"..."}'

3. Re-arm the watcher (same command as above).

Rules:
- Reply to every comment you act on. The user sees replies and file changes
  in realtime — no need to announce edits in chat.
- Never mark threads resolved; resolving is the user's call (you may PATCH
  only your own comment bodies).
- Keep the watcher armed until the user says the review is done. If it dies,
  a Stop hook will remind you to re-arm.
