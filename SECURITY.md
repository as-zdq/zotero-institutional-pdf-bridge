# Security policy

Report vulnerabilities privately to the repository owner before opening a public issue. Until a public repository contact is configured, do not publish proof-of-concept code that exposes institutional sessions.

The plugin intentionally does not read passwords, export cookies, expose a local HTTP endpoint, or bypass institutional authorization. It only uses the session created by the institution's own login page. Server-side expiry and multi-factor authentication are authoritative.
