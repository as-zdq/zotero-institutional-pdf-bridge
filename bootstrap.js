const PLUGIN_ID = "institutional-pdf-bridge@as-zdq.github.io";
const PREF_BRANCH = "institutionalPDFBridge.";
const GLOBAL_PREF_BRANCH = `extensions.zotero.${PREF_BRANCH}`;
const PREF_NAMES = [
  "enabled",
  "institutionName",
  "gatewayURL",
  "loginURL",
  "mode",
  "urlTemplate",
  "cipherKey",
  "autoCloseLogin",
  "requestTimeoutMs",
  "requestRetryCount",
  "autoFetchNewItems",
  "autoFetchDelayMs",
  "loginPathKeywords",
  "autoLogin",
  "checkLoginOnStartup",
  "captureCredentialsFromLogin"
];

var InstitutionalPDFBridge = {
  originalGetFileResolvers: null,
  originalDownloadFirstAvailableFile: null,
  patchedGetFileResolvers: null,
  patchedDownloadFirstAvailableFile: null,
  importedCryptoKeys: new Map(),
  actorName: "InstitutionalPDFBridgeActor",
  actorChildURL: null,
  actorRegistered: false,
  resourceName: "zotero-institutional-pdf-bridge",
  resourceHandler: null,
  preferencePaneID: null,
  hiddenBrowser: null,
  sessionBrowser: null,
  loginWindow: null,
  loginBrowser: null,
  loginPromise: null,
  sessionPromise: null,
  currentURL: null,
  startupError: null,
  autoFetchNotifierID: null,
  autoFetchTimers: new Map(),
  newItemIDs: new Map(),
  autoFetchRunning: new Set(),
  // Two background lanes share authentication without flooding the gateway.
  autoFetchQueues: [Promise.resolve(), Promise.resolve()],
  autoFetchNextQueue: 0,
  lastAutoFetchStatus: null,
  isShuttingDown: false,

  getPref(name, fallback) {
    const value = Zotero.Prefs.get(PREF_BRANCH + name);
    return value === undefined || value === null || value === "" ? fallback : value;
  },

  getConfig() {
    const gatewayURL = String(this.getPref("gatewayURL", ""))
      .trim()
      .replace(/\/+$/, "");
    const loginURL = String(this.getPref("loginURL", "")).trim();
    const mode = String(this.getPref("mode", "sangfor"));
    const requestTimeoutMs = Math.max(
      5000,
      Math.min(60000, Number(this.getPref("requestTimeoutMs", 30000)) || 30000)
    );
    const requestRetryCount = Math.max(
      0,
      Math.min(3, Math.floor(Number(this.getPref("requestRetryCount", 0)) || 0))
    );
    const autoFetchDelayMs = Math.max(
      2000,
      Math.min(60000, Number(this.getPref("autoFetchDelayMs", 2000)) || 2000)
    );
    let gatewayOrigin = null;
    if (gatewayURL) {
      try {
        gatewayOrigin = new URL(gatewayURL).origin;
      } catch (error) {
        throw new Error("机构代理网关 URL 无效");
      }
    }
    return {
      enabled: Boolean(this.getPref("enabled", true)),
      institutionName: String(this.getPref("institutionName", "机构访问")),
      gatewayURL,
      gatewayOrigin,
      loginURL,
      mode,
      urlTemplate: String(this.getPref("urlTemplate", "{gateway}/login?url={url}")),
      cipherKey: String(this.getPref("cipherKey", "")),
      autoCloseLogin: Boolean(this.getPref("autoCloseLogin", true)),
      requestTimeoutMs,
      requestRetryCount,
      autoFetchNewItems: Boolean(this.getPref("autoFetchNewItems", true)),
      autoFetchDelayMs,
      autoLogin: Boolean(this.getPref("autoLogin", true)),
      checkLoginOnStartup: Boolean(this.getPref("checkLoginOnStartup", true)),
      captureCredentialsFromLogin: Boolean(this.getPref("captureCredentialsFromLogin", true)),
      loginPathKeywords: String(this.getPref(
        "loginPathKeywords",
        "login,cas,auth,sso,saml,oauth"
      )).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
    };
  },

  getCredentialOrigin(config = this.getConfig()) {
    const loginURL = config.loginURL || config.gatewayURL;
    if (!loginURL) {
      throw new Error("请先配置机构登录 URL，再保存凭据");
    }
    let url;
    try {
      url = new URL(loginURL);
    } catch (error) {
      throw new Error("机构登录 URL 无效");
    }
    if (url.protocol !== "https:") {
      throw new Error("保存凭据要求机构登录 URL 使用 HTTPS");
    }
    return url.origin;
  },

  getCredentialRealm(config = this.getConfig()) {
    return `institutional-pdf-bridge:${this.getCredentialOrigin(config)}`;
  },

  async getStoredCredentialLogins(config = this.getConfig()) {
    if (!Services.logins) {
      throw new Error("Zotero 密码管理器不可用");
    }
    await Services.logins.initializationPromise;
    const origin = this.getCredentialOrigin(config);
    const httpRealm = this.getCredentialRealm(config);
    if (typeof Services.logins.searchLoginsAsync === "function") {
      return Services.logins.searchLoginsAsync({ origin, httpRealm });
    }
    return Services.logins.findLogins(origin, null, httpRealm);
  },

  createCredentialLogin(username, password, config = this.getConfig()) {
    const LoginInfo = Components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      "nsILoginInfo",
      "init"
    );
    return new LoginInfo(
      this.getCredentialOrigin(config),
      null,
      this.getCredentialRealm(config),
      username,
      password,
      "username",
      "password"
    );
  },

  async hasStoredCredentials(config = this.getConfig()) {
    return (await this.getStoredCredentialLogins(config)).length > 0;
  },

  async storeCredentials(username, password, config = this.getConfig()) {
    const normalizedUsername = String(username || "").trim();
    const normalizedPassword = String(password || "");
    if (!normalizedUsername || !normalizedPassword) {
      throw new Error("保存凭据前请输入用户名和密码");
    }

    for (const login of await this.getStoredCredentialLogins(config)) {
      if (typeof Services.logins.removeLoginAsync === "function") {
        await Services.logins.removeLoginAsync(login);
      } else {
        Services.logins.removeLogin(login);
      }
    }
    const login = this.createCredentialLogin(normalizedUsername, normalizedPassword, config);
    if (typeof Services.logins.addLoginAsync === "function") {
      await Services.logins.addLoginAsync(login);
    } else {
      Services.logins.addLogin(login);
    }
  },

  async removeStoredCredentials(config = this.getConfig()) {
    const logins = await this.getStoredCredentialLogins(config);
    for (const login of logins) {
      if (typeof Services.logins.removeLoginAsync === "function") {
        await Services.logins.removeLoginAsync(login);
      } else {
        Services.logins.removeLogin(login);
      }
    }
    return logins.length;
  },

  async getStoredCredentials(config = this.getConfig()) {
    const login = (await this.getStoredCredentialLogins(config))[0];
    if (!login) {
      return null;
    }
    return { username: login.username, password: login.password };
  },

  isCredentialLoginURL(value, config = this.getConfig()) {
    try {
      return new URL(value).origin === this.getCredentialOrigin(config);
    } catch (error) {
      return false;
    }
  },

  async submitStoredCredentials(browser, state, config = this.getConfig()) {
    if (!config.autoLogin || !state?.hasPasswordField || !this.isCredentialLoginURL(state.url, config)) {
      return false;
    }
    const credentials = await this.getStoredCredentials(config);
    if (!credentials) {
      return false;
    }
    const actor = await this.waitForActor(browser);
    const result = await actor.sendQuery("FillLogin", credentials);
    this.lastAutoLoginStatus = {
      submitted: Boolean(result?.submitted),
      usernameFilled: Boolean(result?.usernameFilled),
      origin: this.getCredentialOrigin(config)
    };
    if (!result?.submitted) {
      throw new Error("无法自动提交机构登录表单");
    }
    Zotero.debug(`Submitted stored institutional credentials to ${this.getCredentialOrigin(config)}`);
    return true;
  },

  async tryStoredCredentialLogin(browser, state, config, attempts) {
    if (!this.isCredentialLoginURL(state?.url, config)) {
      return false;
    }
    const loginKey = new URL(state.url).pathname;
    if (attempts.has(loginKey)) {
      return false;
    }
    const submitted = await this.submitStoredCredentials(browser, state, config);
    if (submitted) {
      attempts.add(loginKey);
    }
    return submitted;
  },

  async watchInteractiveLogin(browser, state, config = this.getConfig()) {
    if (
      !config.autoLogin ||
      !config.captureCredentialsFromLogin ||
      !state?.hasPasswordField ||
      !this.isCredentialLoginURL(state.url, config)
    ) {
      return false;
    }
    const actor = await this.waitForActor(browser);
    await actor.sendQuery("WatchLogin", {});
    return true;
  },

  async register(rootURI) {
    this.isShuttingDown = false;
    this.migrateDoublePrefixedPreferences();
    this.migrateLegacyRequestPolicy();
    this.registerResourceRoot(rootURI);
    this.actorChildURL = `resource://${this.resourceName}/proxy-child.sys.mjs`;
    this.registerWindowActor();
    this.patchFindAvailableFiles();
    this.registerAutoFetch();
    this.preferencePaneID = await Zotero.PreferencePanes.register({
      pluginID: PLUGIN_ID,
      src: rootURI + "preferences.xhtml",
      scripts: [rootURI + "preferences.js"],
      stylesheets: [rootURI + "preferences.css"],
      label: "机构 PDF 桥接",
      image: rootURI + "icon.svg"
    });
    Zotero.InstitutionalPDFBridge = this;
    this.scheduleStartupLoginCheck();
  },

  scheduleStartupLoginCheck() {
    return (async () => {
      await Zotero.Promise.delay(1500);
      if (this.isShuttingDown) {
        return;
      }
      const config = this.getConfig();
      if (!config.enabled || !config.autoLogin || !config.checkLoginOnStartup) {
        return;
      }
      try {
        await this.ensureSessionBrowser({ interactive: false });
        Zotero.debug("机构代理启动登录检查完成");
      } catch (error) {
        Zotero.debug(`机构代理启动登录检查未完成：${error}`);
      }
    })().catch((error) => Zotero.logError(error));
  },

  migrateDoublePrefixedPreferences() {
    const incorrectBranch = `extensions.zotero.${GLOBAL_PREF_BRANCH}`;
    for (const name of PREF_NAMES) {
      const incorrectName = incorrectBranch + name;
      if (!Zotero.Prefs.prefHasUserValue(incorrectName, true)) {
        continue;
      }
      if (!Zotero.Prefs.prefHasUserValue(PREF_BRANCH + name)) {
        Zotero.Prefs.set(PREF_BRANCH + name, Zotero.Prefs.get(incorrectName, true));
      }
      Zotero.Prefs.clear(incorrectName, true);
    }
  },

  migrateLegacyRequestPolicy() {
    const autoDelayName = PREF_BRANCH + "autoFetchDelayMs";
    if (Number(Zotero.Prefs.get(autoDelayName)) > 60000) {
      Zotero.Prefs.set(autoDelayName, 2000);
    }
    const timeoutName = PREF_BRANCH + "requestTimeoutMs";
    if (
      Zotero.Prefs.prefHasUserValue(timeoutName) &&
      Number(Zotero.Prefs.get(timeoutName)) > 60000
    ) {
      Zotero.Prefs.set(timeoutName, 30000);
    }

    const retryName = PREF_BRANCH + "requestRetryCount";
    if (
      Zotero.Prefs.prefHasUserValue(retryName) &&
      Number(Zotero.Prefs.get(retryName)) === 1
    ) {
      Zotero.Prefs.set(retryName, 0);
    }
  },

  registerAutoFetch() {
    if (this.autoFetchNotifierID || !Zotero.Notifier) {
      return;
    }
    this.autoFetchNotifierID = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        if (type !== "item" || (event !== "add" && event !== "modify")) {
          return;
        }
        for (const itemID of ids) {
          if (event === "add" && Zotero.Items.get(itemID)?.isRegularItem?.()) {
            this.newItemIDs.set(itemID, Date.now() + 120000);
          }
          if ((this.newItemIDs.get(itemID) || 0) > Date.now()) {
            this.scheduleAutoFetch(itemID);
          }
        }
        for (const [id, expires] of this.newItemIDs) {
          if (expires <= Date.now()) this.newItemIDs.delete(id);
        }
      }
    }, ["item"], PLUGIN_ID);
  },

  unregisterAutoFetch() {
    if (this.autoFetchNotifierID) {
      Zotero.Notifier.unregisterObserver(this.autoFetchNotifierID);
      this.autoFetchNotifierID = null;
    }
    this.autoFetchTimers.clear();
    this.newItemIDs.clear();
    this.autoFetchRunning.clear();
    this.autoFetchQueues = [Promise.resolve(), Promise.resolve()];
    this.autoFetchNextQueue = 0;
  },

  scheduleAutoFetch(itemID) {
    let config;
    try {
      config = this.getConfig();
    } catch (error) {
      Zotero.logError(error);
      return;
    }
    if (!config.enabled || !config.autoFetchNewItems || this.isShuttingDown) {
      return;
    }

    // Connector imports commonly update DOI/URL immediately after creating the item.
    // A token makes each item a debounce rather than starting competing downloads.
    const token = Symbol(String(itemID));
    this.autoFetchTimers.set(itemID, token);
    (async () => {
      await Zotero.Promise.delay(config.autoFetchDelayMs);
      if (this.autoFetchTimers.get(itemID) !== token || this.isShuttingDown) {
        return;
      }
      this.autoFetchTimers.delete(itemID);
      if (this.autoFetchRunning.has(itemID)) {
        return;
      }
      this.autoFetchRunning.add(itemID);
      const lane = this.autoFetchNextQueue++ % this.autoFetchQueues.length;
      this.autoFetchQueues[lane] = this.autoFetchQueues[lane]
        .catch((error) => Zotero.logError(error))
        .then(() => this.autoFetchItem(itemID))
        .catch((error) => Zotero.logError(error))
        .finally(() => this.autoFetchRunning.delete(itemID));
    })();
  },

  async autoFetchItem(itemID) {
    if (this.isShuttingDown) {
      return false;
    }
    const config = this.getConfig();
    if (!config.enabled || !config.autoFetchNewItems) {
      return false;
    }

    const item = Zotero.Items.get(itemID);
    if (!item?.isRegularItem?.() || this.itemHasPDFAttachment(item)) {
      return false;
    }
    const doi = Zotero.Utilities.cleanDOI(item.getField("DOI") || item.getExtraField("DOI"));
    if (!doi && !item.getField("url")) {
      return false;
    }
    this.newItemIDs.delete(itemID);
    if (
      Zotero.Attachments.canFindFileForItem &&
      !Zotero.Attachments.canFindFileForItem(item)
    ) {
      return false;
    }

    const startedAt = Date.now();
    this.lastAutoFetchStatus = { itemID, state: "running", startedAt };
    try {
      const attachment = await Zotero.Attachments.addFileFromURLs(
        item,
        [this.createProxyResolver(item, false)]
      );
      if (attachment) {
        Zotero.debug(`Institutional PDF downloaded automatically for item ${itemID}`);
      }
      this.lastAutoFetchStatus = {
        itemID, state: attachment ? "downloaded" : "not-found", elapsedMs: Date.now() - startedAt
      };
      return Boolean(attachment);
    } catch (error) {
      // Background lookup must not open the login viewer or surface an alert.
      Zotero.debug(`Institutional PDF automatic lookup skipped for item ${itemID}: ${error}`);
      this.lastAutoFetchStatus = { itemID, state: "failed", elapsedMs: Date.now() - startedAt };
      return false;
    }
  },

  itemHasPDFAttachment(item) {
    for (const attachmentID of item.getAttachments?.() || []) {
      const attachment = Zotero.Items.get(attachmentID);
      const contentType = attachment?.attachmentContentType || attachment?.getField?.("contentType");
      if (/^application\/pdf(?:;|$)/i.test(contentType || "")) {
        return true;
      }
    }
    return false;
  },

  createProxyResolver(item, interactive = true) {
    const marker = async function () {
      return [];
    };
    marker.__institutionalProxyItem = item;
    marker.__institutionalProxyInteractive = interactive;
    return marker;
  },

  patchFindAvailableFiles() {
    if (this.originalGetFileResolvers) {
      return;
    }

    const bridge = this;
    this.originalGetFileResolvers = Zotero.Attachments.getFileResolvers;
    this.originalDownloadFirstAvailableFile = Zotero.Attachments.downloadFirstAvailableFile;

    this.patchedGetFileResolvers = function (item, methods, automatic) {
      const resolvers = bridge.originalGetFileResolvers.call(this, item, methods, automatic);
      const doi = Zotero.Utilities.cleanDOI(item.getField("DOI") || item.getExtraField("DOI"));
      const requested = !methods || methods.includes("doi") || methods.includes("institutional-proxy");
      let enabled = false;
      try {
        enabled = bridge.getConfig().enabled;
      } catch (error) {
        Zotero.logError(error);
      }

      if (enabled && (doi || item.getField("url")) && requested && !automatic) {
        resolvers.push(bridge.createProxyResolver(item, true));
      }
      return resolvers;
    };

    this.patchedDownloadFirstAvailableFile = async function (urlResolvers, path, options) {
      const proxyResolvers = urlResolvers.filter((resolver) => resolver?.__institutionalProxyItem);
      const standardResolvers = urlResolvers.filter((resolver) => !resolver?.__institutionalProxyItem);

      for (const resolver of proxyResolvers) {
        try {
          options?.onAccessMethodStart?.(bridge.getConfig().institutionName);
          const result = await bridge.downloadViaProxy(resolver.__institutionalProxyItem, path, {
            interactive: resolver.__institutionalProxyInteractive !== false
          });
          if (bridge.itemHasPDFAttachment(resolver.__institutionalProxyItem)) {
            if (result) await Zotero.File.removeIfExists(path);
            return false;
          }
          if (result) {
            return result;
          }
        } catch (error) {
          Zotero.logError(error);
        }
      }

      if (proxyResolvers.some(resolver => bridge.itemHasPDFAttachment(resolver.__institutionalProxyItem))) {
        return false;
      }
      return bridge.originalDownloadFirstAvailableFile.call(
        this,
        standardResolvers,
        path,
        options
      );
    };

    Zotero.Attachments.getFileResolvers = this.patchedGetFileResolvers;
    Zotero.Attachments.downloadFirstAvailableFile = this.patchedDownloadFirstAvailableFile;
  },

  unpatchFindAvailableFiles() {
    if (Zotero.Attachments.getFileResolvers === this.patchedGetFileResolvers) {
      Zotero.Attachments.getFileResolvers = this.originalGetFileResolvers;
    }
    if (Zotero.Attachments.downloadFirstAvailableFile === this.patchedDownloadFirstAvailableFile) {
      Zotero.Attachments.downloadFirstAvailableFile = this.originalDownloadFirstAvailableFile;
    }
    this.originalGetFileResolvers = null;
    this.originalDownloadFirstAvailableFile = null;
    this.patchedGetFileResolvers = null;
    this.patchedDownloadFirstAvailableFile = null;
  },

  async withinDeadline(promise, deadline, stage) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      Promise.resolve(promise).catch(() => {});
      throw new Error(`${stage}超时`);
    }
    const win = Services.appShell.hiddenDOMWindow;
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = win.setTimeout(() => reject(new Error(`${stage}超时`)), Math.max(0, remaining));
        })
      ]);
    } finally {
      win.clearTimeout(timer);
    }
  },

  async downloadViaProxy(item, path, { interactive = true } = {}) {
    const doi = Zotero.Utilities.cleanDOI(item.getField("DOI") || item.getExtraField("DOI"));
    const itemURL = item.getField("url");
    const sourceURL = itemURL || (doi ? `https://doi.org/${encodeURIComponent(doi)}` : "");
    if (!sourceURL) {
      return false;
    }

    const config = this.getConfig();
    if (!config.gatewayURL) {
      throw new Error("查找 PDF 前请先配置机构网关");
    }
    Zotero.debug(`Looking for ${doi || sourceURL} via ${config.institutionName}`);
    const deadline = Date.now() + config.requestTimeoutMs;
    const nextRequestConfig = () => {
      const remaining = deadline - Date.now();
      return remaining > 0 ? {
        ...config,
        deadline,
        requestTimeoutMs: Math.min(15000, remaining),
        requestRetryCount: 0
      } : null;
    };
    const pageURL = await this.toProxyURL(sourceURL, config);
    const pageConfig = nextRequestConfig();
    if (!pageConfig) {
      return false;
    }
    const page = await this.withinDeadline(
      this.getAuthenticatedPage(pageURL, pageConfig, interactive), deadline, "机构页面读取"
    );

    if (this.isPDFContentType(page.contentType)) {
      if (this.itemHasPDFAttachment(item)) return false;
      await this.writeValidatedPDF(path, page.blob);
      return this.makeDownloadResult(page.responseURL || sourceURL, null, config);
    }
    if (!page.document) {
      return false;
    }

    const candidates = await this.withinDeadline(this.findPDFCandidates(
      page.document,
      page.responseURL || pageURL,
      doi
    ), deadline, "PDF 链接解析");
    for (const candidate of candidates) {
      const requestConfig = nextRequestConfig();
      if (!requestConfig) {
        break;
      }
      const proxiedCandidate = await this.toProxyURL(candidate.url, config);
      try {
        const response = await this.withinDeadline(
          this.fetchPage(proxiedCandidate, requestConfig, false, interactive), deadline, "PDF 下载"
        );
        // A Connector download may have completed while this lookup was in flight.
        if (this.itemHasPDFAttachment(item)) return false;
        await this.writeValidatedPDF(path, response.blob);
        return this.makeDownloadResult(
          candidate.originalURL || candidate.url,
          candidate.title,
          config
        );
      } catch (error) {
        Zotero.debug(`Institutional PDF candidate failed: ${candidate.url}\n${error}`);
      }
    }
    return false;
  },

  makeDownloadResult(url, title, config) {
    return {
      title: title || Zotero.getString("attachment.fullText"),
      mimeType: "application/pdf",
      url,
      props: {
        accessMethod: config.institutionName,
        articleVersion: "publishedVersion"
      }
    };
  },

  async getAuthenticatedPage(pageURL, config, interactive = true) {
    let page = await this.fetchPage(pageURL, config, true, interactive);
    if (config.deadline && Date.now() >= config.deadline) throw new Error("机构页面读取超时");
    if (!this.isLoginPage(page, config)) {
      return page;
    }

    if (!interactive) {
      await this.clearSession();
      throw new Error("自动查找需要先登录机构代理");
    }
    await this.clearSession();
    if (config.deadline && Date.now() >= config.deadline) throw new Error("机构登录超时");
    await this.ensureSessionBrowser({ interactive: true, forceLogin: true, deadline: config.deadline });
    page = await this.fetchPage(pageURL, config, true, true);
    if (this.isLoginPage(page, config)) {
      throw new Error("机构代理登录尚未完成");
    }
    return page;
  },

  async fetchPage(url, config, allowNavigation, interactive = true) {
    const browser = await this.ensureSessionBrowser({ interactive, deadline: config.deadline });
    if (config.deadline && Date.now() >= config.deadline) throw new Error("机构请求超时");
    let lastError;
    for (let attempt = 0; attempt <= config.requestRetryCount; attempt++) {
      try {
        let response;
        if (allowNavigation && config.mode !== "sangfor") {
          response = await this.navigateAndRead(browser, url, config);
        } else {
          response = await this.fetchViaBrowser(browser, url, Math.min(
            config.requestTimeoutMs, config.deadline ? config.deadline - Date.now() : Infinity
          ));
        }
        if (!response.ok) {
          const error = new Error(`Institutional proxy request failed with HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }

        const contentType = response.contentType || "";
        const BlobConstructor = Services.appShell.hiddenDOMWindow.Blob;
        const blob = new BlobConstructor([response.bytes], { type: contentType });
        let document = null;
        if (contentType.toLowerCase().startsWith("text/html")) {
          document = await Zotero.Utilities.Internal.blobToHTMLDocument(
            blob,
            response.responseURL || url
          );
        }
        return {
          blob,
          contentType,
          document,
          responseURL: response.responseURL || url
        };
      } catch (error) {
        lastError = error;
        if (attempt >= config.requestRetryCount || !this.isRetryableRequestError(error)) {
          throw error;
        }
        const delay = Math.min(5000, 1000 * (attempt + 1));
        Zotero.debug(
          `Institutional proxy request retry ${attempt + 1}/${config.requestRetryCount} in ${delay}ms: ${error}`
        );
        await Zotero.Promise.delay(delay);
      }
    }
    throw lastError;
  },

  isRetryableRequestError(error) {
    const status = Number(error?.status);
    return !Number.isInteger(status) || status === 408 || status === 425 || status === 429 || status >= 500;
  },

  async fetchViaBrowser(browser, url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const actor = await this.withinDeadline(this.waitForActor(browser), deadline, "内容组件等待");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("机构请求超时");
    return this.withinDeadline(actor.sendQuery("Fetch", { url, timeoutMs: remaining }), deadline, "机构请求");
  },

  async navigateAndRead(browser, url, config) {
    if (!this.hiddenBrowser || browser !== this.hiddenBrowser) {
      return this.fetchViaBrowser(browser, url, config.requestTimeoutMs);
    }
    const deadline = config.deadline || Date.now() + config.requestTimeoutMs;
    const wait = promise => this.withinDeadline(promise, deadline, "代理页面导航");
    await wait(browser.load(url));
    try {
      await wait(browser.waitForDocument({ allowInteractiveAfter: 1500 }));
    } catch (error) {
      Zotero.debug(`Proxy navigation document wait failed: ${error}`);
    }
    const actor = await wait(this.waitForActor(browser));
    const state = await wait(actor.sendQuery("State", {}));
    this.currentURL = state.url || null;
    if (Date.now() >= deadline) throw new Error("代理页面导航超时");
    return this.fetchViaBrowser(browser, state.url || url, deadline - Date.now());
  },

  isLoginPage(page, config) {
    if (page.document?.querySelector('input[type="password"], #cas-login, form[action*="login"]')) {
      return true;
    }
    return this.isLoginState({ url: page.responseURL || "", hasPasswordField: false }, config);
  },

  isLoginState(state, config) {
    if (!state?.url || state.url === "about:blank") {
      return true;
    }
    try {
      const url = new URL(state.url);
      const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
      if (config.loginPathKeywords.some((keyword) => haystack.includes(keyword))) {
        return true;
      }
      if (url.origin === config.gatewayOrigin && (url.pathname === "/" || !url.pathname)) {
        return false;
      }
      return state.hasPasswordField;
    } catch (error) {
      return true;
    }
  },

  async ensureSessionBrowser({ interactive = true, forceLogin = false, deadline } = {}) {
    const config = this.getConfig();
    if (!config.enabled || !config.gatewayURL) throw new Error("请先启用并配置机构代理网关");
    deadline = deadline || Date.now() + config.requestTimeoutMs;
    if (this.loginPromise) return this.withinDeadline(this.loginPromise, deadline, "机构登录");
    if (!forceLogin) {
      if (!this.sessionPromise) {
        this.sessionPromise = this.restoreSessionBrowser(Math.min(deadline, Date.now() + 20000))
          .finally(() => { this.sessionPromise = null; });
      }
      try {
        return await this.withinDeadline(this.sessionPromise, deadline, "机构会话检查");
      } catch (error) {
        if (!interactive || Date.now() >= deadline) throw error;
      }
    }
    return this.openInteractiveLogin({ ...config, deadline });
  },

  async restoreSessionBrowser(deadline) {
    const config = this.getConfig();
    if (!config.enabled) {
      throw new Error("机构 PDF 桥接已禁用");
    }
    if (!config.gatewayURL) {
      throw new Error("尚未配置机构代理网关 URL");
    }

    if (this.sessionBrowser) {
      try {
        const state = await this.withinDeadline(this.getBrowserState(this.sessionBrowser), deadline, "会话状态检查");
        if (!this.isLoginState(state, config)) {
          this.currentURL = state.url;
          return this.sessionBrowser;
        }
      } catch (error) {
        Zotero.debug(`Existing proxy session is unavailable: ${error}`);
      }
      await this.clearSession();
    }

    if (Date.now() < deadline) {
      try {
        // A gateway home page may only offer an SSO link, not a login form.
        const state = await this.createHiddenSession(config.loginURL || config.gatewayURL, deadline);
        if (!this.isLoginState(state, config)) {
          return this.sessionBrowser;
        }
      } catch (error) {
        Zotero.debug(`Silent proxy session restore failed: ${error}`);
      }
      await this.clearSession();
    }

    throw new Error("机构后台登录未完成，请在插件设置中检查登录状态");
  },

  async createHiddenSession(sourceURL, deadline = Date.now() + 20000) {
    const wait = async (promise) => {
      const result = await this.withinDeadline(promise, deadline, "机构后台登录");
      if (this.hiddenBrowser !== browser) throw new Error("机构会话已取消");
      return result;
    };
    await this.destroyHiddenBrowser();
    const { HiddenBrowser } = ChromeUtils.importESModule(
      "chrome://zotero/content/HiddenBrowser.mjs"
    );
    const browser = new HiddenBrowser({ useHiddenFrame: false });
    this.hiddenBrowser = browser;
    this.sessionBrowser = browser;
    await wait(browser._createdPromise);
    await wait(browser.load(sourceURL));
    try {
      await wait(browser.waitForDocument({ allowInteractiveAfter: 1500 }));
    } catch (error) {
      Zotero.debug(`Hidden proxy browser document wait failed: ${error}`);
    }
    let state = await wait(this.getBrowserState(browser));
    const config = this.getConfig();
    if (this.isLoginState(state, config)) {
      try {
        let submitted = false;
        for (let attempt = 0; attempt < 20 && this.isLoginState(state, config); attempt++) {
          if (Date.now() >= deadline) throw new Error("机构后台登录超时");
          submitted = await wait(this.submitStoredCredentials(browser, state, config));
          if (submitted) {
            break;
          }
          await Zotero.Promise.delay(250);
          state = await wait(this.getBrowserState(browser));
        }
        if (submitted) {
          for (let attempt = 0; attempt < 120; attempt++) {
            await Zotero.Promise.delay(250);
            if (Date.now() >= deadline) throw new Error("机构后台登录超时");
            try {
              state = await wait(this.getBrowserState(browser));
            } catch (error) {
              if (Date.now() >= deadline) throw error;
              continue; // Navigation temporarily replaces the content actor.
            }
            if (!this.isLoginState(state, config)) {
              Zotero.debug("已使用保存的凭据静默登录机构代理");
              break;
            }
          }
        }
      } catch (error) {
        Zotero.debug(`机构代理静默登录失败：${error}`);
      }
    }
    this.currentURL = state.url || null;
    return state;
  },

  async openInteractiveLogin(config = this.getConfig()) {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    const win = Zotero.openInViewer(config.loginURL || config.gatewayURL, {
      allowJavaScript: true
    });
    this.loginWindow = win;
    this.loginPromise = new Promise((resolve, reject) => {
      let pollTimer;
      let timeoutTimer;
      let finished = false;
      let checking = false;
      const autoLoginAttempts = new Set();

      const cleanup = () => {
        win.clearTimeout(timeoutTimer);
        if (pollTimer) {
          win.clearInterval(pollTimer);
        }
      };
      const fail = (message) => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        this.loginWindow = null;
        this.loginBrowser = null;
        this.loginPromise = null;
        reject(new Error(message));
        if (!win.closed) win.close();
      };
      const succeed = async () => {
        if (finished) {
          return;
        }
        try {
          const visibleState = await this.getBrowserState(this.loginBrowser);
          const hiddenState = await this.createHiddenSession(visibleState.url || config.gatewayURL, config.deadline);
          if (finished) return;
          if (this.isLoginState(hiddenState, config)) {
            throw new Error("无法将已认证会话转移到后台浏览器");
          }
          Zotero.debug("Institutional proxy session transferred to hidden browser");
          finished = true;
          cleanup();
          const browser = this.sessionBrowser;
          this.loginBrowser = null;
          this.loginWindow = null;
          this.loginPromise = null;
          if (config.autoCloseLogin && !win.closed) {
            win.close();
            Zotero.debug("Institutional proxy login window closed");
          }
          resolve(browser);
        } catch (error) {
          if (finished) return;
          Zotero.debug(`Keeping the visible proxy browser: ${error}`);
          finished = true;
          cleanup();
          await this.destroyHiddenBrowser();
          this.sessionBrowser = this.loginBrowser;
          this.currentURL = (await this.getBrowserState(this.loginBrowser)).url;
          this.loginPromise = null;
          resolve(this.sessionBrowser);
        }
      };
      const checkPage = async () => {
        if (checking || finished || !this.loginBrowser) {
          return;
        }
        checking = true;
        try {
          const state = await this.getBrowserState(this.loginBrowser);
          this.currentURL = state.url || null;
          if (this.isLoginState(state, config)) {
            try {
              await this.watchInteractiveLogin(this.loginBrowser, state, config);
            } catch (error) {
              Zotero.debug(`Manual credential capture is unavailable: ${error}`);
            }
            try {
              await this.tryStoredCredentialLogin(
                this.loginBrowser,
                state,
                config,
                autoLoginAttempts
              );
            } catch (error) {
              Zotero.debug(`Automatic institutional login skipped: ${error}`);
            }
          } else {
            await succeed();
          }
        } catch (error) {
          Zotero.debug(`Waiting for institutional proxy authentication: ${error}`);
        } finally {
          checking = false;
        }
      };
      const initializeViewer = () => {
        if (finished) return;
        this.loginBrowser = win.document.querySelector("browser");
        if (!this.loginBrowser) {
          fail("无法创建机构代理登录浏览器");
          return;
        }
        pollTimer = win.setInterval(checkPage, 750);
        win.addEventListener("unload", () => {
          if (!finished) {
            fail("机构代理登录窗口在认证完成前已关闭");
          }
        }, { once: true });
        checkPage();
      };

      timeoutTimer = win.setTimeout(() => fail("机构登录超时，请在设置中单独完成登录"),
        Math.max(0, (config.deadline || Date.now() + config.requestTimeoutMs) - Date.now()));

      if (win.document.readyState === "complete") {
        win.setTimeout(initializeViewer, 0);
      } else {
        win.addEventListener("load", () => win.setTimeout(initializeViewer, 0), { once: true });
      }
    });
    return this.loginPromise;
  },

  async getBrowserState(browser) {
    const actor = await this.waitForActor(browser);
    return actor.sendQuery("State", {});
  },

  async waitForActor(browser) {
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const actor = browser?.browsingContext?.currentWindowGlobal?.getActor(this.actorName);
        if (actor) {
          return actor;
        }
      } catch (error) {
        // Navigations briefly expose about:blank, where the actor is unavailable.
        lastError = error;
      }
      await Zotero.Promise.delay(100);
    }
    const detail = lastError?.message ? `: ${lastError.message}` : "";
    throw new Error(`机构代理内容组件尚未就绪${detail}`);
  },

  async openLogin() {
    await this.clearSession();
    return this.ensureSessionBrowser({ interactive: true, forceLogin: true });
  },

  async reloadConfiguration() {
    await this.clearSession();
    this.importedCryptoKeys.clear();
  },

  async clearSession() {
    this.sessionBrowser = null;
    this.currentURL = null;
    await this.destroyHiddenBrowser();
    if (this.loginWindow && !this.loginWindow.closed) {
      this.loginWindow.close();
    }
    this.loginWindow = null;
    this.loginBrowser = null;
    this.loginPromise = null;
  },

  async destroyHiddenBrowser() {
    if (this.hiddenBrowser) {
      this.hiddenBrowser.destroy();
      this.hiddenBrowser = null;
    }
  },

  async findPDFCandidates(document, pageURL, doi) {
    const candidates = [];
    const seen = new Set();
    const add = (value, title) => {
      if (!value) {
        return;
      }
      try {
        const url = new URL(value, pageURL).href;
        if (!seen.has(url)) {
          seen.add(url);
          candidates.push({ url, originalURL: url, title });
        }
      } catch (error) {
        Zotero.debug(`Ignoring invalid PDF URL ${value}`);
      }
    };

    if (doi) {
      const encodedDOI = encodeURI(doi);
      if (doi.startsWith("10.1126/")) {
        add(`https://www.science.org/doi/pdf/${encodedDOI}`, "Full Text PDF");
        add(`https://www.science.org/doi/epdf/${encodedDOI}`, "Full Text PDF");
      } else if (doi.startsWith("10.1021/")) {
        add(`https://pubs.acs.org/doi/pdf/${encodedDOI}`, "Full Text PDF");
      } else if (doi.startsWith("10.1146/")) {
        add(`https://www.annualreviews.org/doi/pdf/${encodedDOI}`, "Full Text PDF");
        add(`https://www.annualreviews.org/doi/epdf/${encodedDOI}`, "Full Text PDF");
      } else if (doi.startsWith("10.1117/")) {
        add(`https://www.spiedigitallibrary.org/doi/pdf/${encodedDOI}`, "Full Text PDF");
      }
    }

    const metadataSelectors = [
      ['meta[name="citation_pdf_url"]', "content"],
      ['meta[name="eprints.document_url"]', "content"],
      ['meta[property="og:pdf"]', "content"],
      ['link[type="application/pdf"]', "href"],
      ['a[type="application/pdf"]', "href"],
      ['a[data-download-url]', "data-download-url"],
      ['a[data-url*="pdf" i]', "data-url"],
      ['a[href*="/article-pdf/"]', "href"],
      ['a[href*="/doi/epdf/"]', "href"]
    ];
    for (const [selector, attribute] of metadataSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        add(element.getAttribute(attribute));
      }
    }

    for (const element of document.querySelectorAll('a[href]')) {
      const href = element.getAttribute("href");
      const label = element.textContent.trim();
      if (href && (
        /(?:\.pdf(?:$|[?#])|\/pdf(?:$|[/?#])|\/article-pdf\/|\/doi\/epdf\/|pdfdownload|downloadpdf)/i.test(href) ||
        /^(?:download\s+)?(?:full\s+text\s+)?pdf$/i.test(label)
      )) {
        add(href, label || undefined);
      }
      if (candidates.length >= 24) {
        break;
      }
    }
    // Avoid translator network calls when the page already exposes PDF links.
    if (!candidates.length) {
      try {
        const translated = await this.withinDeadline(
          Zotero.Utilities.Internal.getFileFromDocument(document), Date.now() + 5000, "网页解析"
        );
        if (translated) add(translated.url, translated.title);
      } catch (error) {
        Zotero.debug(`Institutional proxy page translation failed: ${error}`);
      }
    }
    return candidates;
  },

  isPDFContentType(contentType) {
    return /^application\/pdf(?:;|$)/i.test(contentType || "");
  },

  async writeValidatedPDF(path, blob) {
    try {
      await Zotero.File.putContentsAsync(path, blob);
      const sample = await Zotero.File.getContentsAsync(path, null, 5);
      if (sample !== "%PDF-") {
        throw new Error("机构代理返回的内容不是 PDF");
      }
    } catch (error) {
      await Zotero.File.removeIfExists(path);
      throw error;
    }
  },

  async toProxyURL(value, config = this.getConfig()) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`不支持的代理目标协议：${url.protocol}`);
    }
    if (this.isLikelyProxiedURL(url, config)) {
      return url.href;
    }

    if (config.mode === "direct") {
      return url.href;
    }
    if (config.mode === "template") {
      if (!config.urlTemplate.includes("{url}")) {
        throw new Error("代理 URL 模板必须包含 {url}");
      }
      return config.urlTemplate
        .replaceAll("{gateway}", config.gatewayURL)
        .replaceAll("{url}", encodeURIComponent(url.href));
    }
    if (config.mode !== "sangfor") {
      throw new Error(`不支持的机构代理模式：${config.mode}`);
    }
    if (config.cipherKey.length !== 16 || /[^\x20-\x7E]/.test(config.cipherKey)) {
      throw new Error("深信服兼容密钥必须是 16 个 ASCII 字符");
    }

    const protocol = url.protocol.slice(0, -1);
    const encryptedHost = await this.encryptHost(url.host, config.cipherKey);
    return `${config.gatewayOrigin}/${protocol}/${encryptedHost}${url.pathname}${url.search}${url.hash}`;
  },

  isLikelyProxiedURL(url, config) {
    if (!config.gatewayURL || !config.gatewayOrigin) {
      return false;
    }
    const gatewayHost = new URL(config.gatewayURL).hostname;
    return url.origin === config.gatewayOrigin ||
      url.hostname === gatewayHost ||
      url.hostname.endsWith(`.${gatewayHost}`);
  },

  async encryptHost(host, cipherKey) {
    const keyBytes = this.asciiBytes(cipherKey);
    const iv = this.asciiBytes(cipherKey);
    const originalLength = host.length;
    const paddedHost = host + "0".repeat((16 - host.length % 16) % 16);
    const plaintext = this.asciiBytes(paddedHost);
    const ciphertext = new Uint8Array(plaintext.length);
    let state = iv;

    if (!this.importedCryptoKeys.has(cipherKey)) {
      const subtle = Services.appShell.hiddenDOMWindow.crypto.subtle;
      this.importedCryptoKeys.set(cipherKey, subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-CBC" },
        false,
        ["encrypt"]
      ));
    }
    const cryptoKey = await this.importedCryptoKeys.get(cipherKey);
    const subtle = Services.appShell.hiddenDOMWindow.crypto.subtle;
    const zeroIV = new Uint8Array(16);

    for (let offset = 0; offset < plaintext.length; offset += 16) {
      const encrypted = new Uint8Array(await subtle.encrypt(
        { name: "AES-CBC", iv: zeroIV },
        cryptoKey,
        state
      ));
      const block = new Uint8Array(16);
      for (let index = 0; index < 16; index++) {
        block[index] = plaintext[offset + index] ^ encrypted[index];
        ciphertext[offset + index] = block[index];
      }
      state = block;
    }
    return this.toHex(iv) + this.toHex(ciphertext.slice(0, originalLength));
  },

  asciiBytes(value) {
    return Uint8Array.from(value, (character) => character.charCodeAt(0));
  },

  toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  },

  registerWindowActor() {
    ChromeUtils.registerWindowActor(this.actorName, {
      parent: {
        esModuleURI: `resource://${this.resourceName}/proxy-parent.sys.mjs`
      },
      child: { esModuleURI: this.actorChildURL },
      matches: ["https://*/*", "http://*/*"],
      allFrames: false
    });
    this.actorRegistered = true;
  },

  registerResourceRoot(rootURI) {
    const handler = Services.io.getProtocolHandler("resource").QueryInterface(
      Components.interfaces.nsIResProtocolHandler
    );
    handler.setSubstitution(this.resourceName, Services.io.newURI(rootURI));
    this.resourceHandler = handler;
  },

  async unregister() {
    this.isShuttingDown = true;
    this.unregisterAutoFetch();
    this.unpatchFindAvailableFiles();
    await this.clearSession();
    if (this.preferencePaneID) {
      Zotero.PreferencePanes.unregister(this.preferencePaneID);
      this.preferencePaneID = null;
    }
    if (this.actorRegistered) {
      ChromeUtils.unregisterWindowActor(this.actorName);
      this.actorRegistered = false;
    }
    if (this.resourceHandler) {
      this.resourceHandler.setSubstitution(this.resourceName, null);
      this.resourceHandler = null;
    }
    if (Zotero.InstitutionalPDFBridge === this) {
      delete Zotero.InstitutionalPDFBridge;
    }
  }
};

async function startup(data, reason) {
  await Zotero.initializationPromise;
  try {
    await InstitutionalPDFBridge.register(data.rootURI);
  } catch (error) {
    InstitutionalPDFBridge.startupError = error.message || String(error);
    Zotero.logError(error);
  }
}

async function shutdown(data, reason) {
  await InstitutionalPDFBridge.unregister();
}

function install(data, reason) {}

function uninstall(data, reason) {}
