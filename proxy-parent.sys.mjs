const PREF_BRANCH = "extensions.zotero.institutionalPDFBridge.";

function getStringPref(name, fallback = "") {
  return Services.prefs.getStringPref(PREF_BRANCH + name, fallback).trim();
}

function isCaptureEnabled() {
  return Services.prefs.getBoolPref(PREF_BRANCH + "autoLogin", true) &&
    Services.prefs.getBoolPref(PREF_BRANCH + "captureCredentialsFromLogin", true);
}

function getCredentialContext() {
  const loginURL = getStringPref("loginURL") || getStringPref("gatewayURL");
  const url = new URL(loginURL);
  if (url.protocol !== "https:") {
    throw new Error("机构凭据保存要求登录 URL 使用 HTTPS");
  }
  return {
    origin: url.origin,
    realm: `institutional-pdf-bridge:${url.origin}`
  };
}

function createLogin(origin, realm, username, password) {
  const LoginInfo = Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    "nsILoginInfo",
    "init"
  );
  return new LoginInfo(origin, null, realm, username, password, "username", "password");
}

export class InstitutionalPDFBridgeActorParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name !== "CaptureCredentials") {
      throw new Error(`不支持的机构代理父级消息：${message.name}`);
    }
    if (!isCaptureEnabled()) {
      return { saved: false };
    }

    const username = String(message.data?.username || "").trim();
    const password = String(message.data?.password || "");
    if (!username || !password) {
      return { saved: false };
    }

    const { origin, realm } = getCredentialContext();
    if (new URL(message.data?.url || "").origin !== origin) {
      return { saved: false };
    }

    await Services.logins.initializationPromise;
    const logins = typeof Services.logins.searchLoginsAsync === "function"
      ? await Services.logins.searchLoginsAsync({ origin, httpRealm: realm })
      : Services.logins.findLogins(origin, null, realm);
    for (const login of logins) {
      if (typeof Services.logins.removeLoginAsync === "function") {
        await Services.logins.removeLoginAsync(login);
      } else {
        Services.logins.removeLogin(login);
      }
    }
    const login = createLogin(origin, realm, username, password);
    if (typeof Services.logins.addLoginAsync === "function") {
      await Services.logins.addLoginAsync(login);
    } else {
      Services.logins.addLogin(login);
    }
    return { saved: true };
  }
}
