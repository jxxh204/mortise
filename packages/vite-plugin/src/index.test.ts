// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { build } from "vite";
import { createDomainModule, discoverDomains, discoverUI, generateTypes, mortise, transformUI, withClientDirective } from "./index";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mortise-plugin-"));
  temporary.push(root);
  const domains = path.join(root, "src/domains");
  const cart = path.join(domains, "cart");
  const write = (relative: string, content = "export default {}") => {
    const file = path.join(cart, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("domain.ts");
  write("queries/state.ts");
  return { root, domains, cart, write };
}
const ui = `import type { UI } from "@mortise/react";
import { QuantityEditable } from "../../../contracts/quantity-editable";
type Props = { label: string };
export default function Quantity({ state, commands, props }: UI<typeof QuantityEditable, Props>) {
  return <button onClick={() => commands.setQuantity.execute(state.quantity + 1)}>{props.label}: {state.quantity}</button>;
}`;

describe("UI compiler", () => {
  it("preserves view code and injects the contract into a props-only wrapper", () => {
    const result = transformUI(ui, "/src/domains/cart/ui/client/Quantity.tsx")!;
    expect(result).toContain("function QuantityView");
    expect(result).toContain("export default function Quantity(props: Props)");
    expect(result).toContain("__mortiseUseCapability(QuantityEditable)");
    expect(result).toContain("state={binding.state} commands={binding.commands} props={props}");
    expect(result).toContain("commands.setQuantity.execute(state.quantity + 1)");
    const transpiled = ts.transpileModule(result, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
    expect(transpiled.diagnostics).toEqual([]);
    expect(transpiled.outputText).toContain("import { QuantityEditable }");
  });
  it("supports an aliased UI marker and avoids helper name collisions", () => {
    const source = ui.replace("{ UI }", "{ UI as InjectedUI }").replace("UI<typeof", "InjectedUI<typeof") + "\nconst __mortiseUseCapability = 1;";
    expect(transformUI(source, "Quantity.tsx")).toContain("__mortiseUseCapability1(QuantityEditable)");
  });
  it("leaves ordinary React components untouched", () => {
    expect(transformUI("export default function Button() { return <button/>; }", "Button.tsx")).toBeNull();
    expect(transformUI('import type { UI } from "@mortise/core"; export default function Button() { return <button/>; }', "Button.tsx")).toBeNull();
  });
  it("rejects async, server, unsupported default exports, and erased contract imports", () => {
    expect(() => transformUI(ui.replace("default function", "default async function"), "Quantity.tsx")).toThrow("cannot be async");
    expect(() => transformUI(ui, "/ui/server/Quantity.tsx")).toThrow("client-only");
    expect(() => transformUI('import type { UI } from "@mortise/core"; const View = (p: UI<typeof C>) => null; export default View;', "Quantity.tsx")).toThrow("default function declaration");
    expect(() => transformUI(ui.replace("import { QuantityEditable }", "import type { QuantityEditable }"), "Quantity.tsx")).toThrow("import it as a value");
  });
});

describe("domain discovery", () => {
  it("uses deterministic names and emits only explicit discovered imports", () => {
    const { domains, write } = fixture();
    write("actions/setQuantity.ts");
    write("actions/change-guests.action.ts");
    write("actions/ignored.test.ts");
    const found = discoverDomains(domains);
    expect(found).toHaveLength(1);
    expect(Object.keys(found[0]!.actions)).toEqual(["changeGuests", "setQuantity"]);
    const module = createDomainModule(found);
    expect(module).toContain('export const cart = __attachDomain(__definition0, { id: "cart"');
    expect(module).toContain('"setQuantity": __action0_1');
    expect(module).toContain("export default { cart }");
  });
  it("rejects missing queries and ambiguous action names", () => {
    const { domains, cart, write } = fixture();
    write("actions/setQuantity.ts");
    write("actions/set-quantity.ts");
    expect(() => discoverDomains(domains)).toThrow("Duplicate action");
    fs.unlinkSync(path.join(cart, "queries/state.ts"));
    expect(() => discoverDomains(domains)).toThrow("requires queries/state.ts");
  });
  it("generates typed public UI entries without requiring injected props at JSX sites", () => {
    const { root, domains, write } = fixture();
    write("ui/client/Quantity.tsx", ui);
    write("ui/client/Plain.tsx", "export default function Plain() { return null; }");
    expect(discoverUI(domains).map((entry) => entry.module)).toEqual(["mortise:ui/cart/Quantity"]);
    const generated = generateTypes(root);
    expect(generated).toHaveLength(2);
    const declaration = fs.readFileSync(path.join(root, ".mortise/ui.d.ts"), "utf8");
    expect(declaration).toContain('declare module "mortise:ui/cart/Quantity"');
    expect(declaration).toContain("Parameters<View>[0] extends { props: infer P }");
    expect(declaration).toContain("ComponentType<ExternalProps>");
    expect(declaration).not.toContain("mortise:ui/cart/Plain");
  });
});

describe("HTTP server boundary", () => {
  it("creates a client registry containing metadata imports only", () => {
    const { domains, write } = fixture();
    write("actions/setQuantity.ts", 'export default { secret: "ACTION_SECRET_SENTINEL" };');
    const code = createDomainModule(discoverDomains(domains), { transport: "http", endpoint: "/rpc" });
    expect(code).toContain("createRemoteDomain");
    expect(code).toContain('endpoint: "/rpc"');
    expect(code).toContain("domain.ts");
    expect(code).not.toContain("queries/");
    expect(code).not.toContain("actions/");
    expect(code).not.toContain("attachDomain");
  });

  async function bundle(root: string, input: string, ssr = false) {
    const output = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [mortise({ transport: "http" })],
      build: {
        write: false,
        minify: false,
        ...(ssr ? { ssr: input } : {}),
        rollupOptions: { input, external: ["@mortise/core"] },
      },
    }) as { output: ({ type: "chunk"; code: string } | { type: "asset" })[] };
    return output.output.filter((chunk) => chunk.type === "chunk").map((chunk) => chunk.code).join("\n");
  }

  it("keeps query and action implementations out of the actual browser build", async () => {
    const { root, write } = fixture();
    write("queries/state.ts", 'export default { secret: "QUERY_SECRET_SENTINEL" };');
    write("actions/setQuantity.ts", 'export default { secret: "ACTION_SECRET_SENTINEL" };');
    const entry = path.join(root, "entry.ts");
    fs.writeFileSync(entry, 'import { cart } from "mortise:domains"; console.log(cart);');
    const code = await bundle(root, entry);
    expect(code).toContain("createRemoteDomain");
    expect(code).not.toContain("QUERY_SECRET_SENTINEL");
    expect(code).not.toContain("ACTION_SECRET_SENTINEL");
  });

  it("rejects a server registry import from the browser but allows an SSR build", async () => {
    const { root, write } = fixture();
    write("queries/state.ts", 'export default { run: () => "QUERY_SERVER_SENTINEL" };');
    const entry = path.join(root, "entry.ts");
    fs.writeFileSync(entry, 'import domains from "mortise:server-domains"; export default domains; console.log(domains);');
    await expect(bundle(root, entry)).rejects.toThrow("SSR-only");
    const code = await bundle(root, entry, true);
    expect(code).toContain("QUERY_SERVER_SENTINEL");
    expect(code).toContain("attachDomain");
  });

  it("rejects transitive browser imports of server implementations", async () => {
    const { root, write } = fixture();
    write("actions/setQuantity.ts", "export default { run: () => 42 };");
    fs.writeFileSync(path.join(root, "helper.ts"), 'export { default } from "./src/domains/cart/actions/setQuantity";');
    const entry = path.join(root, "entry.ts");
    fs.writeFileSync(entry, 'import action from "./helper"; console.log(action);');
    await expect(bundle(root, entry)).rejects.toThrow("Server-only domain module");
  });
});

describe("RSC folder boundaries", () => {
  function configured(root: string, rsc = true) {
    const plugin = mortise({ rsc });
    // Exercise environment-dependent hooks directly; official RSC execution is integration-tested by the app.
    (plugin.configResolved as Function)({ root });
    const transform = (source: string, file: string, environment: string) =>
      (plugin.transform as Function).call({ environment: { name: environment } }, source, file, { ssr: environment !== "client" });
    return { plugin, transform };
  }

  it("adds a client boundary to ordinary folder components, not only injected UI", () => {
    const { root, cart, write } = fixture();
    const source = "export default function Button() { return <button>Click</button>; }";
    write("ui/client/Button.tsx", source);
    const { transform } = configured(root);
    for (const environment of ["client", "ssr", "rsc"]) {
      expect(transform(source, path.join(cart, "ui/client/Button.tsx"), environment).code).toBe(`"use client";\n${source}`);
    }
  });

  it("adds the directive before an injected hook wrapper and preserves existing directives", () => {
    const { root, cart, write } = fixture();
    write("ui/client/Quantity.tsx", ui);
    const result = configured(root).transform(ui, path.join(cart, "ui/client/Quantity.tsx"), "rsc");
    expect(result.code.startsWith('"use client";')).toBe(true);
    expect(result.code).toContain("__mortiseUseCapability(QuantityEditable)");
    const marked = '"use client";\nexport default function Button() { return null; }';
    expect(withClientDirective(marked, "Button.tsx")).toBe(marked);
    expect(() => withClientDirective('"use server";\nexport async function action() {}', "Button.tsx")).toThrow("cannot declare 'use server'");
  });

  it("allows server UI only in the named rsc environment with rsc enabled", () => {
    const { root, cart, write } = fixture();
    const source = "export default async function Cart() { return <h1>Cart</h1>; }";
    write("ui/server/Cart.tsx", source);
    const file = path.join(cart, "ui/server/Cart.tsx");
    const { transform } = configured(root);
    expect(transform(source, file, "rsc")).toBeNull();
    expect(() => transform(source, file, "ssr")).toThrow("only execute in the 'rsc' environment");
    expect(() => transform(source, file, "client")).toThrow("Server-only domain module");
    expect(() => configured(root, false).transform(source, file, "rsc")).toThrow("not implemented");
  });

  it("keeps public domains remote in every environment and server registry private", () => {
    const { root, write } = fixture();
    write("actions/setQuantity.ts", 'export default { secret: "SERVER_ONLY_SENTINEL" };');
    const { plugin } = configured(root);
    for (const environment of ["client", "ssr", "rsc"]) {
      const context = { environment: { name: environment } };
      const code = (plugin.load as Function).call(context, "\0mortise:domains", { ssr: environment !== "client" });
      expect(code).toContain("createRemoteDomain");
      expect(code).not.toContain("actions/");
      expect(code).not.toContain("queries/");
    }
    expect(() => (plugin.resolveId as Function).call({ environment: { name: "client" } }, "mortise:server-domains", undefined, { ssr: true })).toThrow("SSR-only");
    expect((plugin.resolveId as Function).call({ environment: { name: "rsc" } }, "mortise:server-domains", undefined, { ssr: false })).toBe("\0mortise:server-domains");
  });
});
