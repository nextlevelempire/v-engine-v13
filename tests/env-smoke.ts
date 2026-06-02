import assert from "node:assert/strict";
import dotenv from "dotenv";

dotenv.config({ path: ".env.example" });

const leaked = Object.keys(process.env).filter(
  (key) => key.startsWith("NEXT_") || key.startsWith("DATABASE_"),
);

assert.deepEqual(leaked, []);
console.log("env smoke ok");
