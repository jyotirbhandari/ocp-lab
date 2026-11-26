const express = require('express');
const os = require('os');
const { pg, mongo } = require('./db');

const app = express();
app.use(express.json());

// wrap async handlers so errors become 500s instead of crashes
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

// liveness: is the process alive?
app.get('/api/healthz', (req, res) => res.json({ status: 'ok' }));

// readiness: can we reach both databases?
app.get('/api/readyz', async (req, res) => {
  try {
    await pg.query('SELECT 1');
    await mongo.db().command({ ping: 1 });
    res.json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'not ready', error: e.message });
  }
});

// which pod answered? (shows Service load balancing)
app.get('/api/info', (req, res) =>
  res.json({ pod: os.hostname(), version: process.env.APP_VERSION || 'dev' }));

// Postgres: books
app.get('/api/books', h(async (req, res) => {
  const r = await pg.query('SELECT id, title, author, price FROM books ORDER BY id');
  res.json(r.rows);
}));

app.post('/api/books', h(async (req, res) => {
  const { title, author, price } = req.body;
  const r = await pg.query(
    'INSERT INTO books (title, author, price) VALUES ($1, $2, $3) RETURNING *',
    [title, author, price]);
  res.status(201).json(r.rows[0]);
}));

// Mongo: reviews
app.get('/api/books/:id/reviews', h(async (req, res) => {
  const reviews = await mongo.db().collection('reviews')
    .find({ bookId: Number(req.params.id) }).sort({ createdAt: -1 }).toArray();
  res.json(reviews);
}));
