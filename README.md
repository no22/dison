# Dison

Dison is an experimental DSL that transpiles to TypeScript. It builds
**property injection** directly into the language, so dependency
injection reads like ordinary class syntax instead of framework
boilerplate.

The transpiled output used to look like a `ServiceLocator`-style
registry under the hood — an implementation detail hidden below
Dison's own language semantics. Since 2.0 it usually doesn't even look
like that: when your wiring is declarative (which Dison encourages),
**static resolution** proves each injection decision at transpile time
and folds it into the code. The output is then just classes and plain
`new` expressions — no registry, no runtime helpers, no dependencies.
The registry remains only as a fallback for wiring that is genuinely
dynamic. See [Static resolution](#static-resolution-new-in-20).

## Install

```bash
npm install @no22/dison
```

(The package is published as `@no22/dison` — npm's name-similarity
policy rejected the unscoped name `dison` as too close to existing
packages. The CLI command itself is still just `dison`.)

This gives you the `dison` CLI (via `npx dison`) and, for multi-file
projects, a shared runtime importable as `@no22/dison/runtime`.

## Quick start

```dison
// user-service.dis
class SqlUserRepository {
  findById(id: string) {
    return { id, name: "real user" };
  }
}

class MockUserRepository extends SqlUserRepository {
  findById(id: string) {
    return { id, name: "mock user" };
  }
}

class UserService {
  injectable repo: SqlUserRepository;
}

configuration TestConfig {
  override UserService {
    repo = new MockUserRepository();
  }
}

activate TestConfig;

const service = new UserService();
console.log(service.repo.findById("42"));
```

Transpile it:

```bash
npx dison user-service.dis
# 🎉 Success: user-service.dis ➔ user-service.ts
```

The generated `user-service.ts` is plain TypeScript — compile and run
it with your normal toolchain (`tsc`, `tsx`, `ts-node`, ...).

## Syntax reference

Dison only interprets six keywords. Everything else in a `.dis` file
is ordinary TypeScript, passed through unchanged.

### `injectable`

Declares a lazily-resolved, overridable property inside a class body.

```dison
class UserService {
  injectable repo: SqlUserRepository;
}
```

Types that can't be auto-constructed with `new` need a resolution to come
from somewhere. Either bind them...

```dison
class UserService {
  injectable repo: IUserRepository;                       // new in 2.1
}

configuration { bind IUserRepository = SqlUserRepository; }
```

...or give a default initializer:

```dison
class UserService {
  injectable repo: IUserRepository = new SqlUserRepository();
}
```

Omitting the initializer (new in 2.1) requires a binding that is
*unconditionally* active — a top-level `configuration`/`bind`/`activate`, or
a class-scope configuration on the class's own prototype chain. If there is
none, the build fails with a message telling you to add either. This is what
lets an `interface` and the class that declares it need no knowledge of any
implementation; the `configuration` layer decides. Array, union and function
types can't participate in `bind` at all, so they still always require an
initializer.

### `configuration` / `activate`

Groups a set of `override`/`bind` statements. A **named** configuration is
reusable wiring; where you *place* it decides how far it reaches. Writing
`activate X;` is the short way to place one — since 3.0 it means exactly
`configuration extends X {}`, so the usual
[scope rules](#scoped-configuration-new-in-120) apply to it like anything
else:

```dison
configuration TestConfig {
  override UserService { repo = new MockUserRepository(); }
}

activate TestConfig;
```

To activate a configuration defined in another file:

```dison
activate TestConfig from "./configs";
```

#### Reuse and composition: `extends` (new in 2.1)

A configuration can inherit another one and state only its **delta**. This
makes wiring reusable and composable without depending on any class
hierarchy — configurations are just named bags of wiring:

```dison
configuration Production {
  bind Repository = PostgresRepository(DATABASE_URL);
  bind Clock = SystemClock;
}

configuration Test extends Production {
  bind Repository = InMemoryRepository;   // Clock comes from Production
}
```

Multiple parents are allowed (`configuration Full extends Base, Logging`).
Later wins: a child overrides its parents, and a right-hand parent overrides
a left-hand one. If two parents that are unrelated to each other wire the
same key, that is a build error rather than a silent coin flip — the child
must wire it explicitly to say which one it wants. Cycles are a build error
too.

#### Selecting a configuration at runtime (new in 2.3)

A parenthesised conditional picks between named configurations at runtime,
while keeping the wiring a single declarative statement:

```dison
configuration extends (isTest ? Test : Production) {}
configuration extends (mode === "dev" ? Dev : Production) {}   // nested is fine
```

Every branch must be a configuration name, so the transpiler still knows the
full set of candidates — it can inject the imports, keep the diagnostics
working, and tell you (via `--explain`) which configurations a key could come
from. Only the *choice* is dynamic; the shape stays static, and scope still
follows position, so this works in a class body or a function too.

Keys that **every** branch binds still count as guaranteed, so an
`injectable` of that type needs no default initializer.

#### Placing a configuration: anonymous `extends` (new in 2.1)

Naming a configuration decides **what** the wiring is; *where you write it*
decides **how far it reaches** (see [Scoped configuration](#scoped-configuration-new-in-120)).
Those two are independent, and an anonymous `configuration extends X { }`
is how you combine them: it splices `X`'s wiring into the scope it is
written in.

```dison
configuration extends Production {}                      // top level → global

class Service {
  configuration extends CachingWiring {}                 // class body → class scope
}

function underTest() {
  configuration extends Test {}                          // function body → local scope
  ...                                                    // undone at the end of the block
}

configuration extends Test { bind Clock = SystemClock; } // splice, plus a delta
```

In a multi-file project you don't import the configuration: Dison resolves
the name across the project and injects whatever import the generated code
needs, the same way it handles companion symbols.

`activate X;` is sugar for `configuration extends X {}` (new in 3.0), so the
two are interchangeable and there is only one rule to remember: **naming
carries reuse, position carries scope.**

```dison
activate Production;                      // top level → global
class Service { activate CachingWiring; } // class body → class scope (new in 3.0)
```

> **Changed in 3.0 — migration.** Before 3.0, `activate` was a dynamic
> switch that always mutated the global registry, wherever it ran. At the
> top level nothing changes. Inside a function or a conditional it would now
> mean a block-scoped configuration that is undone at the end of the block,
> so rather than change quietly, **3.0 rejects it with a build error** that
> names the replacement:
>
> - block-scoped is what you wanted → `configuration extends X {}`
> - the whole program should be rewired → move it to the top level, or
>   `configuration extends (cond ? X : Y) {}`
>   ([runtime selection](#selecting-a-configuration-at-runtime-new-in-23),
>   available since 2.3)
>
> Because every position whose meaning changed is an error, **a program that
> compiles under 3.0 behaves exactly as it did under 2.x.** 2.3 warns about
> the same positions if you want to migrate before upgrading.

#### Forward references (new in 1.5.0)

A configuration may reference classes declared **later in the same
file** — key evaluation is deferred until the wiring is first consulted,
so the natural "declarative header" style just works:

```dison
configuration { bind Repo = MockRepo; }   // at the top of the file

class Repo { ... }
class MockRepo extends Repo { ... }
class Service { injectable repo: Repo; }
```

This applies to `bind`, `override`, class-body configurations, and
`activate` alike. Registration *order* is still respected: if the same
type is bound twice, the registration that executes later wins, exactly
as if everything had been applied in place.

#### Scoped configuration (new in 1.2.0)

Where you write a `configuration` decides how far it reaches. An
**anonymous** `configuration { ... }` is auto-active (no `activate`
needed) for the place it's written:

- **Top level** → global, as before.
- **Inside a function/method body** → a **local scope**, lexically
  limited to the rest of that block. Great for per-test or per-request
  isolation — the wiring is undone automatically when the block ends,
  and concurrent async requests don't interfere.
- **Directly inside a class body** → a **class scope**: that class's
  declarative DI wiring, shared by all its instances and inherited by
  subclasses (which can override just the parts they change). If the
  same class body wires the same key twice, the last configuration
  wins (new in 1.6.0). Class scopes are lexical, so static resolution
  folds them at transpile time (new in 2.0) — including the differential
  case where a subclass re-wires only part of what its parent wired
  (new in 2.2).

```dison
class UserService {
  injectable repo: IUserRepository = new SqlUserRepository();
  configuration { bind IUserRepository = CachedUserRepository; }  // class scope
}

function underTest(): void {
  configuration { bind IUserRepository = MockUserRepository; }    // local scope
  new UserService().repo.findById("1");   // uses the Mock here...
}
// ...and the real (or class-scoped) wiring everywhere else.
```

Resolution priority is **local > class > global > default initializer**.
A dependency is wired according to the scope active where its *root*
object was constructed, and the whole lazily-built object graph follows
that same scope consistently.

In an `async` function body, entering a local scope is an **implicit
suspension point** (one microtask; new in 1.4.0). The configuration and
the code after it run in the function's own async context, so the scope
can never leak into the caller's code while the function is suspended
at an `await`. Everything else behaves as before: the scope stays
active across `await`s inside the function, concurrent async calls
remain isolated, and instances constructed inside the scope keep it.
Local configurations are rejected at transpile time inside **generator**
function bodies (sync or async), because the scope cannot be kept
across `yield` — put the configuration in the function that drives the
generator instead.

> Local scopes desugar to `using` + `AsyncLocalStorage`, so generated
> code that uses them needs `Symbol.dispose` (TypeScript 5.2+ / Node 20+)
> and `node:async_hooks` at runtime. See [Requirements](#requirements).

*(Only anonymous configurations can be **declared** in a local or class
scope, and they are auto-active there. A named configuration is always
declared at the top level and then placed where you need it, with
`activate X;` or the equivalent
[`configuration extends X {}`](#placing-a-configuration-anonymous-extends-new-in-21).)*

### `override`

Replaces a single property on a specific class:

```dison
override UserService {
  repo = new MockUserRepository();
}
```

An override targeting a base class also applies to instances of its
subclasses (new in 1.3.0) — consistent with the fact that `injectable`
properties are inherited. The most specific registration wins: if both
`override Service` and `override SubService` set the same property, a
`SubService` instance uses the latter. Across scopes the usual priority
(local > class > global) is checked first, so a local override targeting
a base class beats a global override targeting the subclass. Since 2.2 this
folds statically as well: each class in the hierarchy gets whichever getter
its own winner requires.

`override` can also be written standalone (not wrapped in a
`configuration`), which desugars to an immediate assignment — useful
inside a function to capture a lexical variable:

```dison
function createHarness(label: string) {
  class Tagged extends Base { tag = label; }
  override S { dep = new Tagged(); }
  return new S();
}
```

### `bind`

Replaces every use of a type, wherever it's requested (not just one
property):

```dison
bind SqlUserRepository = MockUserRepository;
```

`bind` supports generics on both sides (`bind Repository<User> = MockRepository;`)
and can be written standalone or inside a `configuration`, same as
`override`.

The replacement can take **constructor arguments** (new in 1.2.0), so
you can bind types whose constructor needs values:

```dison
bind Repository = PostgresRepository("postgres://localhost/db");
```

The arguments are type-checked against the replacement's constructor,
and a standalone `bind`'s arguments can capture local variables.

When bind chains redirect the replacement (`bind A = B("x"); bind B = C;`),
`A` resolves all the way to `new C()` and `B`'s arguments are not used —
arguments only matter on the *final* replacement of a chain. This is by
design: a chain replaces `B` wholesale, constructor call included.

### `token`

Most name clashes are resolved automatically (see *Automatic collision
resolution* below), so you rarely need this. `token` is the explicit
escape hatch for the one case Dison can't handle on its own: the same
interface or type-alias name coming from two *different external npm
packages*. Those types are declared outside your project, so Dison
can't attach a companion to them.

```dison
token RepoToken;

class S {
  injectable dep: SomePkgRepository as RepoToken = new Impl();
}

configuration Cfg {
  bind SomePkgRepository as RepoToken = Mock;
}
```

When such an unresolvable clash is detected, the CLI reports a build
error telling you to add a `token` / `as <token>`, rather than
silently letting one type collide with the other. An explicit token
also always wins if you want to override the automatic keying.

## Automatic collision resolution

`bind`/`injectable` match types by identity, not by name, so
same-named types in different files never collide — no tokens, no
coordination:

- **Classes** (concrete or `abstract`) are keyed by the class value
  itself, the same way `override` keys on the class. Two unrelated
  `class Foo` in two files are distinct runtime values.
- **Interfaces / type aliases** have no runtime value, so Dison
  generates a companion `Symbol` per declaration and keys on that.
  When you use such a type from another file, Dison injects the
  matching companion import automatically (it emits companions only
  for types actually used in DI).

So two files can each declare their own `IRepository` and use it in
`bind`/`injectable` with no ceremony; each module's `bind` only affects
its own. See [`sample/multi-file-collision/`](sample/multi-file-collision/).
The only clash Dison can't resolve this way is between types from two
different external packages — that's what [`token`](#token) is for.

## Multiple files

Pass more than one file to the CLI to transpile a project as a unit:

```bash
npx dison a.dis b.dis c.dis
```

Input files can live in different directories. The transpiler analyzes
the project as a whole: wiring it can prove static is folded directly
into the consuming getters (across files, via generated factory
functions — see [Static resolution](#static-resolution-new-in-20)),
and a fully-declarative project needs no runtime at all. Any dynamic
residue shares override/bind state through the `@no22/dison/runtime`
package export, so an `override`/`bind` activated in one file is
visible from classes defined in another — as long as they all resolve
`@no22/dison/runtime` to the same installed copy (in practice: they're part of the same project
and share a common `node_modules` ancestor, which is the normal case).

The CLI also fails the build with a specific fix suggestion when a
`bind`/`override` in one file could **never match** its declaration in
another — e.g. you bound a class without importing it, or imported it
`type`-only where the identity key needs the runtime value (new in
1.6.0). Previously such mistakes were silent no-ops unless you ran
`tsc`.

## Static resolution (new in 2.0)

Declarative wiring doesn't need to exist at runtime. For every
`injectable`, the transpiler tries to prove what the winner will be —
across `bind` chains, `override` inheritance, class scopes, and (in
multi-file mode) module evaluation order — and, when the proof
succeeds, folds it straight into the getter:

```ts
get repo(): Repository {
  if (!this._repo) { this._repo = new CachedRepository(); }
  return this._repo!;
}
```

When *every* injectable in a file folds, the registry machinery is not
emitted at all: the output is plain TypeScript with **zero runtime
dependencies**, and it runs anywhere. This applies to whole multi-file
projects too — cross-file winners are wired through generated factory
functions (direct calls, no shared registry), and a fully-declarative
project stops importing `@no22/dison/runtime` entirely.

What folds:

- injectables with no wiring at all (the default initializer);
- any wiring that executes before the first executable top-level
  statement — the "declarative header" style;
- wiring after executable statements, when the analysis can prove
  those statements cannot resolve the key (it traces the identifiers a
  statement mentions through declarations, imports, bind chains and
  override values);
- class-scope configurations, including inheritance;
- wiring that differs per subclass (new in 2.2) — the analysis computes a
  winner for each class in the hierarchy and re-declares the getter only on
  the classes whose winner actually differs from their parent's, letting the
  prototype chain do the dispatch at no runtime cost.

What stays on the registry — with the reason, which you can inspect
with **`dison --explain <file>`**:

```
UserService.repo   → new MockUserRepository()   [static: bind IRepository (top-level wiring)]
  └ AdminService.repo → new AdminRepository()   [static: override AdminService (top-level wiring)]
Chained.value      → runtime lookup             [dynamic: activated after executable top-level code]
Handler.db         → runtime lookup             [dynamic: bound in a local scope]
```

Lines indented under another are subclasses whose wiring diverges from their
parent's; they get their own generated getter.

Dynamic wiring keeps its exact 1.x behavior: wiring that runs after a key
was already used, configurations selected at runtime, local scopes, and
anything the analysis cannot prove. Static and dynamic keys coexist in
one file — each getter independently gets the cheapest form that
preserves behavior. `dison --no-static` disables folding and restores
the full 1.x registry output.

One **semantic change** comes with this (hence the major version): a
single-file transpile is now treated as self-contained. If a file's
wiring folds completely, its exported `activate...()` functions become
no-ops — importing a *separately transpiled* single-file module and
activating its configurations from outside no longer rewires it. That
pattern was never the supported route for cross-file wiring; pass all
files to the CLI together (multi-file mode) as before, or use
`--no-static`.

## Requirements

The generated code targets a modern TypeScript/Node toolchain, but
what it actually needs depends on how much of your wiring is static:

- **Fully-static output** (everything folded — see
  [Static resolution](#static-resolution-new-in-20)) is plain
  TypeScript with no imports and no special requirements. It runs in
  a browser, on the edge, anywhere. This includes fully-declarative
  multi-file projects, which since 2.0 emit no
  `@no22/dison/runtime` import at all.
- **TypeScript 5.2+** and **Node.js 20+** if you use **local scopes**
  (an anonymous `configuration` inside a function/method body). Those
  desugar to `using` + `AsyncLocalStorage`, which need `Symbol.dispose`
  and `node:async_hooks`. Your `tsconfig.json` needs a `lib` that
  includes `Symbol.dispose` (e.g. `"lib": ["esnext"]`) and
  `@types/node`.
- **Other dynamic wiring** (wiring placed after a key is already used, a
  configuration selected at runtime, ...) keeps the inlined registry in single-file
  output — without local scopes it uses a synchronous stub instead of
  `node:async_hooks` (since 1.6.0), so it still runs outside Node.
  Multi-file output with dynamic residue shares state through
  `@no22/dison/runtime`, which does import `node:async_hooks`, so such
  projects remain Node-oriented.

The runtime module (`@no22/dison/runtime`) is shipped pre-compiled, so
these requirements apply to *your generated `.ts` files*, not to the
package itself.

## Samples

See [`sample/`](sample/) for runnable, self-contained examples covering
`injectable`/`override`/`activate`, `bind` (including generics and
chaining), the declarative-header style and class scopes folded by
static resolution, a central-config project wired across files with
zero runtime dependencies, a four-file project separating contracts /
implementations / wiring / consumers, and a multi-file project where two files
declare their own same-named `IRepository` interface and Dison keeps
them apart automatically — no tokens needed.

## License

ISC
