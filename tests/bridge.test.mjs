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
      appShell: { hiddenDOMWindow: { crypto: webcrypto } },
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

  const submitter = { clicks: 0, click() { this.clicks++; } };
  const form = { querySelector: () => submitter };
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
