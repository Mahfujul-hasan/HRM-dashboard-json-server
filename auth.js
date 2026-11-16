/**
 * Mock auth for the HR dashboard.
 *
 * Local development only: passwords live in db.json in plain text and the token is
 * a base64 blob with no signature. Never deploy this server or reuse these routes
 * against real data.
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h, matching a long HR working day

/** Strips the password before a user is sent to the client. */
function toPublicUser(user) {
  const { password, resetToken, otpCode, ...rest } = user;
  return rest;
}

function makeToken(user) {
  const payload = { sub: user.id, email: user.email, exp: Date.now() + TOKEN_TTL_MS };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function findUser(db, email) {
  const users = db.get("users").value() || [];
  return users.find((user) => String(user.email).toLowerCase() === String(email).toLowerCase());
}

function recordAudit(db, action, user, details) {
  const entry = {
    id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    action,
    userId: user ? user.id : null,
    userEmail: user ? user.email : details && details.email ? details.email : null,
    details: details || null,
    createdAt: new Date().toISOString(),
  };
  db.get("auditLogs").push(entry).write();
}

/**
 * Express middleware with the endpoints `src/features/auth/api` calls.
 * Mount before the json-server router.
 */
function createAuthRoutes(router) {
  const db = router.db;

  return (req, res, next) => {
    if (!req.path.startsWith("/auth/")) return next();

    const body = req.body || {};

    if (req.method === "POST" && req.path === "/auth/login") {
      const user = findUser(db, body.email);
      if (!user || user.password !== body.password) {
        recordAudit(db, "auth.login.failed", user, { email: body.email });
        return res.status(401).jsonp({ message: "Email or password is incorrect" });
      }
      recordAudit(db, "auth.login", user, null);
      return res.jsonp({ user: toPublicUser(user), token: makeToken(user) });
    }

    if (req.method === "POST" && req.path === "/auth/logout") {
      return res.status(204).end();
    }

    if (req.method === "POST" && req.path === "/auth/forgot-password") {
      const user = findUser(db, body.email);
      // Always 204: never reveal whether an address has an account.
      if (user) {
        const resetToken = makeToken(user);
        db.get("users").find({ id: user.id }).assign({ resetToken }).write();
        console.log(`Password reset link: /reset-password?token=${resetToken}`);
      }
      return res.status(204).end();
    }

    if (req.method === "POST" && req.path === "/auth/reset-password") {
      const users = db.get("users").value() || [];
      const user = users.find((item) => item.resetToken && item.resetToken === body.token);
      if (!user) return res.status(400).jsonp({ message: "This reset link is invalid or expired" });
      db.get("users")
        .find({ id: user.id })
        .assign({ password: body.password, resetToken: null })
        .write();
      recordAudit(db, "auth.password.reset", user, null);
      return res.status(204).end();
    }

    if (req.method === "POST" && req.path === "/auth/verify-otp") {
      // Mock second factor: any 6-digit code works, and 000000 is rejected so the
      // error path stays testable.
      const code = String(body.code || "");
      if (!/^\d{6}$/.test(code) || code === "000000") {
        return res.status(400).jsonp({ message: "That code is not valid" });
      }
      const user = (db.get("users").value() || [])[0];
      if (!user) return res.status(401).jsonp({ message: "No HR account exists" });
      return res.jsonp({ user: toPublicUser(user), token: makeToken(user) });
    }

    if (req.method === "GET" && req.path === "/auth/me") {
      const user = (db.get("users").value() || [])[0];
      if (!user) return res.status(401).jsonp({ message: "Not signed in" });
      return res.jsonp(toPublicUser(user));
    }

    return res.status(404).jsonp({ message: `No auth route for ${req.method} ${req.path}` });
  };
}

module.exports = { createAuthRoutes, toPublicUser, makeToken };
