/**
 * migrate-mcp-to-ecc.mjs
 * End-to-end migration pipeline from standard MCP Memory server graph to ECC Memory architecture.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Configuration
const PROJECT_ROOT = process.cwd();
const ECC_MEMORY_DIR = path.join(PROJECT_ROOT, '.ecc', 'memory', 'project');
const TASKS_DIR = 'C:/Users/Administrator/AppData/Roaming/Code/User/globalStorage/zoocodeorganization.zoo-code/tasks';

// 1. Introspect and extract source knowledge graph
export function extractSourceGraph() {
  const entityMap = new Map();
  const relations = [];

  if (!fs.existsSync(TASKS_DIR)) {
    console.warn(`Tasks directory not found: ${TASKS_DIR}`);
    return { entities: [], relations: [] };
  }

  const taskDirs = fs.readdirSync(TASKS_DIR);
  for (const taskDir of taskDirs) {
    const uiMessagesPath = path.join(TASKS_DIR, taskDir, 'ui_messages.json');
    if (!fs.existsSync(uiMessagesPath)) continue;

    let messages = [];
    try {
      messages = JSON.parse(fs.readFileSync(uiMessagesPath, 'utf8'));
    } catch (err) {
      console.warn(`Failed to parse ${uiMessagesPath}:`, err.message);
      continue;
    }

    for (const msg of messages) {
      if (msg.type === 'ask' && msg.text && msg.text.includes('"serverName":"memory"')) {
        try {
          const toolCall = JSON.parse(msg.text);
          const args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments;

          if (toolCall.toolName === 'create_entities' && Array.isArray(args.entities)) {
            for (const ent of args.entities) {
              if (!ent.name || ent.name.startsWith('__probe')) continue;
              if (!entityMap.has(ent.name)) {
                entityMap.set(ent.name, {
                  name: ent.name,
                  entityType: ent.entityType || 'concept',
                  observations: new Set(),
                  firstSeenTs: msg.ts || Date.now(),
                  lastUpdatedTs: msg.ts || Date.now()
                });
              }
              const record = entityMap.get(ent.name);
              if (ent.entityType && ent.entityType !== 'Unknown') {
                record.entityType = ent.entityType;
              }
              if (Array.isArray(ent.observations)) {
                for (const obs of ent.observations) {
                  record.observations.add(obs.trim());
                }
              }
              if (msg.ts) {
                record.firstSeenTs = Math.min(record.firstSeenTs, msg.ts);
                record.lastUpdatedTs = Math.max(record.lastUpdatedTs, msg.ts);
              }
            }
          }

          if (toolCall.toolName === 'add_observations' && Array.isArray(args.observations)) {
            for (const item of args.observations) {
              if (!item.entityName || item.entityName.startsWith('__probe')) continue;
              if (!entityMap.has(item.entityName)) {
                entityMap.set(item.entityName, {
                  name: item.entityName,
                  entityType: 'concept',
                  observations: new Set(),
                  firstSeenTs: msg.ts || Date.now(),
                  lastUpdatedTs: msg.ts || Date.now()
                });
              }
              const record = entityMap.get(item.entityName);
              if (Array.isArray(item.contents)) {
                for (const obs of item.contents) {
                  record.observations.add(obs.trim());
                }
              }
              if (msg.ts) {
                record.lastUpdatedTs = Math.max(record.lastUpdatedTs, msg.ts);
              }
            }
          }

          if (toolCall.toolName === 'create_relations' && Array.isArray(args.relations)) {
            for (const rel of args.relations) {
              if (!rel.from || !rel.to || !rel.relationType) continue;
              relations.push({
                from: rel.from,
                to: rel.to,
                relationType: rel.relationType,
                ts: msg.ts || Date.now()
              });
            }
          }

          if (toolCall.toolName === 'delete_entities' && Array.isArray(args.entityNames)) {
            for (const name of args.entityNames) {
              entityMap.delete(name);
            }
          }
        } catch (err) {
          console.warn('Error processing tool call:', err.message);
        }
      }
    }
  }

  // Deduplicate relations
  const uniqueRelations = [];
  const relKeys = new Set();
  for (const rel of relations) {
    const key = `${rel.from}::${rel.relationType}::${rel.to}`;
    if (!relKeys.has(key)) {
      relKeys.add(key);
      uniqueRelations.push(rel);
    }
  }

  const entities = [];
  for (const [name, data] of entityMap.entries()) {
    entities.push({
      name: data.name,
      entityType: data.entityType,
      observations: Array.from(data.observations),
      firstSeenTs: data.firstSeenTs,
      lastUpdatedTs: data.lastUpdatedTs
    });
  }

  return { entities, relations: uniqueRelations };
}

// 2. Mapping helper: Map entityType to ECC kind
function mapKind(entityType) {
  const lower = (entityType || '').toLowerCase();
  switch (lower) {
    case 'decision':
      return 'decision';
    case 'fact':
      return 'fact';
    case 'runbook':
      return 'runbook';
    case 'lesson':
      return 'lesson';
    case 'preference':
      return 'preference';
    case 'handoff':
      return 'handoff';
    case 'signatureset':
    case 'structureset':
    case 'config':
    case 'service':
    case 'context':
    default:
      return 'context';
  }
}

// Map kind to folder name
function getSubdir(kind) {
  switch (kind) {
    case 'context':
      return 'contexts';
    case 'decision':
      return 'decisions';
    case 'runbook':
      return 'runbooks';
    case 'lesson':
      return 'lessons';
    case 'preference':
      return 'preferences';
    case 'handoff':
      return 'handoffs';
    case 'fact':
    case 'note':
    default:
      return 'notes';
  }
}

// Slugify helper
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

// Format YAML frontmatter
function serializeYaml(meta) {
  const lines = ['---'];
  lines.push(`schema: ${JSON.stringify(meta.schema)}`);
  lines.push(`id: ${JSON.stringify(meta.id)}`);
  lines.push(`title: ${JSON.stringify(meta.title)}`);
  lines.push(`kind: ${JSON.stringify(meta.kind)}`);
  lines.push(`scope: ${JSON.stringify(meta.scope)}`);
  lines.push(`trust: ${JSON.stringify(meta.trust)}`);
  lines.push(`status: ${JSON.stringify(meta.status)}`);
  lines.push(`source_harness: ${JSON.stringify(meta.source_harness)}`);
  lines.push(`target_harnesses: ${JSON.stringify(meta.target_harnesses)}`);
  lines.push(`tags: ${JSON.stringify(meta.tags)}`);
  lines.push(`links: ${JSON.stringify(meta.links)}`);
  lines.push(`created_at: ${JSON.stringify(meta.created_at)}`);
  lines.push(`updated_at: ${JSON.stringify(meta.updated_at)}`);
  lines.push('---');
  return lines.join('\n');
}

// 3. Execution Pipeline
export function runMigration() {
  console.log('=== Starting MCP Memory to ECC-Memory Migration ===\n');

  const { entities, relations } = extractSourceGraph();
  console.log(`Source graph extracted:`);
  console.log(`- Entities: ${entities.length}`);
  console.log(`- Relations: ${relations.length}`);
  const totalObs = entities.reduce((sum, e) => sum + e.observations.length, 0);
  console.log(`- Total observations: ${totalObs}\n`);

  // Relational integrity check on source
  const entityNames = new Set(entities.map(e => e.name));
  const validRelations = [];
  for (const rel of relations) {
    if (!entityNames.has(rel.from)) {
      console.warn(`[Orphan Edge Warning] Source entity '${rel.from}' not found in entities.`);
    } else if (!entityNames.has(rel.to)) {
      console.warn(`[Orphan Edge Warning] Target entity '${rel.to}' not found in entities.`);
    } else {
      validRelations.push(rel);
    }
  }

  // Pre-assign stable ECC memory IDs for each entity
  const entityIdMap = new Map();
  for (const ent of entities) {
    const dateStr = new Date(ent.firstSeenTs).toISOString().slice(0, 10).replace(/-/g, '');
    const hash = crypto.createHash('sha256').update(ent.name).digest('hex').slice(0, 20);
    const id = `mem_${dateStr}_${hash}`;
    entityIdMap.set(ent.name, id);
  }

  // Prepare link mappings based on relations
  const outgoingLinks = new Map();
  const incomingLinks = new Map();
  for (const ent of entities) {
    outgoingLinks.set(ent.name, []);
    incomingLinks.set(ent.name, []);
  }

  for (const rel of validRelations) {
    const targetId = entityIdMap.get(rel.to);
    outgoingLinks.get(rel.from).push({
      targetId,
      targetName: rel.to,
      relationType: rel.relationType
    });
    incomingLinks.get(rel.to).push({
      sourceId: entityIdMap.get(rel.from),
      sourceName: rel.from,
      relationType: rel.relationType
    });
  }

  // Transform and write each entity into ECC memory structure
  let migratedCount = 0;
  for (const ent of entities) {
    const id = entityIdMap.get(ent.name);
    const kind = mapKind(ent.entityType);
    const subdir = getSubdir(kind);
    const targetDir = path.join(ECC_MEMORY_DIR, subdir);
    fs.mkdirSync(targetDir, { recursive: true });

    // Target links must only contain unique valid memory IDs
    const links = Array.from(new Set(outgoingLinks.get(ent.name).map(l => l.targetId)));

    // Build tags
    const tags = [
      'migrated-mcp-memory',
      slugify(ent.entityType)
    ];

    const metadata = {
      schema: 'ecc.memory.v1',
      id,
      title: ent.name,
      kind,
      scope: 'project',
      trust: 'unreviewed',
      status: 'active',
      source_harness: 'mcp-memory',
      target_harnesses: ['roo'],
      tags,
      links,
      created_at: new Date(ent.firstSeenTs).toISOString(),
      updated_at: new Date(ent.lastUpdatedTs).toISOString()
    };

    // Body content construction
    const bodyLines = [];
    bodyLines.push(`# ${ent.name}\n`);
    bodyLines.push(`**Entity Type**: \`${ent.entityType}\`\n`);

    // Relationships section
    const outRel = outgoingLinks.get(ent.name);
    const inRel = incomingLinks.get(ent.name);
    if (outRel.length > 0 || inRel.length > 0) {
      bodyLines.push('## Relationships\n');
      for (const rel of outRel) {
        bodyLines.push(`- **${rel.relationType}** -> [[${rel.targetId}]] (${rel.targetName})`);
      }
      for (const rel of inRel) {
        bodyLines.push(`- ^- **${rel.relationType}** from [[${rel.sourceId}]] (${rel.sourceName})`);
      }
      bodyLines.push('');
    }

    // Observations section
    bodyLines.push('## Observations\n');
    for (const obs of ent.observations) {
      bodyLines.push(`- ${obs}`);
    }
    bodyLines.push('');

    const fullContent = `${serializeYaml(metadata)}\n\n${bodyLines.join('\n')}\n`;
    const filePath = path.join(targetDir, `${id}.md`);
    fs.writeFileSync(filePath, fullContent, 'utf8');
    migratedCount++;
    console.log(`[Migrated] ${ent.name} (${ent.entityType}) -> ${path.relative(PROJECT_ROOT, filePath)} [${id}]`);
  }

  console.log(`\nMigration completed successfully: ${migratedCount} memory items generated.`);
  return {
    entitiesCount: entities.length,
    relationsCount: validRelations.length,
    observationsCount: totalObs,
    entityIdMap
  };
}

if (process.argv[1] && process.argv[1].endsWith('migrate-mcp-to-ecc.mjs')) {
  runMigration();
}
