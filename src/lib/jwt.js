const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const ROLE_RANK = { viewer: 1, manager: 2, admin: 3 };

const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing token", code: "AUTH_REQUIRED" });
  try {
    req.user = verifyToken(token);
    return next();
  } catch (_err) {
    return res.status(401).json({ error: "invalid or expired token", code: "AUTH_INVALID" });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "missing token", code: "AUTH_REQUIRED" });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: "insufficient permissions", code: "FORBIDDEN" });
  }
  return next();
};

const requireMinRole = (minRole) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "missing token", code: "AUTH_REQUIRED" });
  const userRank = ROLE_RANK[req.user.role] || 0;
  const minRank = ROLE_RANK[minRole] || 0;
  if (userRank < minRank) {
    return res.status(403).json({ error: "insufficient permissions", code: "FORBIDDEN" });
  }
  return next();
};

module.exports = { verifyToken, requireAuth, requireRole, requireMinRole };
