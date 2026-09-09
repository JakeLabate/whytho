/* Why backend configuration.
   The publishable key is meant to be public. Every table is behind row level
   security, so a key on its own reads and writes nothing. */
window.WHY_CONFIG = {
  supabaseUrl: 'https://vvekkbboqqkxnlpmxazh.supabase.co',
  publishableKey: 'sb_publishable_jS0s7lenxSg1CZ9z6qsq4w_bghFxM89',
  syncUrl: 'https://vvekkbboqqkxnlpmxazh.supabase.co/functions/v1/why-sync',
  consoleUrl: 'https://why.jakelabate.com/'
};
