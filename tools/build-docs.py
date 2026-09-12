#!/usr/bin/env python3
"""Render whytho-openapi.json into a static docs page.

Deliberately not a client side renderer. The spec is the source of truth, this
writes plain HTML from it, so the docs are crawlable, match the rest of the site,
and do not depend on a third party CDN staying up. Run after changing the spec:

    python3 tools/build-docs.py
"""
import json, html, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = json.loads((ROOT / 'whytho-openapi.json').read_text())
BASE = spec['servers'][0]['url']
e = html.escape

def md(text):
    """Enough markdown for the prose the spec carries: headings, code, bold, links."""
    out, chunks = [], re.split(r'\n\n+', text.strip())
    for c in chunks:
        if c.startswith('```'):
            out.append('<pre><code>' + e(c.strip('`').strip()) + '</code></pre>')
            continue
        if c.startswith('## '):
            out.append('<h2 id="%s">%s</h2>' % (slug(c[3:]), e(c[3:])))
            continue
        c = e(c)
        c = re.sub(r'`([^`]+)`', r'<code>\1</code>', c)
        c = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', c)
        c = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', c)
        out.append('<p>' + c.replace('\n', ' ') + '</p>')
    return '\n'.join(out)

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

def schema_line(s):
    if not isinstance(s, dict):
        return ''
    if '$ref' in s:
        return s['$ref'].split('/')[-1]
    t = s.get('type', '')
    if t == 'array':
        return 'array of ' + schema_line(s.get('items', {}))
    if s.get('enum'):
        return ' or '.join('<code>%s</code>' % e(str(x)) for x in s['enum'] if x is not None)
    return t

def fields(schema, required=()):
    rows = []
    for name, prop in (schema.get('properties') or {}).items():
        req = 'required' if name in (schema.get('required') or required) else ''
        rows.append('<tr><td><code>%s</code>%s</td><td>%s</td><td>%s</td></tr>' % (
            e(name),
            ' <span class="req">required</span>' if req else '',
            schema_line(prop),
            e(prop.get('description', '')) + (
                ' Example: <code>%s</code>' % e(str(prop['example'])) if 'example' in prop else '')))
    return ('<table class="d-table"><thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>'
            '<tbody>%s</tbody></table>' % ''.join(rows)) if rows else ''

def curl(method, path, op):
    lines = ['curl' + ('' if method == 'get' else ' -X ' + method.upper()) +
             ' "%s%s"' % (BASE, path.replace('{', '{').replace('}', '}')),
             '  -H "Authorization: Bearer $WHYTHO_KEY"']
    body = (op.get('requestBody') or {}).get('content', {}).get('application/json', {})
    if body:
        lines.append('  -H "Content-Type: application/json"')
        ex = body.get('example') or (body.get('schema') or {}).get('example')
        if ex:
            lines.append("  -d '" + json.dumps(ex, indent=2) + "'")
    return ' \\\n'.join(lines)

# group operations by tag, in the order the spec declares its tags
groups = {t['name']: {'desc': t.get('description', ''), 'ops': []} for t in spec.get('tags', [])}
for path, item in spec['paths'].items():
    shared = item.get('parameters', [])
    for method in ('get', 'post', 'patch', 'delete'):
        if method not in item:
            continue
        op = item[method]
        tag = (op.get('tags') or ['Other'])[0]
        groups.setdefault(tag, {'desc': '', 'ops': []})
        groups[tag]['ops'].append((method, path, op, shared))

nav, body = [], []
for tag, g in groups.items():
    if not g['ops']:
        continue
    nav.append('<li class="nav-group">%s<ul>' % e(tag))
    body.append('<section class="d-group"><h2 id="%s">%s</h2>%s' % (
        slug(tag), e(tag), '<p class="sub">%s</p>' % e(g['desc']) if g['desc'] else ''))

    for method, path, op, shared in g['ops']:
        oid = slug(method + ' ' + path)
        nav.append('<li><a href="#%s"><span class="m m-%s">%s</span>%s</a></li>' % (
            oid, method, method.upper(), e(op.get('summary', path))))

        body.append('<article class="d-op" id="%s">' % oid)
        body.append('<h3>%s</h3>' % e(op.get('summary', path)))
        body.append('<p class="d-path"><span class="m m-%s">%s</span><code>%s</code></p>' % (
            method, method.upper(), e(path)))
        if op.get('description'):
            body.append('<p>%s</p>' % re.sub(r'`([^`]+)`', r'<code>\1</code>', e(op['description'])))

        params = shared + op.get('parameters', [])
        if params:
            rows = ''.join(
                '<tr><td><code>%s</code>%s</td><td>%s</td><td>%s</td></tr>' % (
                    e(p['name']),
                    ' <span class="req">required</span>' if p.get('required') else '',
                    schema_line(p.get('schema', {})),
                    e(p.get('description', '')) + (
                        ' Example: <code>%s</code>' % e(str(p['example'])) if 'example' in p else ''))
                for p in params)
            body.append('<h4>Parameters</h4><table class="d-table"><thead><tr><th>Name</th>'
                        '<th>Type</th><th>Notes</th></tr></thead><tbody>%s</tbody></table>' % rows)

        rb = (op.get('requestBody') or {}).get('content', {}).get('application/json', {})
        if rb.get('schema'):
            body.append('<h4>Body</h4>' + fields(rb['schema']))

        body.append('<h4>Example</h4><pre><code>%s</code></pre>' % e(curl(method, path, op)))

        rows = ''.join('<tr><td><code>%s</code></td><td>%s</td></tr>' % (code, e(r.get('description', '')))
                       for code, r in (op.get('responses') or {}).items())
        body.append('<h4>Responses</h4><table class="d-table"><tbody>%s</tbody></table>' % rows)
        body.append('</article>')

    body.append('</section>')
    nav.append('</ul></li>')

# schemas, so a reader can see what a note actually looks like
body.append('<section class="d-group"><h2 id="schemas">Objects</h2>')
for name, schema in (spec['components']['schemas']).items():
    body.append('<article class="d-op" id="%s"><h3>%s</h3>%s</article>' % (slug(name), e(name), fields(schema)))
body.append('</section>')
nav.append('<li class="nav-group">Objects<ul>%s</ul></li>' % ''.join(
    '<li><a href="#%s">%s</a></li>' % (slug(n), e(n)) for n in spec['components']['schemas']))

page = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhyTho API reference</title>
<meta name="description" content="The WhyTho API: read and write notes, pages, teams, membership, invites and notifications. Bearer key authentication, per workspace scoping.">
<link rel="canonical" href="https://whytho.jakelabate.com/docs.html">
<meta property="og:title" content="WhyTho API reference">
<meta property="og:description" content="Read and write the reasoning behind the elements on a page.">
<meta property="og:url" content="https://whytho.jakelabate.com/docs.html">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/console.css?v=41">
<link rel="stylesheet" href="assets/docs.css?v=41">
</head>
<body class="doc">

__BAR__

<div class="d-shell">
  <aside class="d-nav"><nav><ul>__NAV__</ul></nav></aside>
  <main class="d-main">
    <h1>__TITLE__</h1>
    <p class="lede">Version __VERSION__. Base URL <code>__BASE__</code></p>
    <div class="d-intro">__INTRO__</div>
    <p class="d-postman">Prefer to poke at it? The same spec is a
      <a href="https://go.postman.co/collection/32118341-290c4a41-b6c0-4a90-b336-168d8b1541f7">Postman collection</a>,
      or download <a href="whytho-openapi.json">the OpenAPI file</a>.</p>
    __BODY__
  </main>
</div>

<footer><p>WhyTho, built by Jake Labate, SEO Consultant. <a href="https://www.jakelabate.com/">jakelabate.com</a></p></footer>
</body>
</html>
'''

# The public pages share one bar. It is defined here rather than scraped from a
# sibling page, so the docs cannot drift out of step the way they did once already.
bar = '''<header class="app-bar">
  <a class="app-mark" href="./">WhyTho</a>
  <nav class="tabs">
    <a href="about.html">How it works</a>
    <a href="install.html">Install</a>
    <a href="docs.html" class="on">API docs</a>
    <a href="demo.html">Demo</a>
  </nav>
  <div class="app-who"><a class="who" href="./"><span class="who-text"><b>Open the app</b></span></a></div>
</header>'''

page = (page.replace('__BAR__', bar)
            .replace('__NAV__', ''.join(nav))
            .replace('__TITLE__', e(spec['info']['title']) + ' reference')
            .replace('__VERSION__', e(spec['info']['version']))
            .replace('__BASE__', e(BASE))
            .replace('__INTRO__', md(spec['info']['description']))
            .replace('__BODY__', '\n'.join(body)))

(ROOT / 'docs.html').write_text(page)
print('docs.html written,', len(page), 'bytes,',
      sum(len(g['ops']) for g in groups.values()), 'operations')
