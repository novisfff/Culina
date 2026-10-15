type ReadQuery = {
  data: unknown;
  isError: boolean;
  isFetching: boolean;
};

export type HomeInventoryReadState = {
  hasInventoryData: boolean;
  hasShoppingData: boolean;
  canSuggest: boolean;
  hasError: boolean;
  isFetching: boolean;
};

export function deriveHomeInventoryReadState(
  inventoryQueries: ReadQuery[],
  shoppingQuery: ReadQuery,
): HomeInventoryReadState {
  const queries = [...inventoryQueries, shoppingQuery];
  const hasInventoryData = inventoryQueries.every((query) => query.data !== undefined);
  const hasShoppingData = shoppingQuery.data !== undefined;
  const hasError = queries.some((query) => query.isError);
  return {
    hasInventoryData,
    hasShoppingData,
    hasError,
    isFetching: queries.some((query) => query.isFetching),
    canSuggest: hasInventoryData && hasShoppingData && !hasError,
  };
}
