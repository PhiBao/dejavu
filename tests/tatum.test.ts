import { describe, it, expect } from "vitest";
import {
  blobIdToDecimal,
  decimalToBlobId,
  daysRemaining,
  epochsRemaining,
  expiryDate,
  checkDelegate,
  type MemWalAccountOnchain,
} from "@/lib/tatum";

/**
 * Blob-id codec: Walrus ids are the uint256 content id as 32 little-endian
 * bytes, base64url, unpadded. Verified against mainnet: the decoded id fetched
 * from the public aggregator returned the real blob.
 */
describe("walrus blob id codec", () => {
  const SAMPLE = "pAnqCNwkYFRxO2uspf01uxN3kWeSGmWTjsc32Azo7PE";
  const DECIMAL =
    "109425973967297115080064029421121778631043468508169779269802851722945549175204";

  it("decodes a real mainnet blob id to its u256", () => {
    expect(blobIdToDecimal(SAMPLE)).toBe(DECIMAL);
  });

  it("round-trips decimal -> blob id -> decimal", () => {
    expect(decimalToBlobId(DECIMAL)).toBe(SAMPLE);
    expect(blobIdToDecimal(decimalToBlobId(DECIMAL)!)).toBe(DECIMAL);
  });

  it("rejects garbage instead of throwing", () => {
    expect(decimalToBlobId("not-a-number")).toBeNull();
    expect(blobIdToDecimal("")).toBeNull();
  });
});

describe("storage lifetime math", () => {
  it("computes remaining epochs and days", () => {
    expect(epochsRemaining(55, 41)).toBe(14);
    expect(daysRemaining(55, 41)).toBe(196);
  });

  it("never goes negative for expired blobs", () => {
    expect(epochsRemaining(40, 41)).toBe(0);
    expect(daysRemaining(40, 41)).toBe(0);
  });

  it("projects an ISO expiry date in the future", () => {
    const d = new Date(expiryDate(55, 41)).getTime();
    expect(d).toBeGreaterThan(Date.now());
    expect(d - Date.now()).toBeGreaterThan(190 * 86400_000);
  });
});

describe("delegate authorization check", () => {
  const account: MemWalAccountOnchain = {
    objectId: "0xacc",
    owner: "0xowner",
    active: true,
    quarantined: false,
    createdAt: 0,
    delegates: [
      {
        label: "Web App",
        publicKeyHex: "ef0c967b7f85bafe9fd697aa26999c74afbc28dcb0d3e3f975b1f8de7a64eec4",
        suiAddress: "0x797b1088b9e211beb3b962a586848f14e722ade38bcb9511bb65d096169a05d3",
        createdAt: 0,
      },
    ],
  };

  it("matches by public key", () => {
    const r = checkDelegate(
      account,
      "ef0c967b7f85bafe9fd697aa26999c74afbc28dcb0d3e3f975b1f8de7a64eec4",
      "0x000",
    );
    expect(r.registered).toBe(true);
    expect(r.matchedLabel).toBe("Web App");
  });

  it("matches by sui address, case-insensitively", () => {
    const r = checkDelegate(
      account,
      "deadbeef",
      "0x797B1088B9E211BEB3B962A586848F14E722ADE38BCB9511BB65D096169A05D3",
    );
    expect(r.registered).toBe(true);
  });

  it("rejects a key that is not onchain", () => {
    const r = checkDelegate(account, "deadbeef", "0xbeef");
    expect(r.registered).toBe(false);
    expect(r.matchedAddress).toBeNull();
  });
});
