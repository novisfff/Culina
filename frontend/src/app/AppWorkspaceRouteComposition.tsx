import { AppWorkspaceRouter, WorkspaceRouteBoundary } from './AppWorkspaceRouter';
import { AppAiWorkspaceRoute } from './AppAiWorkspaceRoute';
import { AppFoodWorkspaceRoute } from './AppFoodWorkspaceRoute';
import { AppIngredientWorkspaceRoute } from './AppIngredientWorkspaceRoute';
import { AppHomeWorkspaceRoute } from './AppHomeWorkspaceRoute';
import { AppEatWorkspaceRoute } from './AppEatWorkspaceRoute';
import { AppMealLogWorkspaceRoute } from './AppMealLogWorkspaceRoute';
import { AppFamilyWorkspaceRoute } from './AppFamilyWorkspaceRoute';
import { InventoryOperationBanner } from '../features/inventory/InventoryOperationBanner';
import { useAppEatTaskBodyArgs } from './useAppEatTaskBodyArgs';
import { useAppEatTaskResolutionArgs } from './useAppEatTaskResolutionArgs';

export function AppWorkspaceRouteComposition({ context }: { context: any }) {
  const {
    navigation, recipes, foods, ingredients, inventoryItems, mealLogs, foodPlanItems, members,
    foodPlanDetail, foodPlanDetailQuery, recipesQuery, foodsQuery, mealLogsQuery, mealLogsFetching,
    mealRecordResultState, cookRecipeMutation, recordMealMutation, completeFoodPlanItemMutation,
    updateFoodPlanItemMutation, deleteFoodPlanItemMutation, createFoodPlanItemMutation, createShoppingMutation,
    updateFoodMutation, updateRecipeMutation, createFoodMutation, toggleFavoriteMutation, createRecipeMutation,
    updateMealMutation, foodScenes, foodPlanWeekRange, foodPlanNavigationRequest, isPhoneViewport,
    inventoryStates, shoppingItems, recentMeals, mealInsights, mealInsightsQuery, aiConversations, aiConversationsQuery,
    dashboardPlanDays, previewCookRecipeMutation, businessDateKey, updateShoppingMutation,
    createFoodSceneMutation, updateFoodSceneMutation, deleteFoodSceneMutation, updateMealCompositionMutation,
    openOperationHistory, recentBannerOperation, revertInventoryOperationMutation, handleRevertInventoryOperation,
    ingredientNavigationRequest, consumeIngredientNavigationRequest, createIngredientMutation,
    updateIngredientMutation, transitionIngredientTrackingModeMutation, createInventoryMutation,
    upsertInventoryStateMutation, consumeInventoryMutation, disposeExpiredInventoryMutation,
    snoozeInventoryExpiryAlertsMutation, correctInventoryExpiryDateMutation, deleteShoppingMutation,
    mobileNotificationCenter, inventoryAlerts, dashboardStats, desktopRecommendations, mobileRecommendations,
    dashboardRecommendationItems, homeInventoryActionGroups, hasLaterInventoryActionGroups,
    hasFullListInventoryActionGroups, homeRequiredActions, hasMoreHomeActions, activeFoodPlanItems,
    foodRecommendations, pendingShoppingCount, pendingShoppingPreview, homeHighlightsViewModel,
    selectedDashboardPlanDay, selectedDashboardPlanDateLabel, selectedPlanSummary, homeBusinessDateKey,
    recordMeal, loadMealCandidates, showNextDesktopRecommendations, showNextMobileRecommendation,
    startRecommendedRecipe, startPlanRecipe, setSelectedDashboardPlanDate, openHomePlanAddDialog,
    openHomePlanAddEmptyDialog, openHomePlanDetail, openHomeRestock, handleOpenActionGroup,
    openIngredientShopping, openIngredientCreate, openIngredientPriority, openShoppingIntake,
    openFamilyActivity, openFoodPlanWeek, retryHomeHighlights, openReconciliation,
    foodPlanWeekNavigation, startRecipeCook, startCookWithFood, setCookResumePromptOpen, cookResumePromptOpen,
    user, membership, family, familyQuery, familyQueryError, currentUser, familyHeroImageUrl, familyStatCards,
    currentUserRecentLogs, familyOwnerMember, familyActivityQuery, familyActivityPhase, isOwner,
    editingMember, familyOverlayMode, inviteForm, profileForm, memberEditForm, passwordForm, familyForm,
    isCreatingMember, isUpdatingProfile, isUpdatingMember, isUpdatingPassword, isUpdatingFamily, familyFormError,
    profileImageControls, familyImageControls, sidebarFamilyName, sidebarMotto, sidebarLocation,
    sidebarMemberLabel, sidebarActivityLabel, resolveDashboardAssetUrl, setFamilyOverlayMode,
    setInviteForm, setProfileForm, setMemberEditForm, setPasswordForm, setFamilyForm, openMemberEdit,
    submitInvite, submitProfile, submitMemberEdit, submitPassword, submitFamily,
    openGlobalSearch, globalSearchOpen, setGlobalSearchOpen, handleGlobalSearchSelect,
  } = context;
  return (
        <AppWorkspaceRouter navigationState={navigation.state} routes={{

          home: (
          <WorkspaceRouteBoundary>
          <AppHomeWorkspaceRoute
            sidebarFamilyName={sidebarFamilyName}
            sidebarMotto={sidebarMotto}
            sidebarLocation={sidebarLocation}
            sidebarMemberLabel={sidebarMemberLabel}
            sidebarActivityLabel={sidebarActivityLabel}
            inventoryAlerts={inventoryAlerts}
            notificationCenter={mobileNotificationCenter}
            dashboardStats={dashboardStats}
            desktopRecommendations={desktopRecommendations}
            mobileRecommendations={mobileRecommendations}
            recommendationCount={dashboardRecommendationItems.length}
            foodRecommendations={foodRecommendations}
            homeInventoryActionGroups={homeInventoryActionGroups}
            hasLaterInventoryActionGroups={hasLaterInventoryActionGroups}
            hasFullListInventoryActionGroups={hasFullListInventoryActionGroups}
            requiredActions={homeRequiredActions}
            hasMoreHomeActions={hasMoreHomeActions}
            activeFoodPlanItems={activeFoodPlanItems}
            foodPlanItems={foodPlanItems}
            dashboardPlanDays={dashboardPlanDays}
            compactPlanDays={dashboardPlanDays}
            selectedDashboardPlanDay={selectedDashboardPlanDay}
            selectedDashboardPlanDateLabel={selectedDashboardPlanDateLabel}
            selectedPlanSummary={selectedPlanSummary}
            pendingShoppingCount={pendingShoppingCount}
            pendingShoppingPreview={pendingShoppingPreview}
            foodPlanWeekRange={foodPlanWeekRange}
            homeHighlights={homeHighlightsViewModel}
            foods={foods}
            recipes={recipes}
            ingredients={ingredients}
            mealLogs={mealLogs}
            inventoryItems={inventoryItems}
            isQuickAdding={recordMealMutation.isPending}
            isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
            resolveAssetUrl={resolveDashboardAssetUrl}
            businessDateKey={homeBusinessDateKey}
            recordMeal={(payload) => recordMealMutation.mutateAsync(payload)}
            loadMealCandidates={loadMealCandidates}
            onRecordSuccess={(response) => mealRecordResultState.publishRecordResult(response)}
            recordResult={mealRecordResultState.result}
            isRevertingRecord={mealRecordResultState.isReverting}
            recordRevertError={mealRecordResultState.revertError}
            recordRateError={mealRecordResultState.rateError}
            onRevertRecord={() => void mealRecordResultState.revert()}
            onViewRecord={() => mealRecordResultState.viewMeal()}
            onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
            onDismissRecord={() => mealRecordResultState.dismiss()}
            createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
            onNavigate={navigation.navigate}
            onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
            onNextDesktopRecommendations={showNextDesktopRecommendations}
            onNextMobileRecommendation={showNextMobileRecommendation}
            onStartRecommendedRecipe={startRecommendedRecipe}
            onStartPlanRecipe={startPlanRecipe}
            onSelectedPlanDateChange={setSelectedDashboardPlanDate}
            onHomePlanAddDialogOpen={openHomePlanAddDialog}
            onHomePlanAddEmptyDialogOpen={openHomePlanAddEmptyDialog}
            onHomePlanDetailOpen={openHomePlanDetail}
            onHomeRestockOpen={openHomeRestock}
            onOpenActionGroup={handleOpenActionGroup}
            onOpenIngredientShopping={openIngredientShopping}
            onOpenIngredientCreate={openIngredientCreate}
            onOpenIngredientPriority={openIngredientPriority}
            onOpenShoppingIntake={() => openShoppingIntake()}
            onOpenFamilyActivity={openFamilyActivity}
            onOpenFullWeek={openFoodPlanWeek}
            onRetryHighlights={retryHomeHighlights}
            onOpenReconciliation={openReconciliation}
            onFoodPlanPreviousWeek={foodPlanWeekNavigation.previousWeek}
            onFoodPlanCurrentWeek={foodPlanWeekNavigation.currentWeek}
            onFoodPlanNextWeek={foodPlanWeekNavigation.nextWeek}
          />
          </WorkspaceRouteBoundary>
        ),

        eat: (
          <WorkspaceRouteBoundary>
            <AppEatWorkspaceRoute
              navigation={navigation}
              taskResolutionArgs={useAppEatTaskResolutionArgs({
                task: navigation.state.eat.task,
                recipes,
                foods,
                planDetail: foodPlanDetail,
                mealLogs,
                recipesQuery,
                foodsQuery,
                planDetailQuery: foodPlanDetailQuery,
                mealLogsQuery,
                mealLogsFetching: mealLogsQuery.isFetching,
              })}
              completionPending={
                cookRecipeMutation.isPending
                || recordMealMutation.isPending
                || completeFoodPlanItemMutation.isPending
                || updateFoodPlanItemMutation.isPending
                || deleteFoodPlanItemMutation.isPending
              }
              cookResumePromptOpen={cookResumePromptOpen}
              taskBodyArgs={useAppEatTaskBodyArgs({
                data: {
                recipes,
                foods,
                ingredients,
                inventoryItems,
                mealLogs,
                foodPlanItems,
                members,
                sessionScope:
                  user?.id && membership?.family_id
                    ? { userId: user.id, familyId: membership.family_id }
                    : null,
                },
                pending: {
                isRecordingMeal: recordMealMutation.isPending,
                isCompletingPlan: completeFoodPlanItemMutation.isPending,
                isUpdatingPlan:
                  createFoodPlanItemMutation.isPending
                  || updateFoodPlanItemMutation.isPending
                  || deleteFoodPlanItemMutation.isPending,
                isCookingRecipe: cookRecipeMutation.isPending,
                isCreatingShopping: createShoppingMutation.isPending,
                isSavingFood: updateFoodMutation.isPending,
                isUpdatingRecipe: updateRecipeMutation.isPending,
                isUpdatingMeal: updateMealMutation.isPending,
                },
                actions: {
                cookRecipe: (recipeId, payload) =>
                  cookRecipeMutation.mutateAsync({ recipeId, payload }),
                previewCookRecipe: (recipeId, payload) =>
                  previewCookRecipeMutation.mutateAsync({ recipeId, payload }),
                updateFoodPlanItem: (itemId, payload) =>
                  updateFoodPlanItemMutation.mutateAsync({ itemId, payload }),
                deleteFoodPlanItem: (itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId),
                createFoodPlanItem: (payload) => createFoodPlanItemMutation.mutateAsync(payload),
                updateFood: (foodId, payload) => updateFoodMutation.mutateAsync({ foodId, payload }),
                updateRecipe: (recipeId, payload) =>
                  updateRecipeMutation.mutateAsync({ recipeId, payload }),
                updateMealLog: (mealLogId, payload) =>
                  updateMealMutation.mutateAsync({ mealLogId, payload }),
                createShoppingItem: (payload) => createShoppingMutation.mutateAsync(payload),
                recordMeal: (payload) => recordMealMutation.mutateAsync(payload),
                completeFoodPlanItem: (itemId, payload) =>
                  completeFoodPlanItemMutation.mutateAsync({ itemId, payload }),
                onRecordSuccess: (response) => mealRecordResultState.publishRecordResult(response),
                onClose: navigation.closeTask,
                onOpenLogs: () => navigation.navigate({ workspace: 'eat', view: 'history' }),
                onNavigateRecipe: (recipeId, mode = 'view') =>
                  navigation.navigate({ workspace: 'eat', view: 'recipe', recipeId, mode }),
                onStartCook: startRecipeCook,
                onStartCookWithFood: startCookWithFood,
                onQuickAdd: (food, mealType) => {
                  navigation.navigate({
                    workspace: 'eat',
                    view: 'meal-create',
                    source: { kind: 'direct' },
                    foodId: food.id,
                    date: businessDateKey(new Date(), 'Asia/Shanghai'),
                    mealType,
                  });
                },
                onCookCompleted: () => {
                  navigation.navigate({ workspace: 'eat', view: 'history' });
                },
                onViewMealLog: (mealLogId) => {
                  navigation.navigate({ workspace: 'eat', view: 'history', mealLogId });
                },
                onCookResumePromptChange: setCookResumePromptOpen,
                },
              })}
              discoverContent={
                <AppFoodWorkspaceRoute
                  recipes={recipes}
                  ingredients={ingredients}
                  foods={foods}
                  inventoryItems={inventoryItems}
                  mealLogs={mealLogs}
                  members={members}
                  foodScenes={foodScenes}
                  foodPlanItems={foodPlanItems}
                  foodPlanWeekRange={foodPlanWeekRange}
                  foodPlanNavigationRequest={foodPlanNavigationRequest}
                  isPhoneViewport={isPhoneViewport}
                  notificationCenter={mobileNotificationCenter}
                  createFood={(payload) => createFoodMutation.mutateAsync(payload)}
                  updateFood={(foodId, payload) => updateFoodMutation.mutateAsync({ foodId, payload })}
                  updateFoodFavorite={(foodId, favorite, expectedRowVersion) =>
                    toggleFavoriteMutation.mutateAsync({ foodId, favorite, expectedRowVersion })
                  }
                  createRecipe={(payload) => createRecipeMutation.mutateAsync(payload)}
                  updateRecipe={(recipeId, payload) => updateRecipeMutation.mutateAsync({ recipeId, payload })}
                  recordMeal={(payload) => recordMealMutation.mutateAsync(payload)}
                  loadMealCandidates={loadMealCandidates}
                  onRecordSuccess={(response) => mealRecordResultState.publishRecordResult(response)}
                  recordResult={mealRecordResultState.result}
                  isRevertingRecord={mealRecordResultState.isReverting}
                  recordRevertError={mealRecordResultState.revertError}
                  recordRateError={mealRecordResultState.rateError}
                  onRevertRecord={() => void mealRecordResultState.revert()}
                  onViewRecord={() => mealRecordResultState.viewMeal()}
                  onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
                  onDismissRecord={() => mealRecordResultState.dismiss()}
                  completeFoodPlanItem={(itemId, payload) =>
                    completeFoodPlanItemMutation.mutateAsync({ itemId, payload })
                  }
                  updateMealLog={(mealLogId, payload) => updateMealMutation.mutateAsync({ mealLogId, payload })}
                  shoppingItems={shoppingItems}
                  createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
                  updateShoppingItem={(itemId, payload) => updateShoppingMutation.mutateAsync({ itemId, payload })}
                  isCreatingShopping={createShoppingMutation.isPending}
                  createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
                  updateFoodPlanItem={(itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload })}
                  deleteFoodPlanItem={(itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId)}
                  createFoodScene={(payload) => createFoodSceneMutation.mutateAsync(payload)}
                  updateFoodScene={(sceneId, payload) => updateFoodSceneMutation.mutateAsync({ sceneId, payload })}
                  deleteFoodScene={(sceneId) => deleteFoodSceneMutation.mutateAsync(sceneId)}
                  onStartRecipe={startRecipeCook}
                  navigate={navigation.navigate}
                  onOpenLogs={() => navigation.navigate({ workspace: 'eat', view: 'history' })}
                  onFoodPlanPreviousWeek={foodPlanWeekNavigation.previousWeek}
                  onFoodPlanCurrentWeek={foodPlanWeekNavigation.currentWeek}
                  onFoodPlanNextWeek={foodPlanWeekNavigation.nextWeek}
                  isSavingFood={createFoodMutation.isPending || updateFoodMutation.isPending}
                  isCreatingRecipe={createRecipeMutation.isPending}
                  isUpdatingRecipe={updateRecipeMutation.isPending}
                  isUpdatingFavorite={toggleFavoriteMutation.isPending}
                  isQuickAdding={recordMealMutation.isPending}
                  isCompletingPlan={completeFoodPlanItemMutation.isPending}
                  isUpdatingPlan={createFoodPlanItemMutation.isPending || updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
                  isUpdatingScene={createFoodSceneMutation.isPending || updateFoodSceneMutation.isPending || deleteFoodSceneMutation.isPending}
                  isUpdatingMeal={updateMealMutation.isPending}
                />
              }
              historyContent={
                <AppMealLogWorkspaceRoute
                  foodPlanItems={foodPlanItems}
                  members={members}
                  recentMeals={recentMeals}
                  foods={foods}
                  mealInsights={mealInsights}
                  mealInsightsStatus={
                    mealInsightsQuery.isError
                      ? 'error'
                      : mealInsightsQuery.isLoading || mealInsightsQuery.isPending
                        ? 'loading'
                        : mealInsightsQuery.isSuccess
                          ? 'success'
                          : 'idle'
                  }
                  onRetryMealInsights={() => {
                    void mealInsightsQuery.refetch();
                  }}
                  isUpdatingMeal={updateMealMutation.isPending}
                  notificationCenter={mobileNotificationCenter}
                  focusMealLogId={navigation.state.eat.task?.kind === 'meal-detail' ? navigation.state.eat.task.mealLogId : null}
                  updateMealLog={(mealLogId, payload) => updateMealMutation.mutateAsync({ mealLogId, payload })}
                  onBackHome={() => navigation.navigate({ workspace: 'home' })}
                  onBackToEat={() => navigation.navigate({ workspace: 'eat', view: 'discover' })}
                  onRecordMeal={() =>
                    navigation.navigate({
                      workspace: 'eat',
                      view: 'meal-create',
                      source: { kind: 'direct' },
                      date: businessDateKey(new Date(), 'Asia/Shanghai'),
                      mealType: 'dinner',
                    })
                  }
                  recordResult={mealRecordResultState.result}
                  isRevertingRecord={mealRecordResultState.isReverting}
                  recordRevertError={mealRecordResultState.revertError}
                  recordRateError={mealRecordResultState.rateError}
                  onRevertRecord={() => void mealRecordResultState.revert()}
                  onViewRecord={() => mealRecordResultState.viewMeal()}
                  onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
                  onDismissRecord={() => mealRecordResultState.dismiss()}
                  updateMealComposition={(mealLogId, payload) =>
                    updateMealCompositionMutation.mutateAsync({ mealLogId, payload })
                  }
                />
              }
            />
          </WorkspaceRouteBoundary>
        ),

        ingredients: (
          <WorkspaceRouteBoundary>
            <AppIngredientWorkspaceRoute
              ingredients={ingredients}
              foods={foods}
              inventoryItems={inventoryItems}
              inventoryStates={inventoryStates}
              shoppingItems={shoppingItems}
              recipes={recipes}
              recordMeal={(payload) => recordMealMutation.mutateAsync(payload)}
              loadMealCandidates={loadMealCandidates}
              onRecordSuccess={(response) => mealRecordResultState.publishRecordResult(response)}
              recordResult={mealRecordResultState.result}
              isRevertingRecord={mealRecordResultState.isReverting}
              recordRevertError={mealRecordResultState.revertError}
              recordRateError={mealRecordResultState.rateError}
              onRevertRecord={() => void mealRecordResultState.revert()}
              onViewRecord={() => mealRecordResultState.viewMeal()}
              onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
              onDismissRecord={() => mealRecordResultState.dismiss()}
              isRecordingMeal={recordMealMutation.isPending}
              openShoppingIntake={openShoppingIntake}
              openReconciliation={openReconciliation}
              openOperationHistory={openOperationHistory}
              operationBanner={
                recentBannerOperation ? (
                  <InventoryOperationBanner
                    operation={recentBannerOperation}
                    busy={revertInventoryOperationMutation.isPending}
                    onView={(operationId) => openOperationHistory(operationId)}
                    onRevert={(operationId) => {
                      void handleRevertInventoryOperation(operationId);
                    }}
                    onOpenHistory={() => openOperationHistory()}
                  />
                ) : null
              }
              notificationCenter={mobileNotificationCenter}
              navigationRequest={ingredientNavigationRequest}
              onNavigationRequestConsumed={consumeIngredientNavigationRequest}
              createIngredient={(payload) => createIngredientMutation.mutateAsync(payload)}
              updateIngredient={(ingredientId, payload) => updateIngredientMutation.mutateAsync({ ingredientId, payload })}
              transitionIngredientTrackingMode={(ingredientId, payload) => transitionIngredientTrackingModeMutation.mutateAsync({ ingredientId, payload })}
              createInventory={(payload) => createInventoryMutation.mutateAsync(payload)}
              upsertInventoryState={(ingredientId, payload) =>
                upsertInventoryStateMutation.mutateAsync({ ingredientId, payload })
              }
              consumeInventory={(payload) => consumeInventoryMutation.mutateAsync(payload)}
              disposeExpiredInventory={(payload) => disposeExpiredInventoryMutation.mutateAsync(payload)}
              snoozeInventoryExpiryAlerts={(payload) => snoozeInventoryExpiryAlertsMutation.mutateAsync(payload)}
              correctInventoryExpiryDate={(inventoryItemId, payload) =>
                correctInventoryExpiryDateMutation.mutateAsync({ inventoryItemId, payload })
              }
              createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
              updateShoppingItem={(payload) => updateShoppingMutation.mutateAsync(payload)}
              deleteShoppingItem={(itemId, expectedRowVersion) =>
                deleteShoppingMutation.mutateAsync({ itemId, expectedRowVersion })
              }
              isCreatingIngredient={createIngredientMutation.isPending}
              isUpdatingIngredient={updateIngredientMutation.isPending}
              isCreatingInventory={createInventoryMutation.isPending || upsertInventoryStateMutation.isPending}
              isConsumingInventory={consumeInventoryMutation.isPending}
              isDisposingExpiredInventory={disposeExpiredInventoryMutation.isPending}
              isCreatingShopping={createShoppingMutation.isPending}
              isUpdatingShopping={updateShoppingMutation.isPending || deleteShoppingMutation.isPending}
            />
          </WorkspaceRouteBoundary>
        ),

        ai: (
          <WorkspaceRouteBoundary>
            <AppAiWorkspaceRoute
              familyId={family?.id ?? ''}
              conversations={aiConversations}
              isLoading={aiConversationsQuery.isLoading}
              currentUser={user}
              createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
              isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
              onBackHome={() => navigation.navigate({ workspace: 'home' })}
              onNavigate={navigation.navigate}
            />
          </WorkspaceRouteBoundary>
        ),

        family: (
          <AppFamilyWorkspaceRoute
            state={navigation.state}
            isOwner={isOwner}
            family={family ?? null}
            familyQueryError={familyQuery.error}
            members={members}
            currentUser={currentUser}
            membership={membership}
            familyHeroImageUrl={familyHeroImageUrl}
            familyStatCards={familyStatCards}
            currentUserRecentLogs={currentUserRecentLogs}
            familyOwnerMember={familyOwnerMember}
            activityQuery={familyActivityQuery}
            activityPhase={familyActivityPhase}
            isPhoneViewport={isPhoneViewport}
            notificationCenter={mobileNotificationCenter}
            overlayMode={familyOverlayMode}
            editingMember={editingMember}
            inviteForm={inviteForm}
            profileForm={profileForm}
            memberEditForm={memberEditForm}
            passwordForm={passwordForm}
            familyForm={familyForm}
            isCreatingMember={isCreatingMember}
            isUpdatingProfile={isUpdatingProfile}
            isUpdatingMember={isUpdatingMember}
            isUpdatingPassword={isUpdatingPassword}
            isUpdatingFamily={isUpdatingFamily}
            familyFormError={familyFormError}
            profileImageControls={profileImageControls}
            familyImageControls={familyImageControls}
            resolveAssetUrl={resolveDashboardAssetUrl}
            onOverlayChange={setFamilyOverlayMode}
            onNavigate={navigation.navigate}
            onMemberEdit={openMemberEdit}
            onInviteFormChange={setInviteForm}
            onProfileFormChange={setProfileForm}
            onMemberEditFormChange={setMemberEditForm}
            onPasswordFormChange={setPasswordForm}
            onFamilyFormChange={setFamilyForm}
            onInviteSubmit={submitInvite}
            onProfileSubmit={submitProfile}
            onMemberEditSubmit={submitMemberEdit}
            onPasswordSubmit={submitPassword}
            onFamilySubmit={submitFamily}
          />
        ),

      }} />
  );
}
