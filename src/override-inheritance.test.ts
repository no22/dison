import { describe, it, expect } from "vitest";
import { runGenerated } from "./test-helpers";

// override の継承鎖照合（docs/override-inheritance.md）。
// ターゲットクラスを this.constructor から親方向へ遡って照合する（child-wins）。
// 優先度は scope-major: 各スコープ層（ローカル内→外 → クラス child→parent →
// グローバル）の中で継承鎖を歩き、最初にヒットした層が勝つ。

describe("override: 継承鎖照合（child-wins）", () => {
  it("親クラスを対象にしたoverrideがサブクラスのインスタンスにも適用される", () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class Mock extends Repo { name = "mock"; }
class Service { injectable repo: Repo; }
class SubService extends Service {}
configuration Cfg { override Service { repo = new Mock(); } }
activate Cfg;
module.exports = {
  base: (new Service() as any).repo.name,
  sub: (new SubService() as any).repo.name,
};
`);
    expect(mod.base).toBe("mock");
    expect(mod.sub).toBe("mock");
  });

  it("親・サブ両方にoverrideがある場合はサブクラス向けが優先される（child-wins）", () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class MockA extends Repo { name = "A"; }
class MockB extends Repo { name = "B"; }
class Service { injectable repo: Repo; }
class SubService extends Service {}
configuration Cfg {
  override Service { repo = new MockA(); }
  override SubService { repo = new MockB(); }
}
activate Cfg;
module.exports = {
  base: (new Service() as any).repo.name,
  sub: (new SubService() as any).repo.name,
};
`);
    expect(mod.base).toBe("A");
    expect(mod.sub).toBe("B");
  });

  it("プロパティ単位の差分合成: 親向けと子向けのoverrideがプロパティごとに独立して効く", () => {
    const mod = runGenerated(`
class Repo { name = "realRepo"; }
class Log { name = "realLog"; }
class MockRepo extends Repo { name = "mockRepo"; }
class MockLog extends Log { name = "mockLog"; }
class Service {
  injectable repo: Repo;
  injectable log: Log;
}
class SubService extends Service {}
configuration Cfg {
  override Service { repo = new MockRepo(); }
  override SubService { log = new MockLog(); }
}
activate Cfg;
const sub: any = new SubService();
module.exports = { repo: sub.repo.name, log: sub.log.name };
`);
    // repo は親向け、log はサブ向けの登録がそれぞれヒットする
    expect(mod.repo).toBe("mockRepo");
    expect(mod.log).toBe("mockLog");
  });

  it("孫クラスにも祖先のoverrideが届き、より近い祖先の登録が優先される", () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class MockBase extends Repo { name = "base"; }
class MockMid extends Repo { name = "mid"; }
class Service { injectable repo: Repo; }
class MidService extends Service {}
class LeafService extends MidService {}
configuration Cfg {
  override Service { repo = new MockBase(); }
  override MidService { repo = new MockMid(); }
}
activate Cfg;
module.exports = { leaf: (new LeafService() as any).repo.name };
`);
    expect(mod.leaf).toBe("mid");
  });
});

describe("override: 継承鎖照合とスコープ優先度（scope-major）", () => {
  it("ローカルの親向けoverrideがグローバルのサブ向けoverrideに勝つ", () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class MockG extends Repo { name = "global"; }
class MockL extends Repo { name = "local"; }
class Service { injectable repo: Repo; }
class SubService extends Service {}
configuration Cfg { override SubService { repo = new MockG(); } }
activate Cfg;
function inScope(): string {
  configuration { override Service { repo = new MockL(); } }
  return (new SubService() as any).repo.name;
}
const inside = inScope();
const outside = (new SubService() as any).repo.name;
module.exports = { inside, outside };
`);
    expect(mod.inside).toBe("local");
    expect(mod.outside).toBe("global");
  });

  it("ネストしたローカルスコープでも内側の親向けが外側のサブ向けに勝つ", () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class MockOuter extends Repo { name = "outer"; }
class MockInner extends Repo { name = "inner"; }
class Service { injectable repo: Repo; }
class SubService extends Service {}
function outer(): string {
  configuration { override SubService { repo = new MockOuter(); } }
  function inner(): string {
    configuration { override Service { repo = new MockInner(); } }
    return (new SubService() as any).repo.name;
  }
  return inner() + "/" + (new SubService() as any).repo.name;
}
module.exports = { v: outer() };
`);
    expect(mod.v).toBe("inner/outer");
  });

  it("クラス本体configuration内の親向けoverrideがサブクラスにも継承される", () => {
    const mod = runGenerated(`
class Repo { name = "real"; }
class Mock extends Repo { name = "mock"; }
class Service {
  injectable repo: Repo;
  configuration { override Service { repo = new Mock(); } }
}
class SubService extends Service {}
module.exports = {
  base: (new Service() as any).repo.name,
  sub: (new SubService() as any).repo.name,
};
`);
    expect(mod.base).toBe("mock");
    expect(mod.sub).toBe("mock");
  });
});
