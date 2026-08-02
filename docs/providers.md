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

## Dalian University of Technology (大连理工大学)

**Gateway:** `https://webvpn.dlut.edu.cn`
**Login:** `https://webvpn.dlut.edu.cn/login?cas_login=true`
**Mode:** Sangfor-compatible WebVPN
**Cipher key:** `Wxzxvpn2023key@$`

The DLUT WebVPN uses Sangfor-compatible AES-128-CFB host encryption. Fill in the gateway URL, login URL, and cipher key above, select **Sangfor-compatible WebVPN** as the proxy mode, and save. Tested with Nature, IEEE Xplore, ScienceDirect, and Springer.

> ⚠️ **Important:** The default WebVPN login page (`/login`) shows a WeChat QR code. Use `?cas_login=true` to show the **username/password form** — this is the URL the plugin requires.

> ⚠️ **Note:** Session tokens expire after a set period. Re-authenticate via the visible login window when downloads stop working. Credentials (username + student/employee ID) are stored in Zotero's Password Manager and are never written to plugin preferences or logs.

**Tested publishers:** Nature (nature.com), IEEE Xplore, ScienceDirect (sciencedirect.com), Springer (link.springer.com)
**Tested with:** Zotero 7, plugin 0.2.1
**Login window closes:** Yes
**Session survives restart:** Yes (until server-side expiry)

## Contributing a tested institution

Open a pull request containing:

1. Institution name and public gateway/login URLs.
2. Proxy mode and non-secret settings.
3. Zotero version and plugin version tested.
4. At least two publisher DOI families tested.
5. Whether the visible login window closes and whether the session survives a Zotero restart.

Never include usernames, passwords, cookies, access tokens, private resolver URLs, or copyrighted PDFs.
