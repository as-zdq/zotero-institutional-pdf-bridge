# Security policy

Report vulnerabilities privately to the repository owner before opening a public issue. Until a public repository contact is configured, do not publish proof-of-concept code that exposes institutional sessions.

The plugin does not read passwords from institution pages, export cookies, expose a local HTTP endpoint, or bypass institutional authorization. If a user explicitly saves credentials, they are kept by Zotero Password Manager rather than plugin preferences or logs, and the plugin submits them only to the configured HTTPS login origin. It otherwise only uses the session created by the institution's own login page. Server-side expiry and multi-factor authentication are authoritative.
