/**
 * verify-migration.mjs
 * Parity, relational integrity, and search retrieval tests for migrated ECC memory.
 */

import fs from 'fs';
import path from 'path';
import { extractSourceGraph } from './migrate-mcp-to-ecc.mjs';
import vaultPkg from './lib/memory-vault.js';

const {
  doctorMemoryVault,
  readMemoryFiles,
  readMemoryById,
  searchMemories
} = vaultPkg;

const PROJECT_ROOT = process.cwd();

async function runTests() {
  console.log('=== Running Automated Parity & Verification Suite ===\n');

  // 1. Extract source graph baseline
  const source = extractSourceGraph();
  console.log(`Source Graph Baseline:`);
  console.log(`- Entities: ${source.entities.length}`);
  console.log(`- Relations: ${source.relations.length}`);
  const sourceObsCount = source.entities.reduce((sum, e) => sum + e.observations.length, 0);
  console.log(`- Observations: ${sourceObsCount}\n`);

  // 2. Doctor Audit
  const audit = doctorMemoryVault({
    projectDir: PROJECT_ROOT,
    scopes: ['project']
  });
  console.log(`ECC Doctor Audit Results:`);
  console.log(JSON.stringify(audit, null, 2));

  let passed = true;
  if (!audit.ok || audit.invalidFileCount > 0 || audit.duplicateIdCount > 0 || audit.brokenLinkCount > 0) {
    console.error('❌ DOCTOR AUDIT FAILED!');
    passed = false;
  } else {
    console.log('✅ Doctor audit passed: 0 invalid files, 0 duplicates, 0 broken links.\n');
  }

  // 3. Parity Verification
  console.log('Verifying Parity:');
  const readRes = readMemoryFiles({
    projectDir: PROJECT_ROOT,
    scopes: ['project']
  });
  const records = readRes.entries.map(e => e.memory);
  console.log(`- Stored ECC memories count: ${records.length}`);

  if (records.length !== source.entities.length) {
    console.error(`❌ Count mismatch: expected ${source.entities.length}, got ${records.length}`);
    passed = false;
  } else {
    console.log(`✅ Entity count parity confirmed: ${records.length}/${source.entities.length}`);
  }

  // Check that every source entity exists by title
  let totalMigratedObs = 0;
  for (const ent of source.entities) {
    const memRec = records.find(r => r && r.title === ent.name);
    if (!memRec) {
      console.error(`❌ Missing memory for entity: '${ent.name}'`);
      passed = false;
      continue;
    }

    // Read full memory content
    const full = readMemoryById(memRec.id, {
      projectDir: PROJECT_ROOT,
      scope: 'project'
    });
    if (!full) {
      console.error(`❌ Failed to read memory: ${memRec.id}`);
      passed = false;
      continue;
    }

    // Verify observations are present in body
    let foundObs = 0;
    const body = full.memory.body || '';
    for (const obs of ent.observations) {
      if (body.includes(obs)) {
        foundObs++;
        totalMigratedObs++;
      } else {
        console.warn(`⚠️ Observation missing in body: "${obs.slice(0, 40)}..."`);
        passed = false;
      }
    }
    console.log(`  - [Entity '${ent.name}'] ${foundObs}/${ent.observations.length} observations intact.`);
  }

  console.log(`Total observations parity: ${totalMigratedObs}/${sourceObsCount}`);
  if (totalMigratedObs === sourceObsCount) {
    console.log('✅ All observations fully preserved.\n');
  } else {
    console.error('❌ Observation count mismatch!');
    passed = false;
  }

  // 4. Relational Integrity & Backlinks Verification
  console.log('Verifying Relational Integrity & Backlinks:');
  for (const rel of source.relations) {
    const sourceRec = records.find(r => r && r.title === rel.from);
    const targetRec = records.find(r => r && r.title === rel.to);
    if (!sourceRec || !targetRec) {
      console.error(`❌ Relational endpoint missing: ${rel.from} -> ${rel.to}`);
      passed = false;
      continue;
    }
// Check forward link
if (!sourceRec.links.includes(targetRec.id)) {
  console.error(`❌ Missing forward link from ${sourceRec.id} to ${targetRec.id}`);
  passed = false;
} else {
  console.log(`  - Forward link confirmed: '${rel.from}' -> '${rel.to}' (${rel.relationType})`);
}

// Check derived backlink via readMemoryById
    const targetDetail = readMemoryById(targetRec.id, {
      projectDir: PROJECT_ROOT,
      scope: 'project'
    });
    const backlinkIds = (targetDetail.backlinks || []).map(b => (typeof b === 'string' ? b : b.id));
    if (!backlinkIds.includes(sourceRec.id)) {
      console.error(`❌ Derived backlink missing on ${targetRec.id} from ${sourceRec.id}`);
      passed = false;
    } else {
      console.log(`  - Derived backlink confirmed: '${rel.to}' <- '${rel.from}'`);
    }
}
  console.log('✅ Relational integrity & backlink verification complete.\n');

  // 5. Search & Retrieval Validation Tests
  console.log('Verifying Search & Retrieval:');
  const testQueries = [
    'BF6',
    'GameContext',
    'SigScanner',
    'Orpheus',
    'mcp_bridge'
  ];

  for (const q of testQueries) {
    const res = searchMemories(q, { projectDir: PROJECT_ROOT, scopes: ['project'], limit: 10 });
    console.log(`  - Query '${q}': returned ${res.results.length} hit(s)`);
    if (res.results.length === 0) {
      console.error(`❌ Search query '${q}' returned no results!`);
      passed = false;
    }
  }

  if (passed) {
    console.log('\n🎉 ALL MIGRATION & PARITY TESTS PASSED SUCCESSFULLY! 🎉');
    process.exit(0);
  } else {
    console.error('\n❌ SOME VERIFICATION CHECKS FAILED.');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
