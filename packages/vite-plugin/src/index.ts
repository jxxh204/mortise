import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Plugin, ResolvedConfig } from "vite";

const VIRTUAL_DOMAINS = "mortise:domains";
const RESOLVED_DOMAINS = "\0mortise:domains";
const VIRTUAL_SERVER_DOMAINS = "mortise:server-domains";
const RESOLVED_SERVER_DOMAINS = "\0mortise:server-domains";
const VIRTUAL_UI = "mortise:ui/";

export interface MortiseOptions {
  /** Relative to Vite's root, or an absolute directory. */
  domainsDir?: string;
  /** Local is the in-process prototype; HTTP keeps implementations on the server. */
  transport?: "local" | "http";
  /** Same-origin RPC mount path in HTTP mode. */
  endpoint?: string;
  /** Fetch handler module, relative to Vite root. Loaded only by the dev server. */
  serverEntry?: string;
  /** Trusted development origin; defaults to Vite's configured/resolved local URL. */
  publicOrigin?: string;
  /** Enable server UI only in the official plugin's named `rsc` environment. */
  rsc?: boolean;
}

export interface DiscoveredDomain {
  id: string;
  exportName: string;
  definition: string;
  query: string;
  actions: Record<string, string>;
}

export interface DiscoveredUI { module: string; file: string }

const slash = (value: string) => value.split(path.sep).join("/");
const canonical = (value: string): string => {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
};
const identifier = (value: string) => value.replace(/[-/](\w)/g, (_, char: string) => char.toUpperCase());

/** Deterministic discovery. Ambiguous names fail instead of selecting a winner. */
export function discoverDomains(directory: string): DiscoveredDomain[] {
  if (!fs.existsSync(directory)) return [];
  const found: DiscoveredDomain[] = [];
  const names = new Set<string>();

  function visit(current: string) {
    const definition = path.join(current, "domain.ts");
    if (fs.existsSync(definition)) {
      const id = slash(path.relative(directory, current));
      if (!id) throw new Error("[Mortise] Put domain.ts inside a named domain folder, not the domains root.");
      const exportName = identifier(id);
      if (!/^[$A-Z_a-z][$\w]*$/.test(exportName) || exportName === "default") {
        throw new Error(`[Mortise] Domain folder '${id}' cannot produce a JavaScript export name.`);
      }
      if (names.has(exportName)) throw new Error(`[Mortise] Duplicate domain export '${exportName}'. Rename one domain folder.`);
      names.add(exportName);
      const query = path.join(current, "queries", "state.ts");
      if (!fs.existsSync(query)) throw new Error(`[Mortise] Domain '${id}' requires queries/state.ts with a default export.`);
      const actions: Record<string, string> = {};
      const actionDir = path.join(current, "actions");
      if (fs.existsSync(actionDir)) {
        for (const file of fs.readdirSync(actionDir).sort()) {
          if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file.endsWith(".test.ts")) continue;
          const actionName = identifier(file.slice(0, -3).replace(/\.action$/, ""));
          if (!/^[$A-Z_a-z][$\w]*$/.test(actionName)) throw new Error(`[Mortise] Invalid action filename '${file}' in '${id}'.`);
          if (Object.hasOwn(actions, actionName)) throw new Error(`[Mortise] Duplicate action '${actionName}' in '${id}'.`);
          actions[actionName] = path.join(actionDir, file);
        }
      }
      found.push({ id, exportName, definition, query, actions });
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") visit(path.join(current, entry.name));
    }
  }
  visit(directory);
  return found;
}

export function createDomainModule(domains: DiscoveredDomain[], options: Pick<MortiseOptions, "transport" | "endpoint"> = {}): string {
  const remote = options.transport === "http";
  const lines = [remote
    ? 'import { createRemoteDomain as __createRemoteDomain } from "@mortise/core";'
    : 'import { attachDomain as __attachDomain } from "@mortise/core";'];
  domains.forEach((domain, index) => {
    lines.push(`import __definition${index} from ${JSON.stringify(slash(domain.definition))};`);
    if (remote) {
      lines.push(`export const ${domain.exportName} = __createRemoteDomain(__definition${index}, { id: ${JSON.stringify(domain.id)}, endpoint: ${JSON.stringify(options.endpoint ?? "/_mortise")} });`);
      return;
    }
    lines.push(`import __query${index} from ${JSON.stringify(slash(domain.query))};`);
    const entries = Object.entries(domain.actions).map(([name, file], actionIndex) => {
      const symbol = `__action${index}_${actionIndex}`;
      lines.push(`import ${symbol} from ${JSON.stringify(slash(file))};`);
      return `${JSON.stringify(name)}: ${symbol}`;
    });
    lines.push(`export const ${domain.exportName} = __attachDomain(__definition${index}, { id: ${JSON.stringify(domain.id)}, query: __query${index}, actions: { ${entries.join(", ")} } });`);
  });
  lines.push(`export default { ${domains.map((domain) => domain.exportName).join(", ")} };`);
  return lines.join("\n");
}

export function discoverUI(directory: string): DiscoveredUI[] {
  const entries: DiscoveredUI[] = [];
  for (const domain of discoverDomains(directory)) {
    const clientDirectory = path.join(path.dirname(domain.definition), "ui", "client");
    if (!fs.existsSync(clientDirectory)) continue;
    function visit(current: string) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.name.endsWith(".tsx") && transformUI(fs.readFileSync(file, "utf8"), file) !== null) {
          const name = slash(path.relative(clientDirectory, file)).replace(/\.tsx$/, "");
          entries.push({ module: `${VIRTUAL_UI}${domain.id}/${name}`, file });
        }
      }
    }
    visit(clientDirectory);
  }
  return entries;
}

/** Run before tsc; also called when the Vite server/build starts. */
export function generateTypes(root: string, options: MortiseOptions = {}): string[] {
  const directory = path.resolve(root, options.domainsDir ?? "src/domains");
  const output = path.join(root, ".mortise");
  fs.mkdirSync(output, { recursive: true });
  const domains = discoverDomains(directory);
  const ui = discoverUI(directory);
  const domainLines = ["// Generated by Mortise. Do not edit.", 'declare module "mortise:domains" {'];
  for (const domain of domains) domainLines.push(`  export const ${domain.exportName}: import("@mortise/core").BoundDomain;`);
  domainLines.push(`  const domains: { ${domains.map((domain) => `${JSON.stringify(domain.exportName)}: typeof ${domain.exportName}`).join("; ")} };`, "  export default domains;", "}");
  domainLines.push('declare module "mortise:server-domains" {', '  export * from "mortise:domains";', '  export { default } from "mortise:domains";', "}");
  const uiLines = ["// Generated public UI signatures. Source views receive injected state and commands."];
  for (const entry of ui) {
    uiLines.push(`declare module ${JSON.stringify(entry.module)} {`,
      `  type View = typeof import(${JSON.stringify(slash(entry.file))}).default;`,
      '  type ExternalProps = Parameters<View>[0] extends { props: infer P } ? P : Record<string, never>;',
      '  const Component: import("react").ComponentType<ExternalProps>;',
      "  export default Component;", "}");
  }
  const files = [path.join(output, "domains.d.ts"), path.join(output, "ui.d.ts")];
  const contents = [domainLines.join("\n") + "\n", uiLines.join("\n") + "\n"];
  files.forEach((file, index) => {
    const content = contents[index]!;
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) fs.writeFileSync(file, content);
  });
  return files;
}

/** Compile the UI injection marker to a public React component. Ordinary React files are untouched. */
export function transformUI(source: string, filename: string): string | null {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const markerNames = new Set<string>();
  const typeOnlyNames = new Set<string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.isTypeOnly && clause.name) typeOnlyNames.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) {
        if (clause.isTypeOnly || specifier.isTypeOnly) typeOnlyNames.add(specifier.name.text);
        if (["@mortise/react", "@mortise/core"].includes(statement.moduleSpecifier.text) && (specifier.propertyName ?? specifier.name).text === "UI") markerNames.add(specifier.name.text);
      }
    }
  }
  if (!markerNames.size) return null;
  const isMarker = (node: ts.Node): node is ts.TypeReferenceNode => ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && markerNames.has(node.typeName.text);
  let marker: ts.TypeReferenceNode | undefined;
  function inspect(node: ts.Node) {
    if (isMarker(node)) marker = node;
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
  if (!marker) return null;
  if (filename.includes(".server.") || slash(filename).includes("/ui/server/")) throw new Error(`[Mortise] UI injection is client-only in v0.1: ${filename}`);
  const component = ast.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  const fail = (message: string): never => { throw new Error(`[Mortise] ${filename}: ${message}`); };
  if (!component) return fail("UI<T, Props> requires an export default function declaration in v0.1; arrow functions and re-exports are unsupported.");
  if (component.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return fail("Client UI functions cannot be async.");
  if (component.typeParameters?.length) return fail("Generic UI component declarations are not supported in v0.1.");
  if (component.parameters.length !== 1 || !component.parameters[0]?.type || !isMarker(component.parameters[0].type)) return fail("The default function must have one parameter annotated UI<typeof Contract, Props>.");
  const annotation = component.parameters[0].type;
  const contractType = annotation.typeArguments?.[0];
  if (!contractType || !ts.isTypeQueryNode(contractType) || !ts.isIdentifier(contractType.exprName)) return fail("Use UI<typeof Contract, Props> with a named contract value import.");
  const contract = contractType.exprName.text;
  if (typeOnlyNames.has(contract)) return fail(`Contract '${contract}' is used at runtime; import it as a value, not with 'import type'.`);
  const names = new Set<string>();
  function collect(node: ts.Node) { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, collect); }
  collect(ast);
  function unique(base: string) { let value = base; let index = 0; while (names.has(value)) value = `${base}${++index}`; names.add(value); return value; }
  const viewName = unique(`${component.name?.text ?? "MortiseUI"}View`);
  const hookName = unique("__mortiseUseCapability");
  const wrapperName = component.name?.text ?? unique("MortiseComponent");
  const factory = ts.factory;
  const view = factory.updateFunctionDeclaration(component,
    component.modifiers?.filter((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword),
    component.asteriskToken, factory.createIdentifier(viewName), component.typeParameters,
    component.parameters, component.type, component.body);
  const printer = ts.createPrinter();
  const rewritten = factory.updateSourceFile(ast, ast.statements.map((statement) => statement === component ? view : statement));
  const propsType = annotation.typeArguments?.[1]
    ? printer.printNode(ts.EmitHint.Unspecified, annotation.typeArguments[1], ast)
    : "Record<string, never>";
  return `${printer.printFile(rewritten)}\nimport { useCapability as ${hookName} } from "@mortise/react";\nexport default function ${wrapperName}(props: ${propsType}) {\n  const binding = ${hookName}(${contract});\n  return <${viewName} state={binding.state} commands={binding.commands} props={props} />;\n}\n`;
}

/** Folder conventions become directives before the official RSC plugin runs. */
export function withClientDirective(source: string, filename: string): string {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let client = false;
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use server") throw new Error(`[Mortise] ui/client modules cannot declare 'use server': ${filename}`);
    if (statement.expression.text === "use client") client = true;
  }
  return client ? source : `"use client";\n${source}`;
}

function serverEnvironment(context: { environment?: { name: string } }, legacySSR?: boolean): boolean {
  // A named client environment always wins over a stale/incorrect SSR option.
  if (context.environment?.name) return ["ssr", "rsc"].includes(context.environment.name);
  return legacySSR === true;
}

export function mortise(options: MortiseOptions = {}): Plugin {
  let config: ResolvedConfig;
  let domainsDirectory: string;
  let serverEntry: string;
  const transport = options.rsc ? "http" : options.transport ?? "local";
  const endpoint = (options.endpoint ?? "/_mortise").replace(/\/$/, "");
  if (!endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint.includes("?") || endpoint.includes("#") || endpoint === "") {
    throw new Error("[Mortise] endpoint must be a same-origin path such as '/_mortise'.");
  }
  const insideDomains = (filename: string) => {
    const relative = path.relative(domainsDirectory, canonical(filename));
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const assertClientBoundary = (filename: string) => {
    if (transport !== "http") return;
    if (canonical(filename) === serverEntry) throw new Error("[Mortise] The server entry cannot be imported into a client bundle.");
    if (!insideDomains(filename)) return;
    const relative = slash(path.relative(domainsDirectory, canonical(filename)));
    if (/(?:^|\/)(?:queries|actions|model|server)(?:\/|$)/.test(relative) || /(?:^|\/)ui\/server\//.test(relative) || /\.server\.[cm]?[jt]sx?$/.test(relative)) {
      throw new Error(`[Mortise] Server-only domain module cannot be imported into a client bundle: ${filename}. Use mortise:domains with HTTP transport.`);
    }
  };
  return {
    name: "mortise",
    enforce: "pre",
    config() { return { esbuild: { jsx: "automatic" } }; },
    configResolved(resolved) {
      config = resolved;
      domainsDirectory = canonical(path.resolve(config.root, options.domainsDir ?? "src/domains"));
      serverEntry = canonical(path.resolve(config.root, options.serverEntry ?? "src/mortise.server.ts"));
    },
    buildStart() {
      generateTypes(config.root, options);
      for (const domain of discoverDomains(domainsDirectory)) {
        this.addWatchFile(domain.definition);
        this.addWatchFile(domain.query);
        Object.values(domain.actions).forEach((file) => this.addWatchFile(file));
      }
    },
    resolveId(id, _importer, resolveOptions) {
      if (id === "@mortise/rsc/server" && !resolveOptions?.ssr) throw new Error("[Mortise] @mortise/rsc/server is server-only.");
      if (id === VIRTUAL_DOMAINS) return RESOLVED_DOMAINS;
      if (id === VIRTUAL_SERVER_DOMAINS || id === RESOLVED_SERVER_DOMAINS) {
        if (!serverEnvironment(this, resolveOptions?.ssr)) throw new Error("[Mortise] mortise:server-domains is SSR-only and cannot be imported into a client bundle.");
        return RESOLVED_SERVER_DOMAINS;
      }
      if (id.startsWith(VIRTUAL_UI)) {
        if (!discoverUI(domainsDirectory).some((entry) => entry.module === id)) throw new Error(`[Mortise] Unknown public UI '${id}'. Use an annotated default function in ui/client/.`);
        return `\0${id}`;
      }
    },
    load(id, loadOptions) {
      if (id === RESOLVED_DOMAINS) return createDomainModule(discoverDomains(domainsDirectory), { transport, endpoint });
      if (id === RESOLVED_SERVER_DOMAINS) {
        if (!serverEnvironment(this, loadOptions?.ssr)) throw new Error("[Mortise] mortise:server-domains is SSR-only.");
        return createDomainModule(discoverDomains(domainsDirectory));
      }
      if (id.startsWith(`\0${VIRTUAL_UI}`)) {
        const entry = discoverUI(domainsDirectory).find((candidate) => candidate.module === id.slice(1));
        if (!entry) throw new Error(`[Mortise] Public UI '${id.slice(1)}' no longer exists.`);
        return `export { default } from ${JSON.stringify(slash(entry.file))};`;
      }
    },
    transform(code, id, transformOptions) {
      const filename = id.split("?")[0];
      if (filename && !filename.startsWith("\0") && !serverEnvironment(this, transformOptions?.ssr)) assertClientBoundary(filename);
      if (!filename?.endsWith(".tsx") || filename.includes("node_modules")) return null;
      const relative = path.relative(domainsDirectory, canonical(filename));
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
      if (slash(filename).includes("/ui/server/") || filename.includes(".server.")) {
        if (options.rsc && this.environment?.name === "rsc") return null;
        if (options.rsc) throw new Error(`[Mortise] Server UI may only execute in the 'rsc' environment, not '${this.environment?.name ?? "unknown"}': ${filename}`);
        throw new Error(`[Mortise] RSC rendering is not implemented. Server UI cannot be imported: ${filename}`);
      }
      if (!slash(filename).includes("/ui/client/")) {
        if (transformUI(code, filename) !== null) throw new Error(`[Mortise] Annotated UI components must live in ui/client/ in v0.1: ${filename}`);
        return null;
      }
      const transformed = transformUI(code, filename);
      if (options.rsc) return { code: withClientDirective(transformed ?? code, filename), map: null };
      return transformed === null ? null : { code: transformed, map: null };
    },
    configureServer(server) {
      if (transport === "http" && !options.rsc) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = request.url?.split("?")[0] ?? "";
          if (pathname !== endpoint && !pathname.startsWith(`${endpoint}/`)) return next();
          try {
            const module = await server.ssrLoadModule(serverEntry);
            if (typeof module.default !== "function") throw new Error(`[Mortise] ${serverEntry} must default-export a Fetch handler.`);
            const { toNodeListener } = await server.ssrLoadModule("@mortise/server/node");
            const publicURL = options.publicOrigin ?? server.config.server.origin ?? server.resolvedUrls?.local[0];
            if (!publicURL) throw new Error("[Mortise] Set publicOrigin to the trusted development server origin.");
            await toNodeListener(module.default, { publicOrigin: new URL(publicURL).origin })(request, response);
          } catch (error) {
            server.config.logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
            if (!response.headersSent) {
              response.statusCode = 500;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ ok: false, error: { code: "SERVER_UNAVAILABLE", message: "The Mortise server could not process the request.", committed: "unknown" } }));
            } else response.end();
          }
        });
      }
      const reload = (file: string) => {
        const relative = path.relative(domainsDirectory, canonical(file));
        if (relative.startsWith("..") || path.isAbsolute(relative)) return;
        generateTypes(config.root, options);
        const module = server.moduleGraph.getModuleById(RESOLVED_DOMAINS);
        if (module) server.moduleGraph.invalidateModule(module);
        const serverModule = server.moduleGraph.getModuleById(RESOLVED_SERVER_DOMAINS);
        if (serverModule) server.moduleGraph.invalidateModule(serverModule);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);
      server.httpServer?.once("close", () => {
        server.watcher.off("add", reload);
        server.watcher.off("unlink", reload);
      });
    },
  };
}

export default mortise;
