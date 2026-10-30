// Sets or changes a user's password and signs that user out everywhere.
// Usage: node server/scripts/set-password.js <email>
// The new password is read from a hidden prompt.
const { fail, parseEmail, askNewPasswordHash, openDb } = require("./common");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) fail("Usage: set-password.js <email>");
  const email = parseEmail(args[0]);

  const { db, close } = await openDb();
  try {
    const user = await db.findUserByEmail(email);
    if (!user) fail(`No user with the email ${email}.`);
    const passwordHash = await askNewPasswordHash();
    await db.setPassword(user.id, passwordHash);
    await db.deleteUserSessions(user.id);
    console.log(`Password changed for ${email}; existing sessions were ended.`);
  } finally {
    await close();
  }
}

main().catch((err) => fail(`set-password failed: ${err.message}`));
