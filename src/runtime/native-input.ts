/**
 * Native desktop input adapter for local_computer takeover.
 *
 * Wraps a native mouse/keyboard/screen library (nut.js) behind a tiny interface so
 * the computer-use loop can drive ANY desktop app. The dependency is OPTIONAL and
 * loaded by dynamic import: a machine that only offers local_browser never needs
 * the native module, and the daemon still builds/typechecks without it installed.
 *
 * Install on a machine that should offer full desktop control:
 *   pnpm add @nut-tree-fork/nut-js
 * and grant OS Screen Recording + Accessibility permissions when prompted.
 */

export type NativeInputAdapter = {
  screenshotPng(): Promise<Buffer>;
  moveMouse(x: number, y: number): Promise<void>;
  click(button: "left" | "right" | "middle"): Promise<void>;
  doubleClick(button: "left" | "right" | "middle"): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  screenSize(): Promise<{ height: number; width: number }>;
  /** Wave 2: drag from (x1, y1) to (x2, y2). */
  drag?(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  /** Wave 2: scroll the wheel at the current cursor position. */
  scroll?(deltaX: number, deltaY: number): Promise<void>;
  /** Wave 2: read the OS clipboard text. */
  clipboardRead?(): Promise<string>;
  /** Wave 2: write text to the OS clipboard. */
  clipboardWrite?(text: string): Promise<void>;
};

// nut.js package name held in a variable so TypeScript treats the dynamic import as
// `any` and does not require the (optional) module to be present at compile time.
const NUT_PACKAGE = "@nut-tree-fork/nut-js";

let cachedAdapter: NativeInputAdapter | null = null;
let loadAttempted = false;

async function loadNutAdapter(): Promise<NativeInputAdapter | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nut: any = await import(NUT_PACKAGE);
    const { keyboard, mouse, screen, Button, Key, Point, straightTo } = nut;

    // Make automation snappy but still human-plausible.
    if (mouse?.config) {
      mouse.config.autoDelayMs = 12;
      mouse.config.mouseSpeed = 1_200;
    }
    if (keyboard?.config) {
      keyboard.config.autoDelayMs = 8;
    }

    const buttonOf = (button: "left" | "right" | "middle") =>
      button === "right" ? Button.RIGHT : button === "middle" ? Button.MIDDLE : Button.LEFT;

    const keyOf = (name: string): unknown => {
      const normalized = name.trim();
      const key = (Key as Record<string, unknown>)[normalized] ?? (Key as Record<string, unknown>)[
        normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase()
      ];
      if (key === undefined) {
        throw new Error(`Unknown key: ${name}`);
      }
      return key;
    };

    const adapter: NativeInputAdapter = {
      async click(button) {
        await mouse.click(buttonOf(button));
      },
      async doubleClick(button) {
        await mouse.doubleClick(buttonOf(button));
      },
      async moveMouse(x, y) {
        await mouse.move(straightTo(new Point(x, y)));
      },
      async pressKeys(keys) {
        const resolved = keys.map(keyOf);
        await keyboard.pressKey(...resolved);
        await keyboard.releaseKey(...resolved);
      },
      async screenSize() {
        const width = await screen.width();
        const height = await screen.height();
        return { height, width };
      },
      async screenshotPng() {
        // nut.js grab() returns an Image; convert to PNG via its provider if present,
        // else fall back to jimp-style raw. We rely on @nut-tree's image-to-png helper.
        const image = await screen.grab();
        if (typeof nut.imageToBuffer === "function") {
          return (await nut.imageToBuffer(image)) as Buffer;
        }
        // Some builds expose .data (BGRA). Without a PNG encoder we cannot transcode
        // safely here, so signal the caller to install the screen provider.
        throw new Error(
          "Native screenshot encoder unavailable. Install @nut-tree-fork/nut-js with its image provider.",
        );
      },
      async typeText(text) {
        await keyboard.type(text);
      },
      // Wave 2: drag, scroll, clipboard. Optional methods on the interface;
      // the smoke tests inject stubs so a missing nut.js module is fine.
      async drag(x1, y1, x2, y2) {
        if (typeof mouse.drag === "function") {
          await mouse.drag(straightTo(new Point(x1, y1)), straightTo(new Point(x2, y2)));
          return;
        }
        // Fallback: step the mouse manually if drag helper is unavailable.
        await mouse.move(straightTo(new Point(x1, y1)));
        await mouse.pressButton(buttonOf("left"));
        await mouse.move(straightTo(new Point(x2, y2)));
        await mouse.releaseButton(buttonOf("left"));
      },
      async scroll(deltaX, deltaY) {
        if (typeof mouse.scroll === "function") {
          await mouse.scroll(deltaX, deltaY);
          return;
        }
        if (typeof mouse.wheel === "function") {
          await mouse.wheel(deltaX, deltaY);
        }
      },
      async clipboardRead() {
        const clipboardApi = nut.clipboard ?? nut.Clipboard;
        if (clipboardApi?.getAll?.content) {
          return String((await clipboardApi.getAll.content()) ?? "");
        }
        if (clipboardApi?.getString) {
          return String((await clipboardApi.getString()) ?? "");
        }
        throw new Error("Native clipboard read unavailable. Install @nut-tree-fork/nut-js clipboard provider.");
      },
      async clipboardWrite(text) {
        const clipboardApi = nut.clipboard ?? nut.Clipboard;
        if (clipboardApi?.set?.content) {
          await clipboardApi.set.content(text);
          return;
        }
        if (clipboardApi?.setString) {
          await clipboardApi.setString(text);
          return;
        }
        throw new Error("Native clipboard write unavailable. Install @nut-tree-fork/nut-js clipboard provider.");
      },
    };

    return adapter;
  } catch {
    return null;
  }
}

/** Resolve the native input adapter, or null if the optional module is absent. */
export async function getNativeInputAdapter(): Promise<NativeInputAdapter | null> {
  if (cachedAdapter) {
    return cachedAdapter;
  }
  if (loadAttempted) {
    return cachedAdapter;
  }
  loadAttempted = true;
  cachedAdapter = await loadNutAdapter();
  return cachedAdapter;
}

export async function isNativeInputAvailable(): Promise<boolean> {
  return (await getNativeInputAdapter()) !== null;
}
