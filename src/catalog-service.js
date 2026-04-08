const express = require("express");
const { Pool } = require("pg");
const client = require("prom-client");

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
      stock INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
};

app.get("/health", (_req, res) => res.json({ status: "ok", service: "catalog" }));
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.post("/suppliers", async (req, res) => {
  const { name, contact_email } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const result = await pool.query("INSERT INTO suppliers (name, contact_email) VALUES ($1, $2) RETURNING *", [name, contact_email || null]);
  res.status(201).json(result.rows[0]);
});
app.get("/suppliers", async (_req, res) => {
  const result = await pool.query("SELECT * FROM suppliers ORDER BY id");
  res.json(result.rows);
});

app.post("/categories", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const result = await pool.query("INSERT INTO categories (name) VALUES ($1) RETURNING *", [name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "category already exists" });
    res.status(500).json({ error: "internal error" });
  }
});
app.get("/categories", async (_req, res) => {
  const result = await pool.query("SELECT * FROM categories ORDER BY id");
  res.json(result.rows);
});

app.post("/products", async (req, res) => {
  const { name, supplier_id, category_id, stock = 0 } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const result = await pool.query(
    "INSERT INTO products (name, supplier_id, category_id, stock) VALUES ($1, $2, $3, $4) RETURNING *",
    [name, supplier_id || null, category_id || null, stock]
  );
  res.status(201).json(result.rows[0]);
});
app.get("/products", async (_req, res) => {
  const result = await pool.query(`
    SELECT p.*, s.name AS supplier_name, c.name AS category_name
    FROM products p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY p.id
  `);
  res.json(result.rows);
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`catalog-service running on ${PORT}`)))
  .catch((e) => {
    console.error("DB init failed", e);
    process.exit(1);
  });
