export function flatAssetReturnRow(y, value = 0){
  return {
    y,
    usLarge: value,
    usSmall: value,
    intlDev: value,
    emerging: value,
    usBonds: value,
    cash: value,
    reit: value,
    gold: value,
  };
}
