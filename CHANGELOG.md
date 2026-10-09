# Changelog

## 0.2.2 - 2026-10-09

- Fix the parent content actor on current Zotero by using the built-in Services global instead of a removed module.
- Bound session readiness checks across redirects instead of waiting indefinitely on a replaced document.
- Prefer the saved article/WebVPN URL, with DOI lookup as a fallback.
- Read the rendered article page and follow embedded PDF viewer links (up to two wrapper levels).
- Honor request timeouts up to 30 minutes and automatic lookup delays up to two minutes.
- Restore expired sessions silently when automatic sign-in is enabled and saved credentials are available; submit once, stop on failure, and never open a background login window.
- Retry unsuccessful new-item lookup once after a minute, except when silent sign-in has failed.
- Serialize institutional downloads to prevent manual and background lookups from navigating the same browser concurrently.
- Match login keywords as URL segments to avoid treating article titles containing "cas" or "auth" as login pages.

## 0.2.1 - 2026-07-31

- Fixed the settings-page credential fields so they remain available for manual secure storage.
- Added optional capture of credentials manually submitted in the configured institutional HTTPS login page when automatic sign-in is enabled.
- Restricted captured credentials to the exact configured login origin and Zotero Password Manager.

## 0.2.0 - 2026-07-28

- Added optional credential storage through Zotero Password Manager.
- Added one-time automatic form fill and submit for the configured HTTPS SSO/CAS login origin.
- Kept background new-item lookups non-interactive; they never use stored credentials to start a login.

## 0.1.0 - 2026-07-24

- First public release with neutral defaults and extension identity.
- Added configurable request timeout/retry behavior and non-interactive new-item lookup.
- Added PDF candidate support for publisher article-PDF links.
- Removed institution-specific preset values from the public package.
