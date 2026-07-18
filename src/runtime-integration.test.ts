import { describe, it, expect } from "vitest";
import { runGenerated } from "./test-helpers";

describe("ランタイム統合テスト（生成コードを実際に実行して検証）", () => {
  it("優先順位: override > bind > 既定初期化式", () => {
    const mod = runGenerated(`
class Base {}
class ViaDefault extends Base { name = "default"; }
class ViaBind extends Base { name = "bind"; }
class ViaOverride extends Base { name = "override"; }

class S {
  injectable dep: Base = new ViaDefault();
}

configuration Cfg {
  bind Base = ViaBind;
  override S {
    dep = new ViaOverride();
  }
}
activate Cfg;

module.exports = { name: (new S() as any).dep.name };
`);
    expect(mod.name).toBe("override");
  });

  it("bindのみ活性化されている場合はbindが既定初期化式より優先される", () => {
    const mod = runGenerated(`
class Base {}
class ViaDefault extends Base { name = "default"; }
class ViaBind extends Base { name = "bind"; }

class S {
  injectable dep: Base = new ViaDefault();
}

configuration Cfg {
  bind Base = ViaBind;
}
activate Cfg;

module.exports = { name: (new S() as any).dep.name };
`);
    expect(mod.name).toBe("bind");
  });

  it("activateしていなければ既定初期化式のまま", () => {
    const mod = runGenerated(`
class Base {}
class ViaDefault extends Base { name = "default"; }
class ViaBind extends Base { name = "bind"; }

class S {
  injectable dep: Base = new ViaDefault();
}

configuration Cfg {
  bind Base = ViaBind;
}

module.exports = { name: (new S() as any).dep.name };
`);
    expect(mod.name).toBe("default");
  });

  it("bindは連鎖する（bind A = B; bind B = C;）", () => {
    const mod = runGenerated(`
class A {}
class B extends A {}
class C extends B { name = "C"; }

class S { injectable dep: A = new A(); }

configuration Cfg {
  bind A = B;
  bind B = C;
}
activate Cfg;

module.exports = { name: (new S() as any).dep.name };
`);
    expect(mod.name).toBe("C");
  });

  it("bindの循環参照は分かりやすいエラーになる", () => {
    expect(() =>
      runGenerated(`
class A {}
class B extends A {}

class S { injectable dep: A = new A(); }

configuration Cfg {
  bind A = B;
  bind B = A;
}
activate Cfg;

module.exports = { name: (new S() as any).dep.name };
`)
    ).toThrow(/circular/);
  });

  it("ジェネリクスbindが空白の書き方に関わらず実際に解決される", () => {
    const mod = runGenerated(`
interface Repository<T> { find(): T; }
class Real implements Repository<{ id: string }> { find() { return { id: "real" }; } }
class Mock implements Repository<{ id: string }> { find() { return { id: "mock" }; } }

class S {
  injectable dep: Repository < { id: string } > = new Real();
}
configuration Cfg {
  bind Repository<{id:string}> = Mock;
}
activate Cfg;

module.exports = { id: (new S() as any).dep.find().id };
`);
    expect(mod.id).toBe("mock");
  });

  it("複数activateの実行順序: 後からactivateした方が勝つ", () => {
    const mod = runGenerated(`
class Base {}
class First extends Base { name = "first"; }
class Second extends Base { name = "second"; }

class S { injectable dep: Base = new Base(); }

configuration Cfg1 { bind Base = First; }
configuration Cfg2 { bind Base = Second; }
activate Cfg1;
activate Cfg2;

module.exports = { name: (new S() as any).dep.name };
`);
    expect(mod.name).toBe("second");
  });
});
