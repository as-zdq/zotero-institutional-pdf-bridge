# Institutional PDF Bridge for Zotero

[English](README.md) | [简体中文](README.zh-CN.md)

Institutional PDF Bridge adds a configurable institutional proxy resolver to Zotero's **Find Available PDF** command. It can transfer an authenticated institutional session to a hidden Zotero browser. New-item PDF lookup is enabled by default, with a two-second debounce and two background download lanes. Automatic lookup never opens a login window; if automatic sign-in is enabled, it can use credentials saved for the configured HTTPS login origin.

## 中文说明

Institutional PDF Bridge 为 Zotero 的“查找可用 PDF”增加可配置的学校或单位访问入口。默认只在机构自己的登录页面中认证；也可以由用户主动把账号和密码保存到 Zotero 的受保护登录管理器。登录成功后会话由 Zotero 的隐藏浏览器使用，登录窗口会自动关闭。

快速开始：从 Release 下载 `.xpi`，在 Zotero 的“工具 > 插件”中选择“从文件安装插件”，再到“设置 > 机构 PDF 桥接”填写机构网关、实际 SSO/CAS 登录地址和代理模式。如需自动登录，勾选自动登录并点击“安全保存凭据”。新条目自动抓取默认开启，等待 2 秒供 Connector 写入元数据后执行；后台不会弹出登录窗口。用户已关闭的自动抓取设置会保留。

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

Users can save credentials either in the settings pane or by submitting them in the visible institutional login page. Login-page capture requires both **Automatically sign in with saved credentials** and **Save credentials entered in the institutional login page**. The plugin does not store credentials in preferences, export cookies, or log credential values. It saves and submits credentials only on an HTTPS origin exactly matching the configured **Login URL**. Server-side expiry and multi-factor authentication remain authoritative. Background login and downloads share session restoration. If silent login cannot complete, automatic lookup stops without opening a viewer.

The institutional network/lookup stages share the configured time budget (30 seconds by default); HTML translation has a five-second sub-limit and is skipped when PDF links are already available. This is not a deadline for Zotero's native fallback, attachment storage, or full-text indexing. Only newly added regular items and their immediate metadata updates trigger automatic lookup. Editing old items does not rescan the library. Invalid legacy auto-delay values above 60 seconds migrate to two seconds; supported custom delays and explicit opt-outs are preserved.

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
