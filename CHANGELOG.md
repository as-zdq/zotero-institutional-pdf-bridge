# Changelog

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
