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

app.post('/api/books/:id/reviews', h(async (req, res) => {
  const doc = {
    bookId: Number(req.params.id),
    rating: req.body.rating,
    comment: req.body.comment,
    createdAt: new Date(),
  };
  await mongo.db().collection('reviews').insertOne(doc);
  res.status(201).json(doc);
}));

async function start() {
  await mongo.connect();
  const server = app.listen(8080, () => console.log('API listening on 8080'));

  // graceful shutdown: Kubernetes sends SIGTERM before killing the pod
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down');
    server.close(async () => {
      await pg.end();
      await mongo.close();
      process.exit(0);
    });
  });
}

start().catch((e) => { console.error(e); process.exit(1); });
