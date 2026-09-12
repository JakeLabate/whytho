/* WhyTho configuration.
   The publishable key is meant to be public. Every table is behind row level
   security, so a key on its own reads and writes nothing. */
window.WHY_CONFIG = {
  supabaseUrl: 'https://vvekkbboqqkxnlpmxazh.supabase.co',
  publishableKey: 'sb_publishable_jS0s7lenxSg1CZ9z6qsq4w_bghFxM89',

  // The annotator still talks to the function directly: it runs on other people's
  // origins and is not something anybody reads out loud.
  syncUrl: 'https://vvekkbboqqkxnlpmxazh.supabase.co/functions/v1/why-sync',

  // Everything public goes through the worker, which is the url that appears in
  // documentation, in the API tab, and in a connector setting.
  apiBase: 'https://whytho-api.jakelabate.com',
  mcpUrl: 'https://whytho-api.jakelabate.com/mcp',

  consoleUrl: 'https://whytho.jakelabate.com/',
  extensionVersion: '4.2.0',

  // Buttons are rendered from whatever the project actually has enabled, so turning a
  // provider on in Supabase is the only step. Anything not listed here still works
  // through the settings endpoint, it just gets its id as a label.
  providers: {
    google: 'Google',
    github: 'GitHub',
    azure: 'Microsoft',
    apple: 'Apple',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
    slack_oidc: 'Slack',
    linkedin_oidc: 'LinkedIn',
    notion: 'Notion',
    figma: 'Figma',
    discord: 'Discord',
    twitch: 'Twitch',
    spotify: 'Spotify',
    workos: 'your work account',
    keycloak: 'Keycloak',
    zoom: 'Zoom'
  }
};
