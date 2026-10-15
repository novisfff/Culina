import { StateBlock } from '../../components/ui-kit';
import type { HomeInventoryReadState } from './homeInventoryReadState';

export function HomeInventoryFeedback(props: { state: HomeInventoryReadState; onRetry: () => void }) {
  const { state } = props;
  if (state.canSuggest) return null;
  const hasCachedData = state.hasInventoryData && state.hasShoppingData;
  return (
    <StateBlock
      className="home-inventory-feedback"
      status={state.hasError ? 'error' : 'loading'}
      title={state.hasError ? hasCachedData ? '库存与采购数据刷新失败' : '库存与采购数据暂时无法读取' : '正在读取库存与采购数据'}
      description={hasCachedData
        ? '统计保留上次成功读取的数据，行动建议将在刷新成功后恢复。'
        : '未读取的数据以“—”显示，行动建议将在读取成功后恢复。'}
      actionLabel={state.hasError && !state.isFetching ? '重试库存与采购' : undefined}
      onAction={props.onRetry}
    />
  );
}
