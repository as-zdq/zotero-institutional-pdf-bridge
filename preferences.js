var InstitutionalPDFBridgePreferences = {
  prefBranch: "institutionalPDFBridge.",

  init() {
    this.updateMode();
  },

  updateMode() {
    const mode = document.getElementById("institutional-pdf-bridge-mode").value;
    document.getElementById("institutional-pdf-bridge-template").disabled = mode !== "template";
    document.getElementById("institutional-pdf-bridge-key").disabled = mode !== "sangfor";
  },

  save() {
    const values = {
      enabled: document.getElementById("institutional-pdf-bridge-enabled").checked,
      institutionName: document.getElementById("institutional-pdf-bridge-name").value.trim(),
      gatewayURL: document.getElementById("institutional-pdf-bridge-gateway").value.trim(),
      loginURL: document.getElementById("institutional-pdf-bridge-login").value.trim(),
      mode: document.getElementById("institutional-pdf-bridge-mode").value,
      urlTemplate: document.getElementById("institutional-pdf-bridge-template").value.trim(),
      cipherKey: document.getElementById("institutional-pdf-bridge-key").value,
      autoCloseLogin: document.getElementById("institutional-pdf-bridge-auto-close").checked,
      requestTimeoutMs: Number(document.getElementById("institutional-pdf-bridge-timeout").value),
      requestRetryCount: Number(document.getElementById("institutional-pdf-bridge-retries").value),
      autoFetchNewItems: document.getElementById("institutional-pdf-bridge-auto-fetch").checked,
      autoFetchDelayMs: Number(document.getElementById("institutional-pdf-bridge-auto-delay").value),
      loginPathKeywords: document.getElementById("institutional-pdf-bridge-keywords").value.trim()
    };
    for (const [name, value] of Object.entries(values)) {
      Zotero.Prefs.set(this.prefBranch + name, value);
    }
  },

  async testLogin() {
    const button = document.getElementById("institutional-pdf-bridge-test");
    button.disabled = true;
    this.setStatus("Waiting for login...");
    try {
      this.save();
      await Zotero.InstitutionalPDFBridge.reloadConfiguration();
      await Zotero.InstitutionalPDFBridge.openLogin();
      this.setStatus("Authenticated; background session is active");
    } catch (error) {
      Zotero.logError(error);
      this.setStatus(error.message || String(error));
    } finally {
      button.disabled = false;
    }
  },

  setStatus(value) {
    document.getElementById("institutional-pdf-bridge-status").value = value;
  }
};

window.InstitutionalPDFBridgePreferences = InstitutionalPDFBridgePreferences;
