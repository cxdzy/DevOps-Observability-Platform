// Password rules for the dashboard routes, and the temporary password an admin hands out.
// The same limits as scripts/common.js: at least 12 characters, at most 72 bytes (bcrypt ignores
// everything after 72 bytes, so a longer password would be cut without anyone knowing).
const crypto = require("crypto");

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;
const TEMP_PASSWORD_LENGTH = 20;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// A sentence saying what is wrong with a new password, or null when it is fine.
function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return `The new password must be at most ${MAX_PASSWORD_BYTES} bytes.`;
  return null;
}

// length random letters and digits from crypto.randomBytes. Bytes of 248 and above are skipped, so
// every character of the 62 is equally likely (248 is the largest multiple of 62 below 256).
function temporaryPassword(length = TEMP_PASSWORD_LENGTH) {
  if (!Number.isInteger(length) || length < 16) throw new Error("A temporary password has at least 16 characters.");
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

module.exports = { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES, TEMP_PASSWORD_LENGTH, passwordProblem, temporaryPassword };
