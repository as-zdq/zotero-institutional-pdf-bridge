# Changelog

## 0.2.0 - 2026-07-28

- Added optional credential storage through Zotero Password Manager.
- Added one-time automatic form fill and submit for the configured HTTPS SSO/CAS login origin.
- Kept background new-item lookups non-interactive; they never use stored credentials to start a login.

## 0.1.0 - 2026-07-24

- First public release with neutral defaults and extension identity.
- Added configurable request timeout/retry behavior and non-interactive new-item lookup.
- Added PDF candidate support for publisher article-PDF links.
- Removed institution-specific preset values from the public package.
