# Zotero 机构全文桥接

本插件为 Zotero 的“查找可用 PDF”增加可配置的学校或单位代理入口。仅在认证失效时显示机构登录窗口；登录成功后，认证会话转移到 Zotero 内部的隐藏浏览器，可见窗口自动关闭。也可由用户选择在新条目导入后自动查找全文。

## 当前兼容范围

- **Sangfor/WrdVPN 兼容模式：** 支持使用加密主机路径形式的兼容网关。
- **URL 模板模式：** 实验性支持接收目标网址的代理网关。
- **直接认证模式：** 用于测试机构特定的 SSO 流程。

不同机构的代理系统、认证流程和资源授权并不统一，因此不能保证仅修改学校域名即可工作。欢迎提交经过验证且不含账号、Cookie 或其他凭据的机构配置。

## 已知可用的机构

### 大连理工大学 (DUT WebVPN)

- **网关地址：** `https://webvpn.dlut.edu.cn`
- **登录地址：** `https://webvpn.dlut.edu.cn/login?cas_login=true`

> ⚠️ **重要提示：** 默认登录页 `/login` 显示微信二维码。请务必使用 `?cas_login=true` 参数打开**统一身份认证（CAS）登录页面**，输入学号/工号和密码。
- **代理模式：** Sangfor-compatible WebVPN（加密主机路径）
- **加密密钥（Sangfor key）：** `Wxzxvpn2023key@$`

在插件设置页（Settings > Institutional PDF Bridge）中依次填入网关地址、登录地址，选择 **Sangfor-compatible WebVPN** 作为代理模式，填入密钥，保存即可。无需手动加密任何内容。已在 Nature、IEEE Xplore、ScienceDirect、Springer 等出版社测试通过。

> ⚠️ **注意：** WebVPN 会话有效期有限，下载失败时请重新打开登录窗口认证。用户名和密码由 Zotero Password Manager 安全保存，绝不会写入插件偏好设置或日志文件。

**已测试出版社：** Nature (nature.com)、IEEE Xplore、ScienceDirect (sciencedirect.com)、Springer (link.springer.com)
**测试版本：** Zotero 7，插件 0.2.1
**登录窗口自动关闭：** 是
**重启后会话保持：** 是（直到服务端会话过期）

## 安装与使用

1. 打开 Zotero 的“工具 > 插件”，点击右上角齿轮，选择“从文件安装插件”。
2. 选择发布页提供的 `.xpi`；不要在 Finder 中双击或用 Zotero 直接打开 XPI，否则会被当作文献导入。
3. 打开“设置 > Institutional PDF Bridge”。
4. 填写机构网关、登录地址与代理模式。
5. 在文献条目上执行“查找可用 PDF”。

账号密码有两种安全保存方式：在设置页输入后点击“安全保存凭据”，或在可见的机构登录页手动提交。后一种方式要求同时勾选“自动登录”和“保存机构登录页面中输入的凭据”。凭据由 Zotero Password Manager 受保护地保存，不写入插件偏好设置、日志或配置导出。保存和自动填写都只会发生在与“登录 URL（SSO/CAS 页面）”完全同源的 HTTPS 页面，因此应填写实际的统一认证/CAS 登录地址，而不仅是 WebVPN 网关地址。

登录成功后，认证会话会转移到 Zotero 的隐藏浏览器。学校设置的会话有效期、二次认证和风险控制仍然有效，插件不会绕过这些限制。新条目自动查找默认关闭；启用后会等待 12 秒让 Connector 写入 DOI 和网址，只在已有登录会话时静默执行，绝不会因为会话失效而在后台尝试自动登录。

开发和机构适配方法见 [README.md](README.md) 与 [docs/providers.md](docs/providers.md)。项目采用 MIT 许可证。
