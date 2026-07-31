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
    return { passwordField, usernameField };
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
      const target = event.target?.closest?.('button, input[type="submit"]');
      if (target && (target.type === "submit" || target.matches?.('button:not([type]), button[type="submit"]'))) {
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
      const { passwordField, usernameField } = this.getLoginFields();
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

      const form = passwordField.form || usernameField?.form;
      const submitter = form?.querySelector('button[type="submit"], input[type="submit"]') ||
        this.document.querySelector('button[type="submit"], input[type="submit"]');
      if (submitter) {
        submitter.click();
      } else if (form?.requestSubmit) {
        form.requestSubmit();
      } else if (form) {
        form.submit();
      } else {
        throw new Error("Institution login form was not found");
      }
      return { submitted: true, usernameFilled: Boolean(usernameField) };
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
