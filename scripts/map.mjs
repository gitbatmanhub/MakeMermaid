#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';

const args = readArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.source ?? 'src');
const outFile = path.resolve(args.out ?? 'public/code-map.json');

if (!existsSync(sourceDir)) {
  console.error(`No existe el directorio fuente: ${sourceDir}`);
  process.exit(1);
}

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    allowJs: false,
    experimentalDecorators: true
  }
});

project.addSourceFilesAtPaths([
  path.join(sourceDir, '**/*.ts').replaceAll('\\', '/'),
  `!${path.join(sourceDir, '**/*.spec.ts').replaceAll('\\', '/')}`,
  `!${path.join(sourceDir, '**/*.d.ts').replaceAll('\\', '/')}`
]);

const sourceFiles = project.getSourceFiles();
const nodes = new Map();
const edges = new Map();
const classIndex = new Map();

for (const sourceFile of sourceFiles) {
  for (const classDeclaration of sourceFile.getClasses()) {
    const name = classDeclaration.getName();
    if (!name) continue;

    const node = buildClassNode(classDeclaration, sourceFile, sourceDir);
    nodes.set(node.id, node);
    classIndex.set(name, node);
  }
}

for (const sourceFile of sourceFiles) {
  for (const classDeclaration of sourceFile.getClasses()) {
    const from = classIndex.get(classDeclaration.getName() ?? '');
    if (!from) continue;

    addImportEdges(sourceFile, from, classIndex, edges);
    addConstructorEdges(classDeclaration, from, classIndex, edges);
    addControllerDtoEdges(classDeclaration, from, classIndex, edges);
    addMethodCallEdges(classDeclaration, from, classIndex, edges);
  }
}

const graph = {
  generatedAt: new Date().toISOString(),
  source: sourceDir,
  summary: summarize([...nodes.values()], [...edges.values()]),
  nodes: [...nodes.values()].sort((a, b) => a.label.localeCompare(b.label)),
  edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
};

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

console.log(`Mapa generado: ${outFile}`);
console.log(`${graph.nodes.length} nodos, ${graph.edges.length} relaciones`);

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

function buildClassNode(classDeclaration, sourceFile, rootDir) {
  const name = classDeclaration.getName();
  const decorators = classDeclaration.getDecorators().map((decorator) => decorator.getName());
  const file = path.relative(rootDir, sourceFile.getFilePath()).replaceAll('\\', '/');
  const kind = getClassKind(name, file, decorators);
  const methods = classDeclaration.getMethods().map((method) => ({
    name: method.getName(),
    route: getNestRoute(method),
    parameters: method.getParameters().map((parameter) => ({
      name: parameter.getName(),
      type: cleanType(parameter.getTypeNode()?.getText() ?? parameter.getType().getText())
    })),
    returns: cleanType(method.getReturnTypeNode()?.getText() ?? method.getReturnType().getText())
  }));

  return {
    id: `class:${name}`,
    label: name,
    kind,
    file,
    decorators,
    methods
  };
}

function getClassKind(name, file, decorators) {
  if (decorators.includes('Controller')) return 'controller';
  if (decorators.includes('Module')) return 'module';
  if (decorators.includes('Entity')) return 'entity';
  if (decorators.includes('Injectable')) return 'service';
  if (/dto/i.test(name) || /\/dto(s)?\//i.test(file)) return 'dto';
  if (/service/i.test(name)) return 'service';
  return 'class';
}

function addImportEdges(sourceFile, from, classIndex, edges) {
  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    for (const namedImport of importDeclaration.getNamedImports()) {
      const target = classIndex.get(namedImport.getName());
      if (!target || target.id === from.id) continue;
      addEdge(edges, from.id, target.id, 'imports', 'importa');
    }
  }
}

function addConstructorEdges(classDeclaration, from, classIndex, edges) {
  const constructorDeclaration = classDeclaration.getConstructors()[0];
  if (!constructorDeclaration) return;

  for (const parameter of constructorDeclaration.getParameters()) {
    const target = classIndex.get(getTypeName(parameter));
    if (!target || target.id === from.id) continue;
    addEdge(edges, from.id, target.id, 'injects', `inyecta ${parameter.getName()}`);
  }
}

function addControllerDtoEdges(classDeclaration, from, classIndex, edges) {
  if (from.kind !== 'controller') return;

  for (const method of classDeclaration.getMethods()) {
    for (const parameter of method.getParameters()) {
      const typeName = getTypeName(parameter);
      const target = classIndex.get(typeName);
      if (!target || target.id === from.id || target.kind !== 'dto') continue;
      const route = getNestRoute(method);
      addEdge(edges, from.id, target.id, 'receives-dto', route ? `recibe ${typeName} en ${route}` : `recibe ${typeName}`);
    }
  }
}

function addMethodCallEdges(classDeclaration, from, classIndex, edges) {
  const constructorDeclaration = classDeclaration.getConstructors()[0];
  const injectedProperties = new Map();

  if (constructorDeclaration) {
    for (const parameter of constructorDeclaration.getParameters()) {
      const target = classIndex.get(getTypeName(parameter));
      if (target) injectedProperties.set(parameter.getName(), target);
    }
  }

  for (const method of classDeclaration.getMethods()) {
    for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;

      const targetExpression = expression.getExpression();
      if (!Node.isPropertyAccessExpression(targetExpression)) continue;
      if (targetExpression.getExpression().getText() !== 'this') continue;

      const target = injectedProperties.get(targetExpression.getName());
      if (!target) continue;
      addEdge(edges, from.id, target.id, 'calls', `${method.getName()} llama ${targetExpression.getName()}.${expression.getName()}()`);
    }
  }
}

function getTypeName(parameter) {
  const typeText = parameter.getTypeNode()?.getText() ?? parameter.getType().getText();
  return cleanType(typeText).replace(/\[\]$/, '');
}

function getNestRoute(method) {
  const httpDecorators = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);
  const decorator = method.getDecorators().find((item) => httpDecorators.has(item.getName()));
  if (!decorator) return null;

  const arg = decorator.getCallExpression()?.getArguments()[0]?.getText().replace(/^['"`]|['"`]$/g, '') ?? '';
  return `${decorator.getName().toUpperCase()} ${arg || '/'}`;
}

function addEdge(edges, from, to, kind, label) {
  const id = `${from}->${to}:${kind}:${label}`;
  edges.set(id, { id, from, to, kind, label });
}

function cleanType(typeText) {
  return typeText
    .replace(/^import\(.+?\)\./, '')
    .replace(/Promise<(.+)>/, '$1')
    .replace(/Readonly<(.+)>/, '$1')
    .trim();
}

function summarize(graphNodes, graphEdges) {
  const byKind = {};
  const byEdgeKind = {};
  for (const node of graphNodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  for (const edge of graphEdges) byEdgeKind[edge.kind] = (byEdgeKind[edge.kind] ?? 0) + 1;
  return {
    totalNodes: graphNodes.length,
    totalEdges: graphEdges.length,
    byKind,
    byEdgeKind
  };
}
