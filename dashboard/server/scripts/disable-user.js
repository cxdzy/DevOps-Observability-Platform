// Disables a user and ends all of that user's sessions. The row is kept.
// Usage: node server/scripts/disable-user.js <email>
const { fail, parseEmail, openDb } = require("./common");
const { disableUserAccount } = require("./actions");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) fail("Usage: disable-user.js <email>");
  const email = parseEmail(args[0]);

  const { db, close } = await openDb();
  try {
    console.log(await disableUserAccount(db, email));
  } finally {
    await close();
  }
}

main().catch((err) => fail(err.message));
