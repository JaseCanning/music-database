const crypto = require("crypto");

/**
 * Music Database MCP Server implementation
 * Provides Model Context Protocol (JSON-RPC & SSE) tools for AI agents (Grokbot, Claude, etc.)
 */
module.exports = function setupMusicMCP(app, getPool) {
  const SERVER_NAME = "music-database";
  const SERVER_VERSION = "1.0.0";

  // Active SSE clients
  const sseSessions = new Map();

  // Tool Definitions
  const tools = [
    {
      name: "get_library_summary",
      description: "Get high-level statistics of Jason's music library including total artists, albums, tracks, storage size, and breakdown by audio quality (Hi-Res, CD, MP3, DSD) and format.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "search_music",
      description: "Search across artists, albums, and tracks in the music database by keyword, with optional filters for library section (hi_res, mp3, other) or audio quality.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search term to match against artist names, album titles, or track titles" },
          section: { type: "string", enum: ["all", "hi_res", "mp3", "other"], default: "all", description: "Filter by library section" },
          quality: { type: "string", enum: ["all", "hi_res", "cd", "lossy", "dsd"], default: "all", description: "Filter by quality tier" },
          limit: { type: "integer", default: 20, description: "Max results per category (default 20)" }
        }
      }
    },
    {
      name: "get_album_details",
      description: "Retrieve comprehensive details for a specific album, including its artist, audio quality specifications, total size, Google Drive folder ID/link, and complete ordered tracklist with Google Drive track links.",
      inputSchema: {
        type: "object",
        properties: {
          album_id: { type: "integer", description: "Unique album ID" },
          title: { type: "string", description: "Album title to look up if album_id is not known" }
        }
      }
    },
    {
      name: "get_artist_details",
      description: "Retrieve artist information including discography (all albums) and track counts.",
      inputSchema: {
        type: "object",
        properties: {
          artist_id: { type: "integer", description: "Unique artist ID" },
          name: { type: "string", description: "Artist name to look up" }
        }
      }
    },
    {
      name: "get_track_details",
      description: "Get details for a specific music track by track ID or title, including Google Drive streaming/file link.",
      inputSchema: {
        type: "object",
        properties: {
          track_id: { type: "integer", description: "Unique track ID" },
          title: { type: "string", description: "Track title to search for" }
        }
      }
    }
  ];

  // Tool Executor
  async function executeTool(name, args = {}) {
    const db = getPool();

    switch (name) {
      case "get_library_summary": {
        const [counts] = await db.query(`
          SELECT 
            (SELECT COUNT(*) FROM artists) as artists_count,
            (SELECT COUNT(*) FROM albums) as albums_count,
            (SELECT COUNT(*) FROM tracks) as tracks_count,
            (SELECT COALESCE(SUM(total_size_bytes), 0) FROM albums) as total_bytes
        `);
        const [qualities] = await db.query(`
          SELECT quality, COUNT(*) as count, COALESCE(SUM(total_size_bytes), 0) as size_bytes
          FROM albums GROUP BY quality ORDER BY count DESC
        `);
        const [sections] = await db.query(`
          SELECT library_section, COUNT(*) as count, COALESCE(SUM(total_size_bytes), 0) as size_bytes
          FROM albums GROUP BY library_section ORDER BY count DESC
        `);
        const [formats] = await db.query(`
          SELECT file_format, COUNT(*) as count FROM albums GROUP BY file_format ORDER BY count DESC
        `);

        const totalGB = (Number(counts[0].total_bytes) / (1024 * 1024 * 1024)).toFixed(2);

        return {
          total_artists: counts[0].artists_count,
          total_albums: counts[0].albums_count,
          total_tracks: counts[0].tracks_count,
          total_storage_size: `${totalGB} GB`,
          quality_breakdown: qualities,
          section_breakdown: sections,
          format_breakdown: formats
        };
      }

      case "search_music": {
        const query = (args.query || "").trim();
        if (!query) {
          throw new Error("Search query is required.");
        }
        const pattern = `%${query}%`;
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);

        // Search Artists
        const [matchingArtists] = await db.query(
          `SELECT id, name, sort_name, 
            (SELECT COUNT(*) FROM albums WHERE artist_id = artists.id) as album_count
           FROM artists 
           WHERE name LIKE ? OR sort_name LIKE ? 
           ORDER BY name ASC LIMIT ?`,
          [pattern, pattern, limit]
        );

        // Search Albums
        let albumSql = `
          SELECT a.id, a.title, a.year, a.library_section, a.quality, a.track_count, 
                 a.total_size_bytes, a.drive_folder_id, a.drive_path, ar.name as artist
          FROM albums a
          JOIN artists ar ON a.artist_id = ar.id
          WHERE (a.title LIKE ? OR ar.name LIKE ?)
        `;
        const albumParams = [pattern, pattern];

        if (args.section && args.section !== "all") {
          albumSql += " AND a.library_section = ?";
          albumParams.push(args.section);
        }
        if (args.quality && args.quality !== "all") {
          albumSql += " AND a.quality = ?";
          albumParams.push(args.quality);
        }
        albumSql += " ORDER BY a.title ASC LIMIT ?";
        albumParams.push(limit);

        const [matchingAlbums] = await db.query(albumSql, albumParams);

        // Search Tracks
        let trackSql = `
          SELECT t.id, t.album_id, t.disc_number, t.track_number, t.title, t.track_artist, 
                 t.file_format, t.size_bytes, t.drive_file_id, 
                 a.title as album, ar.name as artist, a.quality
          FROM tracks t
          JOIN albums a ON t.album_id = a.id
          JOIN artists ar ON a.artist_id = ar.id
          WHERE (t.title LIKE ? OR t.track_artist LIKE ? OR a.title LIKE ? OR ar.name LIKE ?)
        `;
        const trackParams = [pattern, pattern, pattern, pattern];

        if (args.section && args.section !== "all") {
          trackSql += " AND a.library_section = ?";
          trackParams.push(args.section);
        }
        if (args.quality && args.quality !== "all") {
          trackSql += " AND a.quality = ?";
          trackParams.push(args.quality);
        }
        trackSql += " ORDER BY t.title ASC LIMIT ?";
        trackParams.push(limit);

        const [matchingTracks] = await db.query(trackSql, trackParams);

        return {
          query,
          artists_found: matchingArtists.length,
          albums_found: matchingAlbums.length,
          tracks_found: matchingTracks.length,
          artists: matchingArtists,
          albums: matchingAlbums.map(a => ({
            ...a,
            drive_url: a.drive_folder_id ? `https://drive.google.com/drive/folders/${a.drive_folder_id}` : null
          })),
          tracks: matchingTracks.map(t => ({
            ...t,
            drive_url: t.drive_file_id ? `https://drive.google.com/file/d/${t.drive_file_id}/view` : null
          }))
        };
      }

      case "get_album_details": {
        let album = null;
        if (args.album_id) {
          const [rows] = await db.query(`
            SELECT a.*, ar.name as artist
            FROM albums a
            JOIN artists ar ON a.artist_id = ar.id
            WHERE a.id = ? LIMIT 1
          `, [args.album_id]);
          if (rows.length > 0) album = rows[0];
        } else if (args.title) {
          const [rows] = await db.query(`
            SELECT a.*, ar.name as artist
            FROM albums a
            JOIN artists ar ON a.artist_id = ar.id
            WHERE a.title LIKE ? LIMIT 1
          `, [`%${args.title}%`]);
          if (rows.length > 0) album = rows[0];
        }

        if (!album) {
          throw new Error("Album not found.");
        }

        const [tracks] = await db.query(`
          SELECT id, disc_number, track_number, title, track_artist, file_name, file_format, size_bytes, duration_seconds, drive_file_id
          FROM tracks
          WHERE album_id = ?
          ORDER BY disc_number ASC, track_number ASC, id ASC
        `, [album.id]);

        return {
          id: album.id,
          title: album.title,
          artist: album.artist,
          year: album.year,
          quality: album.quality,
          bit_depth: album.bit_depth,
          sample_rate_hz: album.sample_rate_hz,
          library_section: album.library_section,
          track_count: album.track_count,
          total_size_bytes: album.total_size_bytes,
          drive_path: album.drive_path,
          drive_folder_id: album.drive_folder_id,
          drive_url: album.drive_folder_id ? `https://drive.google.com/drive/folders/${album.drive_folder_id}` : null,
          extra_files: album.extra_files,
          notes: album.notes,
          tracks: tracks.map(t => ({
            ...t,
            drive_url: t.drive_file_id ? `https://drive.google.com/file/d/${t.drive_file_id}/view` : null
          }))
        };
      }

      case "get_artist_details": {
        let artist = null;
        if (args.artist_id) {
          const [rows] = await db.query("SELECT * FROM artists WHERE id = ? LIMIT 1", [args.artist_id]);
          if (rows.length > 0) artist = rows[0];
        } else if (args.name) {
          const [rows] = await db.query("SELECT * FROM artists WHERE name LIKE ? LIMIT 1", [`%${args.name}%`]);
          if (rows.length > 0) artist = rows[0];
        }

        if (!artist) {
          throw new Error("Artist not found.");
        }

        const [albums] = await db.query(`
          SELECT id, title, year, library_section, quality, track_count, total_size_bytes, drive_folder_id
          FROM albums
          WHERE artist_id = ?
          ORDER BY year ASC, title ASC
        `, [artist.id]);

        return {
          id: artist.id,
          name: artist.name,
          sort_name: artist.sort_name,
          album_count: albums.length,
          albums: albums.map(a => ({
            ...a,
            drive_url: a.drive_folder_id ? `https://drive.google.com/drive/folders/${a.drive_folder_id}` : null
          }))
        };
      }

      case "get_track_details": {
        let track = null;
        if (args.track_id) {
          const [rows] = await db.query(`
            SELECT t.*, a.title as album_title, a.drive_folder_id, ar.name as artist_name, a.quality
            FROM tracks t
            JOIN albums a ON t.album_id = a.id
            JOIN artists ar ON a.artist_id = ar.id
            WHERE t.id = ? LIMIT 1
          `, [args.track_id]);
          if (rows.length > 0) track = rows[0];
        } else if (args.title) {
          const [rows] = await db.query(`
            SELECT t.*, a.title as album_title, a.drive_folder_id, ar.name as artist_name, a.quality
            FROM tracks t
            JOIN albums a ON t.album_id = a.id
            JOIN artists ar ON a.artist_id = ar.id
            WHERE t.title LIKE ? LIMIT 1
          `, [`%${args.title}%`]);
          if (rows.length > 0) track = rows[0];
        }

        if (!track) {
          throw new Error("Track not found.");
        }

        return {
          id: track.id,
          title: track.title,
          track_artist: track.track_artist || track.artist_name,
          album: track.album_title,
          artist: track.artist_name,
          disc_number: track.disc_number,
          track_number: track.track_number,
          format: track.file_format,
          quality: track.quality,
          size_bytes: track.size_bytes,
          duration_seconds: track.duration_seconds,
          drive_file_id: track.drive_file_id,
          drive_url: track.drive_file_id ? `https://drive.google.com/file/d/${track.drive_file_id}/view` : null,
          album_drive_url: track.drive_folder_id ? `https://drive.google.com/drive/folders/${track.drive_folder_id}` : null
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // Handle JSON-RPC payload
  async function handleJsonRpc(body) {
    const reqs = Array.isArray(body) ? body : [body];
    const responses = [];

    for (const rpc of reqs) {
      const { id = null, method, params = {} } = rpc;

      if (method === "initialize") {
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
          }
        });
      } else if (method === "notifications/initialized") {
        if (id !== null) responses.push({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "ping") {
        responses.push({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        responses.push({
          jsonrpc: "2.0",
          id,
          result: { tools }
        });
      } else if (method === "tools/call") {
        try {
          const toolResult = await executeTool(params.name, params.arguments || {});
          responses.push({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                { type: "text", text: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2) }
              ],
              isError: false
            }
          });
        } catch (err) {
          responses.push({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Error executing tool: ${err.message}` }],
              isError: true
            }
          });
        }
      } else {
        responses.push({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method '${method}' not found` }
        });
      }
    }

    return Array.isArray(body) ? responses : responses[0];
  }

  // MCP HTTP Endpoints
  app.post("/mcp", async (req, res) => {
    try {
      const result = await handleJsonRpc(req.body);
      res.json(result);
    } catch (err) {
      console.error("MCP POST error:", err);
      res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } });
    }
  });

  // MCP SSE Transport
  app.get("/mcp/sse", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    const sessionId = crypto.randomUUID();
    sseSessions.set(sessionId, res);

    const postEndpoint = `/mcp/messages?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${postEndpoint}\n\n`);

    req.on("close", () => {
      sseSessions.delete(sessionId);
    });
  });

  app.post("/mcp/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const sseRes = sseSessions.get(sessionId);

    try {
      const rpcResponse = await handleJsonRpc(req.body);
      if (sseRes) {
        sseRes.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
      }
      res.status(202).json({ accepted: true });
    } catch (err) {
      console.error("MCP SSE Message Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  console.log(`[MCP] Music Database MCP Server initialized with ${tools.length} tools.`);
};
