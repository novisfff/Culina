import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
export function useIngredientQueries(args: { isAuthenticated: boolean; enabled: boolean; needsInventory: boolean; needsShopping: boolean; includeOperations: boolean }) {
  const ingredientsQuery = useQuery({ queryKey: queryKeys.ingredients, queryFn: () => api.getIngredients(), enabled: args.isAuthenticated && args.enabled });
  const inventoryQuery = useQuery({ queryKey: queryKeys.inventory, queryFn: () => api.getInventory(), enabled: args.isAuthenticated && args.needsInventory });
  const inventoryStatesQuery = useQuery({ queryKey: queryKeys.inventoryStates, queryFn: () => api.listInventoryStates(), enabled: args.isAuthenticated && args.needsInventory });
  const shoppingQuery = useQuery({ queryKey: queryKeys.shoppingList, queryFn: api.getShoppingList, enabled: args.isAuthenticated && args.needsShopping });
  const inventoryOperationsQuery = useQuery({ queryKey: queryKeys.inventoryOperationList(20), queryFn: () => api.listInventoryOperations({ limit: 20 }), enabled: args.isAuthenticated && args.includeOperations });
  return { ingredientsQuery, inventoryQuery, inventoryStatesQuery, shoppingQuery, inventoryOperationsQuery };
}
