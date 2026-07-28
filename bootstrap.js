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
  "autoLogin"
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
  currentURL: null,
  startupError: null,
  autoFetchNotifierID: null,
  autoFetchTimers: new Map(),
  autoFetchRunning: new Set(),
  autoFetchQueue: Promise.resolve(),
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
      Math.min(300000, Number(this.getPref("requestTimeoutMs", 180000)) || 180000)
    );
    const requestRetryCount = Math.max(
      0,
      Math.min(3, Math.floor(Number(this.getPref("requestRetryCount", 1)) || 0))
    );
    const autoFetchDelayMs = Math.max(
      2000,
      Math.min(60000, Number(this.getPref("autoFetchDelayMs", 12000)) || 12000)
    );
    let gatewayOrigin = null;
    if (gatewayURL) {
      try {
        gatewayOrigin = new URL(gatewayURL).origin;
      } catch (error) {
        throw new Error("Institutional proxy gateway URL is invalid");
      }
    }
    return {
      enabled: Boolean(this.getPref("enabled", true)),
      institutionName: String(this.getPref("institutionName", "Institutional access")),
      gatewayURL,
      gatewayOrigin,
      loginURL,
      mode,
      urlTemplate: String(this.getPref("urlTemplate", "{gateway}/login?url={url}")),
      cipherKey: String(this.getPref("cipherKey", "")),
      autoCloseLogin: Boolean(this.getPref("autoCloseLogin", true)),
      requestTimeoutMs,
      requestRetryCount,
      autoFetchNewItems: Boolean(this.getPref("autoFetchNewItems", false)),
      autoFetchDelayMs,
      autoLogin: Boolean(this.getPref("autoLogin", false)),
      loginPathKeywords: String(this.getPref(
        "loginPathKeywords",
        "login,cas,auth,sso,saml,oauth"
      )).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
    };
  },

  getCredentialOrigin(config = this.getConfig()) {
    const loginURL = config.loginURL || config.gatewayURL;
    if (!loginURL) {
      throw new Error("Configure the institution login URL before saving credentials");
    }
    let url;
    try {
      url = new URL(loginURL);
    } catch (error) {
      throw new Error("Institution login URL is invalid");
    }
    if (url.protocol !== "https:") {
      throw new Error("Saved credentials require an HTTPS institution login URL");
    }
    return url.origin;
  },

  getCredentialRealm(config = this.getConfig()) {
    return `institutional-pdf-bridge:${this.getCredentialOrigin(config)}`;
  },

  async getStoredCredentialLogins(config = this.getConfig()) {
    if (!Services.logins) {
      throw new Error("Zotero Password Manager is unavailable");
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
      throw new Error("Enter both username and password before saving credentials");
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
    if (!result?.submitted) {
      throw new Error("Institution login form could not be submitted automatically");
    }
    Zotero.debug(`Submitted stored institutional credentials to ${this.getCredentialOrigin(config)}`);
    return true;
  },

  async register(rootURI) {
    this.isShuttingDown = false;
    this.migrateDoublePrefixedPreferences();
    this.migrateLegacyRequestTimeout();
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
      label: "Institutional PDF Bridge",
      image: rootURI + "icon.svg"
    });
    Zotero.InstitutionalPDFBridge = this;
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

  migrateLegacyRequestTimeout() {
    const name = PREF_BRANCH + "requestTimeoutMs";
    if (
      Zotero.Prefs.prefHasUserValue(name) &&
      Number(Zotero.Prefs.get(name)) === 45000
    ) {
      // Version 1.0.3 wrote its old 45-second default as a user preference.
      Zotero.Prefs.set(name, 180000);
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
          this.scheduleAutoFetch(itemID);
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
    this.autoFetchRunning.clear();
    this.autoFetchQueue = Promise.resolve();
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
      this.autoFetchQueue = this.autoFetchQueue
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
    if (
      Zotero.Attachments.canFindFileForItem &&
      !Zotero.Attachments.canFindFileForItem(item)
    ) {
      return false;
    }

    try {
      const attachment = await Zotero.Attachments.addFileFromURLs(
        item,
        [this.createProxyResolver(item, false)]
      );
      if (attachment) {
        Zotero.debug(`Institutional PDF downloaded automatically for item ${itemID}`);
      }
      return Boolean(attachment);
    } catch (error) {
      // Background lookup must not open the login viewer or surface an alert.
      Zotero.debug(`Institutional PDF automatic lookup skipped for item ${itemID}: ${error}`);
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
          const result = await bridge.downloadViaProxy(resolver.__institutionalProxyItem, path, {
            interactive: resolver.__institutionalProxyInteractive !== false
          });
          if (result) {
            return result;
          }
        } catch (error) {
          Zotero.logError(error);
        }
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

  async downloadViaProxy(item, path, { interactive = true } = {}) {
    const doi = Zotero.Utilities.cleanDOI(item.getField("DOI") || item.getExtraField("DOI"));
    const itemURL = item.getField("url");
    const sourceURL = doi ? `https://doi.org/${encodeURIComponent(doi)}` : itemURL;
    if (!sourceURL) {
      return false;
    }

    const config = this.getConfig();
    if (!config.gatewayURL) {
      throw new Error("Configure an institutional gateway before looking up PDFs");
    }
    Zotero.debug(`Looking for ${doi || sourceURL} via ${config.institutionName}`);
    const pageURL = await this.toProxyURL(sourceURL, config);
    const page = await this.getAuthenticatedPage(pageURL, config, interactive);

    if (this.isPDFContentType(page.contentType)) {
      await this.writeValidatedPDF(path, page.blob);
      return this.makeDownloadResult(page.responseURL || sourceURL, null, config);
    }
    if (!page.document) {
      return false;
    }

    const candidates = await this.findPDFCandidates(
      page.document,
      page.responseURL || pageURL,
      doi
    );
    for (const candidate of candidates) {
      const proxiedCandidate = await this.toProxyURL(candidate.url, config);
      try {
        const response = await this.fetchPage(proxiedCandidate, config, false, interactive);
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
    if (!this.isLoginPage(page, config)) {
      return page;
    }

    if (!interactive) {
      await this.clearSession();
      throw new Error("Institutional proxy login is required for automatic lookup");
    }
    await this.clearSession();
    await this.ensureSessionBrowser({ interactive: true, forceLogin: true });
    page = await this.fetchPage(pageURL, config, true, true);
    if (this.isLoginPage(page, config)) {
      throw new Error("Institutional proxy login was not completed");
    }
    return page;
  },

  async fetchPage(url, config, allowNavigation, interactive = true) {
    const browser = await this.ensureSessionBrowser({ interactive });
    let lastError;
    for (let attempt = 0; attempt <= config.requestRetryCount; attempt++) {
      try {
        let response;
        if (allowNavigation && config.mode !== "sangfor") {
          response = await this.navigateAndRead(browser, url, config);
        } else {
          response = await this.fetchViaBrowser(browser, url, config.requestTimeoutMs);
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
    const actor = await this.waitForActor(browser);
    return actor.sendQuery("Fetch", { url, timeoutMs });
  },

  async navigateAndRead(browser, url, config) {
    if (!this.hiddenBrowser || browser !== this.hiddenBrowser) {
      return this.fetchViaBrowser(browser, url, config.requestTimeoutMs);
    }
    await browser.load(url);
    try {
      await browser.waitForDocument({ allowInteractiveAfter: 1500 });
    } catch (error) {
      Zotero.debug(`Proxy navigation document wait failed: ${error}`);
    }
    const actor = await this.waitForActor(browser);
    const state = await actor.sendQuery("State", {});
    this.currentURL = state.url || null;
    return actor.sendQuery("Fetch", {
      url: state.url || url,
      timeoutMs: config.requestTimeoutMs
    });
  },

  isLoginPage(page, config) {
    if (page.document?.querySelector('input[type="password"], #cas-login, form[action*="login"]')) {
      return true;
    }
    return this.isLoginState({ url: page.responseURL || "", hasPasswordField: false }, config);
  },

  isLoginState(state, config) {
    if (!state?.url || state.url === "about:blank" || state.hasPasswordField) {
      return true;
    }
    try {
      const url = new URL(state.url);
      const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
      return config.loginPathKeywords.some((keyword) => haystack.includes(keyword));
    } catch (error) {
      return true;
    }
  },

  async ensureSessionBrowser({ interactive = true, forceLogin = false } = {}) {
    const config = this.getConfig();
    if (!config.enabled) {
      throw new Error("Institutional PDF Bridge is disabled");
    }
    if (!config.gatewayURL) {
      throw new Error("Institutional proxy gateway URL is not configured");
    }

    if (!forceLogin && this.sessionBrowser) {
      try {
        const state = await this.getBrowserState(this.sessionBrowser);
        if (!this.isLoginState(state, config)) {
          this.currentURL = state.url;
          return this.sessionBrowser;
        }
      } catch (error) {
        Zotero.debug(`Existing proxy session is unavailable: ${error}`);
      }
      await this.clearSession();
    }

    if (!forceLogin) {
      try {
        const state = await this.createHiddenSession(config.gatewayURL);
        if (!this.isLoginState(state, config)) {
          return this.sessionBrowser;
        }
      } catch (error) {
        Zotero.debug(`Silent proxy session restore failed: ${error}`);
      }
      await this.clearSession();
    }

    if (!interactive) {
      throw new Error("Institutional proxy login is required");
    }
    return this.openInteractiveLogin(config);
  },

  async createHiddenSession(sourceURL) {
    await this.destroyHiddenBrowser();
    const { HiddenBrowser } = ChromeUtils.importESModule(
      "chrome://zotero/content/HiddenBrowser.mjs"
    );
    const browser = new HiddenBrowser({ useHiddenFrame: false });
    await browser._createdPromise;
    this.hiddenBrowser = browser;
    this.sessionBrowser = browser;
    await browser.load(sourceURL);
    try {
      await browser.waitForDocument({ allowInteractiveAfter: 1500 });
    } catch (error) {
      Zotero.debug(`Hidden proxy browser document wait failed: ${error}`);
    }
    const state = await this.getBrowserState(browser);
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
      let finished = false;
      let checking = false;
      const autoLoginAttempts = new Set();

      const cleanup = () => {
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
      };
      const succeed = async () => {
        if (finished) {
          return;
        }
        try {
          const visibleState = await this.getBrowserState(this.loginBrowser);
          const hiddenState = await this.createHiddenSession(visibleState.url || config.gatewayURL);
          if (this.isLoginState(hiddenState, config)) {
            throw new Error("The authenticated session could not be transferred to a hidden browser");
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
            const loginKey = this.isCredentialLoginURL(state.url, config)
              ? new URL(state.url).pathname
              : null;
            if (loginKey && !autoLoginAttempts.has(loginKey)) {
              autoLoginAttempts.add(loginKey);
              try {
                await this.submitStoredCredentials(this.loginBrowser, state, config);
              } catch (error) {
                Zotero.debug(`Automatic institutional login skipped: ${error}`);
              }
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
        this.loginBrowser = win.document.querySelector("browser");
        if (!this.loginBrowser) {
          fail("Institutional proxy login browser could not be created");
          return;
        }
        pollTimer = win.setInterval(checkPage, 750);
        win.addEventListener("unload", () => {
          if (!finished) {
            fail("Institutional proxy login window was closed before authentication");
          }
        }, { once: true });
        checkPage();
      };

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
    throw new Error(`Institutional proxy content actor is not ready${detail}`);
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

    if (doi) {
      const encodedDOI = encodeURI(doi);
      if (doi.startsWith("10.1021/")) {
        add(`https://pubs.acs.org/doi/pdf/${encodedDOI}`, "Full Text PDF");
      } else if (doi.startsWith("10.1146/")) {
        add(`https://www.annualreviews.org/doi/pdf/${encodedDOI}`, "Full Text PDF");
        add(`https://www.annualreviews.org/doi/epdf/${encodedDOI}`, "Full Text PDF");
      } else if (doi.startsWith("10.1117/")) {
        add(`https://www.spiedigitallibrary.org/doi/pdf/${encodedDOI}`, "Full Text PDF");
      }
    }

    try {
      const translated = await Zotero.Utilities.Internal.getFileFromDocument(document);
      if (translated) {
        add(translated.url, translated.title);
      }
    } catch (error) {
      Zotero.debug(`Institutional proxy page translation failed: ${error}`);
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
        throw new Error("Institutional proxy response was not a PDF");
      }
    } catch (error) {
      await Zotero.File.removeIfExists(path);
      throw error;
    }
  },

  async toProxyURL(value, config = this.getConfig()) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported proxy target protocol: ${url.protocol}`);
    }
    if (this.isLikelyProxiedURL(url, config)) {
      return url.href;
    }

    if (config.mode === "direct") {
      return url.href;
    }
    if (config.mode === "template") {
      if (!config.urlTemplate.includes("{url}")) {
        throw new Error("Proxy URL template must contain {url}");
      }
      return config.urlTemplate
        .replaceAll("{gateway}", config.gatewayURL)
        .replaceAll("{url}", encodeURIComponent(url.href));
    }
    if (config.mode !== "sangfor") {
      throw new Error(`Unsupported institutional proxy mode: ${config.mode}`);
    }
    if (config.cipherKey.length !== 16 || /[^\x20-\x7E]/.test(config.cipherKey)) {
      throw new Error("Sangfor-compatible cipher key must be 16 ASCII characters");
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
