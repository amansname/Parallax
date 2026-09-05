export function legacyHiddenSavingsAggregate(){
  return {
    annual: 105_000,
    split: {
      taxable: 12_000 / 105_000,
      traditional: 93_000 / 105_000,
      roth: 0,
    },
    unallocatedAnnual: 46_000,
    unallocatedSplit: { taxable: 0, traditional: 1, roth: 0 },
    entries: [
      {
        id: 'client-401k-saving', typeId: '401k', label: '401(k) deferral',
        owner: 'client', amount: 23_500, bucket: 'traditional',
      },
      {
        id: 'spouse-401k-saving', typeId: '401k', label: '401(k) deferral',
        owner: 'spouse', amount: 23_500, bucket: 'traditional',
      },
      {
        id: 'client-brokerage-saving', typeId: 'brokerage_taxable', label: 'Taxable brokerage',
        owner: 'client', amount: 12_000, bucket: 'taxable',
      },
    ],
  };
}
