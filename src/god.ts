/**
 * Developer "god mode": enabled only by ?god-mode=zrax, opened with the L key,
 * and unlocked once per device with a password. Only salted SHA-256 hashes are
 * stored here; the password itself never appears in the code.
 *
 * This is obfuscation for a dev tool, not security: anyone can edit client code.
 * Full tools work offline and in matches this browser hosts (via the authority's
 * admin channel), never against other real players in public matches; in other
 * hosts' private parties only ESP and aim assist apply.
 */
const CHECK = "a64131e931d8621c73ec1d50debfc71cf2ae4b56968f7e5693dec2c1fa57b4f5";
const DEVICE_VERIFY =
  "5795cae26e79aa3b80676689d8b2d509ceb7a1643b8dbdfcb6aebd2638a97fca";
const CHECK_SALT = "wildline:god:check:v1:";
const DEVICE_SALT = "wildline:god:device:v1:";
const STORAGE_KEY = "wildline.dev.v1";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export type GodAction = "tp-enemy" | "tp-center";
export type GodScope = "full" | "assist" | "off";

export class GodMode {
  esp = false;
  aimbot = false;
  invulnerable = false;
  infiniteAmmo = false;
  speed = false;
  infiniteRange = false;
  private unlocked = false;
  private root: HTMLDivElement | null = null;
  private lastAttempt = 0;
  onAction: (action: GodAction) => void = () => {};
  /** "full" offline, "assist" in private parties (ESP/aim only), "off" in public matches. */
  scope: () => GodScope = () => "full";

  constructor() {
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.code !== "KeyL" || e.repeat) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      void this.toggle();
    });
  }
  /** Effective switches after applying the current scope. */
  get espOn() {
    return this.esp && this.scope() !== "off";
  }
  get aimOn() {
    return this.aimbot && this.scope() !== "off";
  }
  get godOn() {
    return this.invulnerable && this.scope() === "full";
  }
  get ammoOn() {
    return this.infiniteAmmo && this.scope() === "full";
  }
  get speedOn() {
    return this.speed && this.scope() === "full";
  }
  get rangeOn() {
    return this.infiniteRange && this.scope() === "full";
  }
  private async toggle(): Promise<void> {
    if (!this.unlocked) {
      let stored = "";
      try {
        stored = localStorage.getItem(STORAGE_KEY) || "";
      } catch {
        // Storage blocked: ask for the password every time.
      }
      if (stored && (await sha256(stored)) === DEVICE_VERIFY) this.unlocked = true;
      else {
        this.showLogin();
        return;
      }
    }
    this.showMenu(!this.root || this.root.dataset.view !== "menu" || this.root.hidden);
  }
  private shell(): HTMLDivElement {
    if (this.root) return this.root;
    const style = document.createElement("style");
    style.textContent = `
      #dev-panel{position:fixed;top:96px;right:16px;z-index:40;width:min(300px,calc(100vw - 32px));
        background:#0b1512f2;border:1px solid #c084fc;border-radius:8px;color:#efe7ff;
        font:13px/1.5 system-ui,sans-serif;padding:14px;box-shadow:0 10px 40px #0008}
      #dev-panel[hidden]{display:none}
      #dev-panel h3{margin:0 0 8px;font-size:14px;letter-spacing:1px;color:#d8b4fe}
      #dev-panel label{display:flex;gap:8px;align-items:center;margin:6px 0;cursor:pointer}
      #dev-panel button{margin:4px 4px 0 0;padding:6px 10px;background:#2a1747;color:#efe7ff;
        border:1px solid #c084fc;border-radius:4px;cursor:pointer}
      #dev-panel input[type=password]{width:100%;padding:7px;margin:6px 0;background:#140d22;
        color:#fff;border:1px solid #6b4fa0;border-radius:4px}
      #dev-panel small{display:block;color:#b9a6d6;margin-top:8px}`;
    document.head.append(style);
    const root = (this.root = document.createElement("div"));
    root.id = "dev-panel";
    root.setAttribute("role", "dialog");
    root.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.append(root);
    return root;
  }
  private showLogin(): void {
    const root = this.shell();
    root.dataset.view = "login";
    root.hidden = false;
    root.replaceChildren();
    const title = document.createElement("h3");
    title.textContent = "DEVELOPER ACCESS";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = "Password";
    const status = document.createElement("small");
    const submit = document.createElement("button");
    submit.textContent = "UNLOCK";
    const attempt = async () => {
      if (Date.now() - this.lastAttempt < 1500) {
        status.textContent = "Wait a moment before trying again.";
        return;
      }
      this.lastAttempt = Date.now();
      const password = input.value;
      input.value = "";
      if ((await sha256(CHECK_SALT + password)) !== CHECK) {
        status.textContent = "Incorrect password.";
        return;
      }
      this.unlocked = true;
      try {
        // Device proof: a different salted hash; the code only knows its hash.
        localStorage.setItem(STORAGE_KEY, await sha256(DEVICE_SALT + password));
      } catch {
        // Unlock lasts for this session only.
      }
      this.showMenu(true);
    };
    submit.addEventListener("click", () => void attempt());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void attempt();
      if (e.key === "Escape") root.hidden = true;
    });
    root.append(title, input, submit, status);
    input.focus();
  }
  private showMenu(visible: boolean): void {
    const root = this.shell();
    root.hidden = !visible;
    if (!visible) return;
    root.dataset.view = "menu";
    root.replaceChildren();
    const scope = this.scope();
    const title = document.createElement("h3");
    title.textContent = "DEV TOOLS · L TO CLOSE";
    root.append(title);
    const toggle = (
      key: "esp" | "aimbot" | "invulnerable" | "infiniteAmmo" | "speed" | "infiniteRange",
      text: string,
      available: boolean,
    ) => {
      const label = document.createElement("label"),
        box = document.createElement("input");
      box.type = "checkbox";
      box.checked = this[key];
      box.disabled = !available;
      box.addEventListener("change", () => (this[key] = box.checked));
      label.append(box, text + (available ? "" : " (unavailable here)"));
      root.append(label);
    };
    toggle("esp", "ESP · boxes and tracers on every opponent", scope !== "off");
    toggle("aimbot", "Aim assist · lock onto the nearest opponent", scope !== "off");
    toggle("invulnerable", "Invulnerable", scope === "full");
    toggle("infiniteAmmo", "Infinite ammo", scope === "full");
    toggle("speed", "Speed boost", scope === "full");
    toggle("infiniteRange", "Infinite range", scope === "full");
    const action = (text: string, value: GodAction) => {
      const button = document.createElement("button");
      button.textContent = text;
      button.disabled = scope !== "full";
      button.addEventListener("click", () => this.onAction(value));
      root.append(button);
    };
    action("TP → nearest enemy", "tp-enemy");
    action("TP → zone centre", "tp-center");
    const note = document.createElement("small");
    note.textContent =
      scope === "off"
        ? "Disabled in public matches with other real players."
        : scope === "assist"
          ? "In someone else's party: their host controls health, ammo and movement, so only ESP and aim assist apply."
          : "All tools active (offline, or a match you host).";
    root.append(note);
  }
}
