const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

let db = new sqlite3.Database(path.join(app.getPath('userData'), 'nexpos.db'));

// Initialize tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS shift_closures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    closed_by TEXT,
    close_time TEXT DEFAULT (datetime('now')),
    expected_cash REAL,
    counted_cash REAL,
    variance REAL,
    denominations TEXT,
    notes TEXT,
    organization_id TEXT
  )`);
});

ipcMain.handle('db:query', async (event, { table, action, data, filters }) => {
  return new Promise((resolve, reject) => {
    if (action === 'insert') {
      const keys = Object.keys(data).join(',');
      const placeholders = Object.keys(data).map(() => '?').join(',');
      const values = Object.values(data);
      db.run(`INSERT INTO ${table} (${keys}) VALUES (${placeholders})`, values, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID });
      });
    } else if (action === 'getAll') {
      let query = `SELECT * FROM ${table}`;
      // Basic filtering for today's sales if needed, but let's keep it general
      db.all(query, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    }
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
