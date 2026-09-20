import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface CodeMapNode {
  id: string;
  label: string;
  kind: string;
  file: string;
}

interface CodeMapEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  label: string;
}

interface CodeMap {
  generatedAt: string;
  source: string;
  summary: {
    totalNodes: number;
    totalEdges: number;
    byKind: Record<string, number>;
    byEdgeKind: Record<string, number>;
  };
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
}

const KIND_LABELS: Record<string, string> = {
  controller: 'Controllers',
  service: 'Services',
  dto: 'DTOs',
  module: 'Modules',
  entity: 'Entities',
  migration: 'Migraciones',
  class: 'Classes'
};

const KIND_STYLE_IDS: Record<string, string> = {
  controller: 'controller',
  service: 'service',
  dto: 'dto',
  module: 'module',
  entity: 'entity',
  migration: 'migration',
  class: 'codeClass'
};

@Component({
  selector: 'app-code-map-importer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './code-map-importer.component.html',
  styleUrl: './code-map-importer.component.css'
})
export class CodeMapImporterComponent {
  @Output() readonly mermaidGenerated = new EventEmitter<{ source: string; fileName: string }>();

  readonly graph = signal<CodeMap | null>(null);
  readonly fileName = signal('');
  readonly selectedNodeId = signal('');
  readonly mode = signal<'focus' | 'all'>('all');
  readonly maxNodes = signal(1);
  readonly includeMigrations = signal(false);
  readonly errorMessage = signal('');

  readonly kindLabels = KIND_LABELS;
  readonly nodeOptions = computed(() => this.graph()?.nodes
    .filter((node) => this.includeMigrations() || !this.isMigration(node))
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label)) ?? []);
  readonly selectedNode = computed(() => this.nodeOptions().find((node) => node.id === this.selectedNodeId()) ?? null);
  readonly renderNodeCount = computed(() => Math.min(this.maxNodes(), this.nodeOptions().length));
  readonly summaryItems = computed(() => {
    const graph = this.graph();
    if (!graph) return [];

    return Object.entries(graph.summary.byKind)
      .filter(([, total]) => total > 0)
      .map(([kind, total]) => ({ kind, total, label: KIND_LABELS[kind] ?? kind }));
  });

  async handleJsonSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    try {
      const graph = this.parseGraph(JSON.parse(await file.text()));
      this.graph.set(graph);
      this.fileName.set(file.name);
      this.mode.set('all');
      this.selectedNodeId.set(graph.nodes.find((node) => !this.isMigration(node))?.id ?? graph.nodes[0]?.id ?? '');
      this.maxNodes.set(Math.max(1, graph.nodes.filter((node) => !this.isMigration(node)).length));
      this.errorMessage.set('');
    } catch (error) {
      this.graph.set(null);
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo leer el JSON.');
    }
  }

  generateMermaid(): void {
    const graph = this.graph();
    if (!graph) return;

    const filteredGraph = this.filterMigrations(graph);
    const limit = this.clampMaxNodes(this.maxNodes());
    this.maxNodes.set(limit);
    const source = this.mode() === 'focus'
      ? this.createFocusMermaid(filteredGraph, this.selectedNodeId(), limit)
      : this.createFullMermaid(filteredGraph, limit);

    const baseName = this.fileName().replace(/\.[^.]+$/, '') || 'code-map';
    this.mermaidGenerated.emit({ source, fileName: `${baseName}.mmd` });
  }

  setMaxNodes(value: number): void {
    this.maxNodes.set(this.clampMaxNodes(value));
  }

  setMode(value: 'focus' | 'all'): void {
    this.mode.set(value);
    if (value === 'all') this.maxNodes.set(Math.max(1, this.nodeOptions().length));
  }

  setIncludeMigrations(value: boolean): void {
    this.includeMigrations.set(value);
    this.maxNodes.set(Math.max(1, this.nodeOptions().length));
    if (!this.nodeOptions().some((node) => node.id === this.selectedNodeId())) {
      this.selectedNodeId.set(this.nodeOptions()[0]?.id ?? '');
    }
  }

  private createFocusMermaid(graph: CodeMap, selectedNodeId: string, maxNodes: number): string {
    const selected = graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes[0];
    if (!selected) return 'flowchart LR';

    const relatedEdges = graph.edges.filter((edge) => edge.from === selected.id || edge.to === selected.id);
    const nodeIds = new Set([selected.id]);
    const edges: CodeMapEdge[] = [];

    for (const edge of relatedEdges) {
      const additions = [edge.from, edge.to].filter((id) => !nodeIds.has(id));
      if (nodeIds.size + additions.length > maxNodes) continue;
      nodeIds.add(edge.from);
      nodeIds.add(edge.to);
      edges.push(edge);
    }

    return this.createMermaid(graph, nodeIds, edges);
  }

  private createFullMermaid(graph: CodeMap, maxNodes: number): string {
    const nodeIds = new Set(graph.nodes.slice(0, maxNodes).map((node) => node.id));
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    return this.createMermaid(graph, nodeIds, edges);
  }

  private createMermaid(graph: CodeMap, nodeIds: Set<string>, edges: CodeMapEdge[]): string {
    const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
    const renderedEdges = this.collapseEdges(edges);
    const mermaidIds = new Map(nodes.map((node, index) => [node.id, this.safeId(node.id, index)]));
    const lines = [
      'flowchart LR',
      `%% Source: ${graph.source}`,
      `%% Generated: ${graph.generatedAt}`,
      ''
    ];

    for (const node of nodes) {
      lines.push(`    ${mermaidIds.get(node.id)}${this.shapeForNode(node)}`);
    }

    if (renderedEdges.length) lines.push('');

    for (const edge of renderedEdges) {
      lines.push(`    ${mermaidIds.get(edge.from)} -->|"${this.escapeLabel(edge.label || edge.kind)}"| ${mermaidIds.get(edge.to)}`);
    }

    lines.push('', ...this.createClassStyles(nodes, mermaidIds));
    return lines.join('\n');
  }

  private collapseEdges(edges: CodeMapEdge[]): CodeMapEdge[] {
    const groups = new Map<string, CodeMapEdge[]>();

    for (const edge of edges) {
      const key = `${edge.from}\u0000${edge.to}`;
      groups.set(key, [...(groups.get(key) ?? []), edge]);
    }

    return [...groups.values()].map((group) => ({
      id: `group:${group[0].from}->${group[0].to}`,
      from: group[0].from,
      to: group[0].to,
      kind: 'grouped',
      label: this.formatEdgeDetails(group)
    }));
  }

  private formatEdgeDetails(edges: CodeMapEdge[]): string {
    const priorities: Record<string, number> = {
      imports: 0,
      injects: 1,
      calls: 2,
      'receives-dto': 3
    };
    const orderedLabels = edges
      .slice()
      .sort((a, b) => (priorities[a.kind] ?? 4) - (priorities[b.kind] ?? 4) || a.label.localeCompare(b.label))
      .map((edge) => edge.label || edge.kind);

    return [...new Set(orderedLabels)].join('<br/>');
  }

  private shapeForNode(node: CodeMapNode): string {
    const label = `${node.label}\n${node.kind}\n${node.file}`;
    const escaped = this.escapeLabel(label);

    if (node.kind === 'controller') return `(["${escaped}"])`;
    if (node.kind === 'dto') return `{{"${escaped}"}}`;
    if (node.kind === 'module') return `("${escaped}")`;
    if (node.kind === 'entity') return `[("${escaped}")]`;
    return `["${escaped}"]`;
  }

  private createClassStyles(nodes: CodeMapNode[], mermaidIds: Map<string, string>): string[] {
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

    for (const kind of kinds) {
      const ids = nodes.filter((node) => node.kind === kind).map((node) => mermaidIds.get(node.id));
      const styleId = KIND_STYLE_IDS[kind];
      if (ids.length && styleId) lines.push(`    class ${ids.join(',')} ${styleId}`);
    }

    return lines;
  }

  private parseGraph(value: unknown): CodeMap {
    if (!value || typeof value !== 'object') {
      throw new Error('El archivo no parece ser un code-map.json válido.');
    }

    const raw = value as Partial<CodeMap>;
    if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
      throw new Error('El archivo debe contener arreglos nodes y edges.');
    }

    const nodes = raw.nodes.map((node, index) => {
      if (!node || typeof node.id !== 'string' || !node.id.trim()) {
        throw new Error(`El nodo ${index + 1} no tiene un id válido.`);
      }

      return {
        id: node.id,
        label: typeof node.label === 'string' && node.label ? node.label : node.id,
        kind: typeof node.kind === 'string' && node.kind ? node.kind : 'class',
        file: typeof node.file === 'string' ? node.file : ''
      };
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (nodeIds.size !== nodes.length) throw new Error('El mapa contiene ids de nodos duplicados.');

    const edges = raw.edges.map((edge, index) => {
      if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
        throw new Error(`La relación ${index + 1} no tiene origen y destino válidos.`);
      }
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        throw new Error(`La relación ${index + 1} apunta a un nodo inexistente.`);
      }

      const kind = typeof edge.kind === 'string' && edge.kind ? edge.kind : 'relates';
      return {
        id: typeof edge.id === 'string' && edge.id ? edge.id : `${edge.from}->${edge.to}:${index}`,
        from: edge.from,
        to: edge.to,
        kind,
        label: typeof edge.label === 'string' ? edge.label : kind
      };
    });

    const byKind: Record<string, number> = {};
    const byEdgeKind: Record<string, number> = {};
    for (const node of nodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    for (const edge of edges) byEdgeKind[edge.kind] = (byEdgeKind[edge.kind] ?? 0) + 1;

    return {
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      source: typeof raw.source === 'string' ? raw.source : 'Proyecto externo',
      summary: { totalNodes: nodes.length, totalEdges: edges.length, byKind, byEdgeKind },
      nodes,
      edges
    };
  }

  private clampMaxNodes(value: number): number {
    const availableNodes = Math.max(1, this.nodeOptions().length);
    return Math.min(availableNodes, Math.max(1, Number.isFinite(value) ? Math.round(value) : availableNodes));
  }

  private filterMigrations(graph: CodeMap): CodeMap {
    if (this.includeMigrations()) return graph;

    const nodes = graph.nodes.filter((node) => !this.isMigration(node));
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      ...graph,
      nodes,
      edges: graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    };
  }

  private isMigration(node: CodeMapNode): boolean {
    return node.kind === 'migration'
      || /(^|\/)migrations?(\/|$)/i.test(node.file)
      || /\.migration\.ts$/i.test(node.file);
  }

  private safeId(id: string, index: number): string {
    return `n${index}_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  private escapeLabel(value: string): string {
    return value.replace(/"/g, '#quot;').replace(/\|/g, '/').replace(/\n/g, '<br/>');
  }
}
