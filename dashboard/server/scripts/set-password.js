// Sets or changes a user's password and signs that user out everywhere.
// Usage: node server/scripts/set-password.js <email>
// The new password is read from a hidden prompt.
const { fail, parseEmail, askNewPasswordHash, openDb } = require("./common");
const { setUserPassword } = require("./actions");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) fail("Usage: set-password.js <email>");
  const email = parseEmail(args[0]);

  const { db, close } = await openDb();
  try {
    // Check the user first so nobody types a password for an address that does not exist.
    if (!(await db.findUserByEmail(email))) fail(`No user with the email ${email}.`);
    const passwordHash = await askNewPasswordHash();
    console.log(await setUserPassword(db, email, passwordHash));
  } finally {
    await close();
  }
}

main().catch((err) => fail(err.message));
