// Disables a user and ends all of that user's sessions. The row is kept.
// Usage: node server/scripts/disable-user.js <email>
const { fail, parseEmail, openDb } = require("./common");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) fail("Usage: disable-user.js <email>");
  const email = parseEmail(args[0]);

  const { db, close } = await openDb();
  try {
    const user = await db.findUserByEmail(email);
    if (!user) fail(`No user with the email ${email}.`);
    await db.disableUser(user.id);
    await db.deleteUserSessions(user.id);
    console.log(`Disabled ${email}; existing sessions were ended.`);
  } finally {
    await close();
  }
}

main().catch((err) => fail(`disable-user failed: ${err.message}`));
