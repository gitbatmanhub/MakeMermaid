import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, signal } from '@angular/core';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, StringStream, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import mermaid from 'mermaid';

type RenderStatus = 'rendering' | 'ready' | 'error';

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
      this.renderedSvg = svg;
      output.innerHTML = svg;
      this.normalizeSvgSize(output.querySelector('svg'));
      bindFunctions?.(output);
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
