import { describe, test } from "node:test";
import { expect } from "expect";
import { scopeFor } from "./discovery.ts";

// Default REV_PERSONAL_HOSTS: git.naps.pt (shared/tuning.ts).
describe("scopeFor", () => {
  test("personal-host remotes are personal, whatever the org", () => {
    expect(scopeFor("https://git.naps.pt/yolo/rev.git")).toBe("personal");
    expect(scopeFor("https://git.naps.pt/bullish/mvp.git")).toBe("personal");
    expect(scopeFor("https://user:token@git.naps.pt/yolo/private.git")).toBe("personal");
  });

  test("other remotes bucket by owner org", () => {
    expect(scopeFor("git@github.com:subvisual/bullish.git")).toBe("subvisual");
    expect(scopeFor("https://github.com/subvisual/antseed")).toBe("subvisual");
    expect(scopeFor("https://github.com/tesser-payments/platform.git")).toBe("tesser-payments");
    expect(scopeFor("ssh://git@github.com/Subvisual/x.git")).toBe("subvisual");
  });

  test("no remote or unparseable remote is personal", () => {
    expect(scopeFor(null)).toBe("personal");
    expect(scopeFor("not a url")).toBe("personal");
  });
});

test("personal owners are personal on any host", () => {
  expect(scopeFor("git@github.com:naps62/finance-planning.git")).toBe("personal");
});
