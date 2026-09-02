/* Tacillon — Terms of Service / Privacy Policy acceptance.

   TERMS_VERSION is the single switch. Change the legal text under app/legal/,
   set TERMS_VERSION to the new date, and every enterprise is asked to agree
   again before it can continue past login. Never edit the legal text without
   bumping this constant — the acceptance record stores the version, and the
   version must mean one exact text. See app/legal/README.md.

   decideTermsGate() is a pure function so the self-test harness can prove the
   gate closes: no row and no signup metadata must yield 'ask'. */

export const TERMS_VERSION = '2026-09-01';
export const TERMS_URL = 'legal/terms.html';
export const PRIVACY_URL = 'legal/privacy.html';

/* What to do for a signed-in user.
     row        — the terms_acceptances row for TERMS_VERSION, or null
     metadata   — session.user.user_metadata (may carry terms_version from signup)
     version    — the current TERMS_VERSION
   Returns 'accepted' (proceed), 'record_signup' (the signup checkbox was ticked
   for this exact version — write the row silently, then proceed), or 'ask'
   (show the acceptance screen; nothing else may happen until it is answered). */
export function decideTermsGate({ row, metadata, version }) {
  if (row && row.terms_version === version) return 'accepted';
  if (metadata && metadata.terms_version === version) return 'record_signup';
  return 'ask';
}

/* SHA-256 of a document as served to this device, so the acceptance record
   pins the exact text. Returns null rather than throwing: the version is the
   primary record, the hash is corroboration. */
export async function hashDocument(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const buf = await crypto.subtle.digest('SHA-256', await res.arrayBuffer());
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
