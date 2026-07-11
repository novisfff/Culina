import { aiApi } from './aiApi';
import { authApi } from './authApi';
import { familyApi } from './familyApi';
import { foodsApi } from './foodsApi';
import { ingredientsApi } from './ingredientsApi';
import { inventoryStatesApi } from './inventoryStatesApi';
import { mediaApi } from './mediaApi';
import { recipesApi } from './recipesApi';
import { searchApi } from './searchApi';

export { API_BASE_URL, ApiError, getAccessToken, isApiError, setAccessToken } from './request';

export const api = {
  ...authApi,
  ...familyApi,
  ...ingredientsApi,
  ...inventoryStatesApi,
  ...recipesApi,
  ...foodsApi,
  ...aiApi,
  ...mediaApi,
  ...searchApi,
};
