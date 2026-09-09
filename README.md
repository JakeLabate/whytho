# WhyTho

A webpage annotator that records the reasoning behind element level decisions.

Live at https://whytho.jakelabate.com

## Why it exists

Sites accumulate decisions. An H1 phrased a certain way, a nav item kept above the fold, a
canonical pointing somewhere non obvious. Six months later nobody remembers which of those were
deliberate. WhyTho pins the reasoning to the element itself so the next person can read it.

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

## Backend

Supabase project `vvekkbboqqkxnlpmxazh`, shared with the portal and analytics apps.

- `why_pages`, `why_notes`, `why_tokens`, all with row level security scoped to `auth.uid()`.
- `why_notes` is unique on `(user_id, client_id)`, so pushes are idempotent and a note written
  offline syncs once, not twice.
- Deletes are soft (`deleted_at`) so a sync cannot resurrect a removed note.
- Edge function `why-sync` handles pull, push, delete, and whoami for token holders. It runs with
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
