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
