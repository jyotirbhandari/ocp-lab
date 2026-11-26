const fs = require('fs');
const path = require('path');
const { pg, mongo } = require('./db');

async function migratePostgres() {
  await pg.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const done = await pg.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (done.rowCount) { console.log(`skip   ${file}`); continue; }

    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`apply  ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

async function migrateMongo() {
  await mongo.connect();
  const reviews = mongo.db().collection('reviews');
  await reviews.createIndex({ bookId: 1, createdAt: -1 }); // safe to re-run
  console.log('mongo  indexes ensured');
}

(async () => {
  try {
    await migratePostgres();
    await migrateMongo();
    console.log('migrations complete');
    process.exit(0);
  } catch (e) {
    console.error('MIGRATION FAILED:', e.message);
    process.exit(1);
  }
})();
