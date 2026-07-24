# Institutional PDF Bridge for Zotero

Institutional PDF Bridge adds a configurable institutional proxy resolver to Zotero's **Find Available PDF** command. It opens the institution's login page only when authentication is required, then transfers the authenticated session to a hidden Zotero browser and closes the visible login window. It can optionally find PDFs automatically after a new item finishes importing; automatic lookups only use an existing session and never open a login window.

## Support status

- **Sangfor-compatible WebVPN:** implemented for gateways with the documented encrypted-host URL form.
- **URL-template proxies:** implemented as an experimental adapter for gateways that accept a target URL.
- **Direct authenticated sites:** available for testing institution-specific SSO flows.

Institutional proxies are not standardized. A configuration appearing here means that a contributor has tested it; it does not imply support or endorsement by the institution.

## Install

1. Download the `.xpi` from a release.
2. In Zotero, open **Tools > Plugins**.
3. Open the gear menu and choose **Install Plugin From File**, then select the `.xpi`.
4. Configure the gateway, login entry, and proxy mode under **Settings > Institutional PDF Bridge**.

Do not open the XPI with Zotero from Finder or the command line. Zotero treats files opened
that way as bibliography imports instead of plugin packages.

## Session behavior

Credentials are entered only into the institution's own page. The plugin does not read passwords or copy cookies. After login, it creates a hidden browser in Zotero that shares the institution's browser session and closes the visible window. A session can survive as long as the institution permits its cookies to remain valid; the plugin does not override server expiry or multi-factor authentication policy. New-item lookup is disabled by default. When enabled, it waits 12 seconds so Connector metadata can settle, then silently skips items if the institutional session has expired.

## Development

Requirements: Node.js 20 or newer and the `zip` command.

```bash
npm test
npm run build
```

The XPI is written to `dist/`. Development follows Zotero's bootstrapped plugin model and preference-pane API.

## Privacy and security

- No analytics or telemetry.
- No external service operated by this project.
- No local HTTP endpoint.
- PDF responses must start with `%PDF-` before Zotero imports them.
- The content actor rejects cross-origin fetch instructions.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [docs/providers.md](docs/providers.md) for adding an institution.

## License

MIT
