const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

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
    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        author VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
        emoji VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized');
  } finally { client.release(); }
}

const blobConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'uploads';
let blobServiceClient, uploadsContainerClient, sharedKeyCredential, storageAccountName;

if (blobConnectionString) {
  try {
    blobServiceClient = BlobServiceClient.fromConnectionString(blobConnectionString);
    uploadsContainerClient = blobServiceClient.getContainerClient(containerName);
    const accountNameMatch = blobConnectionString.match(/AccountName=([^;]+)/);
    const accountKeyMatch = blobConnectionString.match(/AccountKey=([^;]+)/);
    if (accountNameMatch && accountKeyMatch) {
      storageAccountName = accountNameMatch[1];
      sharedKeyCredential = new StorageSharedKeyCredential(storageAccountName, accountKeyMatch[1]);
      console.log('Azure Blob Storage configured');
    }
  } catch (err) { console.error('Storage config error:', err.message); }
}

function generateSasUrl(blobName) {
  if (!sharedKeyCredential || !storageAccountName) return null;
  try {
    const sasToken = generateBlobSASQueryParameters({ containerName, blobName, permissions: BlobSASPermissions.parse('r'), startsOn: new Date(), expiresOn: new Date(Date.now() + 30*60*1000) }, sharedKeyCredential).toString();
    return 'https://' + storageAccountName + '.blob.core.windows.net/' + containerName + '/' + blobName + '?' + sasToken;
  } catch (err) { console.error('SAS error:', err.message); return null; }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024 }, fileFilter: (req, file, cb) => { cb(null, ['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)); } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const staticBaseUrl = process.env.AZURE_STATIC_URL || '';
app.use((req, res, next) => { res.locals.staticBaseUrl = staticBaseUrl; next(); });
if (!process.env.AZURE_STATIC_URL) { app.use('/static', express.static(path.join(__dirname, 'public'))); }

// Home
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM notes ORDER BY created_at DESC');
    const notes = result.rows.map(note => {
      if (note.image_url && sharedKeyCredential) { note.image_display_url = generateSasUrl(note.image_url); }
      else if (note.image_url) { note.image_display_url = note.image_url; }
      return note;
    });
    res.render('index', { notes });
  } catch (err) { console.error('Error fetching notes:', err); res.status(500).render('error', { message: 'Failed to load notes' }); }
});

// Single note with comments and reactions
app.get('/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const noteResult = await pool.query('SELECT * FROM notes WHERE id = $1', [id]);
    if (noteResult.rows.length === 0) return res.status(404).render('error', { message: 'Note not found' });

    const note = noteResult.rows[0];
    if (note.image_url && sharedKeyCredential) { note.image_display_url = generateSasUrl(note.image_url); }
    else if (note.image_url) { note.image_display_url = note.image_url; }

    const commentsResult = await pool.query('SELECT * FROM comments WHERE note_id = $1 ORDER BY created_at ASC', [id]);

    // Get reactions grouped by comment
    const reactionsResult = await pool.query(
      'SELECT comment_id, emoji, COUNT(*) as count FROM reactions WHERE comment_id IN (SELECT id FROM comments WHERE note_id = $1) GROUP BY comment_id, emoji ORDER BY count DESC',
      [id]
    );

    // Attach reactions to comments
    const reactionsMap = {};
    reactionsResult.rows.forEach(r => {
      if (!reactionsMap[r.comment_id]) reactionsMap[r.comment_id] = {};
      reactionsMap[r.comment_id][r.emoji] = parseInt(r.count);
    });

    const comments = commentsResult.rows.map(c => {
      c.reactions = reactionsMap[c.id] || {};
      return c;
    });

    res.render('note', { note, comments });
  } catch (err) { console.error('Error fetching note:', err); res.status(500).render('error', { message: 'Failed to load note' }); }
});

// Add comment
app.post('/notes/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const { author, content } = req.body;
    await pool.query('INSERT INTO comments (note_id, author, content) VALUES ($1, $2, $3)', [id, author || 'Anonymous', content]);
    res.redirect('/notes/' + id);
  } catch (err) { console.error('Error adding comment:', err); res.status(500).render('error', { message: 'Failed to add comment' }); }
});

// Add reaction to comment
app.post('/comments/:commentId/react', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { emoji, noteId } = req.body;
    const allowed = ['\u{1F44D}', '\u{1F602}', '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F622}', '\u{1F914}'];
    if (allowed.includes(emoji)) {
      await pool.query('INSERT INTO reactions (comment_id, emoji) VALUES ($1, $2)', [commentId, emoji]);
    }
    res.redirect('/notes/' + noteId);
  } catch (err) { console.error('Error adding reaction:', err); res.redirect('back'); }
});

app.get('/new', (req, res) => { res.render('new'); });

app.post('/notes', upload.single('image'), async (req, res) => {
  try {
    const { title, content } = req.body;
    let imageUrl = null;
    if (req.file && uploadsContainerClient) { const blobName = Date.now() + '-' + req.file.originalname; const b = uploadsContainerClient.getBlockBlobClient(blobName); await b.uploadData(req.file.buffer, { blobHTTPHeaders: { blobContentType: req.file.mimetype } }); imageUrl = blobName; }
    await pool.query('INSERT INTO notes (title, content, image_url) VALUES ($1, $2, $3)', [title, content, imageUrl]);
    res.redirect('/');
  } catch (err) { console.error('Error creating note:', err); res.status(500).render('error', { message: 'Failed to create note' }); }
});

app.post('/notes/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT image_url FROM notes WHERE id = $1', [id]);
    if (result.rows[0] && result.rows[0].image_url && uploadsContainerClient) { await uploadsContainerClient.getBlockBlobClient(result.rows[0].image_url).deleteIfExists(); }
    await pool.query('DELETE FROM notes WHERE id = $1', [id]);
    res.redirect('/');
  } catch (err) { console.error('Error deleting note:', err); res.status(500).render('error', { message: 'Failed to delete note' }); }
});

app.get('/health', async (req, res) => { try { await pool.query('SELECT 1'); res.json({ status: 'healthy', database: 'connected' }); } catch(e) { res.status(500).json({ status: 'unhealthy', database: 'disconnected' }); } });

initDB().then(() => { app.listen(port, () => { console.log('Photo Notes running on port ' + port); }); }).catch(err => { console.error('DB init failed:', err); process.exit(1); });
