// Shared helpers for the user management scripts. Passwords are only ever read from stdin,
// never from arguments or environment variables, and are never printed.
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { createDb } = require("../db");
const { normaliseEmail } = require("../security");

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;
// bcrypt ignores everything after 72 bytes, so longer passwords would be silently cut.
const MAX_PASSWORD_BYTES = 72;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseEmail(value) {
  const email = normaliseEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("A valid email address is required.");
  return email;
}

function passwordProblem(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return `The password must be at most ${MAX_PASSWORD_BYTES} bytes.`;
  return null;
}

// Reads one line from stdin without echoing it when stdin is a terminal.
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped input: take the first line.
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => {
        data += chunk;
      });
      stdin.on("end", () => resolve(data.split(/\r?\n/)[0]));
      stdin.on("error", reject);
      return;
    }
    process.stderr.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// Asks for a new password (twice on a terminal) and returns its bcrypt hash.
async function askNewPasswordHash() {
  const password = await readHidden("New password: ");
  const problem = passwordProblem(password);
  if (problem) fail(problem);
  if (process.stdin.isTTY) {
    const again = await readHidden("Repeat password: ");
    if (again !== password) fail("The passwords do not match.");
  }
  return bcrypt.hash(password, BCRYPT_COST);
}

async function openDb() {
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = createDb(pool);
  await db.init();
  return { db, close: () => pool.end() };
}

module.exports = { fail, parseEmail, passwordProblem, askNewPasswordHash, openDb };
