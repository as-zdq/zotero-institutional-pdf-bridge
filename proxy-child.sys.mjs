export class InstitutionalPDFBridgeActorChild extends JSWindowActorChild {
  isVisible(element) {
    if (!element || element.disabled || element.type === "hidden") {
      return false;
    }
    return !element.getClientRects || element.getClientRects().length > 0;
  }

  getPasswordLoginSwitch() {
    return Array.from(this.document.querySelectorAll('[role="tab"], [role="menuitem"], button, a'))
      .find((element) => this.isVisible(element) &&
        /^(?:password(?:\s+login|\s+sign[ -]?in)?|(?:\u8d26\u53f7|\u8d26\u6237)?\u5bc6\u7801\u767b\u5f55)$/i
          .test((element.textContent || "").trim()));
  }

  getLoginFields() {
    let fields = Array.from(this.document.querySelectorAll("input"));
    const passwordField = fields.find((field) => field.type === "password" && this.isVisible(field) &&
      !/captcha|verification|dynamic\s*code|one-time-code|otp|\u9a8c\u8bc1\u7801/i.test(
        `${field.name || ""} ${field.id || ""} ${field.placeholder || ""} ${field.autocomplete || ""}`
      ));
    if (!passwordField) {
      return { passwordField: null, usernameField: null };
    }

    const form = passwordField.form;
    if (form?.querySelectorAll) {
      fields = Array.from(form.querySelectorAll("input"));
    }
    const usernameFields = fields.filter((field) => {
      const type = (field.type || "text").toLowerCase();
      const label = `${field.name || ""} ${field.id || ""} ${field.placeholder || ""}`;
      return this.isVisible(field) && ["text", "email", "tel"].includes(type) &&
        !/captcha|verification|dynamic\s*code|otp|\u9a8c\u8bc1\u7801/i.test(label);
    });
    const usernameField = usernameFields.find((field) =>
      /username|account|netid|login/i.test(`${field.name || ""} ${field.id || ""} ${field.autocomplete || ""}`)
    ) || usernameFields[0];
    return { passwordField, usernameField };
  }

  isLoginSubmitter(element) {
    return this.isVisible(element) && (element.type === "submit" ||
      /^(?:log\s*in|sign\s*in|\u767b\u5f55|\u767b\u5165)$/i.test((element.textContent || element.value || "").trim()));
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
      if (target && this.isLoginSubmitter(target)) {
        this.captureCredentialSubmission();
      }
    }, true);
    return { watching: true };
  }

  async receiveMessage(message) {
    if (message.name === "State") {
      const { passwordField } = this.getLoginFields();
      return {
        url: this.document.location.href,
        contentType: this.document.contentType,
        readyState: this.document.readyState,
        hasPasswordField: Boolean(passwordField),
        hasPasswordLogin: Boolean(this.getPasswordLoginSwitch())
      };
    }

    if (message.name === "WatchLogin") {
      return this.watchLogin();
    }

    if (message.name === "FillLogin") {
      const { username, password } = message.data;
      if (!this.getLoginFields().passwordField) {
        this.getPasswordLoginSwitch()?.click();
        for (let attempt = 0; attempt < 30 && !this.getLoginFields().passwordField; attempt++) {
          await new Promise((resolve) => this.contentWindow.setTimeout(resolve, 100));
        }
      }
      const { passwordField, usernameField } = this.getLoginFields();
      if (!passwordField || !usernameField) {
        throw new Error("Visible institution username/password fields were not found");
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

      setValue(usernameField, username);
      setValue(passwordField, password);

      const form = passwordField.form || usernameField?.form;
      const submitter = Array.from((form || this.document).querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )).find((element) => this.isLoginSubmitter(element));
      if (submitter) {
        submitter.click();
      } else if (form?.requestSubmit) {
        form.requestSubmit();
      } else {
        throw new Error("Institution login button was not found");
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
