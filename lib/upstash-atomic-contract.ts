export const UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY =
  "diagnostic:base_readonly_oauth_atomic:v1:guard";
export const UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY =
  "diagnostic:base_readonly_oauth_atomic:v1:target";

export const UPSTASH_ATOMIC_DIAGNOSTIC_G1 =
  'base-readonly-oauth-diagnostic:v1:{"version":1,"kind":"guard","owner":"owner-a"}';
export const UPSTASH_ATOMIC_DIAGNOSTIC_G1_ORDER_DIFFERENT =
  'base-readonly-oauth-diagnostic:v1:{"kind":"guard","version":1,"owner":"owner-a"}';
export const UPSTASH_ATOMIC_DIAGNOSTIC_T1 =
  'base-readonly-oauth-diagnostic:v1:{"version":1,"kind":"target","owner":"owner-a","payload":"alpha"}';
export const UPSTASH_ATOMIC_DIAGNOSTIC_T2 =
  'base-readonly-oauth-diagnostic:v1:{"version":1,"kind":"target","owner":"owner-b","payload":"alpha"}';

export const UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_TTL_SECONDS = 600;

export const UPSTASH_ATOMIC_DIAGNOSTIC_DUMMY_VALUES = Object.freeze([
  UPSTASH_ATOMIC_DIAGNOSTIC_G1,
  UPSTASH_ATOMIC_DIAGNOSTIC_G1_ORDER_DIFFERENT,
  UPSTASH_ATOMIC_DIAGNOSTIC_T1,
  UPSTASH_ATOMIC_DIAGNOSTIC_T2,
] as const);
