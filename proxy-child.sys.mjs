export class InstitutionalPDFBridgeActorChild extends JSWindowActorChild {
  getLoginFields() {
    const passwordField = this.document.querySelector('input[type="password"]:not([disabled])');
    if (!passwordField) {
      return { passwordField: null, usernameField: null };
    }

    const fields = Array.from(this.document.querySelectorAll("input"));
    const usernameField = fields.find((field) => {
      const type = (field.type || "text").toLowerCase();
      const name = `${field.name || ""} ${field.id || ""} ${field.autocomplete || ""}`.toLowerCase();
      return !field.disabled && type !== "hidden" && type !== "password" && (
        type === "email" ||
        type === "text" ||
        name.includes("user") ||
        name.includes("account") ||
        name.includes("login")
      );
    });

    // Find the submit button: prefer the CAS "index_login_btn" button which triggers
    // the RSA-encrypted AJAX login, then fall back to any submit button.
    const submitButton =
      this.document.getElementById("index_login_btn") ||
      this.document.querySelector('button[type="submit"], input[type="submit"]');

    return { passwordField, usernameField, submitButton };
  }

  captureCredentialSubmission() {
    const { passwordField, usernameField } = this.getLoginFields();
    const username = String(usernameField?.value || "").trim();
    const password = String(passwordField?.value || "");
    if (!username || !password) {
      return;
    }
    const fingerprint = `${username}\u0000${password}`;
    if (this.lastCapturedCredentialFingerprint === fingerprint) {
      return;
    }
    this.lastCapturedCredentialFingerprint = fingerprint;
    this.sendAsyncMessage("CaptureCredentials", {
      url: this.document.location.href,
      username,
      password
    });
  }

  watchLogin() {
    if (this.isWatchingLogin) {
      return { watching: true };
    }
    this.isWatchingLogin = true;
    this.document.addEventListener("submit", () => this.captureCredentialSubmission(), true);
    this.document.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.captureCredentialSubmission();
      }
    }, true);
    this.document.addEventListener("click", (event) => {
      const target = event.target?.closest?.(
        'button, input[type="submit"], a[id="index_login_btn"], #index_login_btn'
      );
      if (target) {
        this.captureCredentialSubmission();
      }
    }, true);
    return { watching: true };
  }

  async receiveMessage(message) {
    if (message.name === "State") {
      return {
        url: this.document.location.href,
        hasPasswordField: Boolean(this.document.querySelector('input[type="password"]'))
      };
    }

    if (message.name === "WatchLogin") {
      return this.watchLogin();
    }

    if (message.name === "FillLogin") {
      const { username, password } = message.data;
      const { passwordField, usernameField, submitButton } = this.getLoginFields();
      if (!passwordField) {
        throw new Error("Institution login password field was not found");
      }

      const setValue = (field, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          this.contentWindow.HTMLInputElement.prototype,
          "value"
        )?.set;
        if (setter) {
          setter.call(field, value);
        } else {
          field.value = value;
        }
        field.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
        field.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
      };

      if (usernameField) {
        setValue(usernameField, username);
      }
      setValue(passwordField, password);

      // Prefer the explicit submit button (e.g. CAS "index_login_btn" which triggers
      // RSA-encrypted AJAX login). This handles forms where <input> elements are
      // siblings of <form> rather than children — in that case passwordField.form
      // would be null and requestSubmit() would not fire the onsubmit handler.
      if (submitButton) {
        submitButton.click();
      } else {
        // Fallback: try to find the enclosing form by its action attribute.
        const form =
          passwordField.form ||
          usernameField?.form ||
          this.document.querySelector('form[action*="login"], form[action*="cas"]');
        if (form?.requestSubmit) {
          form.requestSubmit();
        } else if (form) {
          form.submit();
        } else {
          throw new Error("Institution login form was not found");
        }
      }
      return { submitted: true, usernameFilled: Boolean(usernameField) };
    }

    if (message.name === "ExportCookies") {
      try {
        const raw = this.document.cookie;
        if (!raw) {
          return [];
        }
        return raw.split(";").map((pair) => {
          const eq = pair.indexOf("=");
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          return { name, value };
        });
      } catch (error) {
        Zotero.debug(`ExportCookies failed: ${error}`);
        return [];
      }
    }

    if (message.name === "ImportCookies") {
      try {
        const { cookieString } = message.data || {};
        if (!cookieString) {
          return;
        }
        for (const cookie of cookieString.split(";").map((c) => c.trim()).filter(Boolean)) {
          try {
            this.document.cookie = cookie;
          } catch (e) {
            // HttpOnly or domain-restricted cookies; ignore.
          }
        }
      } catch (error) {
        Zotero.debug(`ImportCookies failed: ${error}`);
      }
      return;
    }

    if (message.name !== "Fetch") {
      throw new Error(`Unsupported institutional proxy actor message: ${message.name}`);
    }

    const { url, timeoutMs = 45000 } = message.data;
    const target = new this.contentWindow.URL(url, this.document.location.href);
    if (target.origin !== this.document.location.origin) {
      throw new Error("Cross-origin proxy fetch was blocked");
    }

    const controller = new this.contentWindow.AbortController();
    const timer = this.contentWindow.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.contentWindow.fetch(target.href, {
        credentials: "include",
        redirect: "follow",
        signal: controller.signal
      });
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("Content-Type") || "",
        responseURL: response.url || target.href,
        bytes: new Uint8Array(await response.arrayBuffer())
      };
    } finally {
      this.contentWindow.clearTimeout(timer);
    }
  }
}
