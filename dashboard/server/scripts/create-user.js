// Creates a dashboard user. This is the only way to add a user; there is no sign-up page.
// Usage: node server/scripts/create-user.js <email> <admin|viewer> [--password]
// With --password the password is read from a hidden prompt. Without it the user can only
// sign in with Google.
const { fail, parseEmail, askNewPasswordHash, openDb } = require("./common");

async function main() {
  const args = process.argv.slice(2);
  const withPassword = args.includes("--password");
  const [emailArg, role, ...rest] = args.filter((a) => a !== "--password");
  if (!emailArg || !role || rest.length) fail("Usage: create-user.js <email> <admin|viewer> [--password]");
  if (role !== "admin" && role !== "viewer") fail("The role must be admin or viewer.");
  const email = parseEmail(emailArg);

  const passwordHash = withPassword ? await askNewPasswordHash() : null;
  const { db, close } = await openDb();
  try {
    if (await db.findUserByEmail(email)) fail(`A user with the email ${email} already exists.`);
    await db.createUser({ email, role, passwordHash });
    console.log(`Created ${role} ${email} (${passwordHash ? "password and Google" : "Google sign-in only"}).`);
  } finally {
    await close();
  }
}

main().catch((err) => fail(`create-user failed: ${err.message}`));
