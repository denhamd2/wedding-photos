'use strict';

// Generates printable QR table cards — one shared QR code for the whole wedding:
//   npm run qr -- --url https://your-app.up.railway.app [--copies 12] [--couple "John & Katie"]
// Output: out/table-cards.html (print this; one identical card per table) + out/qr-code.png

const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const copies = parseInt(arg('copies', '12'), 10);
const baseUrl = (arg('url', process.env.BASE_URL || '') || '').replace(/\/$/, '');
const couple = arg('couple', process.env.COUPLE_NAMES || 'John & Katie');

if (!baseUrl) {
  console.error('Usage: npm run qr -- --url https://your-app.up.railway.app [--copies 12]');
  process.exit(1);
}

async function main() {
  const outDir = path.join(__dirname, '..', 'out');
  await fs.mkdir(outDir, { recursive: true });

  const png = await QRCode.toBuffer(baseUrl, {
    errorCorrectionLevel: 'H', // survives wine spills and fancy card stock
    width: 900,
    margin: 2,
    color: { dark: '#3b352e', light: '#ffffff' },
  });
  await fs.writeFile(path.join(outDir, 'qr-code.png'), png);
  const dataUri = `data:image/png;base64,${png.toString('base64')}`;

  const card = `  <div class="card">
    <div class="rings">📸</div>
    <h2>${esc(couple)}</h2>
    <div class="invite">Took a photo tonight?<br>Share it with the happy couple —<br>scan with your phone camera.</div>
    <img src="${dataUri}" alt="QR code for sharing wedding photos">
    <div class="scanme">No app needed — the code opens in your browser</div>
  </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(couple)} — photo sharing cards</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, "Times New Roman", serif; background: #f2ede4; color: #3b352e; }
  .sheet { display: flex; flex-wrap: wrap; gap: 24px; padding: 24px; justify-content: center; }
  .card {
    width: 105mm; height: 148mm; /* A6 */
    background: #fffdf9; border: 1px solid #d8cdbb; border-radius: 10px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 10mm; page-break-inside: avoid;
  }
  .card .rings { font-size: 30px; }
  .card h2 { font-weight: 500; font-size: 24px; margin-top: 6px; letter-spacing: 0.5px; }
  .card .invite { font-size: 15px; color: #6f6759; margin-top: 8px; line-height: 1.5; }
  .card img { width: 62mm; height: 62mm; margin-top: 8mm; }
  .card .scanme { font-size: 13px; color: #9a917f; margin-top: 6mm; font-family: -apple-system, sans-serif; }
  @media print {
    body { background: #fff; }
    .sheet { gap: 0; padding: 0; }
    .card { border: 1px dashed #ccc; border-radius: 0; margin: 2mm; }
  }
</style>
</head>
<body>
<div class="sheet">
${Array.from({ length: copies }, () => card).join('\n')}
</div>
</body>
</html>
`;

  const htmlFile = path.join(outDir, 'table-cards.html');
  await fs.writeFile(htmlFile, html);
  console.log(`Wrote out/qr-code.png and ${htmlFile} (${copies} identical cards)`);
  console.log('Open table-cards.html in a browser and print (A6 cards — one per table).');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

main().catch((err) => { console.error(err); process.exit(1); });
