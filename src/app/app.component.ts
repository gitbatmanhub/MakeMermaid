import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, signal } from '@angular/core';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, StringStream, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import mermaid from 'mermaid';

type RenderStatus = 'rendering' | 'ready' | 'error';
type ErConnectorStyle = 'gentle' | 'curved' | 'straight' | 'orthogonal';
type ErRelationship = { source: string; target: string };

const STARTER_DIAGRAM = `flowchart LR
    Idea["Idea"] --> Editar["Editar en Angular"]
    Editar --> Mermaid["Renderizar con Mermaid"]
    Mermaid --> Revisar{"¿Todo correcto?"}
    Revisar -->|Sí| Guardar["Guardar archivo .mmd"]
    Revisar -->|No| Editar`;

const mermaidLanguage = StreamLanguage.define({
  token(stream: StringStream): string | null {
    if (stream.match(/%%.*/)) return 'comment';
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/\b(?:flowchart|graph|subgraph|end|direction|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|quadrantChart|xychart-beta|block-beta|architecture-beta)\b/)) return 'keyword';
    if (stream.match(/(?:-->|---|-.->|==>|~~~|--o|--x|<-->|<--|<->)/)) return 'operator';
    if (stream.match(/\|[^|]*\|/)) return 'labelName';
    if (stream.match(/[\[\]{}()]/)) return 'bracket';
    if (stream.match(/\b[A-Za-z_][\w-]*(?=\s*[\[({])/)) return 'typeName';
    if (stream.match(/\b(?:TB|TD|BT|RL|LR)\b/)) return 'atom';
    stream.next();
    return null;
  }
});

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagram') private diagramElement!: ElementRef<HTMLElement>;
  @ViewChild('editorHost') private editorHost!: ElementRef<HTMLElement>;
  @ViewChild('fileInput') private fileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('previewCanvas') private previewCanvas!: ElementRef<HTMLElement>;
  @ViewChild('workspace') private workspace!: ElementRef<HTMLElement>;

  readonly source = signal(this.readStoredValue('make-mermaid.source', STARTER_DIAGRAM));
  readonly fileName = signal(this.readStoredValue('make-mermaid.filename', 'diagrama.mmd'));
  readonly status = signal<RenderStatus>('rendering');
  readonly errorMessage = signal('');
  readonly zoom = signal(1);
  readonly panX = signal(0);
  readonly panY = signal(0);
  readonly darkMode = signal(this.readInitialTheme());
  readonly isDirty = signal(false);
  readonly editorWidth = signal(this.readStoredNumber('make-mermaid.editor-width', 44));
  readonly diagramWidth = signal(1);
  readonly diagramHeight = signal(1);
  readonly lineCount = computed(() => this.source().split(/\r\n|\r|\n/).length);
  readonly zoomLabel = computed(() => `${Math.round(this.zoom() * 100)}%`);
  readonly isErDiagram = computed(() => /^\s*erDiagram\b/im.test(this.source()));
  readonly erEntities = computed(() => this.extractErEntities(this.source()));
  readonly selectedErEntity = signal('');
  readonly activeErEntity = computed(() => this.selectedErEntity() || this.erEntities()[0] || '');
  readonly selectedErColor = computed(() => this.readEntityColor(this.source(), this.activeErEntity()));
  readonly erConnectorStyle = signal<ErConnectorStyle>(this.readConnectorStyle());
  readonly erConnectorColor = signal(this.readStoredValue('make-mermaid.er-connector-color', '#52736d'));

  private readonly editorTheme = new Compartment();
  private editorView?: EditorView;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private renderGeneration = 0;
  private renderedSvg = '';
  private isResizing = false;
  private isPanning = false;
  private panStart = { x: 0, y: 0, panX: 0, panY: 0 };
  private isReplacingEditorContent = false;
  private hasFittedInitialDiagram = false;

  ngAfterViewInit(): void {
    this.createEditor();
    this.configureMermaid();
    this.queueRender(0);
  }

  ngOnDestroy(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.editorView?.destroy();
  }

  onFileNameInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.fileName.set(value);
    this.isDirty.set(true);
    localStorage.setItem('make-mermaid.filename', value);
  }

  newDocument(): void {
    if (this.isDirty() && !window.confirm('Hay cambios sin guardar. ¿Crear un diagrama nuevo?')) return;

    this.setDocument(STARTER_DIAGRAM, 'diagrama.mmd');
  }

  openDocument(): void {
    this.fileInput.nativeElement.click();
  }

  async handleFileSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.setDocument(await file.text(), file.name);
  }

  saveDocument(): void {
    const name = this.ensureExtension(this.fileName().trim() || 'diagrama', '.mmd');
    this.fileName.set(name);
    this.download(new Blob([this.source()], { type: 'text/plain;charset=utf-8' }), name);
    this.isDirty.set(false);
    this.persistDocument();
  }

  exportSvg(): void {
    if (!this.renderedSvg || this.status() !== 'ready') return;

    const baseName = this.fileName().replace(/\.[^.]+$/, '') || 'diagrama';
    this.download(new Blob([this.renderedSvg], { type: 'image/svg+xml;charset=utf-8' }), `${baseName}.svg`);
  }

  toggleTheme(): void {
    this.darkMode.update(value => !value);
    localStorage.setItem('make-mermaid.theme', this.darkMode() ? 'dark' : 'light');
    this.editorView?.dispatch({ effects: this.editorTheme.reconfigure(this.createEditorTheme()) });
    this.configureMermaid();
    this.queueRender(0);
  }

  setErConnectorStyle(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as ErConnectorStyle;
    this.erConnectorStyle.set(value);
    localStorage.setItem('make-mermaid.er-connector-style', value);
    this.queueRender(0);
  }

  setErConnectorColor(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.erConnectorColor.set(value);
    localStorage.setItem('make-mermaid.er-connector-color', value);
    this.applyErAppearance(this.diagramElement.nativeElement);
    this.updateRenderedSvg();
  }

  selectErEntity(event: Event): void {
    this.selectedErEntity.set((event.target as HTMLSelectElement).value);
    this.decorateErEntities(this.diagramElement.nativeElement);
  }

  setErEntityColor(event: Event): void {
    const entity = this.activeErEntity();
    if (!entity) return;

    const color = (event.target as HTMLInputElement).value;
    const stroke = this.darkenHexColor(color, 0.28);
    const textColor = this.contrastingTextColor(color);
    const styleLine = `    style ${entity} fill:${color},stroke:${stroke},color:${textColor}`;
    const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existingStyle = new RegExp(`^\\s*style\\s+${escapedEntity}\\s+.*$`, 'm');
    const nextSource = existingStyle.test(this.source())
      ? this.source().replace(existingStyle, styleLine)
      : `${this.source().trimEnd()}\n${styleLine}`;

    this.updateEditorSource(nextSource);
  }

  deleteSelectedErEntity(): void {
    const entity = this.selectedErEntity();
    if (!entity || !window.confirm(`¿Eliminar la tabla ${entity} y todas sus relaciones?`)) return;

    const nextSource = this.removeErEntityFromSource(this.source(), entity);
    this.selectedErEntity.set('');
    this.updateEditorSource(nextSource);
  }

  zoomIn(): void {
    this.zoomAroundCanvasCenter(this.zoom() * 1.2);
  }

  zoomOut(): void {
    this.zoomAroundCanvasCenter(this.zoom() / 1.2);
  }

  resetZoom(): void {
    this.zoom.set(1);
    this.panX.set(0);
    this.panY.set(0);
  }

  fitDiagram(): void {
    const canvas = this.previewCanvas.nativeElement;
    const availableWidth = Math.max(100, canvas.clientWidth - 80);
    const availableHeight = Math.max(100, canvas.clientHeight - 80);
    const nextZoom = Math.min(availableWidth / this.diagramWidth(), availableHeight / this.diagramHeight(), 1.5);
    this.zoom.set(this.clampZoom(nextZoom));
    this.panX.set(0);
    this.panY.set(0);
  }

  handleCanvasWheel(event: WheelEvent): void {
    event.preventDefault();
    const bounds = this.previewCanvas.nativeElement.getBoundingClientRect();
    const cursorX = event.clientX - bounds.left - bounds.width / 2;
    const cursorY = event.clientY - bounds.top - bounds.height / 2;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const previousZoom = this.zoom();
    const nextZoom = this.clampZoom(previousZoom * factor);

    if (nextZoom === previousZoom) return;

    const worldX = (cursorX - this.panX()) / previousZoom;
    const worldY = (cursorY - this.panY()) / previousZoom;
    this.panX.set(cursorX - worldX * nextZoom);
    this.panY.set(cursorY - worldY * nextZoom);
    this.zoom.set(nextZoom);
  }

  startCanvasPan(event: PointerEvent): void {
    if (event.button !== 0) return;

    const entityNode = (event.target as Element).closest<SVGGElement>('[data-er-entity]');
    if (entityNode) {
      event.preventDefault();
      this.focusErEntity(entityNode.dataset['erEntity'] ?? '');
      return;
    }

    event.preventDefault();
    this.isPanning = true;
    this.panStart = {
      x: event.clientX,
      y: event.clientY,
      panX: this.panX(),
      panY: this.panY()
    };
    this.previewCanvas.nativeElement.classList.add('is-panning');
    this.previewCanvas.nativeElement.setPointerCapture(event.pointerId);
  }

  moveCanvasPan(event: PointerEvent): void {
    if (!this.isPanning) return;

    this.panX.set(this.panStart.panX + event.clientX - this.panStart.x);
    this.panY.set(this.panStart.panY + event.clientY - this.panStart.y);
  }

  stopCanvasPan(event: PointerEvent): void {
    if (!this.isPanning) return;

    this.isPanning = false;
    this.previewCanvas.nativeElement.classList.remove('is-panning');
    if (this.previewCanvas.nativeElement.hasPointerCapture(event.pointerId)) {
      this.previewCanvas.nativeElement.releasePointerCapture(event.pointerId);
    }
  }

  startResize(event: PointerEvent): void {
    event.preventDefault();
    this.isResizing = true;
    document.body.classList.add('is-resizing-panels');
  }

  resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    this.editorWidth.update(value => this.clampEditorWidth(value + (event.key === 'ArrowLeft' ? -2 : 2)));
    this.persistEditorWidth();
  }

  @HostListener('document:pointermove', ['$event'])
  resizePanels(event: PointerEvent): void {
    if (!this.isResizing) return;

    const bounds = this.workspace.nativeElement.getBoundingClientRect();
    const percentage = ((event.clientX - bounds.left) / bounds.width) * 100;
    this.editorWidth.set(this.clampEditorWidth(percentage));
  }

  @HostListener('document:pointerup')
  stopResize(): void {
    if (!this.isResizing) return;

    this.isResizing = false;
    document.body.classList.remove('is-resizing-panels');
    this.persistEditorWidth();
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    if (!event.metaKey && !event.ctrlKey) return;

    switch (event.key.toLowerCase()) {
      case 's':
        event.preventDefault();
        this.saveDocument();
        break;
      case 'o':
        event.preventDefault();
        this.openDocument();
        break;
      case 'n':
        event.preventDefault();
        this.newDocument();
        break;
    }
  }

  @HostListener('window:beforeunload', ['$event'])
  protectUnsavedChanges(event: BeforeUnloadEvent): void {
    if (this.isDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  private createEditor(): void {
    const state = EditorState.create({
      doc: this.source(),
      extensions: [
        basicSetup,
        mermaidLanguage,
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        this.editorTheme.of(this.createEditorTheme()),
        EditorView.updateListener.of(update => {
          if (!update.docChanged || this.isReplacingEditorContent) return;

          const value = update.state.doc.toString();
          this.source.set(value);
          this.isDirty.set(true);
          localStorage.setItem('make-mermaid.source', value);
          this.queueRender();
        })
      ]
    });

    this.editorView = new EditorView({ state, parent: this.editorHost.nativeElement });
  }

  private createEditorTheme(): Extension {
    const dark = this.darkMode();
    const highlight = HighlightStyle.define([
      { tag: tags.keyword, color: dark ? '#70d6bd' : '#087f6b', fontWeight: '700' },
      { tag: tags.string, color: dark ? '#f0be73' : '#9a5b16' },
      { tag: tags.comment, color: dark ? '#839196' : '#7a8589', fontStyle: 'italic' },
      { tag: tags.operator, color: dark ? '#ff9c91' : '#bc493f', fontWeight: '650' },
      { tag: tags.typeName, color: dark ? '#8eb9f5' : '#2867a7' },
      { tag: tags.labelName, color: dark ? '#d2a8ff' : '#7648a3' },
      { tag: tags.atom, color: dark ? '#e4a4cb' : '#a4467f' },
      { tag: tags.bracket, color: dark ? '#c7d0d3' : '#566166' }
    ]);

    return [
      EditorView.theme({
        '&': { height: '100%', backgroundColor: dark ? '#191e20' : '#f9faf9', color: dark ? '#e7edeb' : '#17211f' },
        '.cm-content': { padding: '18px 0 40px', caretColor: dark ? '#70d6bd' : '#087f6b' },
        '.cm-line': { padding: '0 18px 0 8px' },
        '.cm-gutters': { backgroundColor: dark ? '#202628' : '#f1f4f3', color: dark ? '#758186' : '#899397', border: 'none' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: dark ? '#25302e' : '#edf5f2' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: dark ? '#315b53' : '#bee1d9' },
        '&.cm-focused': { outline: 'none' }
      }, { dark }),
      syntaxHighlighting(highlight)
    ];
  }

  private setDocument(source: string, fileName: string): void {
    this.source.set(source);
    this.fileName.set(fileName);
    this.isDirty.set(false);
    this.replaceEditorContent(source);
    this.persistDocument();
    this.queueRender(0);
  }

  private replaceEditorContent(value: string): void {
    if (!this.editorView || this.editorView.state.doc.toString() === value) return;

    this.isReplacingEditorContent = true;
    this.editorView.dispatch({ changes: { from: 0, to: this.editorView.state.doc.length, insert: value } });
    this.isReplacingEditorContent = false;
  }

  private configureMermaid(): void {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: this.darkMode() ? 'dark' : 'default',
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    });
  }

  private queueRender(delay = 250): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);

    this.status.set('rendering');
    this.renderTimer = setTimeout(() => void this.renderDiagram(), delay);
  }

  private async renderDiagram(): Promise<void> {
    const definition = this.source().trim();
    const generation = ++this.renderGeneration;

    if (!definition) {
      this.renderedSvg = '';
      this.diagramElement.nativeElement.innerHTML = '';
      this.errorMessage.set('Escribe un diagrama Mermaid para comenzar.');
      this.status.set('error');
      return;
    }

    try {
      const { svg, bindFunctions } = await mermaid.render(`diagram-${generation}`, definition);
      if (generation !== this.renderGeneration) return;

      const output = this.diagramElement.nativeElement;
      output.innerHTML = svg;
      this.normalizeSvgSize(output.querySelector('svg'));
      bindFunctions?.(output);
      this.applyErAppearance(output);
      this.updateRenderedSvg();
      this.errorMessage.set('');
      this.status.set('ready');

      requestAnimationFrame(() => {
        this.diagramWidth.set(output.offsetWidth);
        this.diagramHeight.set(output.offsetHeight);
        if (!this.hasFittedInitialDiagram) {
          this.hasFittedInitialDiagram = true;
          this.fitDiagram();
        }
      });
    } catch (error) {
      if (generation !== this.renderGeneration) return;

      this.renderedSvg = '';
      this.diagramElement.nativeElement.innerHTML = '';
      this.errorMessage.set(this.describeError(error));
      this.status.set('error');
    }
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error:\s*/i, '').replace(/mermaid version.*$/is, '').trim();
  }

  private normalizeSvgSize(svg: SVGSVGElement | null): void {
    const viewBox = svg?.viewBox.baseVal;
    if (!svg || !viewBox || viewBox.width <= 0 || viewBox.height <= 0) return;

    svg.style.width = `${viewBox.width}px`;
    svg.style.height = `${viewBox.height}px`;
    svg.style.maxWidth = 'none';
  }

  private applyErAppearance(output: HTMLElement): void {
    if (!this.isErDiagram()) return;

    this.decorateErEntities(output);
    const color = this.erConnectorColor();
    output.querySelectorAll<SVGElement>('.relationshipLine, .marker').forEach(element => {
      element.style.setProperty('stroke', color, 'important');
    });

    if (this.erConnectorStyle() === 'curved') return;

    const relationships = this.extractErRelationships(this.source());
    output.querySelectorAll<SVGPathElement>('path.relationshipLine').forEach((path, index) => {
      const length = path.getTotalLength();
      if (!Number.isFinite(length) || length <= 0) return;

      let start = path.getPointAtLength(0);
      let end = path.getPointAtLength(length);
      const relationship = relationships[index];
      if (relationship) {
        const sourceNode = this.findErEntityNode(output, relationship.source);
        const targetNode = this.findErEntityNode(output, relationship.target);
        if (sourceNode && targetNode) {
          const sourceCenter = this.getErEntityCenter(sourceNode);
          const targetCenter = this.getErEntityCenter(targetNode);
          start = this.getErEntityAnchor(sourceNode, targetCenter);
          end = this.getErEntityAnchor(targetNode, sourceCenter);
        }
      }

      path.setAttribute('d', this.createConnectorPath(start, end, this.erConnectorStyle()));
      this.positionErEdgeLabel(output, path);
    });
  }

  private decorateErEntities(output: HTMLElement): void {
    const nodes = Array.from(output.querySelectorAll<SVGGElement>('g[id^="entity-"]'));
    const availableNodes = new Set(nodes);

    this.erEntities().forEach(entity => {
      const normalizedName = entity.replace(/^"|"$/g, '');
      const node = [...availableNodes].find(candidate => candidate.id.startsWith(`entity-${normalizedName}-`));
      if (!node) return;

      availableNodes.delete(node);
      node.dataset['erEntity'] = entity;
      node.classList.toggle('is-selected', entity === this.selectedErEntity());
    });
  }

  private findErEntityNode(output: HTMLElement, entity: string): SVGGElement | undefined {
    return Array.from(output.querySelectorAll<SVGGElement>('[data-er-entity]'))
      .find(node => node.dataset['erEntity'] === entity);
  }

  private getErEntityCenter(node: SVGGElement): DOMPoint {
    const bounds = (node.querySelector<SVGGraphicsElement>('.outer-path') ?? node).getBBox();
    const matrix = node.transform.baseVal.consolidate()?.matrix;
    const center = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return matrix ? center.matrixTransform(matrix) : center;
  }

  private getErEntityAnchor(node: SVGGElement, toward: DOMPoint): DOMPoint {
    const shape = node.querySelector<SVGGraphicsElement>('.outer-path') ?? node;
    const bounds = shape.getBBox();
    const matrix = node.transform.baseVal.consolidate()?.matrix;
    const center = this.getErEntityCenter(node);
    const halfWidth = Math.max(1, bounds.width / 2);
    const halfHeight = Math.max(1, bounds.height / 2);
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    let anchor: DOMPoint;

    if (Math.abs(dx) / halfWidth >= Math.abs(dy) / halfHeight) {
      anchor = new DOMPoint(bounds.x + (dx >= 0 ? bounds.width : 0), bounds.y + bounds.height / 2);
    } else {
      anchor = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + (dy >= 0 ? bounds.height : 0));
    }

    return matrix ? anchor.matrixTransform(matrix) : anchor;
  }

  private positionErEdgeLabel(output: HTMLElement, path: SVGPathElement): void {
    const edgeId = path.dataset['id'];
    if (!edgeId) return;

    const label = Array.from(output.querySelectorAll<SVGGElement>('.edgeLabels .label[data-id]'))
      .find(candidate => candidate.dataset['id'] === edgeId);
    const labelContainer = label?.parentElement;
    if (!labelContainer) return;

    const point = path.getPointAtLength(path.getTotalLength() / 2);
    labelContainer.setAttribute('transform', `translate(${this.roundCoordinate(point.x)}, ${this.roundCoordinate(point.y)})`);
  }

  private focusErEntity(entity: string): void {
    if (!entity || !this.editorView) return;

    this.selectedErEntity.set(entity);
    const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`^\\s*${escapedEntity}(?=\\s*\\{)`, 'm').exec(this.source());
    const fallback = new RegExp(`^\\s*${escapedEntity}(?=\\s+)`, 'm').exec(this.source());
    const match = declaration ?? fallback;
    if (!match || match.index === undefined) return;

    const from = match.index + match[0].search(/\S/);
    const to = from + entity.length;
    this.editorView.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    });
    this.editorView.focus();
    this.decorateErEntities(this.diagramElement.nativeElement);
  }

  private createConnectorPath(start: DOMPoint, end: DOMPoint, style: ErConnectorStyle): string {
    const startPoint = `${this.roundCoordinate(start.x)},${this.roundCoordinate(start.y)}`;
    const endPoint = `${this.roundCoordinate(end.x)},${this.roundCoordinate(end.y)}`;
    if (style === 'straight') return `M${startPoint} L${endPoint}`;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (style === 'orthogonal') {
      if (Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01) return `M${startPoint} L${endPoint}`;

      if (Math.abs(dx) >= Math.abs(dy)) {
        const middleX = start.x + dx / 2;
        return this.createRoundedPath([
          start,
          new DOMPoint(middleX, start.y),
          new DOMPoint(middleX, end.y),
          end
        ]);
      }

      const middleY = start.y + dy / 2;
      return this.createRoundedPath([
        start,
        new DOMPoint(start.x, middleY),
        new DOMPoint(end.x, middleY),
        end
      ]);
    }

    if (Math.abs(dx) >= Math.abs(dy)) {
      const firstControl = `${this.roundCoordinate(start.x + dx * 0.32)},${this.roundCoordinate(start.y)}`;
      const secondControl = `${this.roundCoordinate(end.x - dx * 0.32)},${this.roundCoordinate(end.y)}`;
      return `M${startPoint} C${firstControl} ${secondControl} ${endPoint}`;
    }

    const firstControl = `${this.roundCoordinate(start.x)},${this.roundCoordinate(start.y + dy * 0.32)}`;
    const secondControl = `${this.roundCoordinate(end.x)},${this.roundCoordinate(end.y - dy * 0.32)}`;
    return `M${startPoint} C${firstControl} ${secondControl} ${endPoint}`;
  }

  private createRoundedPath(points: DOMPoint[], radius = 8): string {
    const commands = [`M${this.roundCoordinate(points[0].x)},${this.roundCoordinate(points[0].y)}`];

    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1];
      const corner = points[index];
      const next = points[index + 1];
      const incomingLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
      const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
      const cornerRadius = Math.min(radius, incomingLength / 2, outgoingLength / 2);
      const before = new DOMPoint(
        corner.x - ((corner.x - previous.x) / incomingLength) * cornerRadius,
        corner.y - ((corner.y - previous.y) / incomingLength) * cornerRadius
      );
      const after = new DOMPoint(
        corner.x + ((next.x - corner.x) / outgoingLength) * cornerRadius,
        corner.y + ((next.y - corner.y) / outgoingLength) * cornerRadius
      );

      commands.push(
        `L${this.roundCoordinate(before.x)},${this.roundCoordinate(before.y)}`,
        `Q${this.roundCoordinate(corner.x)},${this.roundCoordinate(corner.y)} ${this.roundCoordinate(after.x)},${this.roundCoordinate(after.y)}`
      );
    }

    const end = points.at(-1)!;
    commands.push(`L${this.roundCoordinate(end.x)},${this.roundCoordinate(end.y)}`);
    return commands.join(' ');
  }

  private updateRenderedSvg(): void {
    this.renderedSvg = this.diagramElement.nativeElement.querySelector('svg')?.outerHTML ?? '';
  }

  private updateEditorSource(value: string): void {
    this.source.set(value);
    this.isDirty.set(true);
    this.replaceEditorContent(value);
    localStorage.setItem('make-mermaid.source', value);
    this.queueRender(0);
  }

  private extractErEntities(source: string): string[] {
    if (!/^\s*erDiagram\b/im.test(source)) return [];

    const entities = new Set<string>();
    const entityPattern = /^\s*("[^"]+"|[\p{L}_][\p{L}\p{N}_-]*)\s*\{/gmu;
    for (const match of source.matchAll(entityPattern)) entities.add(match[1]);

    for (const relationship of this.extractErRelationships(source)) {
      entities.add(relationship.source);
      entities.add(relationship.target);
    }

    return [...entities];
  }

  private extractErRelationships(source: string): ErRelationship[] {
    const cardinality = '(?:\\|\\||o\\||\\}o|\\}\\||\\|o|o\\{|\\|\\{)';
    const name = '("[^"]+"|[\\p{L}_][\\p{L}\\p{N}_-]*)';
    const pattern = new RegExp(`^\\s*${name}\\s+${cardinality}[.-]{2}${cardinality}\\s+${name}\\s*:`, 'gmu');
    return [...source.matchAll(pattern)].map(match => ({ source: match[1], target: match[2] }));
  }

  private removeErEntityFromSource(source: string, entity: string): string {
    const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockStart = new RegExp(`^\\s*${escapedEntity}\\s*\\{`);
    const relationship = new RegExp(`^\\s*${escapedEntity}\\s+|[.-]{2}(?:\\|\\||o\\||\\}o|\\}\\||\\|o|o\\{|\\|\\{)\\s+${escapedEntity}\\s*:`);
    const style = new RegExp(`^\\s*style\\s+${escapedEntity}(?:\\s|,)`);
    const lines = source.split(/\\r?\\n/);
    const kept: string[] = [];
    let skippingBlock = false;

    for (const line of lines) {
      if (!skippingBlock && blockStart.test(line)) {
        skippingBlock = !line.includes('}');
        continue;
      }
      if (skippingBlock) {
        if (line.includes('}')) skippingBlock = false;
        continue;
      }
      if (relationship.test(line) || style.test(line)) continue;

      const classStatement = line.match(/^(\s*class\s+)(\S+)(\s+.+)$/);
      if (classStatement) {
        const remainingEntities = classStatement[2].split(',').filter(id => id !== entity);
        if (remainingEntities.length) kept.push(`${classStatement[1]}${remainingEntities.join(',')}${classStatement[3]}`);
        continue;
      }

      kept.push(line);
    }

    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  private readEntityColor(source: string, entity: string): string {
    if (!entity) return '#dcefe9';

    const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const style = source.match(new RegExp(`^\\s*style\\s+${escapedEntity}\\s+([^\\n]+)$`, 'mi'))?.[1];
    return style?.match(/(?:^|,)\s*fill\s*:\s*(#[0-9a-f]{6})/i)?.[1] ?? '#dcefe9';
  }

  private darkenHexColor(color: string, amount: number): string {
    const value = Number.parseInt(color.slice(1), 16);
    const channel = (shift: number) => Math.round(((value >> shift) & 255) * (1 - amount));
    return `#${[channel(16), channel(8), channel(0)].map(part => part.toString(16).padStart(2, '0')).join('')}`;
  }

  private contrastingTextColor(color: string): string {
    const value = Number.parseInt(color.slice(1), 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? '#17211f' : '#f7fbfa';
  }

  private roundCoordinate(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private readConnectorStyle(): ErConnectorStyle {
    const value = localStorage.getItem('make-mermaid.er-connector-style');
    return value === 'curved' || value === 'straight' || value === 'orthogonal' ? value : 'gentle';
  }

  private zoomAroundCanvasCenter(value: number): void {
    const previousZoom = this.zoom();
    const nextZoom = this.clampZoom(value);
    if (nextZoom === previousZoom) return;

    this.panX.set(this.panX() * (nextZoom / previousZoom));
    this.panY.set(this.panY() * (nextZoom / previousZoom));
    this.zoom.set(nextZoom);
  }

  private clampZoom(value: number): number {
    return Math.min(6, Math.max(0.1, Math.round(value * 100) / 100));
  }

  private download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private persistDocument(): void {
    localStorage.setItem('make-mermaid.source', this.source());
    localStorage.setItem('make-mermaid.filename', this.fileName());
  }

  private persistEditorWidth(): void {
    localStorage.setItem('make-mermaid.editor-width', String(this.editorWidth()));
  }

  private clampEditorWidth(value: number): number {
    return Math.min(72, Math.max(28, value));
  }

  private ensureExtension(name: string, extension: string): string {
    return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
  }

  private readStoredValue(key: string, fallback: string): string {
    return localStorage.getItem(key) ?? fallback;
  }

  private readStoredNumber(key: string, fallback: number): number {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private readInitialTheme(): boolean {
    const storedTheme = localStorage.getItem('make-mermaid.theme');
    return storedTheme ? storedTheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
}
