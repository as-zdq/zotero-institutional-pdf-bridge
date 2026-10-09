# Security policy

Report vulnerabilities privately to the repository owner before opening a public issue. Until a public repository contact is configured, do not publish proof-of-concept code that exposes institutional sessions.

The plugin does not export cookies, expose a local HTTP endpoint, or bypass institutional authorization. If a user enables automatic login and credential capture, it can read credentials submitted in its login window, restricted to the configured HTTPS login origin. Credentials saved this way or through settings are kept by Zotero Password Manager rather than plugin preferences or logs, and are submitted only to that same origin. It otherwise only uses the session created by the institution's own login page. Server-side expiry and multi-factor authentication are authoritative.
