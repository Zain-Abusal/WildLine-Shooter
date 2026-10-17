export class Input {
  keys: Record<string, boolean> = Object.create(null);
  mx = 0;
  my = 0;
  ax = 0;
  ay = 0;
  pointerX = 0;
  pointerY = 0;
  shoot = false;
  collect = false;
  touch = false;
  weapon = 0;
  pointerAim = false;
  onLeaderboard: () => void = () => {};
  private resetMove = () => {};
  private resetAim = () => {};
  constructor(
    canvas: HTMLCanvasElement,
    public pause: () => void,
  ) {
    const touch = matchMedia("(pointer: coarse)").matches;
    this.setTouch(touch);
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape") {
        if (!e.repeat) {
          e.preventDefault();
          this.pause();
        }
        return;
      }
      if (
        (e.target as HTMLElement).tagName === "INPUT" ||
        (e.target as HTMLElement).tagName === "SELECT"
      )
        return;
      if (e.code === "Tab" && document.activeElement === canvas) {
        e.preventDefault();
        if (!e.repeat) this.onLeaderboard();
        return;
      }
      this.setTouch(false);
      if (
        ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
          e.code,
        )
      )
        e.preventDefault();
      this.keys[e.code] = true;
      if (e.code === "Digit1") this.weapon = 0;
      if (e.code === "Digit2") this.weapon = 1;
    });
    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
    });
    window.addEventListener("blur", () => this.clear());
    window.addEventListener("resize", () => this.clear());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clear();
    });
    window.addEventListener(
      "touchend",
      (event) => {
        if (event.touches.length === 0) this.clear();
      },
      { passive: true },
    );
    window.addEventListener("touchcancel", () => this.clear(), {
      passive: true,
    });
    for (const type of ["gesturestart", "gesturechange", "gestureend"])
      document.addEventListener(
        type,
        (event) => {
          if (document.body.classList.contains("playing"))
            event.preventDefault();
        },
        { passive: false },
      );

    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") {
        this.pointerX = e.clientX;
        this.pointerY = e.clientY;
        this.pointerAim = true;
      }
    });
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") {
        this.setTouch(false);
        this.shoot = true;
        this.pointerX = e.clientX;
        this.pointerY = e.clientY;
        this.pointerAim = true;
      } else this.setTouch(true);
    });
    window.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse") this.shoot = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.stick("move-stick", false);
    this.stick("aim-stick", true);
    const attack = document.getElementById("attack")!;
    attack.addEventListener("pointerdown", (e) => {
      attack.setPointerCapture(e.pointerId);
      this.shoot = true;
    });
    attack.addEventListener("pointerup", () => (this.shoot = false));
    attack.addEventListener("pointercancel", () => (this.shoot = false));
    attack.addEventListener("lostpointercapture", () => (this.shoot = false));
    const interact = document.getElementById("interact")!;
    interact.addEventListener("pointerdown", () => (this.collect = true));
    interact.addEventListener("pointerup", () => (this.collect = false));
    interact.addEventListener("pointercancel", () => (this.collect = false));
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") this.setTouch(true);
    });
  }
  setTouch(value: boolean): void {
    this.touch = value;
    if (value) this.pointerAim = false;
    document.body.classList.toggle("touch", value);
  }
  clear(): void {
    for (const k in this.keys) this.keys[k] = false;
    this.mx = this.my = this.ax = this.ay = 0;
    this.shoot = this.collect = false;
    this.resetMove();
    this.resetAim();
  }
  stick(id: string, aim: boolean): void {
    const el = document.getElementById(id)!,
      knob = el.firstElementChild as HTMLElement;
    let pointer = -1,
      cx = 0,
      cy = 0;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      let x = (e.clientX - cx) / 40,
        y = (e.clientY - cy) / 40;
      const l = Math.hypot(x, y);
      if (l < 0.12) {
        x = 0;
        y = 0;
      }
      if (l > 1) {
        x /= l;
        y /= l;
      }
      if (aim) {
        this.ax = x;
        this.ay = y;
        this.pointerAim = false;
      } else {
        this.mx = x;
        this.my = y;
      }
      knob.style.transform = `translate(${x * 30}px,${y * 30}px)`;
    };
    const reset = () => {
      const previous = pointer;
      pointer = -1;
      if (previous !== -1 && el.hasPointerCapture(previous))
        el.releasePointerCapture(previous);
      if (aim) this.ax = this.ay = 0;
      else this.mx = this.my = 0;
      knob.style.transform = "";
    };
    if (aim) this.resetAim = reset;
    else this.resetMove = reset;
    el.addEventListener("pointerdown", (e) => {
      if (pointer !== -1) return;
      pointer = e.pointerId;
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      el.setPointerCapture(pointer);
      move(e);
    });
    el.addEventListener("pointermove", move);
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      reset();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
  update(): void {
    if (!this.touch) {
      this.mx =
        (this.keys.KeyD || this.keys.ArrowRight ? 1 : 0) -
        (this.keys.KeyA || this.keys.ArrowLeft ? 1 : 0);
      this.my =
        (this.keys.KeyS || this.keys.ArrowDown ? 1 : 0) -
        (this.keys.KeyW || this.keys.ArrowUp ? 1 : 0);
    }
    this.collect = !!this.keys.KeyE || this.collect;
  }
}
