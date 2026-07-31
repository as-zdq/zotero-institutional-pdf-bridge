# Institutional PDF Bridge for Zotero

[English](README.md) | [简体中文](README.zh-CN.md)

Institutional PDF Bridge adds a configurable institutional proxy resolver to Zotero's **Find Available PDF** command. It opens the institution's login page only when authentication is required, then transfers the authenticated session to a hidden Zotero browser and closes the visible login window. It can optionally find PDFs automatically after a new item finishes importing; automatic lookups only use an existing session and never open a login window.

## 中文说明

Institutional PDF Bridge 为 Zotero 的“查找可用 PDF”增加可配置的学校或单位访问入口。默认只在机构自己的登录页面中认证；也可以由用户主动把账号和密码保存到 Zotero 的受保护登录管理器。登录成功后会话由 Zotero 的隐藏浏览器使用，登录窗口会自动关闭。

快速开始：从 Release 下载 `.xpi`，在 Zotero 的“工具 > 插件”中选择“从文件安装插件”，再到“设置 > Institutional PDF Bridge”填写机构网关、实际 SSO/CAS 登录地址和代理模式。随后可对条目执行“查找可用 PDF”。如需自动登录，勾选自动登录并点击“安全保存凭据”。新条目自动抓取默认关闭，启用后只会复用已有会话，绝不会自动弹出登录窗口或尝试自动登录。

完整中文安装、机构适配与安全说明见 [README.zh-CN.md](README.zh-CN.md)。

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

Users can save credentials either by entering them in the settings pane or by submitting them in the visible institutional login page. Login-page capture requires both **Automatically sign in with saved credentials** and **Save credentials entered in the institutional login page** to be enabled. The plugin does not store credentials in preferences, export cookies, or log credential values. It saves and submits credentials only for an HTTPS page whose origin exactly matches the configured **Login URL**; configure that field as the actual SSO/CAS login page, not merely the WebVPN gateway. After login, the plugin creates a hidden Zotero browser that shares the institutional session and closes the visible window. Server-side expiry and multi-factor authentication remain authoritative. New-item lookup is disabled by default; when enabled, it silently skips items whose existing session has expired and never starts automatic credential login.

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
- Optional credentials are held by Zotero Password Manager, never in plugin preferences or logs.
- Login-page capture is limited to the configured HTTPS login origin and requires explicit automatic-sign-in opt-in.
- Saved credentials are submitted only to the configured HTTPS login origin.
- PDF responses must start with `%PDF-` before Zotero imports them.
- The content actor rejects cross-origin fetch instructions.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [docs/providers.md](docs/providers.md) for adding an institution.

## License

MIT
