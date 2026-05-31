import { describe, it, expect, beforeEach } from "vitest";
import { getDaemonPort, setDaemonPort, getBaseUrl } from "../renderer/api";

describe("api", () => {
  beforeEach(() => {
    setDaemonPort(15801);
  });

  it("getDaemonPort returns default port", () => {
    expect(getDaemonPort()).toBe(15801);
  });

  it("setDaemonPort updates port", () => {
    setDaemonPort(15900);
    expect(getDaemonPort()).toBe(15900);
  });

  it("getBaseUrl uses current port", () => {
    expect(getBaseUrl()).toBe("http://127.0.0.1:15801");
    setDaemonPort(15900);
    expect(getBaseUrl()).toBe("http://127.0.0.1:15900");
  });
});
