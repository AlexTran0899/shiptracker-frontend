# Ship Tracker 9000

The app now loads ship playback data from an API instead of `flattened_ships.json`.

Set `VITE_SHIP_API_URL` to the geohash endpoint base. If it is not set, the client will request `http://127.0.0.1:9000/geohash/<geo code>`.

Examples:

```bash
VITE_SHIP_API_URL=http://127.0.0.1:9000/geohash
VITE_SHIP_API_URL=http://127.0.0.1:9000/geohash/{geohash}
```

The client sends a `GET` request and appends the 3-character geohash for the current viewport center to the request path.

The response is expected to be a JSON array of rows in this shape:

```json
[
  ["ship-id", 38.91, -76.99, "2026-04-02T12:00:00"],
  ["ship-id", 38.92, -77.01, "2026-04-02T13:00:00"]
]
```

Each row is `[shipId, latitude, longitude, timestamp]`.
