#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = readArgs(process.argv.slice(2));
const inputFile = path.resolve(args.input ?? 'public/code-map.json');
const outFile = path.resolve(args.out ?? 'public/code-map.mmd');
const mode = args.mode === 'all' ? 'all' : 'focus';
const focus = args.focus ?? '';
const maxNodes = Number.parseInt(args.maxNodes ?? '42', 10);
const includeMigrations = args.includeMigrations === true
  || args.includeMigrations === 'true'
  || args['include-migrations'] === true
  || args['include-migrations'] === 'true';
const graph = filterMigrations(JSON.parse(readFileSync(inputFile, 'utf8')), includeMigrations);
const mermaid = mode === 'all' ? createFullMermaid(graph, maxNodes) : createFocusMermaid(graph, focus, maxNodes);

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, `${mermaid}\n`, 'utf8');

console.log(`Mermaid generado: ${outFile}`);

function readArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    if (!value.startsWith('--')) continue;

    const key = value.slice(2);
    const next = rawArgs[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function createFocusMermaid(graph, selectedNodeId, limit) {
  const selected = graph.nodes.find((node) => node.id === selectedNodeId || node.label === selectedNodeId) ?? graph.nodes[0];
  if (!selected) return 'flowchart LR';

  const relatedEdges = graph.edges.filter((edge) => edge.from === selected.id || edge.to === selected.id);
  const nodeIds = new Set([selected.id]);
  const edges = [];

  for (const edge of relatedEdges) {
    const additions = [edge.from, edge.to].filter((id) => !nodeIds.has(id));
    if (nodeIds.size + additions.length > limit) continue;
    nodeIds.add(edge.from);
    nodeIds.add(edge.to);
    edges.push(edge);
  }

  return createMermaid(graph, nodeIds, edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)));
}

function createFullMermaid(graph, limit) {
  const nodeIds = new Set(graph.nodes.slice(0, limit).map((node) => node.id));
  return createMermaid(graph, nodeIds, graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)));
}

function createMermaid(graph, nodeIds, edges) {
  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
  const mermaidIds = new Map(nodes.map((node, index) => [node.id, safeId(node.id, index)]));
  const lines = [
    'flowchart LR',
    `%% Source: ${graph.source}`,
    `%% Generated: ${graph.generatedAt}`,
    ''
  ];

  for (const node of nodes) lines.push(`    ${mermaidIds.get(node.id)}${shapeForNode(node)}`);
  if (edges.length) lines.push('');
  for (const edge of edges) lines.push(`    ${mermaidIds.get(edge.from)} -->|"${escapeLabel(edge.label || edge.kind)}"| ${mermaidIds.get(edge.to)}`);

  lines.push('', ...createClassStyles(nodes, mermaidIds));
  return lines.join('\n');
}

function shapeForNode(node) {
  const label = `${node.label}\n${node.kind}\n${node.file}`;
  const escaped = escapeLabel(label);
  if (node.kind === 'controller') return `(["${escaped}"])`;
  if (node.kind === 'dto') return `{{"${escaped}"}}`;
  if (node.kind === 'module') return `("${escaped}")`;
  if (node.kind === 'entity') return `[("${escaped}")]`;
  return `["${escaped}"]`;
}

function createClassStyles(nodes, mermaidIds) {
  const kinds = [...new Set(nodes.map((node) => node.kind))];
  const lines = [
    '    classDef controller fill:#e8f1ff,stroke:#2563eb,color:#1d2433',
    '    classDef service fill:#e7f6f4,stroke:#0f766e,color:#1d2433',
    '    classDef dto fill:#fff4df,stroke:#b45309,color:#1d2433',
    '    classDef module fill:#f0eaff,stroke:#7c3aed,color:#1d2433',
    '    classDef entity fill:#e9f8ee,stroke:#15803d,color:#1d2433',
    '    classDef migration fill:#fff1e8,stroke:#c2410c,color:#1d2433',
    '    classDef codeClass fill:#f1f4f8,stroke:#667085,color:#1d2433'
  ];

  const styleIds = {
    controller: 'controller',
    service: 'service',
    dto: 'dto',
    module: 'module',
    entity: 'entity',
    migration: 'migration',
    class: 'codeClass'
  };

  for (const kind of kinds) {
    const ids = nodes.filter((node) => node.kind === kind).map((node) => mermaidIds.get(node.id));
    if (ids.length && styleIds[kind]) lines.push(`    class ${ids.join(',')} ${styleIds[kind]}`);
  }

  return lines;
}

function filterMigrations(graph, includeMigrations) {
  if (includeMigrations) return graph;

  const nodes = graph.nodes.filter((node) => !isMigration(node));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  };
}

function isMigration(node) {
  return node.kind === 'migration'
    || /(^|\/)migrations?(\/|$)/i.test(node.file ?? '')
    || /\.migration\.ts$/i.test(node.file ?? '');
}

function safeId(id, index) {
  return `n${index}_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function escapeLabel(value) {
  return String(value).replace(/"/g, '#quot;').replace(/\|/g, '/').replace(/\n/g, '<br/>');
}
