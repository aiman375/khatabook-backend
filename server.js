const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 5000;
const SECRET = 'khatabook_secret_key';

app.use(cors());
app.use(bodyParser.json());

const dbPath = path.join(__dirname, 'db', 'khatabook.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Connected to SQLite database');
    initializeDB();
  }
});

function initializeDB() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      shop TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      customer TEXT NOT NULL,
      amount REAL NOT NULL,
      discount REAL DEFAULT 0,
      final_amount REAL NOT NULL,
      payment TEXT DEFAULT 'cash',
      notes TEXT,
      date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      balance REAL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    console.log('✅ Tables initialized');
  });
}

// ========== AUTH ROUTES ==========

// SIGNUP
app.post('/api/signup', async (req, res) => {
  const { username, password, name, shop } = req.body;
  if (!username || !password || !name || !shop) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const hashed = await bcrypt.hash(password, 10);
  db.run(
    `INSERT INTO users (username, password, name, shop) VALUES (?, ?, ?, ?)`,
    [username, hashed, name, shop],
    function (err) {
      if (err) return res.status(400).json({ error: 'Username already exists' });
      const token = jwt.sign({ id: this.lastID, name, shop }, SECRET);
      res.json({ token, user: { id: this.lastID, name, shop } });
    }
  );
});

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (!user) return res.status(400).json({ error: 'User not found' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, name: user.name, shop: user.shop }, SECRET);
    res.json({ token, user: { id: user.id, name: user.name, shop: user.shop } });
  });
});

// ========== TRANSACTION ROUTES ==========

// Add transaction (sale or purchase)
app.post('/api/transaction', (req, res) => {
  const { user_id, customer, amount, discount, type, notes, payment } = req.body;
  const final_amount = amount - (discount || 0);

  if ((discount || 0) > amount) {
    return res.status(400).json({ error: 'Discount cannot exceed amount' });
  }

  db.run(
    `INSERT INTO transactions (user_id, type, customer, amount, discount, final_amount, payment, notes, date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [user_id, type, customer, amount, discount || 0, final_amount, payment || 'cash', notes || ''],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to add transaction' });
      res.status(201).json({ message: 'Transaction added', id: this.lastID, final_amount });
    }
  );
});

// Get history
app.get('/api/history/:user_id', (req, res) => {
  db.all(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 50`,
    [req.params.user_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch history' });
      res.json(rows);
    }
  );
});

// Dashboard summary
app.get('/api/dashboard/:user_id', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.all(
    `SELECT type, SUM(final_amount) as total FROM transactions 
     WHERE user_id = ? AND date LIKE ? GROUP BY type`,
    [req.params.user_id, today + '%'],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to get dashboard' });
      let sales = 0, purchases = 0;
      rows.forEach(r => {
        if (r.type === 'sale') sales = r.total;
        if (r.type === 'purchase') purchases = r.total;
      });
      res.json({ sales, purchases, profit: sales - purchases });
    }
  );
});

// ========== CUSTOMER ROUTES ==========

app.post('/api/customers', (req, res) => {
  const { user_id, name, phone } = req.body;
  db.run(
    `INSERT INTO customers (user_id, name, phone) VALUES (?, ?, ?)`,
    [user_id, name, phone || ''],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to add customer' });
      res.json({ id: this.lastID, name, phone });
    }
  );
});

app.get('/api/customers/:user_id', (req, res) => {
  db.all(
    `SELECT * FROM customers WHERE user_id = ?`,
    [req.params.user_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch customers' });
      res.json(rows);
    }
  );
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'running' }));
// Delete transaction
app.delete('/api/transaction/:id', (req, res) => {
  db.run(
    `DELETE FROM transactions WHERE id = ?`,
    [req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Failed to delete' });
      res.json({ message: 'Deleted successfully' });
    }
  );
});

// Edit transaction
app.put('/api/transaction/:id', (req, res) => {
  const { customer, amount, discount, notes } = req.body;
  const final_amount = amount - (discount || 0);
  db.run(
    `UPDATE transactions 
     SET customer = ?, amount = ?, discount = ?, final_amount = ?, notes = ?
     WHERE id = ?`,
    [customer, amount, discount || 0, final_amount, notes || '', req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Failed to update' });
      res.json({ message: 'Updated successfully', final_amount });
    }
  );
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
});