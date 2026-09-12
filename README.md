# WhyTho

A webpage annotator that records the reasoning behind element level decisions.

Live at https://whytho.jakelabate.com

## Why it exists

Sites accumulate decisions. An H1 phrased a certain way, a nav item kept above the fold, a
canonical pointing somewhere non obvious. Six months later nobody remembers which of those were
deliberate. WhyTho pins the reasoning to the element itself so the next person can read it.

## Getting it onto a page

- `extension/` is a manifest v3 Chrome extension: click the toolbar icon or press Alt+Shift+W.
  It packages its own copy of the annotator because manifest v3 forbids remote code, and
  `tools/build-extension.sh` is what keeps that copy identical to `assets/annotator.js` and
  rebuilds `whytho-extension.zip`. Run it after any annotator change.
- The extension gets its token from the app: a content script on whytho.jakelabate.com sets
  `data-whytho-extension` on the document so the app knows it is there, and the app posts the
  token back over `window.postMessage` when you press Connect. Nothing else crosses.
- The bookmarklet and the script tag both still work and are unchanged. Safari and Firefox
  need their own extension builds, so they stay on the bookmarklet for now.

## How it works

- `assets/annotator.js` is the engine. It loads into the page being annotated, via bookmarklet or
  a script tag, and renders its whole interface inside a shadow root so host page CSS cannot reach
  it and its own styles cannot leak.
- Selecting an element generates a selector that prefers meaning over position: id, then test
  hooks such as `data-testid`, then a stable class path, then `nth-of-type` as a last resort.
  Machine generated class names (hashed, emotion, styled components) are filtered out.
- Every note stores the viewport it was taken at, so a note written at 390px is marked as a mobile
  observation rather than a global one.
- Notes save to Postgres against your account. The annotator runs on other people's origins, so
  it cannot hold a Supabase session; it carries a per account annotator token instead, embedded in
  your personal bookmarklet. The `why-sync` edge function resolves that token to a user with the
  service role key and pins every write to that user.
- `localStorage` on the annotated origin is the offline cache. If the network drops, notes are kept
  locally and pushed on the next run.
- Exports: JSON, Markdown for pull requests and handover docs, and CSV.

## Naming

The product is WhyTho and the site is whytho.jakelabate.com. The internal identifiers still read
`why`: the `data-why-token` attribute, the `why:` localStorage keys, the `window.__why__` global,
the `why_pages`, `why_notes` and `why_tokens` tables, and the `why-sync` edge function. Those are
left alone deliberately. Changing them would invalidate installed bookmarklets and orphan notes
cached on annotated origins, and none of them are visible to anyone using the tool.

## What a note carries

Besides the reasoning itself, every note stores the context it was written in: the element's
text, the text immediately before and after it, the nearest heading above it, the ancestor
chain, any href or alt or aria-label, the bounding rect and a few computed styles. That is
read from the DOM, needs no permissions, and is what makes a note legible later without
opening the page.

Extension users also get a real screenshot. `chrome.tabs.captureVisibleTab` grabs the visible
tab, an OffscreenCanvas in the worker crops to the element with a margin and strokes the
highlight box, and the result is sent with the note as a JPEG. DOM rasterisation libraries
were deliberately not used: they re-render rather than capture, so cross origin images and
unsupported CSS come out wrong, and a screenshot that lies is worse than none.

Screenshots live in a private `why-shots` bucket. Nothing is public; readers get signed urls
that expire in an hour, minted by the edge functions which already know who is asking.

## Front door

`cloudflare/whytho-api` is a Worker that fronts both edge functions at
`whytho-api.jakelabate.com`, strips the `/functions/v1/why-api` prefix, and applies the rate
limits the functions have no way to apply themselves. Deploy it with `npx wrangler deploy`
from that folder. It is live, and `https://whytho-api.jakelabate.com` is now the canonical base
url for both the API and the MCP connector. The Supabase function urls still answer directly,
but nothing should point at them.

## API docs

`whytho-openapi.json` is the source of truth for the public API. Two things are generated
from it, and both go stale if it is edited without regenerating:

- `docs.html`, via `python3 tools/build-docs.py`. Static HTML rather than a client side
  renderer, so the reference is crawlable, matches the site, and does not depend on a CDN.
- The Postman collection, which is linked to the spec in Postman's Spec Hub and re-synced
  there rather than edited by hand.

## Change requests

A note can be written as reasoning or as a request. A request is treated as approved the
moment it is written: `why-apply` resolves the page url to a file in the mapped repository,
asks the model for surgical find and replace edits, applies them by exact match, and commits
straight to the live branch. Per repository, `apply_mode` can be `pr` instead, which opens a
pull request for review.

Reach is part of the request: one page, everything under a path prefix, or the whole site.
For anything wider than a page the edit is worked out once against the page the note was
written on, then applied to every file in reach where `old_str` matches exactly once. A
shared header matches everywhere and changes everywhere; a one off paragraph matches nowhere
else and is left alone. The summary reports how many of the files in reach were touched.

Three things keep that safe without a review gate:

- The model returns edits, never a rewritten file, so a request about one heading cannot
  quietly reformat three hundred lines.
- Every `old_str` must match exactly once. Zero matches or several, and nothing is written.
- Every commit records the repository and the blob sha it replaced, so undo is one call.
  That is what the Undo button in the Changes tab uses.

### Who can use it

Writing to a repository runs on one shared `GITHUB_TOKEN`, so it is a per account grant
(`why_profiles.apply_enabled`), off by default, and the flag cannot be set from the client:
a trigger reverts any change to it that comes from a request with JWT claims, so only the
service role can grant it. Mapping a repository requires the grant too, since the mapping
is what decides where a change gets written.

That is a stopgap. The real fix is a GitHub App installed per account, so each person's
changes are written with their own installation token, scoped to the repositories they
chose. Until then, do not enable this for anyone whose repositories the shared token
cannot already reach.

The model is per account, chosen in Workspace and validated against an allowlist in the
function, so a stored value can never become an arbitrary string in an API call. Which model
made a change is recorded on the change and in the commit message, so a bad edit can be
traced to the model that wrote it.

`ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are function secrets. Without them a request fails
loudly rather than doing nothing.

## Backend

Supabase project `vvekkbboqqkxnlpmxazh`, shared with the portal and analytics apps.

- `why_pages`, `why_notes`, `why_tokens`, all with row level security scoped to `auth.uid()`.
- `why_notes` is unique on `(user_id, client_id)`, so pushes are idempotent and a note written
  offline syncs once, not twice.
- Deletes are soft (`deleted_at`) so a sync cannot resurrect a removed note.
- Edge function `why-sync` handles pull, push, delete, and whoami for token holders.
- Edge function `why-api` is the public API: read with any key, write with a key that carries the
  write scope. Writes are pinned to the key's user and workspace, so a key can never reach rows its
  owner could not. Notes created through it are stored with `source = 'api'` rather than
  `'annotator'`, because nothing verified that an element was ever on a page. It runs with
  `verify_jwt` off because it does its own token check, and it answers CORS from any origin, which
  is required for a bookmarklet.
- The console authenticates normally with email and password and talks to PostgREST directly.

## Constraints, stated plainly

- Organizations hold teams, teams hold people. A note written inside an organization is visible to
  every member and attributed to its author; notes written outside one are private to the account.
- Attribution is resolved server side from the account profile, which is populated from the identity
  provider. Nobody types their own name, and a client cannot claim to be someone else.
- Only the author of a note can edit or delete it. Organization admins can remove a page.
- Joining is by invite code rather than email, because this project has no production mailer.
- Third party sites cannot be framed and annotated remotely, so WhyTho runs inside the page. You
  need to be able to load the page yourself.
- If a template changes underneath a note, the pin resolves to nothing and is shown as unresolved
  rather than silently reattaching to the wrong element.

## Data shape

```json
{
  "schema": "why/1",
  "pages": [{
    "url": "https://example.com/services/",
    "origin": "https://example.com",
    "path": "/services/",
    "title": "Services",
    "notes": [{
      "id": "n_abc123",
      "selector": "main > section.hero > h1",
      "fallbackSelector": "main > section.hero > h1",
      "tag": "h1",
      "textSnippet": "Same day plumbing repair",
      "category": "seo",
      "status": "decided",
      "body": "Service plus city string stays because the phrase carries local demand.",
      "author": "Jake Labate",
      "viewport": { "width": 390, "height": 844, "breakpoint": "mobile", "dpr": 3, "touch": true },
      "createdAt": "2026-09-08T14:00:00.000Z"
    }]
  }]
}
```

Categories: seo, content, tech, a11y, perf, ux. Statuses: decided, proposed, question, do not change.

Built by Jake Labate, SEO Consultant.
