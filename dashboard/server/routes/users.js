// User management (Settings, Users; admin only) and the signed-in user's own account.
//
//   GET  /api/settings/users                     every user, with method, status and session count
//   POST /api/settings/users                     add a user (Google only, or a temporary password)
//   POST /api/settings/users/:id/role            viewer to admin or back; ends the user's sessions
//   POST /api/settings/users/:id/disable         blocks sign-in and ends the user's sessions
//   POST /api/settings/users/:id/enable          allows sign-in again
//   POST /api/settings/users/:id/reset-password  a new temporary password; ends the user's sessions
//   POST /api/settings/users/:id/sign-out        ends every session of the user
//
//   GET  /api/account                            the signed-in user's own profile
//   POST /api/account/password                   change one's own password
//   POST /api/account/sign-out-others            end one's other sessions
//
// Every admin change runs in one database transaction with its settings_log row and, where the
// rule says so, the revoke of the user's sessions. A temporary password is made here, stored only
// as a bcrypt hash and sent once in the answer to the request that made it. It never reaches a
// log line, the change log, an error message or any later answer. Nothing is ever deleted.
const bcrypt = require("bcryptjs");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { MAX_EMAIL_LENGTH, normaliseEmail, maskEmail } = require("../security");
const { passwordProblem, temporaryPassword } = require("../passwords");
const { MAX_PASSWORD_LENGTH } = require("../auth");

const ID_RE = /^[1-9]\d{0,17}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ["viewer", "admin"];
const METHODS = ["google", "password"];

class ApiError extends Error {
  constructor(status, error, field) {
    super(error);
    this.status = status;
    this.field = field;
  }
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// A user as the API returns it. Never the hash: only whether there is one, as the sign-in method.
function userView(row, sessions = 0) {
  const hasPassword = row.has_password !== undefined ? row.has_password === true : Boolean(row.password_hash);
  return {
    id: String(row.id),
    email: row.email,
    role: row.role,
    method: hasPassword ? "password" : "google",
    status: row.disabled ? "disabled" : "active",
    must_change_password: row.must_change_password === true,
    created_at: iso(row.created_at),
    last_login_at: iso(row.last_login_at),
    sessions: Number(row.sessions ?? sessions) || 0,
  };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Runs a handler and turns an ApiError or a unique violation into the JSON error body. Anything
// else goes to the app's error handler (500, no details).
const route = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (err instanceof ApiError) {
      const body = { error: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    if (err && err.code === "23505") return res.status(409).json({ error: "A user with this email already exists.", field: "email" });
    next(err);
  }
};

const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const sameId = (a, b) => String(a) === String(b);
const candidate = (value) => (typeof value === "string" && value.length <= MAX_PASSWORD_LENGTH ? value : "");

// deps: { auth, db, now, bcryptCost, log }
function createUsersRouter({ auth, db, now = Date.now, bcryptCost = 12, log = console.log }) {
  const router = express.Router();
  router.use(auth.requireRole("admin"));

  // Writes per admin: enough for a working session, few enough that the confirm password cannot be
  // guessed through these routes.
  const limit = rateLimit({
    ...auth.limiterDefaults,
    windowMs: 10 * 60 * 1000,
    limit: 30,
    keyGenerator: (req) => `users|${req.user.id}`,
  });
  const write = [auth.stateChanging, express.json({ limit: "4kb" }), limit];
  // Failed confirmations per admin, as strict as failed logins, so a stolen admin session cannot
  // guess the admin's password here faster than on the sign-in page. Only the 403 of a refused
  // confirmation counts.
  const confirmLimit = rateLimit({
    ...auth.limiterDefaults,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    requestWasSuccessful: (req, res) => res.statusCode !== 403,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `users-confirm|${req.user.id}`,
  });
  const confirmed = [...write, confirmLimit];

  function parseId(raw) {
    if (!ID_RE.test(String(raw))) throw new ApiError(404, "User not found.");
    return String(raw);
  }

  async function findTarget(ops, id) {
    const user = await ops.findUserById(id);
    if (!user) throw new ApiError(404, "User not found.");
    return user;
  }

  // The acting admin confirms a sensitive change with their own password. An admin without a
  // password (Google sign-in only) types the email of the account being changed instead.
  async function requireConfirm(req, value, targetEmail) {
    const me = await db.findUserById(req.user.id);
    const refuse = (message) => {
      log(JSON.stringify({ event: "user_confirm_failed", admin: maskEmail(req.user.email), path: req.path }));
      return new ApiError(403, message, "confirm");
    };
    if (me && me.password_hash) {
      const given = candidate(value);
      const ok = await bcrypt.compare(given, me.password_hash);
      if (!ok || given === "") throw refuse("Your password is not right. Type your own password to confirm.");
      return;
    }
    if (!targetEmail || normaliseEmail(value) !== targetEmail) throw refuse(`Type ${targetEmail} to confirm.`);
  }

  // One change, its session revoke and its log row in one transaction.
  async function commit(req, fn) {
    return db.transaction(async (ops) => {
      const outcome = await fn(ops);
      await ops.insertLog({ userEmail: req.user.email, ...outcome.log });
      return outcome.result;
    });
  }

  // The last active admin can never be disabled or demoted, so the dashboard always has one.
  async function keepOneAdmin(ops, target) {
    if (target.role === "admin" && !target.disabled && (await ops.countActiveAdmins()) <= 1) {
      throw new ApiError(409, "This is the last active admin. Make another user an admin first.");
    }
  }

  router.get("/", route(async (req, res) => {
    const rows = await db.listUsers(new Date(now()));
    res.json(rows.map((r) => userView(r)));
  }));

  router.post("/", ...confirmed, route(async (req, res) => {
    const body = bodyOf(req);
    const email = normaliseEmail(body.email);
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      throw new ApiError(400, `Enter a valid email address of at most ${MAX_EMAIL_LENGTH} characters.`, "email");
    }
    if (!ROLES.includes(body.role)) throw new ApiError(400, "The role must be viewer or admin.", "role");
    if (!METHODS.includes(body.method)) throw new ApiError(400, "The sign-in method must be Google only or password.", "method");
    if (body.role === "admin") await requireConfirm(req, body.confirm, email);

    const temp = body.method === "password" ? temporaryPassword() : null;
    const passwordHash = temp ? await bcrypt.hash(temp, bcryptCost) : null;
    const user = await commit(req, async (ops) => {
      if (await ops.findUserByEmail(email)) throw new ApiError(409, "A user with this email already exists.", "email");
      const row = await ops.insertUser({ email, role: body.role, passwordHash, mustChangePassword: Boolean(temp) });
      return {
        result: userView(row),
        log: {
          action: "Added user",
          target: email,
          detail: `Role ${body.role}. ${temp ? "Signs in with a temporary password that must be changed at the first sign-in." : "Signs in with Google only."}`,
        },
      };
    });
    res.status(201).json({ user, temporary_password: temp });
  }));

  router.post("/:id/role", ...confirmed, route(async (req, res) => {
    const id = parseId(req.params.id);
    const role = bodyOf(req).role;
    if (!ROLES.includes(role)) throw new ApiError(400, "The role must be viewer or admin.", "role");
    const before = await findTarget(db, id);
    if (role === "admin") await requireConfirm(req, bodyOf(req).confirm, before.email);
    const user = await commit(req, async (ops) => {
      const target = await findTarget(ops, id);
      if (sameId(target.id, req.user.id)) throw new ApiError(409, "You cannot change your own role.");
      if (target.role === role) throw new ApiError(409, `This user is already ${role === "admin" ? "an admin" : "a viewer"}.`);
      if (role === "viewer") await keepOneAdmin(ops, target);
      await ops.updateUser(target.id, { role });
      const ended = await ops.endUserSessions(target.id);
      return {
        result: userView({ ...target, role }),
        log: { action: "Changed user role", target: target.email, detail: `Role ${target.role} to ${role}. ${plural(ended, "session")} ended.` },
      };
    });
    res.json(user);
  }));

  router.post("/:id/disable", ...write, route(async (req, res) => {
    const id = parseId(req.params.id);
    const user = await commit(req, async (ops) => {
      const target = await findTarget(ops, id);
      if (sameId(target.id, req.user.id)) throw new ApiError(409, "You cannot disable your own account.");
      if (target.disabled) throw new ApiError(409, "This user is already disabled.");
      await keepOneAdmin(ops, target);
      await ops.updateUser(target.id, { disabled: true });
      const ended = await ops.endUserSessions(target.id);
      return {
        result: userView({ ...target, disabled: true }),
        log: { action: "Disabled user", target: target.email, detail: `Sign-in blocked. ${plural(ended, "session")} ended. Nothing was deleted.` },
      };
    });
    res.json(user);
  }));

  router.post("/:id/enable", ...write, route(async (req, res) => {
    const id = parseId(req.params.id);
    const user = await commit(req, async (ops) => {
      const target = await findTarget(ops, id);
      if (!target.disabled) throw new ApiError(409, "This user is not disabled.");
      await ops.updateUser(target.id, { disabled: false });
      return {
        result: userView({ ...target, disabled: false }),
        log: { action: "Enabled user", target: target.email, detail: "Sign-in allowed again." },
      };
    });
    res.json(user);
  }));

  router.post("/:id/reset-password", ...confirmed, route(async (req, res) => {
    const id = parseId(req.params.id);
    const before = await findTarget(db, id);
    if (sameId(before.id, req.user.id)) throw new ApiError(409, "Change your own password from your account instead.");
    if (!before.password_hash) throw new ApiError(409, "This user signs in with Google only and has no password to reset.");
    await requireConfirm(req, bodyOf(req).confirm, before.email);
    const temp = temporaryPassword();
    const passwordHash = await bcrypt.hash(temp, bcryptCost);
    const user = await commit(req, async (ops) => {
      const target = await findTarget(ops, id);
      if (!target.password_hash) throw new ApiError(409, "This user signs in with Google only and has no password to reset.");
      await ops.updateUser(target.id, { password_hash: passwordHash, must_change_password: true });
      const ended = await ops.endUserSessions(target.id);
      return {
        result: userView({ ...target, password_hash: passwordHash, must_change_password: true }),
        log: {
          action: "Reset user password",
          target: target.email,
          detail: `A temporary password was issued; it must be changed at the next sign-in. ${plural(ended, "session")} ended.`,
        },
      };
    });
    res.json({ user, temporary_password: temp });
  }));

  router.post("/:id/sign-out", ...write, route(async (req, res) => {
    const id = parseId(req.params.id);
    const user = await commit(req, async (ops) => {
      const target = await findTarget(ops, id);
      if (sameId(target.id, req.user.id)) throw new ApiError(409, "Use Sign out other sessions in your account for your own sessions.");
      const ended = await ops.endUserSessions(target.id);
      return {
        result: userView(target),
        log: { action: "Signed user out everywhere", target: target.email, detail: `${plural(ended, "session")} ended.` },
      };
    });
    res.json(user);
  }));

  return router;
}

// The signed-in user's own account. Mounted before the session gate, because a user with an
// admin-set temporary password must still reach the profile and the password change.
// deps: { auth, db, now, bcryptCost }
function createAccountRouter({ auth, db, now = Date.now, bcryptCost = 12 }) {
  const router = express.Router();
  router.use(auth.requireSession);

  // Failed attempts per user, so the current password cannot be guessed from a stolen session.
  const limit = rateLimit({
    ...auth.limiterDefaults,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `account|${req.user.id}`,
  });
  const write = [auth.stateChanging, express.json({ limit: "4kb" }), limit];

  async function me(req) {
    const rows = await db.listUsers(new Date(now()));
    const row = rows.find((r) => sameId(r.id, req.user.id));
    if (!row) throw new ApiError(401, "not signed in");
    return row;
  }

  router.get("/", route(async (req, res) => {
    const view = userView(await me(req));
    res.json({ email: view.email, role: view.role, method: view.method, must_change_password: view.must_change_password, sessions: view.sessions });
  }));

  router.post("/password", ...write, route(async (req, res) => {
    const body = bodyOf(req);
    const user = await db.findUserById(req.user.id);
    if (!user) throw new ApiError(401, "not signed in");
    if (!user.password_hash) throw new ApiError(409, "This account signs in with Google and has no password.");
    const current = candidate(body.current_password);
    const ok = current !== "" && (await bcrypt.compare(current, user.password_hash));
    if (!ok) throw new ApiError(400, "The current password is not right.", "current_password");
    const next = typeof body.new_password === "string" ? body.new_password : "";
    const problem = passwordProblem(next);
    if (problem) throw new ApiError(400, problem, "new_password");
    if (next === current) throw new ApiError(400, "The new password must be different from the current one.", "new_password");
    const passwordHash = await bcrypt.hash(next, bcryptCost);
    // The other sessions end; this one stays, so the user carries on where they were.
    const ended = await db.transaction(async (ops) => {
      // An admin may have reset the password after the check above; the reset then wins.
      const fresh = await ops.findUserById(user.id);
      if (!fresh || fresh.password_hash !== user.password_hash) {
        throw new ApiError(409, "Your password was changed meanwhile, so nothing was saved. Sign in again.");
      }
      await ops.updateUser(user.id, { password_hash: passwordHash, must_change_password: false });
      return ops.endUserSessions(user.id, req.sessionIdHash);
    });
    res.json({ must_change_password: false, sessions_ended: ended });
  }));

  router.post("/sign-out-others", ...write, route(async (req, res) => {
    const ended = await db.transaction((ops) => ops.endUserSessions(req.user.id, req.sessionIdHash));
    res.json({ sessions_ended: ended });
  }));

  return router;
}

module.exports = { createUsersRouter, createAccountRouter, userView };
