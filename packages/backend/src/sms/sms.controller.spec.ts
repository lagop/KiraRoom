import { SmsController } from "./sms.controller";
import { SmsService } from "../notifications/services/sms.service";

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

  it("POST /sms/test no longer exists (channels audit M8)", () => {
    expect((SmsController.prototype as any).test).toBeUndefined();
  });
});
