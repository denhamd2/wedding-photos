'use strict';

// Generates printable QR table cards:
//   npm run qr -- --tables 12 --url https://your-app.up.railway.app [--couple "John & Katie"]
// Output: out/table-cards.html (print this) + out/qr-table-NN.png (individual codes)

const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const tables = parseInt(arg('tables', process.env.TABLE_COUNT || '12'), 10);
const baseUrl = (arg('url', process.env.BASE_URL || '') || '').replace(/\/$/, '');
const couple = arg('couple', process.env.COUPLE_NAMES || 'John & Katie');

if (!baseUrl) {
  console.error('Usage: npm run qr -- --tables 12 --url https://your-app.up.railway.app');
  process.exit(1);
}

async function main() {
  const outDir = path.join(__dirname, '..', 'out');
  await fs.mkdir(outDir, { recursive: true });

  const cards = [];
  for (let t = 1; t <= tables; t++) {
    const target = `${baseUrl}/t/${t}`;
    const png = await QRCode.toBuffer(target, {
      errorCorrectionLevel: 'H', // survives wine spills and fancy card stock
      width: 900,
      margin: 2,
      color: { dark: '#3b352e', light: '#ffffff' },
    });
    const file = path.join(outDir, `qr-table-${String(t).padStart(2, '0')}.png`);
    await fs.writeFile(file, png);
    cards.push({ table: t, target, dataUri: `data:image/png;base64,${png.toString('base64')}` });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(couple)} — table cards</title>
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
  .card img { width: 58mm; height: 58mm; margin-top: 8mm; }
  .card .table { margin-top: 8mm; font-size: 21px; letter-spacing: 2px; color: #96754a;
    border-top: 1px solid #e4dbcb; padding-top: 5mm; width: 70%; }
  .card .scanme { font-size: 13px; color: #9a917f; margin-top: 3mm; font-family: -apple-system, sans-serif; }
  @media print {
    body { background: #fff; }
    .sheet { gap: 0; padding: 0; }
    .card { border: 1px dashed #ccc; border-radius: 0; margin: 2mm; }
  }
</style>
</head>
<body>
<div class="sheet">
${cards.map((c) => `  <div class="card">
    <div class="rings">📸</div>
    <h2>${esc(couple)}</h2>
    <div class="invite">Took a photo tonight?<br>Share it with the happy couple —<br>scan with your phone camera.</div>
    <img src="${c.dataUri}" alt="QR code for table ${c.table}">
    <div class="table">TABLE ${c.table}</div>
    <div class="scanme">No app needed — the code opens in your browser</div>
  </div>`).join('\n')}
</div>
</body>
</html>
`;

  const htmlFile = path.join(outDir, 'table-cards.html');
  await fs.writeFile(htmlFile, html);
  console.log(`Wrote ${tables} QR codes and ${htmlFile}`);
  console.log('Open table-cards.html in a browser and print (A6 cards, one per table).');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

main().catch((err) => { console.error(err); process.exit(1); });
