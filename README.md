# Dison

Dison is an experimental DSL that transpiles to TypeScript. It builds
**property injection** directly into the language, so dependency
injection reads like ordinary class syntax instead of framework
boilerplate.

The transpiled output happens to look like a `ServiceLocator`-style
registry under the hood — but that's an implementation detail of the
generated code, hidden below Dison's own language semantics. As a
Dison user you write `injectable`, `override`, `bind`, and `configuration`
declarations; you never touch the registry directly.

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

For types that can't be auto-constructed with `new`
(`interface`, `type` alias, `abstract class`, array/union/function
types), a default initializer is required:

```dison
class UserService {
  injectable repo: IUserRepository = new SqlUserRepository();
}
```

### `configuration` / `activate`

Groups a set of `override`/`bind` statements and activates them
explicitly:

```dison
configuration TestConfig {
  override UserService { repo = new MockUserRepository(); }
}

activate TestConfig;
```

`configuration` must be written at the top level. To activate a
configuration defined in another file:

```dison
activate TestConfig from "./configs";
```

### `override`

Replaces a single property on a specific class:

```dison
override UserService {
  repo = new MockUserRepository();
}
```

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

Input files can live in different directories. Their generated output
shares override/bind state through the `@no22/dison/runtime` package
export, so an `override`/`bind` activated in one file is visible from
classes defined in another — as long as they all resolve
`@no22/dison/runtime` to the same installed copy (in practice: they're part of the same project
and share a common `node_modules` ancestor, which is the normal case).

## Samples

See [`sample/`](sample/) for runnable, self-contained examples covering
`injectable`/`override`/`activate`, `bind` (including generics and
chaining), and a multi-file project where two files declare their own
same-named `IRepository` interface and Dison keeps them apart
automatically — no tokens needed.

## License

ISC
