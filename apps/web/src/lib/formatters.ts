/**
 * Pre-allocated Intl.NumberFormat instance for high-throughput USD formatting.
 */
const usdNumberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Hardened USD currency formatter.
 *
 * Guarantees:
 * - Non-finite values (null, undefined, NaN, Infinity) format strictly as '$0.00'.
 * - Signed zero and near-zero values (< 0.005) format strictly as '$0.00' (no -$0.00 or +$0.00).
 * - Negative values format as '-$XX.XX'.
 * - Positive values format as '+$XX.XX' when showPlus is true, otherwise '$XX.XX'.
 *
 * @param val - The numerical amount to format
 * @param showPlus - Whether to prepend '+' for positive values
 * @returns Formatted USD string
 */
export function formatUsd(val: number | null | undefined, showPlus: boolean = false): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return '$0.00';
  }

  if (Math.abs(val) < 0.005) {
    return '$0.00';
  }

  if (val < 0) {
    const absFormatted = usdNumberFormatter.format(Math.abs(val));
    return `-$${absFormatted}`;
  }

  const formatted = usdNumberFormatter.format(val);
  return showPlus ? `+$${formatted}` : `$${formatted}`;
}
