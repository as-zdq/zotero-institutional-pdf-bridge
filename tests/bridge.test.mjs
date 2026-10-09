import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import test from "node:test";

test("manifest includes Zotero 9 required update metadata", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8")
  );
  const updates = JSON.parse(
    readFileSync(new URL("../update.json", import.meta.url), "utf8")
  );
  const zotero = manifest.applications?.zotero;
  const release = updates.addons?.[zotero?.id]?.updates?.[0];
  assert.equal(zotero?.id, "institutional-pdf-bridge@as-zdq.github.io");
  assert.match(zotero?.update_url ?? "", /^https:\/\//);
  assert.equal(zotero?.strict_min_version, "8.0-beta.21");
  assert.equal(zotero?.strict_max_version, "10.99.99");
  assert.equal(release?.version, manifest.version);
  assert.match(release?.update_link ?? "", new RegExp(`${manifest.version}.*\\.xpi$`));
  assert.deepEqual(release?.applications?.zotero, {
    strict_min_version: zotero.strict_min_version,
    strict_max_version: zotero.strict_max_version
  });
});

function loadBridge(preferences = {}) {
  const calls = [];
  const files = new Map();
  const items = new Map();
  const credentialLogins = [];
  let notifier;
  const standardResolver = async () => {
    calls.push("standard-resolver");
    return false;
  };
  const context = {
    URL,
    Uint8Array,
    Services: {
      appShell: { hiddenDOMWindow: { crypto: webcrypto, Blob } },
      logins: {
        findLogins(origin, formActionOrigin, httpRealm) {
          return credentialLogins.filter((login) =>
            login.origin === origin &&
            login.formActionOrigin === formActionOrigin &&
            login.httpRealm === httpRealm
          );
        },
        addLogin(login) {
          credentialLogins.push(login);
        },
        removeLogin(login) {
          const index = credentialLogins.indexOf(login);
          if (index !== -1) {
            credentialLogins.splice(index, 1);
          }
        }
      }
    },
    ChromeUtils: {},
    Components: {
      Constructor: () => function LoginInfo(
        origin,
        formActionOrigin,
        httpRealm,
        username,
        password,
        usernameField,
        passwordField
      ) {
        Object.assign(this, {
          origin,
          formActionOrigin,
          httpRealm,
          username,
          password,
          usernameField,
          passwordField
        });
      }
    },
    Zotero: {
      Attachments: {
        getFileResolvers: () => [standardResolver],
        downloadFirstAvailableFile: async (resolvers) => {
          calls.push("native-download");
          return resolvers[0]?.();
        },
        canFindFileForItem: () => true,
        addFileFromURLs: async (_item, resolvers) => {
          calls.push("auto-add");
          return context.Zotero.Attachments.downloadFirstAvailableFile(resolvers);
        }
      },
      Items: { get: (id) => items.get(id) },
      Notifier: {
        registerObserver: (observer) => {
          notifier = observer;
          return "institutional-pdf-bridge-test-observer";
        },
        unregisterObserver: () => { notifier = null; }
      },
      Prefs: {
        get: (key, global = false) => preferences[
          global ? key : `extensions.zotero.${key}`
        ],
        set: (key, value, global = false) => {
          preferences[global ? key : `extensions.zotero.${key}`] = value;
        },
        clear: (key, global = false) => {
          delete preferences[global ? key : `extensions.zotero.${key}`];
        },
        prefHasUserValue: (key, global = false) => Object.hasOwn(
          preferences,
          global ? key : `extensions.zotero.${key}`
        )
      },
      File: {
        putContentsAsync: async (path, value) => { files.set(path, value); },
        getContentsAsync: async (path, _charset, maxLength) =>
          String(files.get(path)).slice(0, maxLength),
        removeIfExists: async (path) => files.delete(path)
      },
      Promise: { delay: async () => {} },
      Utilities: { cleanDOI: (value) => value },
      debug: () => {},
      getString: () => "Full Text PDF",
      logError: (error) => { throw error; }
    }
  };
  createContext(context);
  runInContext(readFileSync(new URL("../bootstrap.js", import.meta.url), "utf8"), context);
  return {
    bridge: context.InstitutionalPDFBridge,
    context,
    calls,
    files,
    items,
    credentialLogins,
    getNotifier: () => notifier
  };
}

test("Zotero preference API uses the unprefixed plugin branch", () => {
  const preferences = {
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.mode": "direct"
  };
  const { bridge } = loadBridge(preferences);
  const config = bridge.getConfig();
  assert.equal(config.gatewayURL, "https://proxy.example.edu");
  assert.equal(config.mode, "direct");
});

test("double-prefixed preferences are migrated once", () => {
  const badKey =
    "extensions.zotero.extensions.zotero.institutionalPDFBridge.gatewayURL";
  const goodKey = "extensions.zotero.institutionalPDFBridge.gatewayURL";
  const preferences = { [badKey]: "https://proxy.example.edu" };
  const { bridge } = loadBridge(preferences);
  bridge.migrateDoublePrefixedPreferences();
  assert.equal(preferences[goodKey], "https://proxy.example.edu");
  assert.equal(Object.hasOwn(preferences, badKey), false);
});

test("old 45-second user setting is migrated to the slower WebVPN default", () => {
  const preferences = {
    "extensions.zotero.institutionalPDFBridge.requestTimeoutMs": 45000
  };
  const { bridge } = loadBridge(preferences);
  bridge.migrateLegacyRequestTimeout();
  assert.equal(bridge.getConfig().requestTimeoutMs, 180000);
});

test("long user timeouts and import delays are honored", () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.requestTimeoutMs": 1800000,
    "extensions.zotero.institutionalPDFBridge.autoFetchDelayMs": 120000
  });
  assert.equal(bridge.getConfig().requestTimeoutMs, 1800000);
  assert.equal(bridge.getConfig().autoFetchDelayMs, 120000);
});

test("saved article URL is tried before DOI, which remains a fallback", async () => {
  const { bridge, files } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.mode": "direct"
  });
  const sources = [];
  bridge.getAuthenticatedPage = async (url) => {
    sources.push(url);
    if (!url.startsWith("https://doi.org/")) {
      throw new Error("article URL unavailable");
    }
    return { contentType: "application/pdf", blob: "%PDF-data", responseURL: url };
  };
  const result = await bridge.downloadViaProxy({
    getField: (name) => name === "DOI" ? "10.1/example" : "https://proxy.example.edu/article/123",
    getExtraField: () => ""
  }, "/tmp/test.pdf");
  assert.equal(sources[0], "https://proxy.example.edu/article/123");
  assert.match(sources.at(-1), /^https:\/\/doi.org\//);
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(files.get("/tmp/test.pdf"), "%PDF-data");
});

test("rendered lookup uses live document HTML instead of fetching it again", async () => {
  const { bridge } = loadBridge();
  let fetches = 0;
  const browser = {
    load: async () => true,
    getPageData: async (props) => {
      assert.deepEqual(Array.from(props), ["documentHTML", "channelInfo"]);
      return { documentHTML: '<a href="dynamic.pdf">PDF</a>', channelInfo: { responseStatus: 200 } };
    }
  };
  bridge.hiddenBrowser = browser;
  bridge.getBrowserState = async () => ({ url: "https://proxy.example.edu/article", contentType: "text/html" });
  bridge.fetchViaBrowser = async () => { fetches++; };
  const response = await bridge.navigateAndRead(browser, "https://proxy.example.edu/article", bridge.getConfig());
  assert.match(new TextDecoder().decode(response.bytes), /dynamic.pdf/);
  assert.equal(response.status, 200);
  assert.equal(fetches, 0);
});

test("DOI redirects are resolved anonymously before proxying the publisher URL", async () => {
  const { bridge, context } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.mode": "sangfor"
  });
  context.Zotero.HTTP = { request: async (method, url, options) => {
    assert.equal(method, "HEAD");
    assert.match(url, /^https:\/\/doi.org\//);
    assert.equal(options.anon, true);
    assert.equal(options.followRedirects, false);
    return { getResponseHeader: () => "https://publisher.example/article/123" };
  } };
  bridge.toProxyURL = async (url) => {
    assert.equal(url, "https://publisher.example/article/123");
    return "https://proxy.example.edu/publisher/article/123";
  };
  bridge.getAuthenticatedPage = async () => ({ contentType: "application/pdf", blob: "%PDF-real" });
  const result = await bridge.downloadViaProxy({
    getField: (name) => name === "DOI" ? "10.1/test" : "", getExtraField: () => ""
  }, "/tmp/redirected.pdf");
  assert.equal(result.mimeType, "application/pdf");
});

test("a refused static article request still gets the rendered fallback", async () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.mode": "direct"
  });
  const passes = [];
  bridge.getAuthenticatedPage = async (_url, _config, _interactive, rendered) => {
    passes.push(rendered);
    if (!rendered) {
      throw new Error("HTTP 403");
    }
    return { contentType: "application/pdf", blob: "%PDF-rendered" };
  };
  assert.ok(await bridge.downloadViaProxy({
    getField: (name) => name === "url" ? "https://proxy.example.edu/article" : "", getExtraField: () => ""
  }, "/tmp/rendered.pdf"));
  assert.deepEqual(passes, [false, true]);
});

test("PDF wrapper links are followed to a validated PDF", async () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.mode": "direct"
  });
  const article = {};
  const wrapper = { querySelector: () => null };
  bridge.getAuthenticatedPage = async () => ({
    contentType: "text/html", document: article, responseURL: "https://proxy.example.edu/article"
  });
  bridge.findPDFCandidates = async (doc) => [{
    url: doc === article ? "https://proxy.example.edu/epdf/123" : "https://proxy.example.edu/real.pdf"
  }];
  bridge.fetchPage = async (url) => url.endsWith("real.pdf")
    ? { contentType: "application/pdf", blob: "%PDF-actual", responseURL: url }
    : { contentType: "text/html", document: wrapper, responseURL: url };
  const result = await bridge.downloadViaProxy({ getField: () => "https://proxy.example.edu/article", getExtraField: () => "" }, "/tmp/wrapped.pdf");
  assert.equal(result.url, "https://proxy.example.edu/real.pdf");
});

test("article rendering is a fallback when static HTML has no download links", async () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.mode": "sangfor"
  });
  const passes = [];
  bridge.toProxyURL = async (url) => url;
  bridge.getAuthenticatedPage = async (_url, _config, _interactive, rendered) => {
    passes.push(rendered);
    return { contentType: "text/html", document: { rendered } };
  };
  bridge.findPDFCandidates = async (doc) => doc.rendered ? [{ url: "https://proxy.example.edu/dynamic.pdf" }] : [];
  bridge.fetchPage = async () => ({ contentType: "application/pdf", blob: "%PDF-dynamic" });
  const result = await bridge.downloadViaProxy({
    getField: (name) => name === "url" ? "https://proxy.example.edu/article" : "", getExtraField: () => ""
  }, "/tmp/dynamic.pdf");
  assert.equal(result.mimeType, "application/pdf");
  assert.deepEqual(passes, [false, true]);
});

test("manual and background downloads cannot navigate concurrently, even after a failure", async () => {
  const { bridge } = loadBridge();
  let release;
  const firstStarted = [];
  bridge.downloadViaProxyNow = async (item) => {
    firstStarted.push(item);
    if (item === 1) {
      await new Promise((resolve) => { release = resolve; });
      throw new Error("first lookup failed");
    }
    return true;
  };
  const first = bridge.downloadViaProxy(1, "/tmp/a");
  const rejected = assert.rejects(first, /first lookup failed/);
  const second = bridge.downloadViaProxy(2, "/tmp/b");
  await Promise.resolve();
  assert.deepEqual(firstStarted, [1]);
  release();
  await rejected;
  assert.equal(await second, true);
  assert.deepEqual(firstStarted, [1, 2]);
});

test("background lookup restores saved login without opening a viewer", async () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.loginURL": "https://proxy.example.edu/login",
    "extensions.zotero.institutionalPDFBridge.autoLogin": true
  });
  await bridge.storeCredentials("alice", "test-password");
  let submitted = 0;
  bridge.clearSession = async () => { bridge.sessionBrowser = null; };
  bridge.createHiddenSession = async () => {
    bridge.hiddenBrowser = bridge.sessionBrowser = {};
    return submitted ? { url: "https://proxy.example.edu/home" } : { url: "https://proxy.example.edu/login", hasPasswordField: true };
  };
  bridge.getBrowserState = async () => submitted
    ? { url: "https://proxy.example.edu/home" }
    : { url: "https://proxy.example.edu/login", hasPasswordField: true };
  bridge.submitStoredCredentials = async (_browser, state, config) => {
    assert.equal(bridge.isCredentialLoginURL(state.url, config), true);
    submitted++;
    return true;
  };
  bridge.openInteractiveLogin = async () => { throw new Error("must not open a viewer"); };
  assert.equal(await bridge.ensureSessionBrowser({ interactive: false }), bridge.sessionBrowser);
  assert.equal(submitted, 1);
  assert.equal(bridge.silentLoginBlocked, false);
});

test("failed silent login is not submitted again for every queued item", async () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.autoLogin": true
  });
  let attempts = 0;
  bridge.createHiddenSession = async () => ({ url: "https://proxy.example.edu/login" });
  bridge.restoreSavedLogin = async () => { attempts++; return false; };
  bridge.clearSession = async () => {};
  for (let index = 0; index < 2; index++) {
    await assert.rejects(bridge.ensureSessionBrowser({ interactive: false }), /login is required/);
  }
  assert.equal(attempts, 1);
});

test("session readiness is polled across redirects without an unbounded document wait", async () => {
  const { bridge, context } = loadBridge();
  const states = [
    { url: "about:blank", readyState: "complete" },
    { url: "https://proxy.example.edu/home", readyState: "loading" },
    { url: "https://proxy.example.edu/home", readyState: "interactive" }
  ];
  context.ChromeUtils.importESModule = () => ({ HiddenBrowser: class {
    async load() { return false; }
    waitForDocument() { throw new Error("must not use the unbounded readiness actor"); }
  } });
  bridge.destroyHiddenBrowser = async () => {};
  bridge.getBrowserState = async () => states.shift();
  const state = await bridge.createHiddenSession("https://proxy.example.edu");
  assert.equal(state.readyState, "interactive");
  assert.equal(bridge.currentURL, state.url);
});

test("a gateway that stays loading stops at the session timeout", async () => {
  const { bridge, context } = loadBridge();
  let time = 0;
  context.Date = { now: () => (time += 10000) };
  context.ChromeUtils.importESModule = () => ({ HiddenBrowser: class { async load() {} } });
  bridge.destroyHiddenBrowser = async () => {};
  bridge.getBrowserState = async () => ({ url: "about:blank", readyState: "loading" });
  await assert.rejects(bridge.createHiddenSession("https://proxy.example.edu"), /session timeout/);
});

test("login keyword matching does not reject article titles such as cases or authors", () => {
  const { bridge } = loadBridge();
  const config = bridge.getConfig();
  assert.equal(bridge.isLoginState({ url: "https://proxy.example.edu/articles/cases-and-authors" }, config), false);
  assert.equal(bridge.isLoginState({ url: "https://proxy.example.edu/cas/login" }, config), true);
  assert.equal(bridge.isLoginState({ url: "https://proxy.example.edu/oauth2/authorize" }, config), true);
});

test("automatic lookup retries once and stops if a PDF was attached meanwhile", async () => {
  const { bridge, context, items } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.autoFetchNewItems": true
  });
  const item = {
    isRegularItem: () => true, getAttachments: () => [],
    getField: (name) => name === "DOI" ? "10.1/example" : "", getExtraField: () => ""
  };
  items.set(1, item);
  let attempts = 0;
  context.Zotero.Attachments.addFileFromURLs = async () => ++attempts === 2;
  assert.equal(await bridge.autoFetchItem(1), true);
  assert.equal(attempts, 2);
  attempts = 0;
  context.Zotero.Promise.delay = async () => { bridge.itemHasPDFAttachment = () => true; };
  assert.equal(await bridge.autoFetchItem(1), false);
  assert.equal(attempts, 1);
});

test("credentials are stored in Zotero Password Manager instead of preferences", async () => {
  const preferences = {
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.loginURL": "https://login.example.edu/cas"
  };
  const { bridge, credentialLogins } = loadBridge(preferences);
  await bridge.storeCredentials("alice", "correct-horse-battery-staple");

  assert.equal(credentialLogins.length, 1);
  const stored = await bridge.getStoredCredentials();
  assert.equal(stored.username, "alice");
  assert.equal(stored.password, "correct-horse-battery-staple");
  assert.equal(credentialLogins[0].origin, "https://login.example.edu");
  assert.equal(
    credentialLogins[0].httpRealm,
    "institutional-pdf-bridge:https://login.example.edu"
  );
  assert.equal(
    Object.values(preferences).includes("correct-horse-battery-staple"),
    false
  );

  await bridge.removeStoredCredentials();
  assert.equal(await bridge.hasStoredCredentials(), false);
});

test("automatic credential submission is restricted to the configured HTTPS login origin", async () => {
  const preferences = {
    "extensions.zotero.institutionalPDFBridge.gatewayURL": "https://proxy.example.edu",
    "extensions.zotero.institutionalPDFBridge.loginURL": "https://login.example.edu/cas",
    "extensions.zotero.institutionalPDFBridge.autoLogin": true
  };
  const { bridge } = loadBridge(preferences);
  await bridge.storeCredentials("alice", "test-password");
  const queries = [];
  bridge.waitForActor = async () => ({
    sendQuery: async (name, payload) => {
      queries.push({ name, payload });
      return { submitted: true };
    }
  });

  assert.equal(await bridge.submitStoredCredentials({}, {
    url: "https://login.example.edu/cas/login",
    hasPasswordField: true
  }), true);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].name, "FillLogin");
  assert.equal(queries[0].payload.username, "alice");
  assert.equal(queries[0].payload.password, "test-password");

  assert.equal(await bridge.submitStoredCredentials({}, {
    url: "https://unexpected.example.edu/cas/login",
    hasPasswordField: true
  }), false);
  assert.equal(queries.length, 1);
});

test("saved credentials require an HTTPS login URL", async () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.loginURL": "http://login.example.edu/cas"
  });
  await assert.rejects(
    bridge.storeCredentials("alice", "test-password"),
    /require an HTTPS institution login URL/
  );
});

test("manual credential capture is limited to the configured login page", async () => {
  const preferences = {
    "extensions.zotero.institutionalPDFBridge.loginURL": "https://login.example.edu/cas",
    "extensions.zotero.institutionalPDFBridge.autoLogin": true,
    "extensions.zotero.institutionalPDFBridge.captureCredentialsFromLogin": true
  };
  const { bridge } = loadBridge(preferences);
  const queries = [];
  bridge.waitForActor = async () => ({
    sendQuery: async (name) => {
      queries.push(name);
      return { watching: true };
    }
  });

  assert.equal(await bridge.watchInteractiveLogin({}, {
    url: "https://login.example.edu/cas/login",
    hasPasswordField: true
  }), true);
  assert.deepEqual(queries, ["WatchLogin"]);

  assert.equal(await bridge.watchInteractiveLogin({}, {
    url: "https://other.example.edu/cas/login",
    hasPasswordField: true
  }), false);
  assert.deepEqual(queries, ["WatchLogin"]);
});

test("login actor fills a standard form and submits it", async () => {
  const source = readFileSync(new URL("../proxy-child.sys.mjs", import.meta.url), "utf8")
    .replace("export class InstitutionalPDFBridgeActorChild", "class InstitutionalPDFBridgeActorChild")
    .concat("\nglobalThis.InstitutionalPDFBridgeActorChild = InstitutionalPDFBridgeActorChild;");
  const actorContext = { JSWindowActorChild: class {} };
  createContext(actorContext);
  runInContext(source, actorContext);

  class FakeInput {
    constructor({ type, name = "", id = "", form = null }) {
      this.type = type;
      this.name = name;
      this.id = id;
      this.form = form;
      this.disabled = false;
      this.events = [];
      this._value = "";
    }

    get value() {
      return this._value;
    }

    set value(value) {
      this._value = value;
    }

    dispatchEvent(event) {
      this.events.push(event.type);
    }
  }

  const submitter = { type: "submit", clicks: 0, click() { this.clicks++; } };
  const form = { querySelectorAll: (selector) => selector === "input" ? [username, password] : [submitter] };
  const username = new FakeInput({ type: "text", name: "username", form });
  const password = new FakeInput({ type: "password", name: "password", form });
  const document = {
    location: { href: "https://login.example.edu/cas" },
    querySelector(selector) {
      if (selector.startsWith('input[type="password"]')) {
        return password;
      }
      if (selector.includes('button[type="submit"]')) {
        return submitter;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "input" ? [username, password] : [];
    }
  };
  const actor = new actorContext.InstitutionalPDFBridgeActorChild();
  actor.document = document;
  actor.contentWindow = {
    HTMLInputElement: FakeInput,
    Event: class Event { constructor(type) { this.type = type; } }
  };

  const result = await actor.receiveMessage({
    name: "FillLogin",
    data: { username: "alice", password: "test-password" }
  });
  assert.equal(result.submitted, true);
  assert.equal(result.usernameFilled, true);
  assert.equal(username.value, "alice");
  assert.equal(password.value, "test-password");
  assert.deepEqual(username.events, ["input", "change"]);
  assert.deepEqual(password.events, ["input", "change"]);
  assert.equal(submitter.clicks, 1);
});

test("dynamic password login switches mode and ignores hidden forms and code inputs", async () => {
  const source = readFileSync(new URL("../proxy-child.sys.mjs", import.meta.url), "utf8")
    .replace("export class InstitutionalPDFBridgeActorChild", "class InstitutionalPDFBridgeActorChild")
    .concat("\nglobalThis.Actor = InstitutionalPDFBridgeActorChild;");
  const context = { JSWindowActorChild: class {} };
  createContext(context);
  runInContext(source, context);
  const input = (type, placeholder, visible) => ({
    type, placeholder, visible, value: "", getClientRects() { return this.visible ? [{}] : []; },
    dispatchEvent() {}
  });
  const username = input("text", "Staff ID/Student ID/Phone", false);
  const password = input("password", "Enter Password", false);
  const code = input("password", "Enter Dynamic Code", true);
  const captcha = input("text", "Verification code", true);
  const hiddenSubmit = { type: "submit", clicks: 0, getClientRects: () => [], click() { this.clicks++; } };
  const submitter = {
    type: "button", textContent: "LOGIN", visible: true, clicks: 0,
    getClientRects() { return this.visible ? [{}] : []; }, click() { this.clicks++; }
  };
  const form = { querySelectorAll: (selector) => selector === "input" ? [captcha, username, password] : [submitter] };
  username.form = password.form = form;
  const mode = {
    textContent: "Password Login", clicks: 0,
    click() { this.clicks++; username.visible = password.visible = true; code.visible = false; }
  };
  const listeners = new Map();
  const actor = new context.Actor();
  actor.document = {
    location: { href: "https://proxy.example.edu/cas/login" },
    querySelectorAll: (selector) => selector === "input"
      ? [code, captcha, username, password] : selector.includes('role="tab"') ? [mode] : [hiddenSubmit, submitter],
    addEventListener: (type, callback) => listeners.set(type, callback)
  };
  actor.contentWindow = {
    HTMLInputElement: class {}, Event: class {}, setTimeout: (callback) => callback()
  };
  const state = await actor.receiveMessage({ name: "State" });
  assert.equal(state.hasPasswordField, false);
  assert.equal(state.hasPasswordLogin, true);
  const result = await actor.receiveMessage({ name: "FillLogin", data: { username: "alice", password: "secret" } });
  assert.equal(result.submitted, true);
  assert.equal(mode.clicks, 1);
  assert.equal(username.value, "alice");
  assert.equal(password.value, "secret");
  assert.equal(code.value, "");
  assert.equal(captcha.value, "");
  assert.equal(submitter.clicks, 1);
  assert.equal(hiddenSubmit.clicks, 0);
  const captures = [];
  actor.sendAsyncMessage = (name, data) => captures.push({ name, data });
  await actor.receiveMessage({ name: "WatchLogin" });
  listeners.get("click")({ target: { closest: () => submitter } });
  assert.equal(captures[0].data.password, "secret");
  submitter.visible = false;
  await assert.rejects(actor.receiveMessage({ name: "FillLogin", data: { username: "alice", password: "secret" } }), /login button was not found/);
  assert.equal(hiddenSubmit.clicks, 0);
});

test("password-login mode can be selected before visible password fields exist", async () => {
  const { bridge } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.loginURL": "https://proxy.example.edu/cas/login",
    "extensions.zotero.institutionalPDFBridge.autoLogin": true
  });
  await bridge.storeCredentials("alice", "secret");
  bridge.waitForActor = async () => ({ sendQuery: async () => ({ submitted: true }) });
  assert.equal(await bridge.submitStoredCredentials({}, {
    url: "https://proxy.example.edu/cas/login", hasPasswordField: false, hasPasswordLogin: true
  }), true);
});

test("silent login waits for a loading CAS return page before replacing its browser", async () => {
  const { bridge } = loadBridge();
  bridge.hasStoredCredentials = async () => true;
  let creations = 0;
  const states = [
    { url: "https://proxy.example.edu/login", hasPasswordField: true },
    { url: "https://proxy.example.edu/home", readyState: "loading" },
    { url: "https://proxy.example.edu/home", readyState: "complete" }
  ];
  bridge.createHiddenSession = async () => {
    if (++creations === 2) {
      assert.equal(states.length, 0);
    }
    return { url: "https://proxy.example.edu/home" };
  };
  bridge.getBrowserState = async () => states.shift();
  bridge.submitStoredCredentials = async () => true;
  assert.equal(await bridge.restoreSavedLogin(bridge.getConfig()), true);
  assert.equal(creations, 2);
});

test("login actor captures manually submitted credentials once", async () => {
  const source = readFileSync(new URL("../proxy-child.sys.mjs", import.meta.url), "utf8")
    .replace("export class InstitutionalPDFBridgeActorChild", "class InstitutionalPDFBridgeActorChild")
    .concat("\nglobalThis.InstitutionalPDFBridgeActorChild = InstitutionalPDFBridgeActorChild;");
  const actorContext = { JSWindowActorChild: class {} };
  createContext(actorContext);
  runInContext(source, actorContext);

  const listeners = new Map();
  const username = { type: "text", name: "username", id: "", autocomplete: "", disabled: false, value: "alice" };
  const password = { type: "password", name: "password", id: "", autocomplete: "", disabled: false, value: "test-password" };
  const document = {
    location: { href: "https://login.example.edu/cas" },
    querySelector: (selector) => selector.startsWith('input[type="password"]') ? password : null,
    querySelectorAll: (selector) => selector === "input" ? [username, password] : [],
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
  const captures = [];
  const actor = new actorContext.InstitutionalPDFBridgeActorChild();
  actor.document = document;
  actor.sendAsyncMessage = (name, payload) => captures.push({ name, payload });

  assert.equal((await actor.receiveMessage({ name: "WatchLogin" })).watching, true);
  listeners.get("submit")({});
  listeners.get("submit")({});
  assert.equal(captures.length, 1);
  assert.equal(captures[0].name, "CaptureCredentials");
  assert.equal(captures[0].payload.url, "https://login.example.edu/cas");
  assert.equal(captures[0].payload.username, "alice");
  assert.equal(captures[0].payload.password, "test-password");
});

test("credential capture parent validates auto-login and the exact HTTPS origin", () => {
  const source = readFileSync(new URL("../proxy-parent.sys.mjs", import.meta.url), "utf8");
  assert.match(source, /getBoolPref\(PREF_BRANCH \+ "autoLogin", false\)/);
  assert.match(source, /captureCredentialsFromLogin/);
  assert.match(source, /new URL\(message\.data\?\.url \|\| ""\)\.origin !== origin/);
  assert.match(source, /url\.protocol !== "https:"/);
});

test("parent actor loads with the Services global used by current Zotero", async () => {
  const source = readFileSync(new URL("../proxy-parent.sys.mjs", import.meta.url), "utf8")
    .replace("export class InstitutionalPDFBridgeActorParent", "class InstitutionalPDFBridgeActorParent")
    .concat("\nglobalThis.ActorParent = InstitutionalPDFBridgeActorParent;");
  const context = {
    JSWindowActorParent: class {},
    Services: { prefs: { getBoolPref: () => false } }
  };
  createContext(context);
  runInContext(source, context);
  const result = await new context.ActorParent().receiveMessage({ name: "CaptureCredentials" });
  assert.equal(result.saved, false);
});

test("preferences keep manual credential entry available", () => {
  const source = readFileSync(new URL("../preferences.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /institutional-pdf-bridge-username"\)\.disabled/);
  assert.doesNotMatch(source, /institutional-pdf-bridge-password"\)\.disabled/);
  assert.match(source, /capture-login-credentials"\)\.disabled = !enabled/);
});

test("Sangfor-compatible host encoding remains stable", async () => {
  const { bridge } = loadBridge();
  const encoded = await bridge.encryptHost("doi.org", "0123456789abcdef");
  assert.equal(encoded, "30313233343536373839616263646566161d17a671ae9a");
});

test("manual lookup adds the proxy resolver and tries it first", async () => {
  const { bridge, context, calls } = loadBridge();
  bridge.downloadViaProxy = async () => {
    calls.push("proxy-download");
    return { mimeType: "application/pdf" };
  };
  bridge.patchFindAvailableFiles();
  const item = {
    getField: (name) => name === "DOI" ? "10.1/example" : "",
    getExtraField: () => ""
  };
  const manual = context.Zotero.Attachments.getFileResolvers(item, ["doi"], false);
  const automatic = context.Zotero.Attachments.getFileResolvers(item, ["doi"], true);
  assert.equal(manual.length, 2);
  assert.equal(automatic.length, 1);
  const result = await context.Zotero.Attachments.downloadFirstAvailableFile(manual, "/tmp/a.pdf", {});
  assert.ok(result);
  assert.deepEqual(calls, ["proxy-download"]);
});

test("automatic lookup uses a quiet resolver and never requests interactive login", async () => {
  const { bridge, context, calls, items } = loadBridge({
    "extensions.zotero.institutionalPDFBridge.autoFetchNewItems": true
  });
  const item = {
    isRegularItem: () => true,
    getAttachments: () => [],
    getField: (name) => name === "DOI" ? "10.1/example" : "",
    getExtraField: () => ""
  };
  items.set(1, item);
  bridge.downloadViaProxy = async (_item, _path, { interactive }) => {
    calls.push(`proxy-download-${interactive}`);
    return { mimeType: "application/pdf" };
  };
  bridge.patchFindAvailableFiles();
  assert.equal(await bridge.autoFetchItem(1), true);
  assert.deepEqual(calls, ["auto-add", "proxy-download-false"]);

  bridge.registerAutoFetch();
  const observer = context.Zotero.Notifier && bridge.autoFetchNotifierID;
  assert.equal(observer, "institutional-pdf-bridge-test-observer");
});

test("AIP-style article PDF links are recognized as candidates", async () => {
  const { bridge } = loadBridge();
  const link = {
    getAttribute: (name) => name === "href" ? "/aip/rsi/article-pdf/doi/10.1063/5.0288215/test.pdf" : "",
    textContent: "Download PDF"
  };
  const document = {
    querySelectorAll: (selector) => selector === 'a[href*="/article-pdf/"]' ? [link] : []
  };
  const candidates = await bridge.findPDFCandidates(
    document,
    "https://pubs.aip.org/aip/rsi/article/doi/10.1063/5.0288215/example",
    "10.1063/5.0288215"
  );
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].url, /article-pdf\/doi\/10\.1063/);
});

test("template mode encodes the target URL", async () => {
  const { bridge } = loadBridge();
  const result = await bridge.toProxyURL("https://doi.org/10.1/example", {
    mode: "template",
    gatewayURL: "https://proxy.example.edu",
    gatewayOrigin: "https://proxy.example.edu",
    urlTemplate: "{gateway}/login?url={url}"
  });
  assert.equal(
    result,
    "https://proxy.example.edu/login?url=https%3A%2F%2Fdoi.org%2F10.1%2Fexample"
  );
});

test("invalid PDF output is removed before native fallback", async () => {
  const { bridge, files } = loadBridge();
  await assert.rejects(
    bridge.writeValidatedPDF("/tmp/not-a-pdf", "<html>login</html>"),
    /was not a PDF/
  );
  assert.equal(files.has("/tmp/not-a-pdf"), false);
});

test("window actor lookup tolerates navigation transitions", async () => {
  const { bridge } = loadBridge();
  const actor = { sendQuery() {} };
  let attempts = 0;
  const browser = {
    browsingContext: {
      currentWindowGlobal: {
        getActor() {
          attempts++;
          if (attempts === 1) {
            throw new Error("actor unavailable for about:blank");
          }
          return actor;
        }
      }
    }
  };
  assert.equal(await bridge.waitForActor(browser), actor);
  assert.equal(attempts, 2);
});
