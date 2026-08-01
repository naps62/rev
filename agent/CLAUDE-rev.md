# Code review via rev

An always-on review server runs on this machine at `http://localhost:7373`
(LAN: same port on the machine's IP). Use it whenever you want the user to
review changes. Do NOT start a per-review server.

## Requesting a review

No registration step. Build the URL and send it to the user:

```
http://<host>:7373/review?dir=<url-encoded absolute path of your checkout/worktree>&base=<base ref, e.g. main>
```

Uncommitted and untracked changes are included automatically — you don't need
to commit first, and new commits show up live.

## Waiting for and answering comments

Comments are stored server-side. Poll with a cursor (`seq`), long-polling so
you don't spin:

```bash
curl -s "http://localhost:7373/api/comments?dir=$DIR&since=$CURSOR&wait=1"
# → { "comments": [...], "cursor": <new seq> }
```

Start with `since=0` (or the cursor from before you asked for the review),
then repeat with the returned cursor. New comments from the user have
`"author": "user"`; each has an `anchor` (file/side/line/snippet) or is a
review-level note.

Reply in-thread (`parentId` = the root comment's id):

```bash
curl -s -X POST http://localhost:7373/api/comments \
  -H 'content-type: application/json' \
  -d '{"dir":"'$DIR'","base":"main","parentId":"<id>","author":"agent","body":"Fixed in the working tree — the check now happens before the write."}'
```

Rules:
- Reply to every comment you act on, briefly, after making the change. The
  user sees replies and file changes in realtime — no need to announce edits.
- Never mark threads resolved; resolving is the user's call
  (you may PATCH only your own comment bodies).
- Keep polling until the user says the review is done.
