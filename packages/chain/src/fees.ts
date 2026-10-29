import {
  RENEW_FEE_PLANCK,
  STORE_FEE_BASE_PLANCK,
  STORE_FEE_PER_BYTE_PLANCK,
  TPOT_DECIMALS,
} from "@memdot/config";
import { getFakeTxCreator } from "polkadot-api/tx-creator";
import type { PortaldotApi } from "./client.js";

/** Instant quote from the measured linear model; use for previews, not for the final confirm. */
export function quoteStoreFee(bytes: number): bigint {
  return STORE_FEE_BASE_PLANCK + STORE_FEE_PER_BYTE_PLANCK * BigInt(bytes);
}

export function quoteRenewFee(): bigint {
  return RENEW_FEE_PLANCK;
}

/** Exact fee from the runtime. Ships the whole payload to the node, so call it once at confirm. */
export function estimateStoreFee(
  api: PortaldotApi,
  payerAddress: string,
  data: Uint8Array,
): Promise<bigint> {
  return api.tx.TransactionStorage.store({ data }).getEstimatedFees(getFakeTxCreator(payerAddress));
}

export function formatTpot(planck: bigint, fractionDigits = 4): string {
  const unit = 10n ** BigInt(TPOT_DECIMALS);
  const whole = planck / unit;
  const fraction = (planck % unit).toString().padStart(TPOT_DECIMALS, "0").slice(0, fractionDigits);
  return `${whole}.${fraction} tPOT`;
}
