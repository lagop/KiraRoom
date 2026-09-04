import { SmsController } from "./sms.controller";
import { SmsService } from "../notifications/services/sms.service";

function buildReq(role: string, tenantId: string) {
  return { user: { id: "u1", tenantId, role } } as any;
}

describe("SmsController", () => {
  let sms: jest.Mocked<SmsService>;

  beforeEach(() => {
    sms = {
      isConfigured: jest.fn(),
      sendSms: jest.fn(),
    } as any;
  });

  describe("GET /sms/status", () => {
    it("returns the configured flag without requiring a tenant plan", () => {
      sms.isConfigured.mockReturnValue(true);
      const ctrl = new SmsController(sms);
      const res = ctrl.status();
      expect(sms.isConfigured).toHaveBeenCalled();
      expect(res).toEqual({ configured: true });
    });

    it("returns configured:false when Twilio env is missing", () => {
      sms.isConfigured.mockReturnValue(false);
      const ctrl = new SmsController(sms);
      expect(ctrl.status()).toEqual({ configured: false });
    });
  });

  describe("POST /sms/test", () => {
    it("calls sendSms with the body and forwards the result", async () => {
      sms.sendSms.mockResolvedValue({ success: true, id: "SM123" });
      const ctrl = new SmsController(sms);
      const req = buildReq("owner", "tenant-1");
      const out = await ctrl.test(req, { to: "+34600000000", body: "hola" });
      expect(sms.sendSms).toHaveBeenCalledWith({
        to: "+34600000000",
        body: "hola",
      });
      expect(out).toEqual({
        success: true,
        id: "SM123",
        tenantId: "tenant-1",
      });
    });

    it("returns success:false when Twilio is not configured (no exception)", async () => {
      sms.sendSms.mockResolvedValue({
        success: false,
        error: "SMS service not configured",
      });
      const ctrl = new SmsController(sms);
      const req = buildReq("admin", "tenant-2");
      const out = await ctrl.test(req, { to: "+34600000000", body: "x" });
      expect(out.success).toBe(false);
      expect(out.error).toBe("SMS service not configured");
      expect(out.tenantId).toBe("tenant-2");
    });
  });
});
