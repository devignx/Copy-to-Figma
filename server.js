const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CAPTURE_FILE = path.join(__dirname, 'capture.js');

const server = http.createServer((req, res) => {
  // Allow the bookmarklet to load this script cross-origin from any page.
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = req.url.split('?')[0];

  if (url === '/capture.js') {
    fs.readFile(CAPTURE_FILE, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('capture.js not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`capture.js served at http://localhost:${PORT}/capture.js`);
});
