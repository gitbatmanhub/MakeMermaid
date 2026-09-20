import { TestBed } from '@angular/core/testing';
import mermaid from 'mermaid';
import { CodeMapImporterComponent } from './code-map-importer.component';

const VALID_GRAPH = {
  generatedAt: '2026-09-19T12:00:00.000Z',
  source: '/project/src',
  nodes: [
    { id: 'class:UsersController', label: 'UsersController', kind: 'controller', file: 'users.controller.ts' },
    { id: 'class:UsersService', label: 'UsersService', kind: 'service', file: 'users.service.ts' },
    { id: 'class:CreateUsers', label: 'CreateUsers', kind: 'class', file: 'database/migrations/1700-create-users.ts' }
  ],
  edges: [
    { id: 'users', from: 'class:UsersController', to: 'class:UsersService', kind: 'calls', label: 'UsersService.findAll()' },
    { id: 'migration', from: 'class:CreateUsers', to: 'class:UsersService', kind: 'imports', label: 'importa' }
  ]
};

describe('CodeMapImporterComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [CodeMapImporterComponent] }).compileComponents();
  });

  it('generates a styled Mermaid diagram from a valid code map', async () => {
    const fixture = TestBed.createComponent(CodeMapImporterComponent);
    const component = fixture.componentInstance;
    let generated: { source: string; fileName: string } | undefined;
    component.mermaidGenerated.subscribe((value) => generated = value);

    await component.handleJsonSelection(fileEvent(VALID_GRAPH, 'backend-code-map.json'));
    component.mode.set('all');
    component.generateMermaid();

    expect(generated?.fileName).toBe('backend-code-map.mmd');
    expect(generated?.source).toContain('flowchart LR');
    expect(generated?.source).toContain('UsersController<br/>controller<br/>users.controller.ts');
    expect(generated?.source).toContain('-->|"UsersService.findAll()"|');
    expect(generated?.source).toContain('classDef controller');
    expect(generated?.source).toContain('classDef codeClass');
    expect(generated?.source).not.toContain('classDef class');
    expect(generated?.source).not.toContain('CreateUsers');
    await expectAsync(mermaid.parse(generated!.source)).toBeResolved();
  });

  it('includes migrations only when the option is enabled', async () => {
    const fixture = TestBed.createComponent(CodeMapImporterComponent);
    const component = fixture.componentInstance;
    let generated: { source: string; fileName: string } | undefined;
    component.mermaidGenerated.subscribe((value) => generated = value);

    await component.handleJsonSelection(fileEvent(VALID_GRAPH));
    component.mode.set('all');
    component.setIncludeMigrations(true);
    component.generateMermaid();

    expect(generated?.source).toContain('CreateUsers');
    expect(generated?.source).toContain('classDef migration');
    await expectAsync(mermaid.parse(generated!.source)).toBeResolved();
  });

  it('rejects edges that reference missing nodes', async () => {
    const fixture = TestBed.createComponent(CodeMapImporterComponent);
    const component = fixture.componentInstance;
    const invalidGraph = {
      ...VALID_GRAPH,
      edges: [{ id: 'missing', from: 'class:UsersController', to: 'missing', kind: 'calls', label: '' }]
    };

    await component.handleJsonSelection(fileEvent(invalidGraph));

    expect(component.graph()).toBeNull();
    expect(component.errorMessage()).toContain('nodo inexistente');
  });
});

function fileEvent(content: object, name = 'code-map.json'): Event {
  const file = new File([JSON.stringify(content)], name, { type: 'application/json' });
  return { target: { files: [file], value: name } } as unknown as Event;
}
