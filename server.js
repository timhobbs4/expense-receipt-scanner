require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database setup ─────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'receipts.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS receipts (
    id         TEXT PRIMARY KEY,
    vendor     TEXT,
    date       TEXT,
    currency   TEXT DEFAULT 'CAD',
    total      REAL,
    subtotal   REAL,
    gst        REAL,
    pst        REAL,
    gratuity   REAL,
    category   TEXT DEFAULT 'Other',
    image_data TEXT,
    notes      TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// ── Anthropic client ───────────────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Multer (in-memory storage so we can pass base64 to Claude) ─────────────────
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

// ── OCR endpoint ───────────────────────────────────────────────────────────────
app.post('/api/ocr', upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
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
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Image },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const rawText = message.content[0].text.trim();

    // Strip markdown code fences if model wraps response
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let extracted;
    try {
      extracted = JSON.parse(jsonText);
    } catch {
      return res.status(422).json({ error: 'Could not parse OCR response', raw: rawText });
    }

    // Return the base64 image back so the client can preview it without re-uploading
    extracted.image_data = `data:${mediaType};base64,${base64Image}`;

    return res.json(extracted);
  } catch (err) {
    console.error('Claude API error:', err);
    return res.status(500).json({ error: err.message || 'OCR failed' });
  }
});

// ── Receipts CRUD ──────────────────────────────────────────────────────────────
const getAll = db.prepare(`
  SELECT * FROM receipts ORDER BY date DESC, created_at DESC
`);

const getOne = db.prepare(`SELECT * FROM receipts WHERE id = ?`);

const insert = db.prepare(`
  INSERT INTO receipts (id, vendor, date, currency, total, subtotal, gst, pst, gratuity, category, image_data, notes)
  VALUES (@id, @vendor, @date, @currency, @total, @subtotal, @gst, @pst, @gratuity, @category, @image_data, @notes)
`);

const update = db.prepare(`
  UPDATE receipts
  SET vendor=@vendor, date=@date, currency=@currency, total=@total, subtotal=@subtotal,
      gst=@gst, pst=@pst, gratuity=@gratuity, category=@category, image_data=@image_data,
      notes=@notes, updated_at=datetime('now')
  WHERE id=@id
`);

const remove = db.prepare(`DELETE FROM receipts WHERE id = ?`);

app.get('/api/receipts', (_req, res) => {
  res.json(getAll.all());
});

app.get('/api/receipts/:id', (req, res) => {
  const row = getOne.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/receipts', (req, res) => {
  const receipt = { id: uuidv4(), ...sanitize(req.body) };
  insert.run(receipt);
  res.status(201).json(receipt);
});

app.put('/api/receipts/:id', (req, res) => {
  const existing = getOne.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const receipt = { id: req.params.id, ...sanitize(req.body) };
  update.run(receipt);
  res.json(receipt);
});

app.delete('/api/receipts/:id', (req, res) => {
  const existing = getOne.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  remove.run(req.params.id);
  res.status(204).end();
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Receipt Tracker running on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. OCR will not work.');
  }
});
