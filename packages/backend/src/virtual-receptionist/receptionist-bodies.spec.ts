import { VirtualReceptionistController } from "./virtual-receptionist.controller";
import {
  CreateLlmProviderConfigDto,
  TestLlmProviderDto,
  UpdateLlmProviderConfigDto,
} from "./dto/receptionist-bodies.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

describe("virtual receptionist bodies", () => {
  it("are validated classes, not zod type aliases", () => {
    const C = VirtualReceptionistController;
    expect(bodyMetatype(C, "createLLMConfig")).toBe(CreateLlmProviderConfigDto);
    expect(bodyMetatype(C, "updateLLMConfig")).toBe(UpdateLlmProviderConfigDto);
    expect(bodyMetatype(C, "testLLMProvider")).toBe(TestLlmProviderDto);
  });

  it("an LLM test names a known provider", async () => {
    const parse = bodyParser(VirtualReceptionistController, "testLLMProvider");
    expect(await parse({ provider: "anthropic", apiKey: "k" })).toEqual({ provider: "anthropic", apiKey: "k" });
    await expect(parse({ provider: "skynet", apiKey: "k" })).rejects.toBeDefined();
  });
});
