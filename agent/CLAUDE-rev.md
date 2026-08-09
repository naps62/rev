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

It blocks until the user submits review comments (the UI batches a review
pass and sends it explicitly or on idle), then exits printing the batch as
JSON — which re-invokes you. When that happens:

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

## Visual reviews (spike)

To have the user review a running page (dev server, preview) instead of a
diff, hand them `{{HOST}}/visual?dir={{DIR}}&url=<url-encoded page URL>`.
They drop pins on the page; each pin arrives on the same comment long-poll
with `anchor.file` set to the URL and `anchor.visual` describing the spot:
fractional frame coordinates `{x, y}` always, and — when the page went
through rev's injecting proxy — the picked element as `selector`, `ex`/`ey`
(offset within it) and `outerHtml` (a snapshot of the element's markup, the
most useful field for locating the code). Reply in-thread exactly like diff
comments.
