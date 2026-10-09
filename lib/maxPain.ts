// Max pain calculation — ported unchanged from the working "treasury-wheel-mobile" scaffold.
// Standard formula: for each candidate strike, sum (call pain + put pain) across all open
// interest; max pain is the strike that minimizes total option-writer payout.

export type ChainContract = {
  kind: "put" | "call";
  strike: number | null;
  openInterest: number | null;
};

export function calculateMaxPain(contracts: ChainContract[]): number | null {
  const usable = contracts.filter((contract) => contract.strike !== null && contract.openInterest !== null);
  const strikes = Array.from(new Set(usable.map((contract) => contract.strike as number))).sort((a, b) => a - b);
  const totalOi = usable.reduce((total, contract) => total + (contract.openInterest ?? 0), 0);
  if (!strikes.length || totalOi <= 0) return null;

  let minPain = Number.POSITIVE_INFINITY;
  let maxPain = strikes[Math.floor(strikes.length / 2)];

  for (const candidate of strikes) {
    const callPain = usable.reduce((total, contract) => {
      if (contract.kind !== "call" || contract.strike === null || contract.strike <= candidate) return total;
      return total + (contract.strike - candidate) * (contract.openInterest ?? 0);
    }, 0);
    const putPain = usable.reduce((total, contract) => {
      if (contract.kind !== "put" || contract.strike === null || contract.strike >= candidate) return total;
      return total + (candidate - contract.strike) * (contract.openInterest ?? 0);
    }, 0);
    const totalPain = callPain + putPain;
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPain = candidate;
    }
  }

  return maxPain;
}
