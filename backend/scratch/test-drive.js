const axios = require('axios');
const links = [
  'https://drive.google.com/drive/folders/1_ra-8GJpXsX6jjZtwAftuPDs4jMdDi7-?usp=sharing',
  'https://drive.google.com/drive/folders/1TtquQM8_YiDDSL3rUPEP1Pt8I1m4UoWc?usp=sharing',
  'https://drive.google.com/drive/folders/1ODdvU3wrjP1tlEf3AjR_7ity7s09YyCh?usp=sharing'
];

async function check() {
  for (const link of links) {
    const match = link.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    const folderId = match[1];
    const res = await axios.get(link, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = res.data;
    
    const patterns = [
      /1[a-zA-Z0-9_-]{32}/g,
      /0B[a-zA-Z0-9_-]{31}/g,
      /0b[a-zA-Z0-9_-]{31}/g,
      /\/file\/d\/([a-zA-Z0-9_-]{25,})/g,
      /\\\\"[a-zA-Z0-9_-]{25,}\\\\"|"[a-zA-Z0-9_-]{28,35}"/g,
    ];

    const candidateIds = new Set();
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(html)) !== null) {
        const idStr = m[1] || m[0];
        const clean = idStr.replace(/[\"\\]/g, '').replace(/-0$/, '');
        if (clean !== folderId && clean.length >= 25 && clean.length <= 40) {
          if (!clean.includes('-webkit') && !clean.includes('google') && !clean.includes('logo_') && !clean.includes('theme') && !clean.includes('__') && !clean.includes('--') && /[0-9]/.test(clean) && /[a-zA-Z]/.test(clean)) {
            candidateIds.add(clean);
          }
        }
      }
    }
    console.log('Folder:', folderId, 'Found file IDs:', candidateIds.size);
    console.log('Sample file IDs:', Array.from(candidateIds).slice(0, 5));
  }
}
check().catch(e => console.error(e.message));
