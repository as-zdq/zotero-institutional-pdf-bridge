export class InstitutionalPDFBridgeActorChild extends JSWindowActorChild {
  isVisibleField(field) {
    if (!field || field.disabled || field.hidden || field.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
    const view = this.contentWindow || this.document.defaultView;
    const style = view?.getComputedStyle?.(field);
    return (!style || (style.display !== "none" && style.visibility !== "hidden")) &&
      (typeof field.getClientRects !== "function" || field.getClientRects().length > 0);
  }

  getLoginFields() {
    const fields = Array.from(this.document.querySelectorAll("input"));
    const passwordFields = fields.filter((field) =>
      (field.type || "").toLowerCase() === "password" && !field.disabled
    );
    const passwordField = passwordFields.find((field) => this.isVisibleField(field)) ||
      passwordFields[0];
    if (!passwordField) {
      return { passwordField: null, usernameField: null };
    }

    const isUsernameField = (field, requireVisible) => {
      const type = (field.type || "text").toLowerCase();
      const name = `${field.name || ""} ${field.id || ""} ${field.autocomplete || ""} ${field.placeholder || ""}`.toLowerCase();
      return (!requireVisible || this.isVisibleField(field)) && !field.disabled &&
        type !== "hidden" && type !== "password" && (
        type === "email" ||
        type === "text" ||
        type === "tel" ||
        name.includes("user") ||
        name.includes("account") ||
        name.includes("login") ||
        name.includes("学号") ||
        name.includes("职工号") ||
        name.includes("手机号")
      );
    };
    const usernameField = fields.find((field) =>
      field.form === passwordField.form && isUsernameField(field, true)
    ) || fields.find((field) => isUsernameField(field, true)) ||
      fields.find((field) => field.form === passwordField.form && isUsernameField(field, false)) ||
      fields.find((field) => isUsernameField(field, false));
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
        hasPasswordField: Boolean(this.getLoginFields().passwordField)
      };
    }

    if (message.name === "WatchLogin") {
      return this.watchLogin();
    }

    if (message.name === "FillLogin") {
      const { username, password } = message.data;
      const { passwordField, usernameField } = this.getLoginFields();
      if (!passwordField) {
        throw new Error("未找到机构登录密码输入框");
      }

      const setValue = (field, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          this.contentWindow.HTMLInputElement.prototype,
          "value"
        )?.set;
        field.focus?.();
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

      // Let login pages driven by Vue/React update their form state before
      // choosing and activating the submit control.
      if (typeof this.contentWindow.setTimeout === "function") {
        await new Promise((resolve) => this.contentWindow.setTimeout(resolve, 0));
      }

      const form = passwordField.form || usernameField?.form;
      const controls = Array.from(
        (form || this.document).querySelectorAll?.('button:not([disabled]), input[type="submit"]') || []
      );
      const visibleControls = controls.filter((control) => this.isVisibleField(control));
      const labelledLogin = (control) => /^(?:登录|login|signin)$/i.test(
        String(control.textContent || control.value || "").replace(/\s+/g, "")
      );
      const submitter = visibleControls.find((control) =>
        (control.type || "").toLowerCase() === "submit"
      ) || visibleControls.find(labelledLogin) ||
        form?.querySelector?.('button[type="submit"], input[type="submit"]') ||
        this.document.querySelector?.('button[type="submit"], input[type="submit"]') ||
        controls.find(labelledLogin);
      if (submitter) {
        submitter.click();
      } else if (form?.requestSubmit) {
        form.requestSubmit();
      } else if (form) {
        form.submit();
      } else {
        throw new Error("未找到机构登录表单");
      }
      return { submitted: true, usernameFilled: Boolean(usernameField) };
    }

    if (message.name !== "Fetch") {
      throw new Error(`不支持的机构代理消息：${message.name}`);
    }

    const { url, timeoutMs = 45000 } = message.data;
    const target = new this.contentWindow.URL(url, this.document.location.href);
    if (target.origin !== this.document.location.origin) {
      throw new Error("已阻止跨域代理请求");
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
