const express = require("express");
const { Pool } = require("pg");
const client = require("prom-client");
const { requireAuth, requireMinRole, requireRole } = require("./lib/jwt");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpCounter = new client.Counter({
  name: "catalog_http_requests_total",
  help: "Total HTTP requests on catalog service",
  labelNames: ["route", "method", "status"],
});
register.registerMetric(httpCounter);
app.use((req, res, next) => {
  res.on("finish", () => httpCounter.inc({ route: req.path, method: req.method, status: res.statusCode }));
  next();
});

const sendError = (res, status, code, message) => res.status(status).json({ error: message, code });

const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      contact_email VARCHAR(150),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      supplier_id INT REFERENCES suppliers(id) ON DELETE SET NULL,
      category_id INT REFERENCES categories(id) ON DELETE SET NULL,
      stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
};

app.get("/health", (_req, res) => res.json({ status: "ok", service: "catalog" }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use(requireAuth);

app.post("/suppliers", requireMinRole("manager"), async (req, res) => {
  const { name, contact_email } = req.body;
  if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
  const result = await pool.query("INSERT INTO suppliers (name, contact_email) VALUES ($1, $2) RETURNING *", [
    name,
    contact_email || null,
  ]);
  res.status(201).json(result.rows[0]);
});

app.get("/suppliers", requireMinRole("viewer"), async (_req, res) => {
  const result = await pool.query("SELECT * FROM suppliers ORDER BY id");
  res.json(result.rows);
});

app.get("/suppliers/:id", requireMinRole("viewer"), async (req, res) => {
  const result = await pool.query("SELECT * FROM suppliers WHERE id=$1", [req.params.id]);
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "supplier not found");
  res.json(result.rows[0]);
});

app.patch("/suppliers/:id", requireMinRole("manager"), async (req, res) => {
  const { name, contact_email } = req.body;
  const result = await pool.query(
    "UPDATE suppliers SET name=COALESCE($1, name), contact_email=COALESCE($2, contact_email) WHERE id=$3 RETURNING *",
    [name || null, contact_email ?? null, req.params.id]
  );
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "supplier not found");
  res.json(result.rows[0]);
});

app.delete("/suppliers/:id", requireRole("admin"), async (req, res) => {
  const result = await pool.query("DELETE FROM suppliers WHERE id=$1 RETURNING id", [req.params.id]);
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "supplier not found");
  res.status(204).send();
});

app.post("/categories", requireMinRole("manager"), async (req, res) => {
  const { name } = req.body;
  if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
  try {
    const result = await pool.query("INSERT INTO categories (name) VALUES ($1) RETURNING *", [name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return sendError(res, 409, "DUPLICATE", "category already exists");
    return sendError(res, 500, "INTERNAL_ERROR", "internal error");
  }
});

app.get("/categories", requireMinRole("viewer"), async (_req, res) => {
  const result = await pool.query("SELECT * FROM categories ORDER BY id");
  res.json(result.rows);
});

app.get("/categories/:id", requireMinRole("viewer"), async (req, res) => {
  const result = await pool.query("SELECT * FROM categories WHERE id=$1", [req.params.id]);
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "category not found");
  res.json(result.rows[0]);
});

app.delete("/categories/:id", requireRole("admin"), async (req, res) => {
  const result = await pool.query("DELETE FROM categories WHERE id=$1 RETURNING id", [req.params.id]);
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "category not found");
  res.status(204).send();
});

app.post("/products", requireMinRole("manager"), async (req, res) => {
  const { name, supplier_id, category_id, stock = 0 } = req.body;
  if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
  if (stock < 0) return sendError(res, 400, "VALIDATION_ERROR", "stock cannot be negative");
  const result = await pool.query(
    "INSERT INTO products (name, supplier_id, category_id, stock) VALUES ($1, $2, $3, $4) RETURNING *",
    [name, supplier_id || null, category_id || null, stock]
  );
  res.status(201).json(result.rows[0]);
});

app.get("/products", requireMinRole("viewer"), async (_req, res) => {
  const result = await pool.query(`
    SELECT p.*, s.name AS supplier_name, c.name AS category_name
    FROM products p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY p.id
  `);
  res.json(result.rows);
});

app.get("/products/:id", requireMinRole("viewer"), async (req, res) => {
  const result = await pool.query(
    `
    SELECT p.*, s.name AS supplier_name, c.name AS category_name
    FROM products p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.id=$1
  `,
    [req.params.id]
  );
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "product not found");
  res.json(result.rows[0]);
});

app.patch("/products/:id", requireMinRole("manager"), async (req, res) => {
  const { name, supplier_id, category_id, stock } = req.body;
  if (stock !== undefined && stock < 0) return sendError(res, 400, "VALIDATION_ERROR", "stock cannot be negative");
  const result = await pool.query(
    `UPDATE products SET
      name = COALESCE($1, name),
      supplier_id = COALESCE($2, supplier_id),
      category_id = COALESCE($3, category_id),
      stock = COALESCE($4, stock)
     WHERE id=$5 RETURNING *`,
    [name || null, supplier_id ?? null, category_id ?? null, stock ?? null, req.params.id]
  );
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "product not found");
  res.json(result.rows[0]);
});

app.delete("/products/:id", requireRole("admin"), async (req, res) => {
  const result = await pool.query("DELETE FROM products WHERE id=$1 RETURNING id", [req.params.id]);
  if (!result.rows[0]) return sendError(res, 404, "NOT_FOUND", "product not found");
  res.status(204).send();
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`catalog-service running on ${PORT}`)))
  .catch((e) => {
    console.error("DB init failed", e);
    process.exit(1);
  });

module.exports = app;
