# Samples

A few self-contained `.dis` examples showing what Dison's syntax looks
like in practice. Each one is plain source — run it through the CLI
yourself to see the generated TypeScript and its output.

First, install dependencies and build once from the repo root:

```bash
npm install
```

## 01-basic-di.dis

The core pattern: `injectable` + `override` + `configuration` +
`activate`, in a single file. Shows a class resolving to its real
implementation by default, then to a mock after a configuration is
activated.

```bash
npx dison sample/01-basic-di.dis
npx tsx sample/01-basic-di.ts
```

## 02-bind-and-generics.dis

`bind`, which replaces a type everywhere it's requested rather than
one property at a time. Shows an interface-typed injectable, a
generic `Repository<T>` bind, and bind chaining (`bind A = B; bind B = C;`).

```bash
npx dison sample/02-bind-and-generics.dis
npx tsx sample/02-bind-and-generics.ts
```

## 03-declarative-header.dis

The "declarative header" style, and static resolution (new in 2.0):
all wiring sits above the first executable statement, so the
transpiler proves each injectable's winner at compile time and folds
it straight into the getter. The generated file has **no registry and
no runtime helpers at all** — compare its size with the output of
`--no-static`. Use `--explain` to see each decision and its reason.

```bash
npx dison --explain sample/03-declarative-header.dis
npx tsx sample/03-declarative-header.ts
```

## 04-class-scope.dis

Class-scope configuration (an anonymous `configuration { ... }` inside
a class body) as a class's own declarative wiring, inherited by
subclasses — and folded statically, because a class scope is lexical.
Also shows the precision of the analysis: an unrelated class using the
same type is not affected by another class's scope, and a subclass that
re-wires only part of what its parent wired gets its own generated getter
while its siblings keep inheriting (new in 2.2 — run with `--explain` to
see the diverging subclass listed under its parent).

```bash
npx dison --explain sample/04-class-scope.dis
npx tsx sample/04-class-scope.ts
```

## central-config/

A 2-file project where the entry module (`app.dis`) is the composition
root: it imports the service layer and declares all wiring in one
place, including a constructor argument captured from a local
constant. Static resolution handles this **across files** via factory
hoisting — `app.ts` exports a generated factory function for the bind
expression, and the getter in `services.ts` calls it directly. No
shared registry, no runtime import: the generated project has zero
runtime dependencies.

```bash
npx dison sample/central-config/services.dis sample/central-config/app.dis
npx tsx sample/central-config/app.ts
```

Expected output:

```
42 (postgres @ postgres://localhost/app)
```

## three-layer/

The layering Dison is built for, in four files: **contracts** (`interface`
only), **implementations** (classes that know the contracts), **wiring**
(`configuration`s that decide which implementation wins), and a **service**
that declares what it needs and knows none of the above.

Two 2.1 features make the separation complete:

- `configuration Test extends Production { ... }` — configurations inherit
  from each other, so `Test` states only its delta. Reuse and extension of
  wiring, with no dependency on any class hierarchy.
- `injectable repo: Repository;` — no default initializer naming an
  implementation. It can be omitted whenever the wiring guarantees a
  binding, so the declaration site no longer has to know one.

`app.dis` composes by *placing* a configuration: an anonymous
`configuration extends Production {}` splices that wiring into the scope
it's written in. Nothing is imported from `wiring.dis` — Dison resolves the
name across the project and injects whatever import the generated code
needs. The whole project folds statically and imports no runtime.

```bash
npx dison --explain sample/three-layer/contracts.dis sample/three-layer/implementations.dis \
          sample/three-layer/wiring.dis sample/three-layer/service.dis sample/three-layer/app.dis
npx tsx sample/three-layer/app.ts
```

Write that same splice **inside a function** instead and it becomes a local
scope — the wiring applies only within the block and is undone at the end:

```dison
export function underTest(): string {
  configuration extends Test {}
  return new ReportService().render("42");
}
```

That keeps those keys on the runtime registry, by design: a scope that can
be entered and left cannot be folded away. It's the same trade the
[Static resolution](../README.md#static-resolution-new-in-20) section
describes — declarative production wiring folds, dynamic test wiring stays.

## multi-file-collision/

A 3-file project (`user-module.dis`, `admin-module.dis`, `main.dis`)
demonstrating cross-file dependency injection and **automatic
collision resolution**. `user-module.dis` and `admin-module.dis` each
declare their own, unrelated `IRepository` interface — the same name,
in two different files — with **no tokens and no coordination** between
them. Each module's `bind` only affects its own `IRepository`.

Dison handles this automatically: every interface/type-alias
declaration gets its own generated companion `Symbol`, so two
same-named interfaces are distinct keys at runtime and never collide
across files. (Concrete classes work the same way, keyed by the class
value itself.) You only need the explicit `token` / `as <token>`
syntax when the clashing types come from two *different external npm
packages*, which Dison can't generate companions for — see the `token`
section in the top-level README.

Since 2.0, static resolution folds this whole project — the generated
files import no shared runtime, so nothing needs to be installed to
run them. (With `--no-static`, the generated files import their shared
runtime from `"@no22/dison/runtime"` instead, which then requires
`@no22/dison` to be installed as a dependency of the target project.)

```bash
npx dison sample/multi-file-collision/user-module.dis sample/multi-file-collision/admin-module.dis sample/multi-file-collision/main.dis
npx tsx sample/multi-file-collision/main.ts
```

Expected output:

```
user: mock user repository
admin: mock admin repository
```
