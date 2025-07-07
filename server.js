const express = require('express');
const cors = require('cors');
const app = express();
const port = 3000;
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');

app.use(cors());
app.use(express.json());

// Ensure uploads directory exists before multer setup
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`✅ Created uploads directory at: ${uploadsDir}`);
}

// Restrict upload size to 400MB
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 400 * 1024 * 1024 }, // 400MB
});

// Setup Postgres connection
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'landuse',
  password: 'mypassword123',
  port: 5433,
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// Serve admin boundaries from local files
['local', 'district', 'province'].forEach(level => {
  app.get(`/api/${level}`, (req, res) => {
    const file = path.join(__dirname, `data/${level}.geojson`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: `${level} boundary not found` });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    res.json(data);
  });
});

// Load land use features with pagination (to avoid memory/JSON limits)
app.get('/api/land_use', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 1000; // default 1000 per page
  const offset = parseInt(req.query.offset, 10) || 0;
  try {
    const { rows } = await pool.query(`
      SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(jsonb_agg(ST_AsGeoJSON(t.*)::jsonb), '[]'::jsonb)
      ) AS geojson
      FROM (
        SELECT * FROM landuse
        ORDER BY id
        OFFSET $1 LIMIT $2
      ) AS t;
    `, [offset, limit]);
    res.json(rows[0].geojson);
  } catch (e) {
    console.error('Error fetching land use:', e);
    res.status(500).json({ error: 'Database error fetching land use' });
  }
});

// ✅ Corrected filter features by type with case-insensitive match
app.get('/api/filter/:type', async (req, res) => {
  const { type } = req.params;
  const limit = parseInt(req.query.limit, 10) || 1000;
  const offset = parseInt(req.query.offset, 10) || 0;
  try {
    const { rows } = await pool.query(`
      SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(jsonb_agg(ST_AsGeoJSON(t.*)::jsonb), '[]'::jsonb)
      ) AS geojson
      FROM (
        SELECT * FROM landuse
        WHERE LOWER(type) = LOWER($1)
        ORDER BY id
        OFFSET $2 LIMIT $3
      ) AS t;
    `, [type, offset, limit]);
    const result = rows[0].geojson;
    if (!result || !result.features || result.features.length === 0) {
      return res.status(404).json({ error: `No features found with type '${type}'` });
    }
    res.json(result);
  } catch (e) {
    console.error('Error filtering:', e);
    res.status(500).json({ error: 'Database error filtering land use' });
  }
});

// ✅ Corrected area calculation by type with case-insensitive match
app.get('/api/area/:type', async (req, res) => {
  const { type } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS feature_count,
             SUM(ST_Area(geom::geography)) AS total_area_m2
      FROM landuse
      WHERE LOWER(type) = LOWER($1);
    `, [type]);
    const count = parseInt(rows[0].feature_count, 10);
    const area = parseFloat(rows[0].total_area_m2 || 0);
    if (count === 0) {
      return res.status(404).json({ error: `No features found with type '${type}'` });
    }
    res.json({
      type,
      totalAreaSquareMeters: area,
      totalAreaHectares: area / 10000,
      featureCount: count
    });
  } catch (e) {
    console.error('Error calculating area:', e);
    res.status(500).json({ error: 'Database error calculating area' });
  }
});

// Upload route with safe file deletion
app.post('/api/upload', upload.single('geojson'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const uploadedPath = path.resolve(uploadsDir, req.file.filename);

  try {
    const data = JSON.parse(fs.readFileSync(uploadedPath, 'utf8'));

    // Basic validation of GeoJSON
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      throw new Error('Invalid GeoJSON format');
    }

    await pool.query('BEGIN');
    await pool.query('DELETE FROM landuse');

    // Insert features in batches to avoid memory problems
    const BATCH_SIZE = 500;
    let insertCount = 0;
    for (let i = 0; i < data.features.length; i += BATCH_SIZE) {
      const batch = data.features.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      batch.forEach((f, idx) => {
        const geomJSON = f.geometry ? JSON.stringify(f.geometry) : null;
        const typeVal = f.properties?.type || null;
        if (geomJSON && typeVal) {
          params.push(geomJSON, typeVal);
          // ($1, $2), ($3, $4), ...
          values.push(`(ST_SetSRID(ST_GeomFromGeoJSON($${params.length - 1}), 4326), $${params.length})`);
        }
      });
      if (params.length > 0) {
        await pool.query(
          `INSERT INTO landuse (geom, type) VALUES ${values.join(', ')}`,
          params
        );
        insertCount += batch.length;
      }
    }

    await pool.query('COMMIT');
    res.json({ message: `GeoJSON uploaded and database updated successfully! Inserted ${insertCount} features.` });
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('❌ Upload Error:', e.message);
    res.status(500).json({ error: e.message || 'Failed to upload and save GeoJSON' });
  } finally {
    if (fs.existsSync(uploadedPath)) {
      fs.unlinkSync(uploadedPath);
    }
  }
});

// Fallback for unknown API routes
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// Start the server
app.listen(port, () => console.log(`🚀 Server running at http://localhost:${port}`));
