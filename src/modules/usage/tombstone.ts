/**
 * The fixed sentinel `token_usage.user_id` is rewritten to on account
 * deletion (DATA_RETENTION_AND_PRIVACY.md "Account deletion"). All-zero so
 * it reads unambiguously as "not a real user" wherever it shows up (billing
 * exports, dashboards) without needing a schema change to express "deleted".
 */
export const TOMBSTONE_USER_ID = "00000000-0000-0000-0000-000000000000";
