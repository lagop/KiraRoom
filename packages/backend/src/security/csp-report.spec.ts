import { CspReportController } from "./csp-report.controller";
import { cleanUrl, parseCspReport } from "./csp-report";

/**
 * While the Content Security Policy is report-only, these reports are how we
 * learn whether enforcing it would break a page. Both browser formats are
 * read, query strings (which can carry tokens) are dropped, and a repeated
 * violation is logged once an hour.
 */

const legacy = {
  "csp-report": {
    "document-uri": "https://app.kiraroom.net/reset-password?token=secret-reset-token",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://evil.example/x.js?c=1",
    "source-file": "https://app.kiraroom.net/_next/static/chunks/app.js",
    "line-number": 12,
    disposition: "report",
  },
};

const reportingApi = [
  {
    type: "csp-violation",
    body: {
      documentURL: "https://salon-lucia.kiraroom.net/?professionalId=p1",
      effectiveDirective: "connect-src",
      blockedURL: "https://tracker.example/collect",
      disposition: "report",
    },
  },
  { type: "deprecation", body: { id: "x" } },
];

describe("parseCspReport", () => {
  it("reads the report-uri format and drops query strings", () => {
    const [v] = parseCspReport(legacy);
    expect(v.directive).toBe("script-src-elem");
    expect(v.blocked).toBe("https://evil.example/x.js");
    expect(v.page).toBe("https://app.kiraroom.net/reset-password");
    expect(JSON.stringify(v)).not.toContain("secret-reset-token");
    expect(v.source).toBe("https://app.kiraroom.net/_next/static/chunks/app.js:12");
  });

  it("reads the Reporting API format and ignores other report types", () => {
    const vs = parseCspReport(reportingApi);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ directive: "connect-src", blocked: "https://tracker.example/collect", page: "https://salon-lucia.kiraroom.net/" });
  });

  it("ignores junk", () => {
    expect(parseCspReport(null)).toEqual([]);
    expect(parseCspReport({ hello: 1 })).toEqual([]);
    expect(parseCspReport([{ type: "csp-violation" }])).toEqual([]);
    expect(parseCspReport({ "csp-report": {} })).toEqual([]);
  });

  it("keeps keywords like inline or eval as they are", () => {
    expect(cleanUrl("inline")).toBe("inline");
    expect(cleanUrl("eval")).toBe("eval");
    expect(cleanUrl(undefined)).toBe("");
  });
});

describe("CspReportController", () => {
  it("logs each distinct violation once an hour", () => {
    const c = new CspReportController();
    const warn = jest.fn();
    (c as any).logger = { warn };
    c.receive(legacy);
    c.receive(legacy);
    c.receive(reportingApi);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("would block script-src-elem: https://evil.example/x.js");
  });

  it("keeps a bounded memory of what it has logged", () => {
    const c = new CspReportController();
    (c as any).logger = { warn: jest.fn() };
    for (let i = 0; i < 600; i++) {
      c.receive({ "csp-report": { "effective-directive": "img-src", "blocked-uri": `https://x${i}.example/`, "document-uri": "https://app.kiraroom.net/" } });
    }
    expect((c as any).lastLogged.size).toBeLessThanOrEqual(500);
  });
});
