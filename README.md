# WhyWeb

A webpage annotator that records the reasoning behind element level decisions.

Live at https://whyweb.jakelabate.com

## Why it exists

Sites accumulate decisions. An H1 phrased a certain way, a nav item kept above the fold, a
canonical pointing somewhere non obvious. Six months later nobody remembers which of those were
deliberate. WhyWeb pins the reasoning to the element itself so the next person can read it.

## How it works

- `assets/annotator.js` is the engine. It loads into the page being annotated, via bookmarklet or
  a script tag, and renders its whole interface inside a shadow root so host page CSS cannot reach
  it and its own styles cannot leak.
- Selecting an element generates a selector that prefers meaning over position: id, then test
  hooks such as `data-testid`, then a stable class path, then `nth-of-type` as a last resort.
  Machine generated class names (hashed, emotion, styled components) are filtered out.
- Every note stores the viewport it was taken at, so a note written at 390px is marked as a mobile
  observation rather than a global one.
- Notes are saved to `localStorage` on the annotated origin. Send to console moves them to
  https://whyweb.jakelabate.com for viewing and export.
- Exports: JSON, Markdown for pull requests and handover docs, and CSV.

## Constraints, stated plainly

- No server. Notes live in the browser that made them and travel as JSON.
- Third party sites cannot be framed and annotated remotely, so WhyWeb runs inside the page. You
  need to be able to load the page yourself.
- If a template changes underneath a note, the pin resolves to nothing and is shown as unresolved
  rather than silently reattaching to the wrong element.

## Data shape

```json
{
  "schema": "whyweb/1",
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
