
/**
 * ClerkAI — KV Case Ingest Script
 * 
 * Reads all JSON files from knowledge/cases/
 * Writes to Cloudflare KV in the format the Worker expects:
 *   case:{caseId}         → individual case JSON
 *   cases:{discipline}    → array of all cases for that discipline
 * 
 * Usage: node scripts/ingest-cases.js
 * 
 * Required env vars:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *   KV_NAMESPACE_ID  (the id of CASES_KV from wrangler.toml)
 */

const fs   = require('fs');
const path = require('path');

const API_TOKEN     = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID    = process.env.CLOUDFLARE_ACCOUNT_ID;
const KV_NAMESPACE  = process.env.KV_NAMESPACE_ID || 'cdea5b79bd5d40f68392b9218db77e17'; // CASES_KV id from wrangler.toml

if (!API_TOKEN)  { console.error('Missing CLOUDFLARE_API_TOKEN'); process.exit(1); }
if (!ACCOUNT_ID) { console.error('Missing CLOUDFLARE_ACCOUNT_ID'); process.exit(1); }

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE}`;

const headers = {
  'Authorization': `Bearer ${API_TOKEN}`,
  'Content-Type':  'application/json',
};

// ── Write a single KV entry ────────────────────────────────────
async function kvPut(key, value) {
  const resp = await fetch(`${BASE_URL}/values/${encodeURIComponent(key)}`, {
    method:  'PUT',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'text/plain' },
    body:    typeof value === 'string' ? value : JSON.stringify(value),
  });
  const data = await resp.json();
  if (!data.success) throw new Error(`KV write failed for ${key}: ${JSON.stringify(data.errors)}`);
  return data;
}

// ── Load all cases from knowledge/cases/ ──────────────────────
function loadAllCases() {
  const casesDir = path.join(process.cwd(), 'knowledge', 'cases');

  if (!fs.existsSync(casesDir)) {
    console.error(`Cases directory not found: ${casesDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(casesDir).filter(f => f.endsWith('.json'));
  console.log(`Found ${files.length} case file(s) in ${casesDir}`);

  const allCases = [];

  for (const file of files) {
    const filePath = path.join(casesDir, file);
    const raw      = fs.readFileSync(filePath, 'utf-8');
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`Failed to parse ${file}:`, e.message);
      continue;
    }

    // Support both { cases: [...] } and [...] formats
    const cases = Array.isArray(parsed) ? parsed : parsed.cases ?? [];
    console.log(`  ${file}: ${cases.length} cases`);
    allCases.push(...cases);
  }

  return allCases;
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const allCases = loadAllCases();

  if (allCases.length === 0) {
    console.error('No cases found — check your knowledge/cases/ directory');
    process.exit(1);
  }

  // Group by discipline
  const byDiscipline = {};
  for (const c of allCases) {
    const disc = c.discipline || 'general';
    if (!byDiscipline[disc]) byDiscipline[disc] = [];
    byDiscipline[disc].push(c);
  }

  console.log(`\nIngesting ${allCases.length} cases across ${Object.keys(byDiscipline).length} discipline(s)...`);

  let written = 0;

  // Write individual cases: case:{caseId}
  for (const c of allCases) {
    const key = `case:${c.caseId}`;
    try {
      await kvPut(key, c);
      console.log(`  ✓ ${key}`);
      written++;
    } catch (e) {
      console.error(`  ✗ ${key}: ${e.message}`);
    }
  }

  // Write discipline lists: cases:{discipline}
  for (const [discipline, cases] of Object.entries(byDiscipline)) {
    const key = `cases:${discipline}`;
    try {
      await kvPut(key, cases);
      console.log(`  ✓ ${key} (${cases.length} cases)`);
      written++;
    } catch (e) {
      console.error(`  ✗ ${key}: ${e.message}`);
    }
  }

  console.log(`\nDone — ${written} KV entries written`);
}

main().catch(e => {
  console.error('Ingest failed:', e);
  process.exit(1);
});
