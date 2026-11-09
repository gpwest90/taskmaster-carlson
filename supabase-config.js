// Supabase connection for the Button task.
// The publishable key is meant to be public: the database only lets it call
// get_status / record_click with a contestant's secret key (see supabase/schema.sql).
// Never put the secret / service_role key in this repo.
window.SUPABASE_CONFIG = {
  url: "https://srllwyiewwjhvbeaudrf.supabase.co",
  publishableKey: "sb_publishable_SdXfHrjI_W8WLwWLyAqnLA_qoSijGNg",
};
