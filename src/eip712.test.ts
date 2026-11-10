import { describe, expect, it } from "vitest";
import { CANCEL_ALL_MARKETS, cancelAllMarketId, marketIdHash, orderMessage } from "./eip712";
import type { SignedOrder } from "./api/types";
import { localChain } from "./chain";

describe("order payload", () => {
  it("hashes market id as keccak of utf8 bytes", () => {
    expect(marketIdHash("smoke")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("maps SignedOrder to human-readable EIP-712 fields", () => {
    const o: SignedOrder = {
      trader: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      market_id: "BTC-USD-5M-test",
      side: "Yes",
      price: 600,
      size: 10,
      order_type: "Limit",
      tif: "GTC",
      nonce: 1,
      salt: 2,
      expires_at: 0,
      gas_fee: 10_000,
      chain_id: 31337,
      verifying_contract: "0x1111111111111111111111111111111111111111",
    };
    const m = orderMessage(o);
    expect(m.side).toBe("Yes");
    expect(m.price).toBe(600);
    expect(m.size).toBe(10_000_000n);
    expect(m.orderType).toBe("Limit");
    expect(m.tif).toBe("GTC");
    expect(m.marketId).toBe(o.market_id);
    expect(m.gasFee).toBe(10_000n);
  });

  it("CancelAll marketId is the market string or empty for all", () => {
    expect(cancelAllMarketId()).toBe(CANCEL_ALL_MARKETS);
    expect(cancelAllMarketId("")).toBe(CANCEL_ALL_MARKETS);
    expect(cancelAllMarketId("btc-5m-1")).toBe("btc-5m-1");
  });

  it("local chain is Hardhat 31337 not mainnet", () => {
    expect(localChain.id).toBe(31337);
    expect(localChain.id).not.toBe(1);
    expect(localChain.rpcUrls.default.http[0]).toMatch(/127\.0\.0\.1:8545|\/rpc$/);
  });
});
