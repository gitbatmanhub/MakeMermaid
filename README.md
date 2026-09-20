# Make Mermaid

Editor local Angular para crear, abrir, previsualizar y exportar diagramas Mermaid.

También incluye una funcionalidad independiente para convertir mapas de código TypeScript/NestJS en diagramas Mermaid.

## Desarrollo

```bash
npm install
npm start
```

Abre la URL que muestre Angular, normalmente:

```txt
http://localhost:4201/
```

## Editor Mermaid

La pestaña **Editor** mantiene el flujo original:

- Editar código Mermaid.
- Previsualizar con pan/zoom.
- Guardar `.mmd`.
- Exportar SVG.
- Ajustar apariencia de diagramas ER.

## Code Map

La pestaña **Code map** permite cargar un `code-map.json` y convertirlo en Mermaid sin salir de la app.

Flujo recomendado:

```txt
Backend NestJS
      ↓
npm run map
      ↓
public/code-map.json
      ↓
Pestaña Code map
      ↓
Enviar al editor Mermaid
```

Para generar el JSON desde un backend:

```bash
npm run map -- --source /ruta/al/proyecto/src --out public/code-map.json
```

Para generar un `.mmd` directamente por CLI:

```bash
npm run map:mermaid -- --input public/code-map.json --out public/code-map.mmd --mode focus --focus UsersService --maxNodes 42
```

Las migraciones quedan fuera del diagrama por defecto. Puedes incluirlas desde el check **Incluir migraciones** de la app o al generar por CLI:

```bash
npm run map:mermaid -- --input public/code-map.json --out public/code-map.mmd --mode all --include-migrations
```

También puedes usar una vista más amplia:

```bash
npm run map:mermaid -- --input public/code-map.json --out public/code-map.mmd --mode all --maxNodes 120
```

## Qué Detecta

- Controllers, services, DTOs, modules, entities y clases TypeScript.
- Imports entre clases.
- Inyección por constructor.
- DTOs recibidos por controllers.
- Llamadas tipo `this.servicio.metodo()`.
- Rutas HTTP básicas de NestJS.
- Migraciones, identificadas por su carpeta o por archivos `*.migration.ts`.

## Nota Sobre Proyectos Grandes

Para proyectos con cientos de nodos, usa **focus** por defecto. Un Mermaid con todo el grafo puede volverse tan ilegible como cualquier otro diagrama masivo.

La estrategia recomendada es generar mapas pequeños por servicio, controller o módulo central.
