const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS status(
    stop_id integer PRIMARY KEY,
    status text,
    note text,
    walker text,
    updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS claim(
    chunk_id text PRIMARY KEY,
    walker text,
    claimed_at timestamptz NOT NULL DEFAULT now())`);
  console.log('DB ready');
}

// --- API ---
app.get('/api/state', async (req, res) => {
  try {
    const since = req.query.since;
    let sql = 'SELECT stop_id, status, note, walker, (extract(epoch from updated_at)*1000)::bigint AS ts FROM status';
    const params = [];
    if (since) { sql += ' WHERE updated_at > $1'; params.push(new Date(Number(since))); }
    const st = await pool.query(sql, params);
    const cl = await pool.query('SELECT chunk_id, walker, (extract(epoch from claimed_at)*1000)::bigint AS ts FROM claim');
    res.json({ now: Date.now(), statuses: st.rows, claims: cl.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/mark', async (req, res) => {
  try {
    const { stopId, status, note, walker } = req.body || {};
    if (typeof stopId !== 'number') return res.status(400).json({ error: 'stopId required' });
    if ((!status || status === '') && (!note || note === '')) {
      await pool.query('DELETE FROM status WHERE stop_id=$1', [stopId]);
    } else {
      await pool.query(
        `INSERT INTO status(stop_id,status,note,walker,updated_at) VALUES($1,$2,$3,$4,now())
         ON CONFLICT(stop_id) DO UPDATE SET
           status=EXCLUDED.status, note=EXCLUDED.note, walker=EXCLUDED.walker, updated_at=now()`,
        [stopId, status || null, note || null, walker || null]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/claim', async (req, res) => {
  try {
    const { chunkId, walker } = req.body || {};
    if (!chunkId) return res.status(400).json({ error: 'chunkId required' });
    const ins = await pool.query(
      'INSERT INTO claim(chunk_id,walker) VALUES($1,$2) ON CONFLICT(chunk_id) DO NOTHING RETURNING walker',
      [chunkId, walker || null]);
    let owner = walker;
    if (ins.rowCount === 0) {
      const o = await pool.query('SELECT walker FROM claim WHERE chunk_id=$1', [chunkId]);
      owner = o.rows[0] ? o.rows[0].walker : null;
    }
    res.json({ ok: ins.rowCount > 0 || owner === walker, owner });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/release', async (req, res) => {
  try {
    const { chunkId, walker } = req.body || {};
    await pool.query('DELETE FROM claim WHERE chunk_id=$1 AND walker=$2', [chunkId, walker || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// --- Static app (single self-contained file) ---
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const port = process.env.PORT || 3000;
init()
  .then(() => app.listen(port, () => console.log('AmberWalk on', port)))
  .catch(e => { console.error('Startup failed:', e); process.exit(1); });
