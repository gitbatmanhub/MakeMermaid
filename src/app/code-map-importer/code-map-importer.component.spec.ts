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
    { id: 'users-import', from: 'class:UsersController', to: 'class:UsersService', kind: 'imports', label: 'importa' },
    { id: 'users-inject', from: 'class:UsersController', to: 'class:UsersService', kind: 'injects', label: 'inyecta usersService' },
    { id: 'users-find-all', from: 'class:UsersController', to: 'class:UsersService', kind: 'calls', label: 'findAll llama usersService.findAll()' },
    { id: 'users-find-one', from: 'class:UsersController', to: 'class:UsersService', kind: 'calls', label: 'findOne llama usersService.findOne()' },
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
    expect(generated?.source).toContain('-->|"importa<br/>inyecta usersService<br/>findAll llama usersService.findAll()<br/>findOne llama usersService.findOne()"|');
    expect(generated?.source).not.toContain('2 llamadas');
    expect(generated?.source?.match(/-->/g)?.length).toBe(1);
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

  it('uses every available node instead of silently capping large maps', async () => {
    const fixture = TestBed.createComponent(CodeMapImporterComponent);
    const component = fixture.componentInstance;
    let generated: { source: string; fileName: string } | undefined;
    component.mermaidGenerated.subscribe((value) => generated = value);
    const nodes = Array.from({ length: 300 }, (_, index) => ({
      id: `class:Node${index}`,
      label: `Node${index}`,
      kind: 'class',
      file: `node-${index}.ts`
    }));

    await component.handleJsonSelection(fileEvent({ ...VALID_GRAPH, nodes, edges: [] }));
    component.generateMermaid();

    expect(component.mode()).toBe('all');
    expect(component.maxNodes()).toBe(300);
    expect(component.renderNodeCount()).toBe(300);
    expect(generated?.source.match(/\["Node\d+<br\/>/g)?.length).toBe(300);
  });
});

function fileEvent(content: object, name = 'code-map.json'): Event {
  const file = new File([JSON.stringify(content)], name, { type: 'application/json' });
  return { target: { files: [file], value: name } } as unknown as Event;
}
