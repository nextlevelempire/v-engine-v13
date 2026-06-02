import type { Page } from "playwright";

export const visibleMode: true = true;
export const OMNI_MOTION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
const PRECISION_ARROW_CURSOR = `<svg width="20" height="24" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4.5 2.06451L17.2059 13.9161L11.5317 14.6713L14.7353 20.8064L12.3382 22L9.04412 15.6774L4.5 19.3548V2.06451Z"
        fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

export const EMPIRE_HAND_CURSOR_SVG = PRECISION_ARROW_CURSOR;

const DELAY_MIN_MS = 800;
const DELAY_MAX_MS = 2200;
const WPM_MIN = 60;
const WPM_MAX = 120;
const TYPO_PROBABILITY = 0.05;
const CLICK_OFFSET_PX = 2.25;
const BEZIER_STEPS = 32;
const DRAG_BEZIER_STEPS = 52;
const SCROLL_STEP_MIN = 40;
const SCROLL_STEP_MAX = 120;
const SCROLL_TICK_MIN_MS = 30;
const SCROLL_TICK_MAX_MS = 90;
const SEMANTIC_MAX_CHARS = 50_000;
const POINTER_STEP_MIN_MS = 4;
const POINTER_STEP_MAX_MS = 11;
const POINTER_SETTLE_MIN_MS = 22;
const POINTER_SETTLE_MAX_MS = 58;
const CLICK_HOLD_MIN_MS = 42;
const CLICK_HOLD_MAX_MS = 90;

export type OmniTelemetryEmitter = (event: string, data: Record<string, unknown>) => void;

interface Point {
  x: number;
  y: number;
}

export async function humanDelay(
  min: number = DELAY_MIN_MS,
  max: number = DELAY_MAX_MS,
): Promise<void> {
  await sleep(gaussianRandom(min, max));
}

export async function humanScroll(
  page: Page,
  targetY: number,
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  const currentY = await page.evaluate(() => window.scrollY);
  const distance = targetY - currentY;
  if (Math.abs(distance) < 10) return;

  const direction = distance > 0 ? 1 : -1;
  let remaining = Math.abs(distance);

  while (remaining > 0) {
    const step = Math.min(remaining, randomInt(SCROLL_STEP_MIN, SCROLL_STEP_MAX));
    await page.mouse.wheel(0, step * direction);
    remaining -= step;
    await sleep(randomInt(SCROLL_TICK_MIN_MS, SCROLL_TICK_MAX_MS));
    emit?.("scroll_tick", {
      remaining,
      step: step * direction,
      y: await page.evaluate(() => window.scrollY),
    });
  }
}

export async function humanType(
  page: Page,
  selector: string,
  text: string,
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  await humanClick(page, selector, emit);
  await sleep(randomInt(100, 300));

  const wpm = gaussianRandom(WPM_MIN, WPM_MAX);
  const charsPerMinute = wpm * 5;
  const baseDelayMs = 60000 / charsPerMinute;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (Math.random() < TYPO_PROBABILITY && /[a-zA-Z]/.test(char)) {
      const wrongChar = getAdjacentKey(char);
      await broadcastKey(page, wrongChar);
      await page.keyboard.press(wrongChar);
      emit?.("typing_char", { char: wrongChar, index, isTypo: true });
      await sleep(randomInt(200, 500));
      await broadcastKey(page, "\b");
      await page.keyboard.press("Backspace");
      emit?.("typing_char", { char: "Backspace", index, isCorrection: true });
      await sleep(randomInt(80, 200));
    }

    await broadcastKey(page, char);
    if (char === " ") {
      await page.keyboard.press("Space");
    } else {
      await page.keyboard.press(char);
    }

    emit?.("typing_char", { char, index, isTypo: false });

    let charDelay = gaussianRandom(baseDelayMs * 0.6, baseDelayMs * 1.4);
    if (".!?;:".includes(char)) {
      charDelay += randomInt(150, 400);
    }
    if (char === " ") {
      charDelay += randomInt(30, 120);
    }
    await sleep(charDelay);
  }
}

export async function humanClick(
  page: Page,
  selector: string,
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  const box = await page.evaluate((sel: string) => {
    let el: Element | null = null;
    try {
      el = document.querySelector(sel);
    } catch {
      // Ignore invalid selector; fallback to text lookup below.
    }

    if (!el) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node: Element | null = null;
      while ((node = walker.nextNode() as Element | null)) {
        const text = node.textContent?.trim().toLowerCase();
        if (
          text?.includes(sel.toLowerCase()) &&
          (node.tagName === "A" ||
            node.tagName === "BUTTON" ||
            node.getAttribute("role") === "button" ||
            node.tagName === "INPUT")
        ) {
          el = node;
          break;
        }
      }
    }

    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
  }, selector);

  if (!box) {
    throw new Error(`humanClick: Element not found for selector "${selector}"`);
  }

  const targetX = box.x + box.width / 2 + randomFloat(-CLICK_OFFSET_PX, CLICK_OFFSET_PX);
  const targetY = box.y + box.height / 2 + randomFloat(-CLICK_OFFSET_PX, CLICK_OFFSET_PX);
  const currentPos = await getViewportCenter(page);
  const path = generateBezierPath(currentPos.x, currentPos.y, targetX, targetY, BEZIER_STEPS);

  await moveCursorAlongPath(page, path, emit, 1);

  await sleep(randomInt(POINTER_SETTLE_MIN_MS, POINTER_SETTLE_MAX_MS));
  await page.mouse.down();
  emit?.("pointer_down", { x: targetX, y: targetY });
  await sleep(randomInt(CLICK_HOLD_MIN_MS, CLICK_HOLD_MAX_MS));
  await page.mouse.up();
  emit?.("pointer_up", { x: targetX, y: targetY });
  emit?.("click_target", { selector, x: targetX, y: targetY });
}

export async function humanMoveMouse(
  page: Page,
  x: number,
  y: number,
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  const currentPos = await getViewportCenter(page);
  const path = generateBezierPath(currentPos.x, currentPos.y, x, y, BEZIER_STEPS);

  await moveCursorAlongPath(page, path, emit);
}

export async function humanClickPixel(
  page: Page,
  x: number,
  y: number,
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  const targetX = x + randomFloat(-CLICK_OFFSET_PX, CLICK_OFFSET_PX);
  const targetY = y + randomFloat(-CLICK_OFFSET_PX, CLICK_OFFSET_PX);
  const currentPos = await getViewportCenter(page);
  const path = generateBezierPath(currentPos.x, currentPos.y, targetX, targetY, BEZIER_STEPS);

  await moveCursorAlongPath(page, path, emit, 1);

  await sleep(randomInt(POINTER_SETTLE_MIN_MS, POINTER_SETTLE_MAX_MS));
  await page.mouse.down();
  emit?.("pointer_down", { x: targetX, y: targetY });
  await sleep(randomInt(CLICK_HOLD_MIN_MS, CLICK_HOLD_MAX_MS));
  await page.mouse.up();
  emit?.("pointer_up", { x: targetX, y: targetY });
  emit?.("click_pixel", { x: targetX, y: targetY });
}

export async function humanDrag(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  const currentPos = await getViewportCenter(page);
  const approachPath = generateBezierPath(currentPos.x, currentPos.y, fromX, fromY, BEZIER_STEPS);
  await moveCursorAlongPath(page, approachPath, emit);

  emit?.("drag_start", { fromX, fromY, toX, toY });
  await page.mouse.down();
  emit?.("pointer_down", { x: fromX, y: fromY });
  await sleep(randomInt(90, 140));

  const dragPath = generateBezierPath(fromX, fromY, toX, toY, DRAG_BEZIER_STEPS);
  await moveCursorAlongPath(page, dragPath, emit);

  await sleep(randomInt(50, 100));
  await page.mouse.up();
  emit?.("pointer_up", { x: toX, y: toY });
  emit?.("drag_end", { fromX, fromY, toX, toY });
}

export async function humanPressCombo(
  page: Page,
  keys: string[],
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  if (keys.length === 0) return;

  const modifiers = keys.slice(0, -1);
  const finalKey = keys[keys.length - 1]!;

  for (const mod of modifiers) {
    await page.keyboard.down(mod);
    await sleep(randomInt(30, 80));
  }

  await page.keyboard.press(finalKey);
  await sleep(randomInt(50, 120));

  for (let index = modifiers.length - 1; index >= 0; index -= 1) {
    await page.keyboard.up(modifiers[index]!);
    await sleep(randomInt(20, 60));
  }

  emit?.("combo_key", { combo: keys.join("+"), keys });
}

export async function extractSemanticPage(
  page: Page,
  format: "markdown" | "text" = "markdown",
  emit?: OmniTelemetryEmitter,
): Promise<string> {
  const result = await page.evaluate((fmt: "markdown" | "text") => {
    if (fmt === "text") {
      return `URL: ${window.location.href}\nTitle: ${document.title}\n\n${document.body.innerText || ""}`;
    }

    const lines: string[] = [];
    lines.push(`# ${document.title}`);
    lines.push(`> URL: ${window.location.href}`);
    lines.push("");

    function traverse(node: Node): void {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text) lines.push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "svg", "path", "meta", "link"].includes(tag)) return;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;

      switch (tag) {
        case "h1":
          lines.push(`\n# ${el.innerText.trim()}`);
          return;
        case "h2":
          lines.push(`\n## ${el.innerText.trim()}`);
          return;
        case "h3":
          lines.push(`\n### ${el.innerText.trim()}`);
          return;
        case "h4":
          lines.push(`\n#### ${el.innerText.trim()}`);
          return;
        case "h5":
          lines.push(`\n##### ${el.innerText.trim()}`);
          return;
        case "h6":
          lines.push(`\n###### ${el.innerText.trim()}`);
          return;
        case "p":
          lines.push(`\n${el.innerText.trim()}\n`);
          return;
        case "a": {
          const href = el.getAttribute("href") || "";
          const text = el.innerText.trim();
          lines.push(text && href ? `[${text}](${href})` : text);
          return;
        }
        case "img":
          lines.push(`![${el.getAttribute("alt") || "image"}](${el.getAttribute("src") || ""})`);
          return;
        case "li":
          lines.push(`- ${el.innerText.trim()}`);
          return;
        case "code":
          lines.push(`\`${el.innerText.trim()}\``);
          return;
        case "pre":
          lines.push(`\n\`\`\`\n${el.innerText.trim()}\n\`\`\`\n`);
          return;
        case "blockquote":
          lines.push(`> ${el.innerText.trim()}`);
          return;
        case "hr":
          lines.push("\n---\n");
          return;
        case "br":
          lines.push("");
          return;
        case "input":
        case "textarea":
        case "select":
          lines.push(
            `[${tag}: ${el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || tag}]`,
          );
          return;
        case "button":
          lines.push(`[Button: ${el.innerText.trim()}]`);
          return;
        case "table": {
          const rows = el.querySelectorAll("tr");
          rows.forEach((row, rowIndex) => {
            const cellTexts = Array.from(row.querySelectorAll("th, td")).map((cell) =>
              (cell as HTMLElement).innerText.trim(),
            );
            lines.push(`| ${cellTexts.join(" | ")} |`);
            if (rowIndex === 0) {
              lines.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
            }
          });
          return;
        }
        default:
          break;
      }

      for (const child of Array.from(node.childNodes)) {
        traverse(child);
      }
    }

    traverse(document.body);
    return lines.join("\n");
  }, format);

  const truncated =
    result.length > SEMANTIC_MAX_CHARS
      ? `${result.slice(0, SEMANTIC_MAX_CHARS)}\n\n[... truncated at 50,000 characters]`
      : result;

  emit?.("page_extract", { format, length: truncated.length, url: page.url() });
  return truncated;
}

export async function waitForNavigation(
  page: Page,
  options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle" },
  emit?: OmniTelemetryEmitter,
): Promise<void> {
  const waitUntil = options?.waitUntil ?? "domcontentloaded";
  const timeout = options?.timeout ?? 15_000;
  const start = Date.now();

  try {
    await page.waitForLoadState(waitUntil, { timeout });
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            resolve();
          }, 100);
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });
        timer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 2000);
      });
    });
  } catch {
    console.warn(`[omni-human-rhythm] waitForNavigation timed out after ${timeout}ms`);
  }

  emit?.("nav_sync", { elapsed: Date.now() - start, url: page.url(), waitUntil });
}

async function getViewportCenter(page: Page): Promise<Point> {
  return page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
}

async function broadcastKey(page: Page, char: string): Promise<void> {
  await page
    .evaluate((value: string) => {
      if ((window as any).nleBroadcastKey) {
        (window as any).nleBroadcastKey(value, true);
        (window as any).nle_scheduleKeyboardHide?.();
      }
    }, char)
    .catch(() => {});
}

async function moveCursorAlongPath(
  page: Page,
  path: Point[],
  emit?: OmniTelemetryEmitter,
  sampleEvery: number = 5,
): Promise<void> {
  const total = Math.max(path.length - 1, 1);

  for (let index = 0; index < path.length; index += 1) {
    const point = path[index]!;
    await page.mouse.move(point.x, point.y);
    if (index % sampleEvery === 0 || index === path.length - 1) {
      emit?.("mouse_move_coord", { x: point.x, y: point.y });
    }
    const progress = total === 0 ? 1 : index / total;
    await sleep(interpolatePointerDelay(progress));
  }
}

function generateBezierPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps: number,
): Point[] {
  const path: Point[] = [];
  const dx = endX - startX;
  const dy = endY - startY;
  const cp1: Point = {
    x: startX + dx * 0.25 + randomFloat(-50, 50),
    y: startY + dy * 0.1 + randomFloat(-30, 30),
  };
  const cp2: Point = {
    x: startX + dx * 0.75 + randomFloat(-50, 50),
    y: startY + dy * 0.9 + randomFloat(-30, 30),
  };

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    const x =
      u * u * u * startX +
      3 * u * u * t * cp1.x +
      3 * u * t * t * cp2.x +
      t * t * t * endX;
    const y =
      u * u * u * startY +
      3 * u * u * t * cp1.y +
      3 * u * t * t * cp2.y +
      t * t * t * endY;
    path.push({ x: Math.round(x), y: Math.round(y) });
  }

  return path;
}

function interpolatePointerDelay(progress: number): number {
  const eased = materialEase(progress);
  return Math.round(POINTER_STEP_MAX_MS - (POINTER_STEP_MAX_MS - POINTER_STEP_MIN_MS) * eased);
}

function materialEase(t: number): number {
  return cubicBezierAtTime(t, 0.4, 0, 0.2, 1);
}

function cubicBezierAtTime(t: number, p1x: number, p1y: number, p2x: number, p2y: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleCurveX = (value: number) => ((ax * value + bx) * value + cx) * value;
  const sampleCurveY = (value: number) => ((ay * value + by) * value + cy) * value;
  const sampleDerivativeX = (value: number) => (3 * ax * value + 2 * bx) * value + cx;

  let solved = t;
  for (let index = 0; index < 6; index += 1) {
    const x = sampleCurveX(solved) - t;
    const derivative = sampleDerivativeX(solved);
    if (Math.abs(x) < 1e-5 || Math.abs(derivative) < 1e-5) {
      break;
    }
    solved -= x / derivative;
  }

  let lower = 0;
  let upper = 1;
  while (sampleCurveX(solved) > t) {
    upper = solved;
    solved = (lower + solved) / 2;
  }
  while (sampleCurveX(solved) < t) {
    lower = solved;
    solved = (solved + upper) / 2;
  }

  return sampleCurveY(solved);
}

function getAdjacentKey(char: string): string {
  const keyboardMap: Record<string, string[]> = {
    a: ["s", "q", "z"],
    b: ["v", "g", "n"],
    c: ["x", "d", "v"],
    d: ["s", "e", "f", "c"],
    e: ["w", "r", "d"],
    f: ["d", "r", "g", "v"],
    g: ["f", "t", "h", "b"],
    h: ["g", "y", "j", "n"],
    i: ["u", "o", "k"],
    j: ["h", "u", "k", "m"],
    k: ["j", "i", "l"],
    l: ["k", "o"],
    m: ["n", "j"],
    n: ["b", "h", "m"],
    o: ["i", "p", "l"],
    p: ["o", "l"],
    q: ["w", "a"],
    r: ["e", "t", "f"],
    s: ["a", "w", "d", "x"],
    t: ["r", "y", "g"],
    u: ["y", "i", "j"],
    v: ["c", "f", "b"],
    w: ["q", "e", "s"],
    x: ["z", "s", "c"],
    y: ["t", "u", "h"],
    z: ["a", "x"],
  };
  const options = keyboardMap[char.toLowerCase()];
  if (!options || options.length === 0) return char;
  const replacement = options[randomInt(0, options.length - 1)]!;
  return char === char.toUpperCase() ? replacement.toUpperCase() : replacement;
}

function gaussianRandom(min: number, max: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const normalized = Math.min(1, Math.max(0, num / 10 + 0.5));
  return min + normalized * (max - min);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
