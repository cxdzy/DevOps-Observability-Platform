// The database side of the user scripts, kept apart from argument parsing and prompts so it can be
// tested with the in-memory database. Each returns a message for the script to print, or throws.

async function createUserAccount(db, { email, role, passwordHash }) {
  if (await db.findUserByEmail(email)) throw new Error(`A user with the email ${email} already exists.`);
  await db.createUser({ email, role, passwordHash });
  return `Created ${role} ${email} (${passwordHash ? "password and Google" : "Google sign-in only"}).`;
}

// Changing a password signs the user out everywhere.
async function setUserPassword(db, email, passwordHash) {
  const user = await db.findUserByEmail(email);
  if (!user) throw new Error(`No user with the email ${email}.`);
  await db.setPassword(user.id, passwordHash);
  await db.deleteUserSessions(user.id);
  return `Password changed for ${email}; existing sessions were ended.`;
}

async function disableUserAccount(db, email) {
  const user = await db.findUserByEmail(email);
  if (!user) throw new Error(`No user with the email ${email}.`);
  await db.disableUser(user.id);
  await db.deleteUserSessions(user.id);
  return `Disabled ${email}; existing sessions were ended.`;
}

module.exports = { createUserAccount, setUserPassword, disableUserAccount };
