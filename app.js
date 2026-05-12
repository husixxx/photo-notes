const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- Database Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// --- Azure Blob Storage Setup ---
const blobConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'uploads';
const staticContainerName = process.env.AZURE_STATIC_CONTAINER || 'static';

let blobServiceClient;
let uploadsContainerClient;

if (blobConnectionString) {
  blobServiceClient = BlobServiceClient.fromConnectionString(blobConnectionString);
  uploadsContainerClient = blobServiceClient.getContainerClient(containerName);
}

// Generate SAS token for private blob access (valet key pattern)
function generateSasUrl(blobName) {
  if (!blobConnectionString) return null;

  const credential = StorageSharedKeyCredential.fromConnectionString(blobConnectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  const sasOptions = {
    containerName,
    blobName,
    permissions: BlobSASPermissions.parse('r'),
    startsOn: new Date(),
    expiresOn: new Date(new Date().valueOf() + 30 * 60 * 1000), // 30 minutes
  };

  const sasToken = generateBlobSASQueryParameters(sasOptions, credential).toString();
  return `${blobClient.url}?${sasToken}`;
}

// --- Multer (memory storage for upload to blob) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// --- Middleware ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files: from Blob Storage URL (production) or locally (dev)
const staticBaseUrl = process.env.AZURE_STATIC_URL || '';
app.use((req, res, next) => {
  res.locals.staticBaseUrl = staticBaseUrl;
  next();
});

// Fallback: serve static files locally if no Azure static URL configured
if (!process.env.AZURE_STATIC_URL) {
  app.use('/static', express.static(path.join(__dirname, 'public')));
}

// --- Routes ---

// Home - list all notes
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM notes ORDER BY created_at DESC');
    const notes = result.rows.map(note => {
      if (note.image_url && blobConnectionString) {
        note.image_display_url = generateSasUrl(note.image_url);
      } else if (note.image_url) {
        note.image_display_url = note.image_url;
      }
      return note;
    });
    res.render('index', { notes });
  } catch (err) {
    console.error('Error fetching notes:', err);
    res.status(500).render('error', { message: 'Failed to load notes' });
  }
});

// Create note form
app.get('/new', (req, res) => {
  res.render('new');
});

// Create note
app.post('/notes', upload.single('image'), async (req, res) => {
  try {
    const { title, content } = req.body;
    let imageUrl = null;

    if (req.file && uploadsContainerClient) {
      const blobName = `${Date.now()}-${req.file.originalname}`;
      const blockBlobClient = uploadsContainerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(req.file.buffer, {
        blobHTTPHeaders: { blobContentType: req.file.mimetype },
      });
      imageUrl = blobName; // Store blob name, generate SAS on read
    }

    await pool.query(
      'INSERT INTO notes (title, content, image_url) VALUES ($1, $2, $3)',
      [title, content, imageUrl]
    );
    res.redirect('/');
  } catch (err) {
    console.error('Error creating note:', err);
    res.status(500).render('error', { message: 'Failed to create note' });
  }
});

// Delete note
app.post('/notes/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT image_url FROM notes WHERE id = $1', [id]);

    if (result.rows[0]?.image_url && uploadsContainerClient) {
      const blockBlobClient = uploadsContainerClient.getBlockBlobClient(result.rows[0].image_url);
      await blockBlobClient.deleteIfExists();
    }

    await pool.query('DELETE FROM notes WHERE id = $1', [id]);
    res.redirect('/');
  } catch (err) {
    console.error('Error deleting note:', err);
    res.status(500).render('error', { message: 'Failed to delete note' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch {
    res.status(500).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// --- Start ---
initDB().then(() => {
  app.listen(port, () => {
    console.log(`Photo Notes app running on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
