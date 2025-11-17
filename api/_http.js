const https = require('https');
const http = require('http');
const { URL } = require('url');

function httpRequest(method, urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;

    const headers = Object.assign({}, options.headers || {});
    let bodyBuf = null;

    if (options.body != null) {
      if (typeof options.body === 'string') {
        bodyBuf = Buffer.from(options.body, 'utf8');
      } else {
        bodyBuf = Buffer.from(JSON.stringify(options.body), 'utf8');
        if (!headers['content-type']) headers['content-type'] = 'application/json';
      }
      headers['content-length'] = String(bodyBuf.length);
    }

    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers,
        timeout: options.timeout || 30000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = { httpRequest };
