const number = (value) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
};

const mapBalance = (row) => ({
  currency: row.currency,
  available: number(row.available),
  reserved: number(row.reserved),
  total: number(row.total ?? number(row.available) + number(row.reserved)),
  amount: number(row.amount),
});

export async function loadPartyProfile(client, partyId, partyKind) {
  if (!partyId || !partyKind) throw new Error("A party and party kind are required");
  const { data, error } = await client.rpc("sarraf_party_profile", {
    p_party_id: partyId,
    p_party_kind: partyKind,
  });
  if (error) throw error;
  return {
    party: data?.party || null,
    balances: (data?.balances || []).map(mapBalance),
    debts: data?.debts || [],
    transactions: data?.transactions || [],
    receipts: data?.receipts || [],
    payments: data?.payments || [],
    generatedAt: data?.generated_at || null,
  };
}

export async function loadCashReconciliation(client) {
  const { data, error } = await client.rpc("sarraf_cash_reconciliation");
  if (error) throw error;
  return {
    currencies: (data?.currencies || []).map((row) => ({
      currency: row.currency,
      physical: number(row.physical),
      system: number(row.system),
      held: number(row.held),
      debt: number(row.debt),
      difference: number(row.difference),
      status: row.status === "matched" ? "matched" : "discrepancy",
    })),
    generatedAt: data?.generated_at || null,
  };
}

export function summarizePartyCurrencies(rows) {
  return (rows || []).reduce((out, row) => {
    const currency = row.currency;
    if (!currency) return out;
    out[currency] = (out[currency] || 0) + number(row.total ?? row.amount);
    return out;
  }, {});
}
