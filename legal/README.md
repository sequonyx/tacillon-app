# app/legal — the shipped legal documents

`terms.html` and `privacy.html` are the Terms of Service and Privacy Policy that every
enterprise agrees to before it can use the app. **They ship to the client** like everything
else under `app/`, and they are the exact text the acceptance record refers to.

## The one rule

**Never change the text of either file without bumping `TERMS_VERSION` in
`app/js/terms.js` to the new date, and changing the version line inside both files to
match.** Then bump `APP_VERSION` and `CACHE_NAME` as for any deploy.

Why: the `terms_acceptances` table records *which version* an enterprise agreed to, plus a
SHA-256 of the file as served at that moment. A version has to mean one exact text. Editing
the file under an existing version means an enterprise's record says they agreed to words
they never saw. Bumping the version makes the app ask every enterprise to agree again on
their next sign-in, which is the correct outcome for any substantive change.

Cosmetic-only fixes (a typo, CSS) still change the hash. Bump anyway; a re-acceptance costs
an enterprise one tap.

## Keeping old versions

Before changing the text, copy the outgoing files to `C:\LT\legal\versions\<old version>\`
(outside `app/`, so they do not ship) so the text behind every recorded version can be
produced on request. Section 1.4 of the Terms promises this.

## What lives elsewhere

- `C:\LT\legal\Pilot_Letter_Template.html` — the one-page letter each pilot customer signs.
  Not shipped.
- `C:\LT\legal\Tacillon_Data_Position.html` — the founder's briefing on ownership, storage,
  access and the law. Not shipped.
