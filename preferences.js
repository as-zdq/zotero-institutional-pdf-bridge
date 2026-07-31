var InstitutionalPDFBridgePreferences = {
  prefBranch: "institutionalPDFBridge.",

  init() {
    this.updateMode();
    this.updateCredentialControls();
    this.refreshCredentialStatus();
    window.setTimeout(() => this.updateCredentialControls(), 0);
  },

  updateMode() {
    const mode = document.getElementById("institutional-pdf-bridge-mode").value;
    document.getElementById("institutional-pdf-bridge-template").disabled = mode !== "template";
    document.getElementById("institutional-pdf-bridge-key").disabled = mode !== "sangfor";
  },

  saveSettings() {
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
      autoLogin: document.getElementById("institutional-pdf-bridge-auto-login").checked,
      loginPathKeywords: document.getElementById("institutional-pdf-bridge-keywords").value.trim()
    };
    for (const [name, value] of Object.entries(values)) {
      Zotero.Prefs.set(this.prefBranch + name, value);
    }
  },

  updateCredentialControls() {
    const enabled = document.getElementById("institutional-pdf-bridge-auto-login").checked;
    document.getElementById("institutional-pdf-bridge-capture-login-credentials").disabled = !enabled;
    this.refreshCredentialStatus();
  },

  async refreshCredentialStatus() {
    const status = document.getElementById("institutional-pdf-bridge-credential-status");
    try {
      const stored = await Zotero.InstitutionalPDFBridge.hasStoredCredentials();
      const enabled = document.getElementById("institutional-pdf-bridge-auto-login").checked;
      status.value = stored
        ? enabled ? "Credentials saved securely" : "Credentials saved; automatic sign-in is disabled"
        : "No saved credentials";
    } catch (error) {
      status.value = error.message || String(error);
    }
  },

  async saveCredentials({ quiet = false } = {}) {
    const button = document.getElementById("institutional-pdf-bridge-save-credentials");
    const username = document.getElementById("institutional-pdf-bridge-username").value;
    const password = document.getElementById("institutional-pdf-bridge-password").value;
    button.disabled = true;
    try {
      this.saveSettings();
      await Zotero.InstitutionalPDFBridge.storeCredentials(username, password);
      document.getElementById("institutional-pdf-bridge-username").value = "";
      document.getElementById("institutional-pdf-bridge-password").value = "";
      await this.refreshCredentialStatus();
      if (!quiet) {
        this.setStatus("Credentials saved in Zotero Password Manager");
      }
    } catch (error) {
      Zotero.logError(error);
      this.setStatus(error.message || String(error));
      throw error;
    } finally {
      button.disabled = false;
    }
  },

  async removeCredentials() {
    const button = document.getElementById("institutional-pdf-bridge-remove-credentials");
    button.disabled = true;
    try {
      this.saveSettings();
      await Zotero.InstitutionalPDFBridge.removeStoredCredentials();
      document.getElementById("institutional-pdf-bridge-username").value = "";
      document.getElementById("institutional-pdf-bridge-password").value = "";
      await this.refreshCredentialStatus();
      this.setStatus("Saved credentials removed");
    } catch (error) {
      Zotero.logError(error);
      this.setStatus(error.message || String(error));
    } finally {
      button.disabled = false;
    }
  },

  async testLogin() {
    const button = document.getElementById("institutional-pdf-bridge-test");
    button.disabled = true;
    this.setStatus("Waiting for login...");
    try {
      this.saveSettings();
      const username = document.getElementById("institutional-pdf-bridge-username").value;
      const password = document.getElementById("institutional-pdf-bridge-password").value;
      if (username || password) {
        await this.saveCredentials({ quiet: true });
      }
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
