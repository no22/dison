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

This example needs `@no22/dison` itself installed as a dependency,
since the generated files import their shared runtime from
`"@no22/dison/runtime"`. If you're running this from inside a clone of
the Dison repo itself, `npm link` (once, globally) and then
`npm link @no22/dison` (in this repo) sets that up.

```bash
npx dison sample/multi-file-collision/user-module.dis sample/multi-file-collision/admin-module.dis sample/multi-file-collision/main.dis
npx tsx sample/multi-file-collision/main.ts
```

Expected output:

```
user: mock user repository
admin: mock admin repository
```
