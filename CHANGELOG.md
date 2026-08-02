# Changelog

## 0.2.3 - 2026-08-02

- Fixed login form submission for institutions using CAS with RSA-encrypted password fields (e.g. DLUT WebVPN): the plugin now finds the explicit submit button (`#index_login_btn`) before falling back to `requestSubmit()`, ensuring the custom AJAX login handler is triggered rather than sending plaintext credentials.
- Fixed session transfer between the visible login window and the background hidden browser: after a successful login, the WebVPN session cookies are now exported from the visible browser and injected into the hidden session, so background PDF downloads work without requiring a second authentication.
- Added credential capture for CAS-style `<a>` submit buttons (previously only `button` and `input[type=submit]` were monitored).
- Updated DLUT WebVPN login URL in documentation to `https://webvpn.dlut.edu.cn/login?cas_login=true` (the default `/login` page shows a WeChat QR code; the CAS username/password form requires `?cas_login=true`).

## 0.2.2 - 2026-08-02

- Initial DLUT WebVPN support with Sangfor-compatible AES-128-CFB encryption (key: `Wxzxvpn2023key@$`).

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
