/**
 * Unit test for the structured JSON logger (P4-01).
 * Tests the log module by capturing stdout/stderr.
 */
import assert from "node:assert/strict";
import { Writable } from "node:stream";

function captureStream(stream: NodeJS.WriteStream, fn: () => void): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });
    const origWrite = stream.write.bind(stream);
    (stream as any).write = (data: any) => sink.write(data);
    fn();
    setImmediate(() => {
      (stream as any).write = origWrite;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

const { log } = await import("../src/server/log.js");

// info goes to stdout
const out = await captureStream(process.stdout, () => {
  log.info("test.event", { foo: "bar", n: 42 });
});
const lines = out.trim().split("\n");
assert.equal(lines.length, 1, "should emit exactly one line");
const obj = JSON.parse(lines[0]);
assert.equal(obj.level, "info");
assert.equal(obj.msg, "test.event");
assert.equal(obj.data.foo, "bar");
assert.equal(obj.data.n, 42);
assert.match(obj.ts, /^\d{4}-\d{2}-\d{2}T/);

// warn goes to stderr
const errOut = await captureStream(process.stderr, () => {
  log.warn("test.warn", { x: 1 });
});
const warnObj = JSON.parse(errOut.trim());
assert.equal(warnObj.level, "warn");

// error goes to stderr
const errOut2 = await captureStream(process.stderr, () => {
  log.error("test.error", { y: 2 });
});
const errObj = JSON.parse(errOut2.trim());
assert.equal(errObj.level, "error");

// Level filter: debug suppressed at default level
const out2 = await captureStream(process.stdout, () => {
  log.debug("test.debug", { hidden: true });
});
assert.equal(out2, "", "debug should be suppressed at default level");

// Level filter: debug emitted when OMNI_LOG_LEVEL=debug
process.env.OMNI_LOG_LEVEL = "debug";
// Re-import to pick up env (cache invalidation via query string)
const mod = await import("../src/server/log.js?re" + Date.now());
const out3 = await captureStream(process.stdout, () => {
  mod.log.debug("test.debug2", { visible: true });
});
delete process.env.OMNI_LOG_LEVEL;
assert.match(out3, /"msg":"test.debug2"/, "debug should be emitted when OMNI_LOG_LEVEL=debug");

console.log("structured-logging unit test ok");
