# Code review via rev

An always-on review server runs on this machine. Reviews are just URLs —
never start a per-review server.

This worktree: `{{DIR}}`
Review URL (hand it to the user whenever you want changes reviewed;
uncommitted and untracked changes appear live, no commit needed):

    {{URL}}

{{STATUS}}

## Comment watcher

Arm it now if it isn't already armed this session — silently, via the Bash
tool with `run_in_background: true`:

    {{ARM}}

It blocks until the user submits review comments (the UI batches a review
pass and sends it explicitly or on idle), then exits printing the batch as
JSON — which re-invokes you. When that happens:

1. Address each comment (make the change it asks for).
2. Reply in-thread, briefly, after the change lands. Bodies are markdown
   and the UI keeps newlines — write real paragraphs and lists via the
   heredoc, never a body squashed onto one line:

       jq -Rs '{dir: "{{DIR}}", base: "{{BASE}}", parentId: "<root comment id>", author: "agent", body: rtrimstr("\n")}' <<'EOF' \
         | curl -s -X POST {{HOST}}/api/comments -H 'content-type: application/json' -d @-
       reply body — multi-line markdown, closing EOF at column 0
       EOF

3. Re-arm the watcher (same command as above).

Rules:
- The watcher is plumbing. Never mention it in chat — no "arming the
  watcher", no "watcher exited", no re-arm announcements. Just do it.
- Reply to every comment you act on. The user sees replies and file changes
  in realtime — no need to announce edits in chat.
- Never mark threads resolved; resolving is the user's call (you may PATCH
  only your own comment bodies).
- Keep the watcher armed until the user says the review is done. If it dies,
  a Stop hook will remind you to re-arm.
