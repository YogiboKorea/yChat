const http = require('http');
const https = require('https');

const data = JSON.stringify({
  message: 'hi',
  memberId: 'test_id'
});

const options = {
  hostname: 'port-0-ychat-lzgmwhc4d9883c97.sel4.cloudtype.app',
  port: 443,
  path: '/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(options, res => {
  console.log(`statusCode: ${res.statusCode}`);
  res.on('data', d => {
    process.stdout.write(d);
    console.log('\n====');
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(data);
req.end();
