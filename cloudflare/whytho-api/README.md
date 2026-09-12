# whytho-api worker

Puts the WhyTho edge functions behind `https://whytho-api.jakelabate.com`, and adds
rate limiting the functions cannot do for themselves.

    /notes, /pages, /teams, /members, /invites, /notifications  ->  why-api
    /mcp, /token, /register, /revoke, /issue-code, /.well-known ->  why-mcp
    /                                                           ->  redirect to the docs

## Deploy

    cd cloudflare/whytho-api
    npx wrangler deploy

Then attach the hostname, which creates the DNS record and the certificate:

    npx wrangler deployments domains add whytho-api.jakelabate.com

Or in the dashboard: Workers & Pages, whytho-api, Settings, Domains & Routes, Add
custom domain.

## Why this hostname

`whytho-api.jakelabate.com` is a single level subdomain, which Cloudflare's free
Universal SSL covers. `api.whytho.jakelabate.com` is two levels deep and would need
Advanced Certificate Manager at ten dollars a month per zone.

## Rate limits

120 requests a minute per API key, 20 a minute per IP for unauthenticated callers,
counted per Cloudflare location. Both are defined on the bindings in wrangler.toml,
so changing them is a deploy rather than a migration.

## One thing this unlocks

The MCP connector currently advertises its OAuth metadata through a WWW-Authenticate
header, because Supabase will not serve `/.well-known/` at the host root. Behind this
worker it can: `https://whytho-api.jakelabate.com/.well-known/oauth-protected-resource`
resolves, which removes the only fragile assumption in the connector setup.
