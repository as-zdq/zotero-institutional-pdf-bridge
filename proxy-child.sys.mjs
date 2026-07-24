export class InstitutionalPDFBridgeActorChild extends JSWindowActorChild {
  async receiveMessage(message) {
    if (message.name === "State") {
      return {
        url: this.document.location.href,
        hasPasswordField: Boolean(this.document.querySelector('input[type="password"]'))
      };
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
