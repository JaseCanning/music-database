const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");
const setupMusicMCP = require("./mcp");

// Load environment variables
dotenv.config({ path: "/srv/apps/.env" });
if (!process.env.DB_PASSWORD) {
  dotenv.config({ path: path.join(__dirname, ".env") });
}

const app = express();
const PORT = process.env.PORT || 3007;
const HOST = process.env.HOST || "127.0.0.1";

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || "10.0.0.207",
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || "jason",
      password: process.env.DB_PASSWORD,
      database: "music_library",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

// Setup Music MCP Server for Grokbot & external AI agents
setupMusicMCP(app, getPool);

// User info endpoint (forwarded by dashboard gateway)
app.get("/api/user", (req, res) => {
  const username = req.headers["x-user"] || "jason";
  const displayName = req.headers["x-display-name"] || "Jason Canning";
  res.json({ username, displayName });
});

// Health check endpoint (used by dashboard /api/apps-status)
app.get("/api/health", async (req, res) => {
  try {
    const db = getPool();
    const [counts] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM artists) as artists_count,
        (SELECT COUNT(*) FROM albums) as albums_count,
        (SELECT COUNT(*) FROM tracks) as tracks_count,
        (SELECT COALESCE(SUM(total_size_bytes), 0) FROM albums) as total_size_bytes
    `);

    const data = counts[0] || {};
    res.json({
      status: "healthy",
      app: "music-database",
      port: Number(PORT),
      artists_count: data.artists_count || 0,
      albums_count: data.albums_count || 0,
      tracks_count: data.tracks_count || 0,
      total_size_bytes: data.total_size_bytes || 0
    });
  } catch (err) {
    console.error("Health check error:", err);
    res.status(500).json({ status: "error", error: err.message });
  }
});

// Library statistics & breakdown
app.get("/api/stats", async (req, res) => {
  try {
    const db = getPool();
    const [counts] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM artists) as artists_count,
        (SELECT COUNT(*) FROM albums) as albums_count,
        (SELECT COUNT(*) FROM tracks) as tracks_count,
        (SELECT COALESCE(SUM(total_size_bytes), 0) FROM albums) as total_size_bytes
    `);

    const [qualityRows] = await db.query(`
      SELECT quality, COUNT(*) as count, COALESCE(SUM(total_size_bytes), 0) as size_bytes,
             COALESCE(SUM(track_count), 0) as track_count
      FROM albums GROUP BY quality ORDER BY count DESC
    `);

    const [sectionRows] = await db.query(`
      SELECT library_section, COUNT(*) as count, COALESCE(SUM(total_size_bytes), 0) as size_bytes,
             COALESCE(SUM(track_count), 0) as track_count
      FROM albums GROUP BY library_section ORDER BY count DESC
    `);

    const [formatRows] = await db.query(`
      SELECT file_format, COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as size_bytes
      FROM tracks GROUP BY file_format ORDER BY count DESC
    `);

    const [topArtists] = await db.query(`
      SELECT ar.id, ar.name, COUNT(al.id) as album_count, COALESCE(SUM(al.track_count), 0) as track_count,
             COALESCE(SUM(al.total_size_bytes), 0) as total_size_bytes
      FROM artists ar
      JOIN albums al ON ar.id = al.artist_id
      GROUP BY ar.id, ar.name
      ORDER BY album_count DESC, track_count DESC
      LIMIT 10
    `);

    const [recentAlbums] = await db.query(`
      SELECT al.id, al.title, al.year, al.library_section, al.quality, al.track_count, 
             al.total_size_bytes, al.drive_folder_id, al.extra_files, ar.name as artist
      FROM albums al
      JOIN artists ar ON al.artist_id = ar.id
      ORDER BY al.updated_at DESC, al.id DESC
      LIMIT 8
    `);

    res.json({
      success: true,
      counts: counts[0] || {},
      qualities: qualityRows,
      sections: sectionRows,
      formats: formatRows,
      topArtists,
      recentAlbums
    });
  } catch (err) {
    console.error("Stats API error:", err);
    res.status(500).json({ error: "Failed to retrieve library statistics", details: err.message });
  }
});

// Unified Search (Artists, Albums, Tracks)
app.get("/api/search", async (req, res) => {
  const query = (req.query.q || "").trim();
  const type = req.query.type || "all"; // 'all' | 'artists' | 'albums' | 'tracks'
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 60);

  if (!query) {
    return res.json({ success: true, query: "", artists: [], albums: [], tracks: [] });
  }

  const pattern = `%${query}%`;
  const db = getPool();

  try {
    const results = { success: true, query };

    // Search Artists
    if (type === "all" || type === "artists") {
      const [artists] = await db.query(`
        SELECT ar.id, ar.name, ar.sort_name,
               COUNT(DISTINCT al.id) as album_count,
               COALESCE(SUM(al.track_count), 0) as track_count,
               COALESCE(SUM(al.total_size_bytes), 0) as total_size_bytes
        FROM artists ar
        LEFT JOIN albums al ON ar.id = al.artist_id
        WHERE ar.name LIKE ? OR ar.sort_name LIKE ?
        GROUP BY ar.id, ar.name, ar.sort_name
        ORDER BY ar.name ASC
        LIMIT ?
      `, [pattern, pattern, limit]);
      results.artists = artists;
    }

    // Search Albums
    if (type === "all" || type === "albums") {
      const [albums] = await db.query(`
        SELECT al.id, al.title, al.year, al.library_section, al.quality, al.file_format,
               al.bit_depth, al.sample_rate_hz, al.track_count, al.total_size_bytes,
               al.drive_folder_id, al.drive_path, al.extra_files, ar.name as artist, ar.id as artist_id
        FROM albums al
        JOIN artists ar ON al.artist_id = ar.id
        WHERE al.title LIKE ? OR ar.name LIKE ?
        ORDER BY al.title ASC
        LIMIT ?
      `, [pattern, pattern, limit]);
      results.albums = albums;
    }

    // Search Tracks
    if (type === "all" || type === "tracks") {
      const [tracks] = await db.query(`
        SELECT t.id, t.album_id, t.disc_number, t.track_number, t.title, t.track_artist,
               t.file_format, t.size_bytes, t.duration_seconds, t.drive_file_id,
               al.title as album, al.quality, al.library_section, al.drive_folder_id,
               ar.name as artist, ar.id as artist_id
        FROM tracks t
        JOIN albums al ON t.album_id = al.id
        JOIN artists ar ON al.artist_id = ar.id
        WHERE t.title LIKE ? OR t.track_artist LIKE ? OR al.title LIKE ? OR ar.name LIKE ?
        ORDER BY t.title ASC
        LIMIT ?
      `, [pattern, pattern, pattern, pattern, limit]);
      results.tracks = tracks;
    }

    res.json(results);
  } catch (err) {
    console.error("Search API error:", err);
    res.status(500).json({ error: "Failed to perform search", details: err.message });
  }
});

// Albums List (paginated, filtered, sorted)
app.get("/api/albums", async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);
  const offset = (page - 1) * limit;

  const query = (req.query.q || "").trim();
  const artistId = req.query.artist_id ? Number(req.query.artist_id) : null;
  const section = req.query.section || "all";
  const quality = req.query.quality || "all";
  const format = req.query.format || "all";
  const sort = req.query.sort || "title"; // 'title', 'artist', 'tracks', 'size', 'newest', 'quality'
  const order = (req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  try {
    const db = getPool();
    const conditions = [];
    const params = [];

    if (query) {
      conditions.push("(al.title LIKE ? OR ar.name LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }
    if (artistId) {
      conditions.push("al.artist_id = ?");
      params.push(artistId);
    }
    if (section && section !== "all") {
      conditions.push("al.library_section = ?");
      params.push(section);
    }
    if (quality && quality !== "all") {
      conditions.push("al.quality = ?");
      params.push(quality);
    }
    if (format && format !== "all") {
      conditions.push("al.file_format = ?");
      params.push(format);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Total count
    const [countRows] = await db.query(`
      SELECT COUNT(*) as total
      FROM albums al
      JOIN artists ar ON al.artist_id = ar.id
      ${whereClause}
    `, params);

    const total = countRows[0].total;

    // Sorting map
    let sortColumn = "al.title";
    if (sort === "artist") sortColumn = "ar.name";
    else if (sort === "tracks") sortColumn = "al.track_count";
    else if (sort === "size") sortColumn = "al.total_size_bytes";
    else if (sort === "quality") sortColumn = "al.quality";
    else if (sort === "newest") sortColumn = "al.id";

    // Query albums
    const [albums] = await db.query(`
      SELECT al.id, al.title, al.year, al.library_section, al.quality, al.file_format,
             al.bit_depth, al.sample_rate_hz, al.track_count, al.total_size_bytes,
             al.drive_folder_id, al.drive_path, al.extra_files, al.notes,
             ar.name as artist, ar.id as artist_id
      FROM albums al
      JOIN artists ar ON al.artist_id = ar.id
      ${whereClause}
      ORDER BY ${sortColumn} ${order}
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      success: true,
      albums,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Albums API error:", err);
    res.status(500).json({ error: "Failed to fetch albums", details: err.message });
  }
});

// Single Album Details & Tracks
app.get("/api/albums/:id", async (req, res) => {
  const albumId = Number(req.params.id);
  if (!albumId) {
    return res.status(400).json({ error: "Invalid album ID" });
  }

  try {
    const db = getPool();
    const [albumRows] = await db.query(`
      SELECT al.*, ar.name as artist, ar.sort_name as artist_sort_name
      FROM albums al
      JOIN artists ar ON al.artist_id = ar.id
      WHERE al.id = ? LIMIT 1
    `, [albumId]);

    if (!albumRows || albumRows.length === 0) {
      return res.status(404).json({ error: "Album not found" });
    }

    const album = albumRows[0];

    // Fetch tracks
    const [tracks] = await db.query(`
      SELECT id, album_id, disc_number, track_number, title, track_artist,
             file_name, drive_file_id, file_format, size_bytes, duration_seconds
      FROM tracks
      WHERE album_id = ?
      ORDER BY disc_number ASC, track_number ASC, id ASC
    `, [albumId]);

    // Fetch Qobuz offers if any
    const [offers] = await db.query(`
      SELECT * FROM qobuz_offers WHERE album_id = ? LIMIT 5
    `, [albumId]);

    res.json({
      success: true,
      album: {
        ...album,
        drive_url: album.drive_folder_id ? `https://drive.google.com/drive/folders/${album.drive_folder_id}` : null
      },
      tracks: tracks.map(t => ({
        ...t,
        drive_url: t.drive_file_id ? `https://drive.google.com/file/d/${t.drive_file_id}/view` : null
      })),
      offers
    });
  } catch (err) {
    console.error("Album details API error:", err);
    res.status(500).json({ error: "Failed to fetch album details", details: err.message });
  }
});

// Tracks List (paginated, filtered, sorted)
app.get("/api/tracks", async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = (page - 1) * limit;

  const query = (req.query.q || "").trim();
  const artistId = req.query.artist_id ? Number(req.query.artist_id) : null;
  const albumId = req.query.album_id ? Number(req.query.album_id) : null;
  const section = req.query.section || "all";
  const quality = req.query.quality || "all";
  const format = req.query.format || "all";
  const sort = req.query.sort || "title"; // 'title', 'artist', 'album', 'size', 'track_number'
  const order = (req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  try {
    const db = getPool();
    const conditions = [];
    const params = [];

    if (query) {
      conditions.push("(t.title LIKE ? OR t.track_artist LIKE ? OR al.title LIKE ? OR ar.name LIKE ?)");
      params.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
    }
    if (artistId) {
      conditions.push("ar.id = ?");
      params.push(artistId);
    }
    if (albumId) {
      conditions.push("t.album_id = ?");
      params.push(albumId);
    }
    if (section && section !== "all") {
      conditions.push("al.library_section = ?");
      params.push(section);
    }
    if (quality && quality !== "all") {
      conditions.push("al.quality = ?");
      params.push(quality);
    }
    if (format && format !== "all") {
      conditions.push("t.file_format = ?");
      params.push(format);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count
    const [countRows] = await db.query(`
      SELECT COUNT(*) as total
      FROM tracks t
      JOIN albums al ON t.album_id = al.id
      JOIN artists ar ON al.artist_id = ar.id
      ${whereClause}
    `, params);

    const total = countRows[0].total;

    // Sort column
    let sortColumn = "t.title";
    if (sort === "artist") sortColumn = "ar.name";
    else if (sort === "album") sortColumn = "al.title";
    else if (sort === "size") sortColumn = "t.size_bytes";
    else if (sort === "track_number") sortColumn = "t.track_number";

    const [tracks] = await db.query(`
      SELECT t.id, t.album_id, t.disc_number, t.track_number, t.title, t.track_artist,
             t.file_name, t.file_format, t.size_bytes, t.duration_seconds, t.drive_file_id,
             al.title as album, al.quality, al.library_section, al.drive_folder_id,
             ar.name as artist, ar.id as artist_id
      FROM tracks t
      JOIN albums al ON t.album_id = al.id
      JOIN artists ar ON al.artist_id = ar.id
      ${whereClause}
      ORDER BY ${sortColumn} ${order}
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      success: true,
      tracks: tracks.map(t => ({
        ...t,
        drive_url: t.drive_file_id ? `https://drive.google.com/file/d/${t.drive_file_id}/view` : null,
        album_drive_url: t.drive_folder_id ? `https://drive.google.com/drive/folders/${t.drive_folder_id}` : null
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Tracks API error:", err);
    res.status(500).json({ error: "Failed to fetch tracks", details: err.message });
  }
});

// Artists List
app.get("/api/artists", async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 36, 1), 100);
  const offset = (page - 1) * limit;

  const query = (req.query.q || "").trim();
  const letter = (req.query.letter || "").trim().toUpperCase();
  const sort = req.query.sort || "name"; // 'name', 'albums', 'tracks', 'size'
  const order = (req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  try {
    const db = getPool();
    const conditions = [];
    const params = [];

    if (query) {
      conditions.push("(ar.name LIKE ? OR ar.sort_name LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }
    if (letter && letter !== "ALL") {
      if (letter === "#") {
        conditions.push("ar.name REGEXP '^[^a-zA-Z]'");
      } else {
        conditions.push("ar.name LIKE ?");
        params.push(`${letter}%`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [countRows] = await db.query(`
      SELECT COUNT(*) as total FROM artists ar ${whereClause}
    `, params);

    const total = countRows[0].total;

    let sortCol = "ar.name";
    if (sort === "albums") sortCol = "album_count";
    else if (sort === "tracks") sortCol = "track_count";
    else if (sort === "size") sortCol = "total_size_bytes";

    const [artists] = await db.query(`
      SELECT ar.id, ar.name, ar.sort_name,
             COUNT(DISTINCT al.id) as album_count,
             COALESCE(SUM(al.track_count), 0) as track_count,
             COALESCE(SUM(al.total_size_bytes), 0) as total_size_bytes
      FROM artists ar
      LEFT JOIN albums al ON ar.id = al.artist_id
      ${whereClause}
      GROUP BY ar.id, ar.name, ar.sort_name
      ORDER BY ${sortCol} ${order}
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      success: true,
      artists,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Artists API error:", err);
    res.status(500).json({ error: "Failed to fetch artists", details: err.message });
  }
});

// Single Artist Details (with their albums and tracks)
app.get("/api/artists/:id", async (req, res) => {
  const artistId = Number(req.params.id);
  if (!artistId) {
    return res.status(400).json({ error: "Invalid artist ID" });
  }

  try {
    const db = getPool();
    const [artistRows] = await db.query("SELECT * FROM artists WHERE id = ? LIMIT 1", [artistId]);
    if (!artistRows || artistRows.length === 0) {
      return res.status(404).json({ error: "Artist not found" });
    }

    const artist = artistRows[0];

    const [albums] = await db.query(`
      SELECT al.*, COUNT(t.id) as real_track_count
      FROM albums al
      LEFT JOIN tracks t ON al.id = t.album_id
      WHERE al.artist_id = ?
      GROUP BY al.id
      ORDER BY al.year ASC, al.title ASC
    `, [artistId]);

    const [topTracks] = await db.query(`
      SELECT t.id, t.title, t.track_number, t.file_format, t.size_bytes, t.drive_file_id,
             al.title as album, al.quality, al.id as album_id
      FROM tracks t
      JOIN albums al ON t.album_id = al.id
      WHERE al.artist_id = ?
      ORDER BY al.id ASC, t.disc_number ASC, t.track_number ASC
      LIMIT 50
    `, [artistId]);

    res.json({
      success: true,
      artist,
      albums: albums.map(a => ({
        ...a,
        drive_url: a.drive_folder_id ? `https://drive.google.com/drive/folders/${a.drive_folder_id}` : null
      })),
      tracks: topTracks.map(t => ({
        ...t,
        drive_url: t.drive_file_id ? `https://drive.google.com/file/d/${t.drive_file_id}/view` : null
      }))
    });
  } catch (err) {
    console.error("Artist details API error:", err);
    res.status(500).json({ error: "Failed to fetch artist details", details: err.message });
  }
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, "public")));

// Fallback to index.html for SPA client-side routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Jason Canning Music Database listening on http://${HOST}:${PORT}`);
});
