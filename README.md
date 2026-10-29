# Jason Canning Music Database & Library Browser

A clean, modern music library browser and search interface for Jason's personal music collection (FLAC, Hi-Res 24-bit/96kHz, CD 16-bit/44.1kHz, and MP3 collections) hosted on Proxmox CT 101 (`10.0.0.212:3007`) and backed by MariaDB (`10.0.0.207:3306`, database: `music_library`).

## Features
- **Instant Search**: Search across 641 artists, 1,182 albums, and 20,449 tracks in real-time.
- **Google Drive Integration**: Direct links to open album folders or stream individual tracks in Google Drive.
- **Audio Quality Classification**: Hi-Res 24-bit studio masters, CD-quality Redbook audio, DSD direct stream, and lossy MP3s.
- **Alphabetical Artist Browser**: Jump between artists A-Z with full discographies.
- **Library Insights**: Live statistics and breakdown of library format distributions, storage consumption, and top artists.
- **Model Context Protocol (MCP)**: Embedded JSON-RPC and SSE `/mcp` endpoints allowing Grokbot and external AI assistants to query the library, search music, and look up metadata.
- **Seamless Portal Integration**: Reverse-proxied behind `https://jasoncanning.uk/music/` with session authentication and shared dark/light theme.
