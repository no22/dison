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
same type is not affected by another class's scope.

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
