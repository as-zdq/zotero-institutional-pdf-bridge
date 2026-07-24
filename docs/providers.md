# Provider configuration

## Sangfor-compatible WebVPN

Use this mode when proxied targets have the following shape:

```text
https://gateway.example.edu/https/<encoded-host>/path
```

Required fields:

- `gatewayURL`: proxy origin without a trailing slash.
- `loginURL`: interactive institution login entry.
- `cipherKey`: 16 printable ASCII characters from the institution's public WebVPN configuration. This is a gateway compatibility setting, not a user credential.

## URL template

Use this mode when a gateway accepts a complete target URL. The template must contain `{url}`; the plugin replaces it with the percent-encoded target. `{gateway}` expands to the configured gateway URL.

```text
{gateway}/login?url={url}
```

This mode is experimental because EZproxy, OpenAthens, Shibboleth, and custom gateways rewrite hosts and sessions differently.

## Contributing a tested institution

Open a pull request containing:

1. Institution name and public gateway/login URLs.
2. Proxy mode and non-secret settings.
3. Zotero version and plugin version tested.
4. At least two publisher DOI families tested.
5. Whether the visible login window closes and whether the session survives a Zotero restart.

Never include usernames, passwords, cookies, access tokens, private resolver URLs, or copyrighted PDFs.
