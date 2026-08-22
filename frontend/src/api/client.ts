import { aiApi } from './aiApi';
import { authApi } from './authApi';
import { familyApi } from './familyApi';
import { familyModelSettingsApi } from './familyModelSettingsApi';
import { foodsApi } from './foodsApi';
import { ingredientsApi } from './ingredientsApi';
import { inventoryOperationsApi } from './inventoryOperationsApi';
import { inventoryStatesApi } from './inventoryStatesApi';
import { mealLogsApi } from './mealLogsApi';
import { mediaApi } from './mediaApi';
import { modelUsageApi } from './modelUsageApi';
import { recipesApi } from './recipesApi';
import { searchApi } from './searchApi';

export { API_BASE_URL, ApiError, getAccessToken, isApiError, setAccessToken } from './request';

export const api = {
  ...authApi,
  ...familyApi,
  ...familyModelSettingsApi,
  ...ingredientsApi,
  ...inventoryStatesApi,
  ...inventoryOperationsApi,
  ...recipesApi,
  ...foodsApi,
  ...mealLogsApi,
  ...aiApi,
  ...mediaApi,
  ...searchApi,
  ...modelUsageApi,
};
