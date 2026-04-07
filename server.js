require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ── BTP / CF helpers ───────────────────────────────────────────────────────────

/**
 * Build a pg Pool config from VCAP_SERVICES (BTP CF) or DATABASE_URL (local).
 * BTP binds PostgreSQL credentials under any service label whose credentials
 * contain a "uri" starting with "postgres".
 */
function getDbConfig() {
  if (process.env.VCAP_SERVICES) {
    const vcap = JSON.parse(process.env.VCAP_SERVICES);
    const allServices = Object.values(vcap).flat();
    const pgSvc = allServices.find(
      (s) =>
        s.credentials?.uri?.startsWith('postgres') ||
        s.credentials?.url?.startsWith('postgres')
    );
    if (pgSvc) {
      const uri = pgSvc.credentials.uri || pgSvc.credentials.url;
      return { connectionString: uri, ssl: { rejectUnauthorized: false } };
    }
  }
  // Local dev — set DATABASE_URL or rely on pg defaults (PGHOST/PGUSER/etc.)
  return { connectionString: process.env.DATABASE_URL || 'postgresql://localhost/receipts' };
}

/**
 * Resolve the Anthropic API key:
 *   1. Process env (local dev / cf set-env)
 *   2. A CF user-provided service with credential key ANTHROPIC_API_KEY
 */
function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.VCAP_SERVICES) {
    const vcap = JSON.parse(process.env.VCAP_SERVICES);
    const ups = vcap['user-provided'] || [];
    for (const svc of ups) {
      if (svc.credentials?.ANTHROPIC_API_KEY) return svc.credentials.ANTHROPIC_API_KEY;
    }
  }
  return null;
}

// ── Database ───────────────────────────────────────────────────────────────────
const pool = new Pool(getDbConfig());

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS receipts (
      id         TEXT PRIMARY KEY,
      vendor     TEXT,
      date       TEXT,
      currency   TEXT        DEFAULT 'CAD',
      total      DOUBLE PRECISION,
      subtotal   DOUBLE PRECISION,
      gst        DOUBLE PRECISION,
      pst        DOUBLE PRECISION,
      gratuity   DOUBLE PRECISION,
      category   TEXT        DEFAULT 'Other',
      image_data TEXT,
      notes      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Anthropic client (lazy) ────────────────────────────────────────────────────
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    const key = getAnthropicKey();
    if (!key) return null;
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

// ── Multer (memory storage — BTP file system is ephemeral) ────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are accepted'));
  },
});

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (required by BTP CF health-check-type: http) ─────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── OCR endpoint ───────────────────────────────────────────────────────────────
app.post('/api/ocr', upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  const anthropic = getAnthropic();
  if (!anthropic) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not configured. Set it via cf set-env or a user-provided service.',
    });
  }

  const base64Image = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype;

  const prompt = `You are a receipt OCR assistant. Analyze this receipt image and extract the following data.

Return ONLY a valid JSON object with exactly these fields (use null for any field you cannot determine):

{
  "vendor": "business/restaurant name as printed on receipt",
  "date": "date in YYYY-MM-DD format",
  "currency": "3-letter ISO 4217 currency code (e.g. CAD, USD, EUR, GBP) — derive from country context, currency symbols, or tax labels (GST/PST = Canada = CAD). Return null only if truly ambiguous.",
  "subtotal": numeric value before taxes (number or null),
  "gst": GST amount if shown (number or null),
  "pst": PST or QST or HST amount if shown (number or null),
  "gratuity": tip or gratuity amount if shown (number or null),
  "total": final total charged (number or null),
  "suggested_category": "one of: Meals & Entertainment | Accommodation | Transportation | Office Supplies | Software & Tools | Conferences & Events | Other"
}

Rules:
- All numeric fields must be plain numbers (no currency symbols, no commas).
- If only a total is visible and no subtotal breakdown, put the total in "total" and leave subtotal/taxes as null.
- Do not include any explanation or markdown — only the raw JSON object.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const rawText = message.content[0].text.trim();
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let extracted;
    try {
      extracted = JSON.parse(jsonText);
    } catch {
      return res.status(422).json({ error: 'Could not parse OCR response', raw: rawText });
    }

    extracted.image_data = `data:${mediaType};base64,${base64Image}`;
    return res.json(extracted);
  } catch (err) {
    console.error('Claude API error:', err);
    return res.status(500).json({ error: err.message || 'OCR failed' });
  }
});

// ── Receipts CRUD ──────────────────────────────────────────────────────────────
app.get('/api/receipts', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM receipts ORDER BY date DESC NULLS LAST, created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/receipts/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM receipts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/receipts', async (req, res) => {
  const r = { id: uuidv4(), ...sanitize(req.body) };
  try {
    await pool.query(
      `INSERT INTO receipts (id, vendor, date, currency, total, subtotal, gst, pst, gratuity, category, image_data, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [r.id, r.vendor, r.date, r.currency, r.total, r.subtotal, r.gst, r.pst, r.gratuity, r.category, r.image_data, r.notes]
    );
    res.status(201).json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/receipts/:id', async (req, res) => {
  const r = { id: req.params.id, ...sanitize(req.body) };
  try {
    const result = await pool.query(
      `UPDATE receipts
       SET vendor=$2, date=$3, currency=$4, total=$5, subtotal=$6, gst=$7, pst=$8,
           gratuity=$9, category=$10, image_data=$11, notes=$12, updated_at=NOW()
       WHERE id=$1`,
      [r.id, r.vendor, r.date, r.currency, r.total, r.subtotal, r.gst, r.pst, r.gratuity, r.category, r.image_data, r.notes]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM receipts WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function sanitize(body) {
  return {
    vendor:     body.vendor     || null,
    date:       body.date       || null,
    currency:   body.currency   || 'CAD',
    total:      toNum(body.total),
    subtotal:   toNum(body.subtotal),
    gst:        toNum(body.gst),
    pst:        toNum(body.pst),
    gratuity:   toNum(body.gratuity),
    category:   body.category   || 'Other',
    image_data: body.image_data || null,
    notes:      body.notes      || null,
  };
}

function toNum(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ── Catch-all → SPA ───────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    // BTP CF requires binding to 0.0.0.0
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Receipt Tracker running on http://0.0.0.0:${PORT}`);
      if (!getAnthropicKey()) {
        console.warn(
          'WARNING: ANTHROPIC_API_KEY not found. Set it with:\n' +
          '  cf set-env <app> ANTHROPIC_API_KEY <key>  (then cf restage)\n' +
          '  or bind a user-provided service with that credential.'
        );
      }
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
